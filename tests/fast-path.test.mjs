import test from 'node:test';
import assert from 'node:assert/strict';
import { Chain,ERC,raw,fmt } from '../host/routes/chain.mjs';
import { rpcPools } from '../host/routes/rpc-pools.mjs';
import { Router } from '../host/routes/router.mjs';
import { RoutedService } from '../host/routed-service.mjs';
import { Gang } from '../host/routes/gang.mjs';
const TOKEN='0xaf21e620ff8df6042902e01e52cfbb22933abbbb',OWNER='0x1234567890123456789012345678901234567890',Q='0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f';
function chain(t,cfg={}){const c=new Chain(cfg);t.after(()=>c.providers.forEach(p=>p.destroy?.()));return c;}

test('403 nodes remain excluded even when every other node is cooling',async t=>{
  const c=chain(t,{rpcPurpose:'trade'});c.providers.forEach(p=>p.destroy());let denied=0;
  c.providers=[{send:async()=>56,call:async()=>{denied++;throw new Error('403 Forbidden');}},{send:async()=>56,call:async()=>42}];
  assert.equal(await c.run(p=>p.call()),42);c.cooldowns.set(1,Date.now()+20000);
  assert.equal(await c.run(p=>p.call()),42);assert.equal(denied,1);
  c.penalize(1,new Error('403 Forbidden'));await assert.rejects(c.confirmation('hash'),{code:'RPC_UNAVAILABLE'});
  c.bans.set(0,Date.now()-1);assert.deepEqual(c.available(),[0]);
});

test('funding prewarm starts while fresh platform detection is still pending',async()=>{
  const s=new RoutedService({}, {dir:'unused-test'}, {},{});let release,called=0;
  const route={quote:Q};s.warmInput={token:TOKEN,amount:'.01',slippage:'50'};s.warmRoute={token:TOKEN,route};
  s.router={reads:{values:new Map()}};s.viewRouter={detect:()=>new Promise(r=>{release=r;}),fundingQuote:async()=>{called++;},tokenMeta:async()=>({})};s.wallet={audit:async()=>({})};
  const work=s.prewarmContext(OWNER);assert.equal(called,1);release(route);await work;assert.equal(s.warmJob,false);
});

test('confirmation uses the fast verified node without waiting for a slow primary',async t=>{
  const c=chain(t,{rpcPurpose:'trade'});c.providers.forEach(p=>p.destroy());
  const hash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64),receipt={hash,blockHash,blockNumber:12,status:1},tx={hash,blockHash,blockNumber:12};
  let release;const slow=new Promise(resolve=>{release=resolve;});
  c.providers=[{send:async()=>56,getTransactionReceipt:()=>slow,getTransaction:async()=>tx},{send:async()=>56,getTransactionReceipt:async()=>receipt,getTransaction:async()=>tx}];
  try{assert.deepEqual(await c.confirmation(hash),[receipt,tx]);assert.equal(c.verified.size,2);}finally{release(null);}
});

test('a fast null receipt cannot mask a mined receipt from the other node',async t=>{
  const c=chain(t,{rpcPurpose:'trade'});c.providers.forEach(p=>p.destroy());
  const hash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64),receipt={hash,blockHash,blockNumber:12},tx={hash,blockHash,blockNumber:12};
  c.providers=[{send:async()=>56,getTransactionReceipt:async()=>null,getTransaction:async()=>null},{send:async()=>56,getTransactionReceipt:async()=>receipt,getTransaction:async()=>tx}];
  assert.deepEqual(await c.confirmation(hash),[receipt,tx]);
  c.providers[1].getTransactionReceipt=async()=>null;assert.deepEqual(await c.confirmation(hash),[null,null]);
});

test('confirmation rejects mismatched hashes, blocks and wrong-chain providers',async t=>{
  const c=chain(t,{rpcPurpose:'trade'});c.providers.forEach(p=>p.destroy());
  const hash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64);
  const receipt={hash,blockHash,blockNumber:12},tx={hash,blockHash,blockNumber:12};
  c.providers=[{send:async()=>56,getTransactionReceipt:async()=>receipt,getTransaction:async()=>tx}];
  for(const bad of [{hash:'other'},{blockHash:'other'},{blockNumber:13}]){
    c.providers[0].getTransaction=async()=>({...tx,...bad});await assert.rejects(c.confirmation(hash),{code:'TX_MISMATCH'});
  }
  c.verified.clear();c.providers[0].send=async()=>1;await assert.rejects(c.confirmation(hash),{code:'WRONG_CHAIN'});
});

test('nested supply preparation shares reads, while a later submit scope stays fresh',async t=>{
  const c=chain(t);let calls=0;c.run=async()=>{calls++;return ERC.encodeFunctionResult('balanceOf',[100n]);};
  await c.withReadScope(async()=>{await c.balance(TOKEN,OWNER);await c.withReadScope(()=>c.balance(TOKEN,OWNER));});
  assert.equal(calls,1);await c.balance(TOKEN,OWNER);assert.equal(calls,2);
});
test('trade RPC configuration uses its own pool without putting dedicated URLs into reads',()=>{
  const p=rpcPools({rpcUrls:['https://read.example'],tradeRpcUrls:['https://trade.example']},{});
  assert.deepEqual(p.read,['https://read.example']);assert.equal(p.trade[0],'https://trade.example');assert.ok(!p.read.some(u=>p.trade.includes(u)));
  assert.equal(rpcPools({rpcUrls:['https://paid.example']},{}).trade[0],'https://paid.example');
  assert.equal(rpcPools({tradeRpcUrls:['https://config.example']},{TRADE_RPC_URL:'https://env.example'}).trade[0],'https://env.example');
  assert.throws(()=>rpcPools({tradeRpcUrls:['file:///tmp/key']},{}));
});
test('default service separates foreground trade reads from background RPC jobs',t=>{
  const s=new RoutedService({}, {dir:'unused-test'}, {});t.after(()=>[s.router,s.viewRouter].forEach(r=>r.chain.providers.forEach(p=>p.destroy())));
  assert.notEqual(s.router.chain,s.viewRouter.chain);assert.equal(s.router.chain.trade,true);assert.equal(s.viewRouter.chain.trade,false);
  assert.equal(s.router.fundingReads,s.viewRouter.fundingReads);assert.notEqual(s.router.reads,s.viewRouter.reads);
});
test('one preparation shares identical reads, but the next step and submit read fresh',async t=>{
  const c=chain(t);let calls=0;c.run=async fn=>fn({call:async()=>{calls++;return ERC.encodeFunctionResult('balanceOf',[100n]);}});
  await c.withReadScope(async()=>{await Promise.all([c.balance(TOKEN,OWNER),c.balance(TOKEN,OWNER)]);await c.balance(TOKEN,OWNER);});assert.equal(calls,1);
  await c.withReadScope(()=>c.balance(TOKEN,OWNER));assert.equal(calls,2);await c.balance(TOKEN,OWNER);assert.equal(calls,3);
});
test('failed scoped reads can be retried and sender/block changes are never coalesced',async t=>{
  const c=chain(t);let calls=0;c.run=async()=>{calls++;if(calls===1)throw new Error('temporary');return ERC.encodeFunctionResult('balanceOf',[1n]);};
  await c.withReadScope(async()=>{await assert.rejects(c.balance(TOKEN,OWNER));await c.balance(TOKEN,OWNER);await c.balanceAt(TOKEN,OWNER,100);await c.balanceAt(TOKEN,OWNER,101);});assert.equal(calls,4);
});
test('trade RPC fails over on rate limiting and skips a cooling node next time',async t=>{
  const c=chain(t,{rpcPurpose:'trade'});c.providers.forEach(p=>p.destroy());let bad=0,good=0;
  c.providers=[{send:async()=>56,call:async()=>{bad++;throw new Error('429 rate limit');}},{send:async()=>56,call:async()=>{good++;return 'ok';}}];
  assert.equal(await c.run(p=>p.call()),'ok');assert.equal(await c.run(p=>p.call()),'ok');assert.equal(bad,1);assert.equal(good,2);
});
test('parallel cold reads share a single network identity check per endpoint',async t=>{
  const c=chain(t);c.providers.forEach(p=>p.destroy());let checks=0;
  c.providers=[{send:async()=>{checks++;return 56;}}];
  await Promise.all([c.run(()=>1),c.run(()=>2),c.run(()=>3)]);assert.equal(checks,1);
});
test('contract revert and wrong chain never retry as a transient RPC failure',async t=>{
  const c=chain(t,{rpcPurpose:'trade'});c.providers.forEach(p=>p.destroy());let next=0;
  c.providers=[{send:async()=>56,call:async()=>{throw Object.assign(new Error('revert'),{code:'CALL_EXCEPTION'});}},{send:async()=>{next++;return 56;}}];
  await assert.rejects(c.run(p=>p.call()),{code:'CALL_EXCEPTION'});assert.equal(next,0);
  c.verified.clear();c.providers[0].send=async()=>1;await assert.rejects(c.run(()=>1),{code:'WRONG_CHAIN'});assert.equal(next,0);
});
test('trade reads retry one bounded round after every node is transiently unavailable',async t=>{
  const c=chain(t,{rpcPurpose:'trade'});c.providers.forEach(p=>p.destroy());let count=0;
  c.providers=[{send:async()=>56,call:async()=>{if(++count===1)throw new Error('429');return 'recovered';}}];
  assert.equal(await c.run(p=>p.call()),'recovered');assert.equal(count,2);
});
test('funding estimate is reused within 30 seconds and expires beyond that boundary',async()=>{
  let calls=0;const wallet={cli:async()=>{calls++;return {toCoinAmount:'0.26',slippage:.5};}};
  const router=new Router(wallet,{}, {meta:async()=>({symbol:'BNCB',decimals:18}),balance:async()=>0n});
  const i={slippage:'50'},p=await router.funding(Q,'0.002',OWNER,i);assert.equal(calls,1);assert.equal(p.step.role,'funding');assert.equal(p.step.amount,'0.002');
  const hit=[...router.fundingReads.values.values()][0];hit.value.quotedAt=Date.now()-3000;
  await router.funding(Q,'0.002',OWNER,i);assert.equal(calls,1);
  hit.at=Date.now()-31000;hit.value.quotedAt=hit.at;
  await router.funding(Q,'0.002',OWNER,i);assert.equal(calls,2);
});

test('changing budget uses cached integer rate without waiting for background quote; confirmed funding wins',async()=>{
  let calls=0,release;const gate=new Promise(r=>release=r);
  const router=new Router({cli:async()=>{if(++calls>1)await gate;return {toCoinAmount:'.26',slippage:.5};}}, {}, {meta:async()=>({decimals:18}),balance:async()=>0n});
  await router.funding(Q,'.002',OWNER,{slippage:'50'});
  const next=await router.funding(Q,'.001',OWNER,{slippage:'50'});
  assert.equal(next.step.amount,'.001');assert.equal(next.amount,raw('.13'));assert.equal(next.step.quote.toCoinAmount,'0.13');
  release();await Promise.all(router.fundingReads.jobs.values());
  router.chain.balance=async()=>raw('.12');
  const actual=await router.funding(Q,'.001',OWNER,{slippage:'50',_funded:{[Q.toLowerCase()]:String(raw('.12'))}});
  assert.equal(actual.amount,raw('.12'));assert.equal(actual.step,null);
});

test('background estimate refresh failure preserves usable estimate but expired estimate fails closed',async()=>{
  let fail=false;const router=new Router({cli:async()=>{if(fail)throw new Error('offline');return {toCoinAmount:'.26',slippage:.5};}}, {}, {meta:async()=>({decimals:18}),balance:async()=>0n});
  await router.funding(Q,'.002',OWNER,{slippage:'50'});fail=true;
  const hit=[...router.fundingReads.values.values()][0];hit.at=hit.value.quotedAt=Date.now()-10000;
  assert.equal((await router.funding(Q,'.002',OWNER,{slippage:'50'})).amount,raw('.26'));
  await Promise.allSettled(router.fundingReads.jobs.values());hit.at=hit.value.quotedAt=Date.now()-31000;
  await assert.rejects(router.funding(Q,'.002',OWNER,{slippage:'50'}),/offline/);
});
test('funding shortfall and a changed slippage always obtain their own exact quote',async()=>{
  const amounts=[];const router=new Router({cli:async a=>{amounts.push(a[a.indexOf('--fromTokenQty')+1]);return {toCoinAmount:fmt(raw(amounts.at(-1))*130n),slippage:.5};}}, {}, {meta:async()=>({decimals:18}),balance:async()=>raw('.13')});
  await router.funding(Q,'0.002',OWNER,{slippage:'50'});assert.equal(amounts.length,2);assert.equal(raw(amounts[1]),raw('.001'));
  await router.funding(Q,'0.002',OWNER,{slippage:'5'});assert.equal(amounts.length,4);
});
test('Gang curve, funding and room reads start concurrently before building the step',async()=>{
  const started=new Set();let release;const gate=new Promise(r=>release=r),start=async name=>{started.add(name);await gate;};
  const chain={meta:async t=>({symbol:t===Q?'BNCB':'MEME',decimals:18}),call:async()=>{await start('room');return [raw('1000000')];}};
  const gang=new Gang(chain);gang.check=async()=>{await start('curve');return {platform:'gang',kind:'v2',stage:'inner',pad:OWNER,quote:Q,c:{virtualQuote:raw('1'),realQuote:0n,sold:0n,gradAmt:raw('100')}};};
  const engine={tokenMeta:chain.meta,funding:async()=>{await start('funding');return {amount:raw('.26'),step:{kind:'market',role:'funding'}};},approval:async()=>null};
  const pending=gang.build({platform:'gang',kind:'v2',stage:'inner',pad:OWNER,quote:Q},{token:TOKEN,side:'buy',amount:'0.002',slippage:'50'},OWNER,'0.002',engine);
  await new Promise(r=>setImmediate(r));assert.deepEqual([...started].sort(),['curve','funding','room']);release();
  assert.equal((await pending).step.role,'funding');
});
test('receipt position uses a specific confirmed block and never expected token amounts',async()=>{
  let at,emitted;const router={chain:{balanceAt:async(_t,_w,b)=>{at=b;return raw('127.5');}},tokenMeta:async()=>({symbol:'MEME',decimals:18})};
  const s=new RoutedService({}, {dir:'unused-test',onPosition:p=>emitted=p},{},router);
  await s.publishPosition({wallet:OWNER,token:TOKEN},{role:'trade',status:'FINISHED',txHash:'0x123',confirmedAt:20},{blockNumber:100,status:1});
  assert.equal(at,100);assert.equal(emitted.balance,'127.5');assert.equal(emitted.source,'receipt-block');
  emitted=null;await s.publishPosition({wallet:OWNER,token:TOKEN},{role:'approval'},{blockNumber:100});assert.equal(emitted,null);
});
test('snapshot replaces delayed wallet zero with verified chain holdings and recomputes value',async()=>{
  const router={detect:async()=>({platform:'gang',kind:'v2',stage:'inner'}),tokenMeta:async()=>({symbol:'MEME',decimals:18}),chain:{holding:async()=>({balanceRaw:String(raw('127.5')),blockNumber:101})}};
  const wallet={audit:async()=>({}),cli:async a=>{
    if(a[1]==='status')return {status:'CONNECTED'};
    if(a[1]==='address')return {addresses:[{binanceChainId:'56',address:OWNER}]};
    if(a[1]==='settings')return {};
    if(a[1]==='balance')return [{binanceChainId:'56',address:a[a.indexOf('--tokenAddress')+1],balance:'0',price:'.02',value:'0'}];
    throw new Error('unexpected write');
  }};
  const s=new RoutedService(wallet,{dir:'unused-test',list:async()=>[]},{},router),snapshot=await s.snapshot({token:TOKEN});
  assert.equal(snapshot.holding.balance,'127.5');assert.equal(snapshot.holding.source,'chain');assert.equal(snapshot.holding.blockNumber,101);assert.equal(snapshot.holding.value,'2.5500000000000003');
});
