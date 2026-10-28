import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletState } from '../host/wallet-state.mjs';
import { RoutedService } from '../host/routed-service.mjs';
const OWNER='0x1234567890123456789012345678901234567890';

function lockService({status='LOCKED',pending=false,fail=false,owner=OWNER}={}){
  const calls=[];const service=new RoutedService({cli:async a=>{
    calls.push(a.join(' '));
    if(a[1]==='tx-lock')return {status};
    if(a[1]==='status')return {status:'CONNECTED'};
    if(a[1]==='address')return {addresses:[{binanceChainId:'56',address:owner}]};
    if(fail)throw new Error('offline');
    if(a[1]==='tx-history')return {transactions:pending?[{id:'pending'}]:[],hasMore:false};
    if(a[1]==='list')return {list:[],total:0};
    throw new Error('write forbidden');
  }},{dir:'unused'},{},{chain:{}});return {service,calls};
}
test('cached lock is rechecked live and released state can pass without submitting',async()=>{
  const {service,calls}=lockService({status:'UNLOCKED'});
  await service.requireWalletUnlocked({status:'LOCKED'},OWNER);assert.equal(calls.some(c=>c.includes('tx-history')),false);
});
test('live locked state distinguishes empty queues, actual pending orders, and read failures',async()=>{
  for(const [options,pattern] of [[{},/未查到待处理交易/],[{pending:true},/仍有待处理订单/],[{fail:true},/查询未完成/]]){
    const {service}=lockService(options);await assert.rejects(service.requireWalletUnlocked({status:'LOCKED'},OWNER),e=>e.code==='WALLET_LOCKED'&&pattern.test(e.message));
  }
});
test('wallet change during lock recheck cannot pass even if new wallet is unlocked',async()=>{
  const {service}=lockService({status:'UNLOCKED',owner:'0x2222222222222222222222222222222222222222'});
  await assert.rejects(service.requireWalletUnlocked({status:'LOCKED'},OWNER),{code:'WALLET_CHANGED'});
});

test('fresh background wallet snapshot is reused, expiry forces a read',async()=>{
  let now=0,calls=0;const s=new WalletState(async()=>({owner:++calls}),{now:()=>now});
  assert.equal((await s.get()).owner,1);now=5999;assert.equal((await s.get()).owner,1);
  now=6000;assert.equal((await s.get()).owner,2);assert.equal(calls,2);
});
test('concurrent readers share one refresh and background failure clears stale state',async()=>{
  let calls=0,fail=false;const s=new WalletState(async()=>{calls++;if(fail)throw new Error('offline');return {};});
  await Promise.all([s.get(),s.get(),s.get()]);assert.equal(calls,1);
  fail=true;await assert.rejects(s.get({force:true}),/offline/);assert.equal(s.value,null);
  await assert.rejects(s.get(),/offline/);assert.equal(calls,3);
});
test('late refresh cannot resurrect state invalidated by a submission',async()=>{
  let release;const s=new WalletState(()=>new Promise(r=>release=r));const pending=s.get();await Promise.resolve();
  s.invalidate();release({owner:OWNER});await assert.rejects(pending,{code:'WALLET_STATE_CHANGED'});assert.equal(s.value,null);
});
test('production background identity, lock and developer checks reuse one snapshot; invalidation forces fresh checks',async t=>{
  let calls=0,locked=false,dev=true;const wallet={cli:async a=>{calls++;if(a[1]==='status')return {status:'CONNECTED'};if(a[1]==='address')return {addresses:[{binanceChainId:'56',address:OWNER}]};if(a[1]==='settings')return {devMode:{enabled:dev}};if(a[1]==='tx-lock')return {status:locked?'LOCKED':'UNLOCKED'};throw new Error('write forbidden');}};
  const s=new RoutedService(wallet,{dir:'unused'},{},{chain:{}});t.after(()=>s.stopBackgroundState());s.startBackgroundState();
  await s.walletState.get();const initial=calls;
  await Promise.all([s.owner(),s.walletLock(),s.developer(true)]);assert.equal(calls,initial);
  s.invalidateWalletState();locked=true;dev=false;
  assert.equal((await s.walletLock()).status,'LOCKED');await assert.rejects(s.developer(true),{code:'DEVELOPER_MODE'});assert.equal(calls,initial+4);
});
