import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from '../host/routes/router.mjs';
import { Gang,gangBuy,gangSell,V2,PADS } from '../host/routes/gang.mjs';
import { Flap,PORTAL,FLAP } from '../host/routes/flap.mjs';
import { ethers,raw,fmt,expiryMs,ZERO,ERC } from '../host/routes/chain.mjs';
import { RoutedService } from '../host/routed-service.mjs';
import { Journal } from '../host/journal.mjs';
import { BNB } from '../host/domain.mjs';
const OWNER='0x1234567890123456789012345678901234567890',TOKEN='0xaf21e620ff8df6042902e01e52cfbb22933abbbb',Q='0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f';
const input={chainId:'56',token:TOKEN,side:'buy',amount:'0.005',slippage:'auto',mev:true,gasLevel:'MEDIUM'};

test('background locked state prevents execution and submission clears warm state',async t=>{
  const {service,wallet,state}=await fixture(t);t.after(()=>service.stopBackgroundState());
  const cli=wallet.cli;wallet.cli=async a=>a[1]==='tx-lock'?{status:'LOCKED'}:cli(a);
  service.startBackgroundState();await service.walletState.get();
  const p=await service.prepare(input),row=await service.submit({previewId:p.id,confirmed:true});
  assert.equal(row.errorCode,'WALLET_LOCKED');assert.equal(state.swaps,0);assert.equal(state.executes,0);assert.equal(service.walletState.value,null);
});

test('route construction overlaps audit, but rejected audit never produces executable preview', {timeout:3000}, async t=>{
  const {service,router,wallet,state}=await fixture(t);let release;const gate=new Promise(r=>release=r);
  wallet.audit=async()=>{await gate;return {available:true,riskLevel:5};};
  const original=router.build.bind(router);router.build=async(...args)=>{release();return original(...args);};
  await assert.rejects(service.prepare(input),{code:'AUDIT_BLOCKED'});
  assert.equal(service.previews.size,0);assert.equal(state.swaps,0);assert.equal(state.executes,0);
});

test('submission starts identity, payment balance and block checks concurrently', {timeout:3000}, async t=>{
  const {service,router}=await fixture(t),p=await service.prepare(input);
  p.step.spendToken=Q;p.step.spendAmount='0.65';
  const started=new Set();let release;const gate=new Promise(r=>release=r);
  const check=async(name,value)=>{started.add(name);if(started.size===3)release();await gate;return value;};
  service.owner=()=>check('owner',OWNER);router.chain.block=()=>check('block',100);router.chain.balance=()=>check('balance',raw('100'));
  const row=await service.submit({previewId:p.id,confirmed:true});
  assert.equal(row.status,'PENDING');assert.equal(started.size,3);
});

test('cached preparation identity cannot bypass live identity at submission',async t=>{
  const {service,state}=await fixture(t),p=await service.prepare(input);
  service.reads.values.set('prepare-owner',{at:Date.now(),value:OWNER});service.owner=async()=>TOKEN;
  const row=await service.submit({previewId:p.id,confirmed:true});
  assert.equal(row.errorCode,'WALLET_CHANGED');assert.equal(state.swaps,0);assert.equal(state.executes,0);
});
test('developer expiry accepts live ISO response as well as Unix seconds',()=>{
  assert.equal(expiryMs('2026-11-03T17:57:03+08:00'),Date.parse('2026-11-03T17:57:03+08:00'));assert.equal(expiryMs(1800000000),1800000000000);
});
test('Gang curve quote honors budget, holding room and graduation cap with bigint math',()=>{
  const c={realQuote:'0',gradAmt:String(raw('2025')),virtualQuote:String(raw('675')),sold:'0'};
  const q=gangBuy(c,raw('0.65'),raw('10000000'));assert.ok(q.tokens>0n);assert.ok(q.spent<=raw('0.65'));
  const capped=gangBuy(c,raw('10'),raw('1'));assert.ok(capped.tokens<=raw('1'));assert.ok(capped.spent<raw('10'));
  const after={...c,realQuote:String(q.spent-q.spent*100n/10000n),sold:String(q.tokens)};
  assert.ok(gangSell(after,q.tokens)<raw('0.65'));
});
test('confirmed funding uses exact receipt amount and cannot swap BNB again due to price movement',async()=>{
  let quoted=0;const router=new Router({cli:async()=>{quoted++;throw new Error('must not quote another funding swap');}}, {},{balance:async()=>raw('0.65')});
  const plan=await router.funding(Q,'0.005',OWNER,{...input,_funded:{[Q.toLowerCase()]:String(raw('0.65'))}});
  assert.equal(plan.amount,raw('0.65'));assert.equal(plan.step,null);assert.equal(quoted,0);
});
test('Flap ordinary portal produces expected native buy calldata and validates gate',async()=>{
  const chain={probe:async()=>[ZERO],call:async(_to,_abi,fn)=>{assert.equal(fn,'quoteExactInput');return [raw('123')];}};
  const built=await new Flap(chain).build({platform:'flap',kind:'portal',stage:'inner',quote:ZERO,nativeSwap:true},input,OWNER,'0.005',{tokenMeta:async()=>({symbol:'FLAP',decimals:18})});
  const tx=PORTAL.parseTransaction({data:built.step.inputData,value:built.step.value});assert.equal(tx.name,'swapExactInput');assert.equal(tx.args[0].inputAmount,raw('0.005'));assert.equal(built.step.to,FLAP);
});
test('Four uses original transaction emitted by official helper without rebuilding calldata',async()=>{
  const tx={to:PADS[0],value:'1234',inputData:'0x12345678'};
  const router=new Router({four:async()=>({tx,simulation:{ok:true},estimate:{tokenAmount:'12'}})}, {},{meta:async()=>({symbol:'FOUR',decimals:18})});
  const p=await router.build({platform:'four',kind:'agent',stage:'inner'},input,OWNER,'0.005');
  assert.equal(p.step.to,tx.to);assert.equal(p.step.value,tx.value);assert.equal(p.step.inputData,tx.inputData);
});
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'platform-route-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const journal=new Journal(dir);await journal.init();
  const state={swaps:0,executes:0,approved:false,receipted:false,throwSwap:false,dev:true,lastTx:null,orderStatus:'PENDING',requireApp:false};
  const chain={block:async()=>100,meta:async()=>({symbol:'TOKEN',decimals:18}),balance:async()=>raw('100'),transfers:(_r,asset)=>asset.toLowerCase()===Q.toLowerCase()?raw('0.65'):raw('100'),receipt:async()=>state.receipted?{status:1,logs:[]}:null,transaction:async()=>state.lastTx};
  const wallet={audit:async()=>({available:true,hits:[]}),cli:async args=>{
    if(args[1]==='status')return {status:'CONNECTED'};
    if(args[1]==='address')return {addresses:[{binanceChainId:'56',address:OWNER}]};
    if(args[1]==='settings')return {devMode:{enabled:state.dev,expiresAt:'2099-01-01T00:00:00Z'}};
    if(args[1]==='balance')return [{address:args[args.indexOf('--tokenAddress')+1],balance:'1',binanceChainId:'56',symbol:'BNB'}];
    if(args[1]==='tx-lock')return {status:'UNLOCKED'};
    if(args[0]==='contract-call'&&args[1]==='preview'){
      state.lastPreview={to:args[args.indexOf('--to')+1],inputData:args[args.indexOf('--inputData')+1],value:args[args.indexOf('--value')+1]};
      return {requestId:'request',parsedTx:{transactionType:'ContractCall'},simulationResult:{simulationCode:'000000000'},risks:{riskDetails:[]}};
    }
    if(args[0]==='contract-call'&&args[1]==='execute'){
      state.executes++;state.lastTx={from:OWNER,to:state.lastPreview.to,data:state.lastPreview.inputData,value:BigInt(state.lastPreview.value),blockNumber:101};
      return {status:state.requireApp?'PENDING_CONFIRMATION':'BROADCASTED',txHash:state.requireApp?null:'0x'+'b'.repeat(64),orderId:'contract-order'};
    }
    if(args[1]==='swap'){state.swaps++;if(state.throwSwap)throw new Error('network timeout');state.lastTx={from:OWNER,value:0n};return {orderId:'funding-order'};}
    if(args[1]==='list')return {list:[{orderId:'funding-order',chain:'56',fromToken:BNB,toToken:Q,fromTokenQty:'0.005',toTokenActualQty:'0.65',status:state.orderStatus,txHash:'0x'+'a'.repeat(64)}]};
    throw new Error('Unexpected command '+args.join(' '));
  }};
  const router={chain,detect:async()=>({platform:'gang',kind:'v2',stage:'inner',quote:Q}),tokenMeta:async()=>({symbol:'SUMMER',decimals:18}),build:async(_route,i)=>{
    if(!i._funded[Q.toLowerCase()])return {route:'Gang V2',out:'100',receive:TOKEN,step:{kind:'market',label:'fund',role:'funding',fromToken:BNB,toToken:Q,amount:'0.005',quote:{fromCoinAmount:'0.005',toCoinAmount:'0.65',slippage:.01}}};
    return {route:'Gang V2',out:'100',receive:TOKEN,step:state.approved?{kind:'contract',label:'trade',role:'trade',to:PADS[0],value:'0',inputData:V2.encodeFunctionData('buy',[TOKEN,raw('.65'),raw('99')])}:{kind:'contract',label:'approve',role:'approval',to:Q,value:'0',inputData:ERC.encodeFunctionData('approve',[PADS[0],raw('.65')])}};
  }};
  const service=new RoutedService(wallet,journal,{},router);return {service,wallet,router,journal,state};
}
test('multi-step flow executes exactly one confirmed step, waits for receipt, then requires a new confirmation',async t=>{
  const {service,journal,state}=await fixture(t);const p=await service.prepare(input);assert.equal(state.swaps,0);
  const row=await service.submit({previewId:p.id,confirmed:true});assert.equal(state.swaps,1);assert.equal(row.status,'PENDING');
  await assert.rejects(service.continueOrder({id:row.id}),/不能继续/);
  await service.submit({previewId:p.id,confirmed:true});assert.equal(state.swaps,1);
  state.orderStatus='FINISHED';await service.refreshOrder({id:row.id});assert.equal((await journal.get(row.id)).status,'PENDING');
  state.receipted=true;const funded=await service.refreshOrder({id:row.id});assert.equal(funded.status,'WAITING_NEXT');assert.equal(funded.spentBnb,String(raw('0.005')));
  const approval=await service.continueOrder({id:row.id});assert.ok(approval.contractPreview.parsedTx);assert.equal(state.executes,0);
  await service.submit({previewId:approval.id,confirmed:true});assert.equal(state.executes,1);
  await service.refreshOrder({id:row.id});state.approved=true;
  const trade=await service.continueOrder({id:row.id});await service.submit({previewId:trade.id,confirmed:true});
  const done=await service.refreshOrder({id:row.id});assert.equal(done.status,'FINISHED');assert.equal(state.executes,2);assert.equal(state.swaps,1);assert.equal(await journal.active(),null);
});
test('developer mode is checked before any inner quote or calldata preview',async t=>{
  const {service,state}=await fixture(t);state.dev=false;await assert.rejects(service.prepare(input),/开发者模式/);assert.equal(state.swaps,0);assert.equal(state.executes,0);
});
test('funding timeout keeps global workflow lock and cannot retry after process restart',async t=>{
  const {service,wallet,router,journal,state}=await fixture(t);const p=await service.prepare(input);state.throwSwap=true;
  const row=await service.submit({previewId:p.id,confirmed:true});assert.equal(row.status,'UNKNOWN');
  const restarted=new RoutedService(wallet,journal,{},router);await assert.rejects(restarted.prepare(input),/未确认流程/);
  await restarted.submit({previewId:p.id,confirmed:true});assert.equal(state.swaps,1);
});
test('funding failure stops subsequent authorization/trade and retains partial-work information',async t=>{
  const {service,state,journal}=await fixture(t);const p=await service.prepare(input);const row=await service.submit({previewId:p.id,confirmed:true});state.orderStatus='FAILED';
  const failed=await service.refreshOrder({id:row.id});assert.equal(failed.status,'FAILED');assert.equal(state.executes,0);assert.equal(await journal.active(),null);
});
test('transaction mismatch cannot complete or unlock a workflow',async t=>{
  const {service,state,journal}=await fixture(t);const p=await service.prepare(input),row=await service.submit({previewId:p.id,confirmed:true});state.receipted=true;state.orderStatus='FINISHED';state.lastTx={from:TOKEN,value:0n};
  await service.refreshOrder({id:row.id});assert.equal((await journal.get(row.id)).status,'PENDING');assert.ok(await journal.active());
});
test('two native hosts cannot execute the same next step concurrently',async t=>{
  const {service,wallet,router,state,journal}=await fixture(t);const p=await service.prepare(input),row=await service.submit({previewId:p.id,confirmed:true});state.orderStatus='FINISHED';state.receipted=true;await service.refreshOrder({id:row.id});
  const other=new RoutedService(wallet,journal,{},router);
  const [a,b]=await Promise.all([service.continueOrder({id:row.id}),other.continueOrder({id:row.id})]);
  const result=await Promise.allSettled([service.submit({previewId:a.id,confirmed:true}),other.submit({previewId:b.id,confirmed:true})]);
  assert.equal(state.executes,1);assert.equal(result.filter(x=>x.status==='rejected').length,1);assert.equal((await journal.get(row.id)).status,'PENDING');
});
test('App approval does not trigger re-execution or next-step preparation without a matching mined hash',async t=>{
  const {service,state,journal}=await fixture(t);const p=await service.prepare(input),row=await service.submit({previewId:p.id,confirmed:true});state.orderStatus='FINISHED';state.receipted=true;await service.refreshOrder({id:row.id});
  const approval=await service.continueOrder({id:row.id});state.requireApp=true;await service.submit({previewId:approval.id,confirmed:true});
  assert.equal((await journal.get(row.id)).status,'APP_CONFIRM');await service.refreshOrder({id:row.id});assert.equal(state.executes,1);
  await assert.rejects(service.continueOrder({id:row.id}),/不能继续/);
  state.lastTx={...state.lastTx,to:TOKEN};
  await assert.rejects(service.attachHash({id:row.id,txHash:'0x'+'f'.repeat(64)}),/不匹配/);
  assert.equal((await journal.get(row.id)).status,'APP_CONFIRM');
});

test('one quick click automatically funds, approves and buys only after each matching receipt',async t=>{
  const {service,state,journal}=await fixture(t);service.quickFlow.kick=()=>{};
  const row=await service.quickFlow.start({...input,quick:true,acknowledgeUnavailable:true});
  assert.equal(state.swaps,1);assert.ok(row.quick);assert.equal(state.executes,0);
  await service.quickFlow.tick(row.id);assert.equal(state.executes,0);
  state.orderStatus='FINISHED';state.receipted=true;
  assert.equal(await service.quickFlow.tick(row.id),true);assert.equal(state.executes,1);
  assert.equal((await journal.get(row.id)).steps[1].role,'approval');
  state.approved=true;
  assert.equal(await service.quickFlow.tick(row.id),true);assert.equal(state.executes,2);
  assert.equal(await service.quickFlow.tick(row.id),false);
  assert.equal((await journal.get(row.id)).status,'FINISHED');assert.equal(state.swaps,1);assert.equal(await journal.active(),null);
});

test('quick flow never repeats an uncertain funding request or proceeds past pending App approval',async t=>{
  const {service,state}=await fixture(t);service.quickFlow.kick=()=>{};state.throwSwap=true;
  const row=await service.quickFlow.start({...input,quick:true,acknowledgeUnavailable:true});
  assert.equal(row.status,'UNKNOWN');assert.equal(await service.quickFlow.tick(row.id),true);assert.equal(state.swaps,1);
});

test('quick flow waits for App approval without repeating contract execute',async t=>{
  const {service,state,journal}=await fixture(t);service.quickFlow.kick=()=>{};
  const row=await service.quickFlow.start({...input,quick:true,acknowledgeUnavailable:true});
  state.orderStatus='FINISHED';state.receipted=true;state.requireApp=true;
  await service.quickFlow.tick(row.id);assert.equal(state.executes,1);assert.equal((await journal.get(row.id)).status,'APP_CONFIRM');
  await service.quickFlow.tick(row.id);await service.quickFlow.tick(row.id);assert.equal(state.executes,1);
});

test('quick authorization expires without issuing the next transaction',async t=>{
  const {service,state,journal}=await fixture(t);service.quickFlow.kick=()=>{};
  const row=await service.quickFlow.start({...input,quick:true,acknowledgeUnavailable:true});
  const saved=await journal.get(row.id);saved.quick.expiresAt=Date.now()-1;await journal.save(saved);
  state.orderStatus='FINISHED';state.receipted=true;
  assert.equal(await service.quickFlow.tick(row.id),false);assert.equal(state.executes,0);assert.equal((await journal.get(row.id)).status,'PAUSED');
  assert.ok(await journal.active());
});

test('quick flow stops on fresh developer-mode failure after funding',async t=>{
  const {service,state,journal}=await fixture(t);service.quickFlow.kick=()=>{};
  const row=await service.quickFlow.start({...input,quick:true,acknowledgeUnavailable:true});
  state.orderStatus='FINISHED';state.receipted=true;state.dev=false;
  assert.equal(await service.quickFlow.tick(row.id),false);assert.equal(state.executes,0);
  const stopped=await journal.get(row.id);assert.equal(stopped.status,'PAUSED');assert.match(stopped.message,/开发者模式/);
});

test('quick start requires explicit quick intent and audit-unavailable acknowledgment',async t=>{
  const {service,state,wallet}=await fixture(t);service.quickFlow.kick=()=>{};
  await assert.rejects(service.quickFlow.start(input),/快捷买入/);
  wallet.audit=async()=>({available:false,message:'unavailable'});
  await assert.rejects(service.quickFlow.start({...input,quick:true}),/安全审计不可用/);assert.equal(state.swaps,0);
  await service.quickFlow.start({...input,quick:true,acknowledgeUnavailable:true});assert.equal(state.swaps,1);
});

test('quick restart restores UNKNOWN read-only polling but never starts manual workflows',async t=>{
  const {service,state,journal}=await fixture(t);const kicked=[];service.quickFlow.kick=id=>kicked.push(id);
  const row=await service.quickFlow.start({...input,quick:true,acknowledgeUnavailable:true});kicked.length=0;
  await service.quickFlow.restore();assert.deepEqual(kicked,[row.id]);
  const saved=await journal.get(row.id);saved.status='UNKNOWN';await journal.save(saved);kicked.length=0;
  await service.quickFlow.restore();assert.deepEqual(kicked,[row.id]);assert.equal(state.swaps,1);kicked.length=0;
  saved.status='WAITING_NEXT';delete saved.quick;await journal.save(saved);
  await service.quickFlow.restore();assert.deepEqual(kicked,[]);
});

test('risk error without order ID recovers pending history then unlocks on failure without resubmitting',async t=>{
  const {service,state,wallet,journal}=await fixture(t);service.quickFlow.kick=()=>{};state.throwSwap=true;
  const row=await service.quickFlow.start({...input,quick:true,acknowledgeUnavailable:true}),cli=wallet.cli;
  wallet.cli=async a=>{const result=await cli(a);if(a[1]==='list')return {...result,total:1,list:result.list.map(o=>({...o,txHash:null,bookTime:new Date(row.steps[0].createdAt+1000).toISOString()}))};return result;};
  assert.equal(await service.quickFlow.tick(row.id),true);
  let saved=await journal.get(row.id);assert.equal(saved.steps[0].orderId,'funding-order');assert.equal(saved.status,'PENDING');
  state.orderStatus='FAILED';assert.equal(await service.quickFlow.tick(row.id),false);
  saved=await journal.get(row.id);assert.equal(saved.status,'FAILED');assert.equal(await journal.active(),null);assert.equal(state.swaps,1);assert.equal(state.executes,0);
});

test('explicit quick resume renews expired intent and continues the original budget without re-funding',async t=>{
  const {service,state,journal}=await fixture(t);service.quickFlow.kick=()=>{};
  const row=await service.quickFlow.start({...input,quick:true,acknowledgeUnavailable:true});
  const saved=await journal.get(row.id);saved.quick.expiresAt=Date.now()-1;await journal.save(saved);state.orderStatus='FINISHED';state.receipted=true;
  await service.quickFlow.tick(row.id);assert.equal((await journal.get(row.id)).status,'PAUSED');
  const resumed=await service.quickFlow.resume({id:row.id});assert.equal(resumed.status,'PENDING');assert.ok(resumed.quick.expiresAt>Date.now());
  assert.equal(state.swaps,1);assert.equal(state.executes,1);assert.equal(resumed.spentBnb,String(raw('0.005')));
});

test('Gang approval covers only this funded budget to avoid repeat approvals on curve rounding changes',async()=>{
  let requested=0n;const amount=raw('0.65');
  const route={platform:'gang',kind:'v2',stage:'inner',pad:PADS[0],quote:Q,c:{realQuote:'0',gradAmt:String(raw('2025')),virtualQuote:String(raw('675')),sold:'0'}};
  const chain={meta:async()=>({symbol:'BNCB',decimals:18}),call:async()=>[raw('10000000')],allowance:async(_token,_owner,_pad,n)=>{requested=n;return {kind:'contract',role:'approval'};}};
  const gang=new Gang(chain,{});gang.detect=async()=>route;
  const built=await gang.build(route,input,OWNER,'0.005',{tokenMeta:async()=>({symbol:'SUMMER',decimals:18}),funding:async()=>({amount,step:null})});
  assert.equal(requested,amount);assert.equal(built.step.role,'approval');
});

test('funding receipt advances before aggregator status catches up and includes the existing contribution',async t=>{
  const {service,state,router,journal}=await fixture(t),build=router.build;
  router.build=async(...a)=>{const p=await build(...a);if(p.step.role==='funding')p.step.existingContribution=String(raw('.2'));return p;};
  const p=await service.prepare(input),row=await service.submit({previewId:p.id,confirmed:true});
  state.receipted=true;state.orderStatus='PENDING';
  const ready=await service.refreshOrder({id:row.id});assert.equal(ready.status,'WAITING_NEXT');assert.equal(ready.funded[Q.toLowerCase()],String(raw('.85')));
  assert.equal((await journal.get(row.id)).steps[0].status,'FINISHED');assert.equal(state.swaps,1);
});

test('new App-approved calls are identified by full calldata, value, wallet, block and nonce, not by balance',async t=>{
  const {service,state,router,wallet,journal}=await fixture(t);router.chain.nonce=async()=>7;
  const cli=wallet.cli;
  wallet.cli=async a=>a[1]==='tx-history'?{transactions:[{txHash:'0x'+'c'.repeat(64)}]}:cli(a);
  const p=await service.prepare(input),row=await service.submit({previewId:p.id,confirmed:true});state.receipted=true;state.orderStatus='FINISHED';await service.refreshOrder({id:row.id});
  const approval=await service.continueOrder({id:row.id});state.requireApp=true;await service.submit({previewId:approval.id,confirmed:true});
  state.lastTx={...state.lastTx,nonce:6};await service.refreshOrder({id:row.id});assert.equal((await journal.get(row.id)).status,'APP_CONFIRM');
  state.lastTx={...state.lastTx,nonce:7,data:'0x1234'};await service.refreshOrder({id:row.id});assert.equal((await journal.get(row.id)).status,'APP_CONFIRM');
  state.lastTx={...state.lastTx,data:approval.step.inputData};
  const next=await service.refreshOrder({id:row.id});assert.equal(next.status,'WAITING_NEXT');assert.equal(next.steps.at(-1).txHash,'0x'+'c'.repeat(64));assert.equal(state.executes,1);
});

test('sell can finish with quote assets retained instead of submitting a BNB settlement swap',async t=>{
  const {service,state,router,journal}=await fixture(t);
  router.build=async()=>({route:'Gang V2',out:'.65',receive:Q,step:{kind:'contract',label:'sell',role:'trade',to:PADS[0],value:'0',inputData:V2.encodeFunctionData('sell',[TOKEN,raw('100'),raw('.6')])}});
  const p=await service.prepare({...input,side:'sell',percent:'100',sellToBnb:false});
  const row=await service.submit({previewId:p.id,confirmed:true});state.receipted=true;
  const done=await service.refreshOrder({id:row.id});assert.equal(done.status,'FINISHED');assert.equal(done.result.toToken,Q);assert.equal(state.swaps,0);assert.equal(await journal.active(),null);
});

test('quick submission can switch a newly graduated token to outer route before any buy is sent',async t=>{
  const {service,state,router}=await fixture(t);service.quickFlow.kick=()=>{};let checks=0;
  router.detect=async()=>({platform:'gang',kind:'v2',stage:++checks===1?'inner':'outer',quote:Q});
  const build=router.build;
  router.build=async(route,...args)=>route.stage==='outer'?{route:'Gang outer',out:'100',receive:TOKEN,step:{kind:'market',label:'outer buy',role:'trade',fromToken:BNB,toToken:TOKEN,amount:'0.005',quote:{slippage:.01}}}:build(route,...args);
  const row=await service.quickFlow.start({...input,quick:true,acknowledgeUnavailable:true});
  assert.equal(row.status,'PENDING');assert.equal(row.steps.length,1);assert.equal(row.steps[0].label,'outer buy');assert.equal(state.swaps,1);
});

test('audit and developer reads are reused during preparation but submission forces a current developer check',async t=>{
  const {service,wallet,state}=await fixture(t);let audits=0,settings=0;const cli=wallet.cli;
  wallet.audit=async()=>{audits++;return {available:true,hits:[]};};
  wallet.cli=async a=>{if(a[1]==='settings')settings++;return cli(a);};
  await service.prepare(input);const p=await service.prepare(input);assert.equal(audits,1);assert.equal(settings,1);
  // Funding is an aggregator step; a contract step is still checked fresh by submit.
  await service.developer(true);assert.equal(settings,2);assert.equal(state.executes,0);assert.ok(p.id);
});

test('Flap Agent quote buy checks both Portal and market approval before building the buy call',async()=>{
  const seen=[],market='0xeddc6C5736CD9f280bE750c408D36c8d6E1a473d';
  const chain={call:async()=>({shares:raw('100')})};
  const engine={tokenMeta:async()=>({symbol:'TEST',decimals:18}),funding:async()=>({amount:raw('.65'),step:null}),approval:async(_t,_o,spender)=>{
    seen.push(spender);return spender===market?{kind:'contract',label:'market approval',role:'approval'}:null;
  }};
  const built=await new Flap(chain).build({platform:'flap',kind:'agent',stage:'inner',market,quote:Q},input,OWNER,'0.005',engine);
  assert.equal(seen.length,2);assert.ok(seen.includes(market));assert.equal(built.step.label,'market approval');
});

test('legacy App-approved order recovers from a verified prior call and searches the newest history first',async t=>{
  const {service,state,router,wallet,journal}=await fixture(t);
  const p=await service.prepare(input),row=await service.submit({previewId:p.id,confirmed:true});
  state.receipted=true;state.orderStatus='FINISHED';await service.refreshOrder({id:row.id});
  const approval=await service.continueOrder({id:row.id});await service.submit({previewId:approval.id,confirmed:true});
  const prior={...state.lastTx,nonce:10};await service.refreshOrder({id:row.id});state.approved=true;router.chain.block=async()=>102;
  const trade=await service.continueOrder({id:row.id});state.requireApp=true;await service.submit({previewId:trade.id,confirmed:true});
  const current={...state.lastTx,nonce:11,blockNumber:103},hash='0x'+'c'.repeat(64),old=await journal.get(row.id);old.status='UNKNOWN';await journal.save(old);
  const cli=wallet.cli;wallet.cli=async a=>a[1]==='tx-history'?{transactions:[{txType:'contract_call',txHash:hash},...Array.from({length:40},(_,i)=>({txHash:'0x'+(100+i).toString(16).padStart(64,'0')}))]}:cli(a);
  let validAnchor=false;
  router.chain.transaction=async h=>h==='0x'+'b'.repeat(64)?{...prior,data:validAnchor?prior.data:'0x1234'}:h===hash?current:null;
  await service.refreshOrder({id:row.id});assert.equal((await journal.get(row.id)).status,'UNKNOWN');
  validAnchor=true;service.reads.clear();
  const recovered=await service.refreshOrder({id:row.id});assert.equal(recovered.status,'FINISHED');assert.equal(recovered.steps.at(-1).txHash,hash);assert.equal(recovered.steps.at(-1).beforeNonce,11);assert.equal(recovered.steps.at(-1).nonceRecoveredFrom,'0x'+'b'.repeat(64));assert.equal(state.executes,2);
});

test('legacy continuation requires a user click and never repeats the confirmed funding step',async t=>{
  const {service,state}=await fixture(t);service.quickFlow.kick=()=>{};
  const p=await service.prepare(input),row=await service.submit({previewId:p.id,confirmed:true});state.receipted=true;state.orderStatus='FINISHED';await service.refreshOrder({id:row.id});
  await assert.rejects(service.quickFlow.resume({id:row.id}),/不能恢复/);assert.equal(state.executes,0);
  const resumed=await service.quickFlow.resume({id:row.id,confirmed:true,acknowledgeUnavailable:true});assert.equal(resumed.status,'PENDING');assert.ok(resumed.quick);assert.equal(state.swaps,1);assert.equal(state.executes,1);
});

async function idleSale(t){
  const f=await fixture(t),p=await f.service.prepare(input),row=await f.service.submit({previewId:p.id,confirmed:true});
  row.side='sell';row.input={...input,side:'sell',percent:'100'};row.status='WAITING_NEXT';row.afterSell={token:Q,amount:String(raw('.65'))};
  row.steps=[{kind:'contract',role:'trade',status:'FINISHED',label:'sell',to:PADS[0],value:'0',inputData:'0x1234',previewId:row.id}];
  await f.journal.save(row);
  f.router.market=async()=>({kind:'market',role:'settle',label:'quote to BNB',fromToken:Q,toToken:BNB,amount:'.65',quote:{toCoinAmount:'.0049',slippage:.01}});
  return {...f,row};
}

test('manual settlement releases the global trade lock and reacquires it before settlement execution',async t=>{
  const {service,journal,state,row}=await idleSale(t);
  assert.equal(await journal.active(),null);await service.prepare(input);
  const p=await service.continueOrder({id:row.id}),before=state.swaps;
  const pending=await service.submit({previewId:p.id,confirmed:true});
  assert.equal(pending.status,'PENDING');assert.equal((await journal.active()).id,row.id);assert.equal(state.swaps,before+1);assert.equal(pending.steps[0].status,'FINISHED');
});

test('settlement preview cannot submit while a new trade owns the global lock',async t=>{
  const {service,journal,state,row}=await idleSale(t);await journal.active();
  const settlement=await service.continueOrder({id:row.id}),buy=await service.prepare(input),pending=await service.submit({previewId:buy.id,confirmed:true}),before=state.swaps;
  const held=await service.submit({previewId:settlement.id,confirmed:true});
  assert.equal(held.errorCode,'INFLIGHT');assert.equal(state.swaps,before);assert.equal((await journal.active()).id,pending.id);
});

test('idle settlement is not detached while its step is claimed or a submitted result remains unknown',async t=>{
  const {journal,row}=await idleSale(t);await journal.claimStep(row.id,'test-step');
  assert.equal((await journal.active()).id,row.id);await journal.releaseStep(row.id,'test-step');
  row.status='UNKNOWN';await journal.save(row);assert.equal((await journal.active()).id,row.id);
});
