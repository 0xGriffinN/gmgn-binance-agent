import test from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../host/routes/router.mjs';
import { ReadCache } from '../host/read-cache.mjs';
import { raw,fmt,ERC,contractStep } from '../host/routes/chain.mjs';
import { BNB,USDT } from '../host/domain.mjs';
const Q='0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f',TOKEN='0xaf21e620ff8df6042902e01e52cfbb22933abbbb',OWNER='0x1234567890123456789012345678901234567890';
const input={chainId:'56',token:TOKEN,side:'buy',amount:'0.005',slippage:'auto',approvalCap:true};

test('existing quote balance is consumed first and only the BNB shortfall is exchanged',async()=>{
  const quoted=[];let held=raw('0.4');
  const wallet={cli:async a=>{const amount=a[a.indexOf('--fromTokenQty')+1];quoted.push(amount);return {toCoinAmount:fmt(raw(amount)*130n),slippage:.01};}};
  const router=new Router(wallet,{}, {meta:async()=>({symbol:'BNCB',decimals:18}),balance:async()=>held});
  const plan=await router.funding(Q,'0.005',OWNER,input);
  assert.equal(plan.step.existingContribution,String(held));assert.ok(raw(plan.step.amount)<raw('0.005'));
  assert.equal(plan.amount,held+raw(plan.step.quote.toCoinAmount));assert.ok(plan.amount>=raw('0.65'));
  const firstCalls=quoted.length;held=raw('1');
  const ready=await router.funding(Q,'0.005',OWNER,input);assert.equal(ready.step,null);assert.equal(quoted.length,firstCalls);
});

test('Ondo shortfall keeps existing quote contribution across the USDT intermediate step',async()=>{
  const quoted=[];
  const wallet={cli:async a=>{const from=a[a.indexOf('--fromToken')+1],to=a[a.indexOf('--toToken')+1],amount=a[a.indexOf('--fromTokenQty')+1];quoted.push({from,to,amount});
    if(from===BNB&&to===Q)throw new Error('Unsupported token pair for Ondo');
    return {toCoinAmount:fmt(raw(amount)*(from===BNB?1000n:2n)),slippage:.01};}};
  const chain={meta:async()=>({symbol:'QUOTE',decimals:18}),balance:async t=>t.toLowerCase()===USDT.toLowerCase()?raw('3'):raw('.2')};
  const router=new Router(wallet,{},chain),first=await router.funding(Q,'0.005',OWNER,input);
  assert.equal(first.step.toToken,USDT);assert.equal(first.step.fundingPlan.existing,String(raw('.2')));assert.ok(raw(first.step.amount)<raw('.005'));
  const before=quoted.length;
  const next=await router.funding(Q,'0.005',OWNER,{...input,_funded:{[USDT.toLowerCase()]:String(raw('3'))},_fundingPlans:{[Q.toLowerCase()]:first.step.fundingPlan}});
  assert.equal(next.step.fromToken,USDT);assert.equal(next.step.amount,'3.0');assert.equal(next.amount,raw('6.2'));assert.equal(next.step.existingContribution,String(raw('.2')));
  assert.equal(quoted.length,before+1);assert.equal(quoted.at(-1).from,USDT);
});

test('bounded reusable approval covers about twice the buy limit; exact mode and sell-all mode remain selectable',async()=>{
  const chain={balance:async()=>raw('100'),allowance:async(t,_o,s,n)=>contractStep('approve',t,ERC,'approve',[s,n],0n,'approval')};
  const router=new Router({}, {maxBuyBnb:'0.1'},chain);
  const reusable=await router.approval(Q,OWNER,TOKEN,raw('.65'),input);
  assert.equal(ERC.decodeFunctionData('approve',reusable.inputData)[1],raw('26'));
  const exact=await router.approval(Q,OWNER,TOKEN,raw('.65'),{...input,approvalCap:false});
  assert.equal(ERC.decodeFunctionData('approve',exact.inputData)[1],raw('.65'));
  const sell=await router.approval(TOKEN,OWNER,Q,raw('25'),{...input,side:'sell'},'sell');
  assert.equal(ERC.decodeFunctionData('approve',sell.inputData)[1],raw('101'));
});

test('graduated buy spends already-funded quote assets instead of creating another BNB conversion',async()=>{
  let args;
  const router=new Router({cli:async a=>{args=a;return {toCoinAmount:'100',slippage:.01};}}, {}, {meta:async()=>({symbol:'TOKEN',decimals:18})});
  const built=await router.outer({platform:'gang',stage:'outer',quote:Q},{...input,_funded:{[Q.toLowerCase()]:String(raw('.65'))}},OWNER,'0.005');
  assert.equal(args[args.indexOf('--fromToken')+1],Q.toLowerCase());assert.equal(built.step.amount,'0.65');assert.equal(built.step.toToken,TOKEN);
});

test('read cache coalesces concurrent reads and force refresh does not reuse stored values',async()=>{
  const cache=new ReadCache();let calls=0;
  const read=async()=>++calls;
  assert.deepEqual(await Promise.all([cache.get('x',5000,read),cache.get('x',5000,read)]),[1,1]);
  assert.equal(await cache.get('x',5000,read),1);assert.equal(await cache.get('x',5000,read,{force:true}),2);
});

test('route prewarming coalesces detection while explicit submit rechecks remain fresh',async()=>{
  const router=new Router({}, {}, {});let calls=0;router.identify=async()=>({stage:++calls===1?'inner':'outer'});
  const first=await Promise.all([router.detect(TOKEN,OWNER),router.detect(TOKEN,OWNER)]);assert.equal(calls,1);assert.equal(first[1].stage,'inner');
  assert.equal((await router.detect(TOKEN,OWNER,{force:true})).stage,'outer');assert.equal(calls,2);
});

test('retaining quote assets applies to both Four official helper and aggregate outer sells',async()=>{
  let fourParams,aggregate;
  const router=new Router({four:async(_command,p)=>{fourParams=p;return {tx:{to:TOKEN,inputData:'0x12345678',value:'0'},estimate:{userReceives:'.65'},simulation:{ok:true}};},cli:async a=>{aggregate=a;return {toCoinAmount:'.65',slippage:.01};}}, {},{meta:async()=>({symbol:'TOKEN',decimals:18})});
  const sell={...input,side:'sell',percent:'25',sellToBnb:false};
  const four=await router.build({platform:'four',kind:'agent',stage:'inner',quote:Q},sell,OWNER,'25');assert.equal(fourParams.receive,'QUOTE');assert.equal(four.receive,Q);
  const dex=await router.outer({platform:'gang',stage:'outer',quote:Q},sell,OWNER,'25');assert.equal(aggregate[aggregate.indexOf('--toToken')+1],Q);assert.equal(dex.receive,Q);
});
