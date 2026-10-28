import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../host/journal.mjs';
import { TradeQueue } from '../host/trade-queue.mjs';
import { positionLedger } from '../host/position-ledger.mjs';
import { raw } from '../host/routes/chain.mjs';
import { BNB } from '../host/domain.mjs';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
const wallet='0x1234567890123456789012345678901234567890',token='0xaf21e620ff8df6042902e01e52cfbb22933abbbb';
const input={chainId:'56',token,side:'buy',amount:'0.005',slippage:'auto',mev:true,gasLevel:'MEDIUM',quick:true,expectedWallet:wallet};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'agent-queue-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const journal=new Journal(dir);await journal.init();const calls=[];
  const s={journal,cfg:{maxBuyBnb:'0.1'},owner:async()=>wallet,quickFlow:{kick(){},start:async input=>{
    calls.push(input);const r={id:crypto.randomUUID(),queueId:input.queueId,wallet,token,createdAt:Date.now(),status:'PENDING',steps:[]};await journal.lock(r.id,r);await journal.save(r);return r;
  }}};
  const q=new TradeQueue(s);q.kick=()=>{};return {q,s,calls,journal};
}
test('queue persists FIFO intents and waits for the current receipt before dispatching next',async t=>{
  const {q,journal,calls}=await fixture(t);const a=await q.enqueue(input),b=await q.enqueue({...input,amount:'0.006'});
  await q.tick();assert.equal(calls.length,1);assert.equal(calls[0].queueId,a.id);await q.tick();assert.equal(calls.length,1);
  const active=await journal.active();await journal.save({...active,status:'FINISHED'});await q.tick();assert.equal(calls.length,2);assert.equal(calls[1].queueId,b.id);
});

test('click time includes admission checks; invalid future click times use host receipt time',async t=>{
  const {q,calls}=await fixture(t),clickedAt=Date.now()-1000;
  await q.enqueue({...input,clickedAt});await q.tick();assert.equal(calls[0].requestedAt,clickedAt);
  const future=await q.enqueue({...input,amount:'0.007',clickedAt:Date.now()+60000});
  assert.equal(future.clickedAt,future.receivedAt);assert.ok(future.createdAt>=future.receivedAt);
});
test('identical clicks and repeated request IDs are deduplicated even after dispatch',async t=>{
  const {q,calls}=await fixture(t),id=crypto.randomUUID();const a=await q.enqueue({...input,requestId:id});assert.equal((await q.enqueue(input)).id,a.id);
  await q.tick();await q.enqueue({...input,requestId:id});await q.tick();assert.equal(calls.length,1);
});
test('cancellation and expiry are persisted without invoking execution',async t=>{
  const {q,calls}=await fixture(t);const a=await q.enqueue(input);await q.cancel({id:a.id});await q.tick();assert.equal(calls.length,0);
  const b=await q.enqueue({...input,amount:'0.006'});await q.change(s=>{s.pending[0].expiresAt=0;});await q.tick();assert.equal(calls.length,0);assert.equal((await q.records()).find(r=>r.id===b.id).status,'EXPIRED');
});
test('wallet switch rejects the queued intent instead of moving it to a new wallet',async t=>{
  const {q,s,calls}=await fixture(t);await q.enqueue(input);s.owner=async()=>token;await q.tick();assert.equal(calls.length,0);assert.equal((await q.records())[0].status,'REJECTED');
});
test('unknown transaction blocks the queue, while expired intents can still be cleared',async t=>{
  const {q,journal,calls}=await fixture(t);const r={id:crypto.randomUUID(),status:'UNKNOWN'};await journal.save(r);await journal.lock(r.id,r);await q.enqueue(input);await q.tick();assert.equal(calls.length,0);assert.equal((await q.list())[0].status,'QUEUED');
});
test('queued orders name the blocking order and step; a finished root releases the queue automatically',async t=>{
  const {q,journal,calls}=await fixture(t);const r={id:crypto.randomUUID(),token,status:'PENDING',steps:[{label:'USDT 兑换支付币'}]};await journal.save(r);await journal.lock(r.id,r);
  await q.enqueue(input);await q.enqueue({...input,amount:'0.006'});await q.tick();
  const rows=await q.list();assert.equal(rows[0].blockedBy.id,r.id);assert.match(rows[0].message,/USDT 兑换支付币/);assert.equal(rows[1].queuePosition,2);assert.equal(calls.length,0);
  await journal.save({...r,status:'FINISHED'});await q.tick();assert.equal(calls.length,1);assert.equal((await q.state()).recent.at(-1).blockedBy,undefined);
});
test('unchanged blocking status does not repeatedly write or publish queue events',async t=>{
  const {q,journal}=await fixture(t);const r={id:crypto.randomUUID(),token,status:'APP_CONFIRM',steps:[{label:'授权'}]};await journal.save(r);await journal.lock(r.id,r);await q.enqueue(input);
  let events=0;journal.onSave=()=>events++;await q.tick();assert.equal(events,1);await q.tick();assert.equal(events,1);assert.match((await q.list())[0].message,/App 审批/);
});
test('restart matches a started queue intent to its persisted execution without resending',async t=>{
  const {q,journal,calls}=await fixture(t),a=await q.enqueue(input);
  await q.change(s=>{s.pending[0].status='QUEUE_STARTING';s.pending[0].startedBy=99999999;});
  await journal.save({id:crypto.randomUUID(),queueId:a.id,createdAt:Date.now(),status:'UNKNOWN'});
  await q.restore();assert.equal((await q.list()).length,0);assert.equal(calls.length,0);
});
test('two helper instances share one dispatcher and only execute once',async t=>{
  const {q,s,calls}=await fixture(t);await q.enqueue(input);const other=new TradeQueue(s);other.kick=()=>{};await Promise.all([q.tick(),other.tick()]);assert.equal(calls.length,1);
});
test('failure after root persistence does not requeue a possibly submitted execution',async t=>{
  const {q,s,calls}=await fixture(t);const original=s.quickFlow.start;s.quickFlow.start=async i=>{await original(i);throw new Error('transport lost');};await q.enqueue(input);await q.tick();assert.equal(calls.length,1);assert.equal((await q.list()).length,0);
});
const buy=(qty,bnb,time=1)=>({wallet,token,side:'buy',createdAt:time,input:{amount:bnb},steps:[{role:'trade',status:'FINISHED',receivedRaw:String(raw(qty)),receive:token,confirmedAt:time}]});
const sell=(qty,proceeds,time=2)=>({wallet,token,side:'sell',createdAt:time,status:'FINISHED',amount:qty,result:{toToken:BNB,toTokenActualQty:proceeds},steps:[{role:'trade',status:'FINISHED',sellAmount:qty,confirmedAt:time}]});
const opts={wallet,token,balance:'100',decimals:18,value:'20',nativePrice:'100'};
test('ledger uses confirmed quantities and weighted cost for a partial sell',()=>{
  const a=positionLedger([buy('100','0.1'),buy('100','0.3',2),sell('100','0.25',3)],opts);
  assert.equal(a.costBnb,'0.2');assert.equal(a.realizedBnb,'0.05');assert.equal(a.unrealizedBnb,'0');
});
test('external holdings and incomplete history never invent a cost basis',()=>{
  assert.equal(positionLedger([],opts).costBnb,null);assert.equal(positionLedger([buy('99','0.1')],opts).costBnb,null);
  assert.equal(positionLedger([{...buy('100','0.1'),steps:[{role:'trade',status:'PENDING',receivedRaw:String(raw('100')),receive:token}]}],opts).costBnb,null);
});
test('sale kept in quote assets or awaiting settlement has no fabricated BNB profit',()=>{
  const sale=sell('50','0.08');sale.result.toToken=token;
  const a=positionLedger([buy('100','0.1'),sale],{...opts,balance:'50'});assert.equal(a.costBnb,'0.05');assert.equal(a.realizedBnb,null);
});
test('recorded gas is included, and a new position after selling all starts fresh',()=>{
  const b=buy('100','0.1');b.steps[0].gasFeeRaw=String(raw('0.001'));
  const a=positionLedger([b,sell('100','0.2'),buy('10','0.03',3)],{...opts,balance:'10'});assert.equal(a.costBnb,'0.03');assert.equal(a.realizedBnb,'0.099');
});
test('preset groups reject excessive amounts and unsafe numeric syntax',async()=>{
  const c={};runInNewContext(await readFile(new URL('../extension/preset-model.js',import.meta.url),'utf8'),c);const model=c.AgentPresets;
  assert.equal(model.defaults().length,3);assert.equal(model.values('0.001,0.005','buy').length,2);
  for(const v of ['1e-3','-1','0','<script>','0.101'])assert.throws(()=>model.values(v,'buy'));
  assert.throws(()=>model.values('101','sell'));assert.throws(()=>model.values('0.001','sell'));
});
