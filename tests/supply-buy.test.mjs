import test from 'node:test';
import assert from 'node:assert/strict';
import { SupplyBuy,solveSupplyBudget } from '../host/supply-buy.mjs';
import { raw,fmt,WBNB,ZERO,ethers } from '../host/routes/chain.mjs';
import { gangBuy,gangCost } from '../host/routes/gang.mjs';
import { Router } from '../host/routes/router.mjs';
const TOKEN='0xaf21e620ff8df6042902e01e52cfbb22933abbbb',OWNER='0x1234567890123456789012345678901234567890';
const input={chainId:'56',token:TOKEN,side:'buy',amount:'.003',pctSupply:'1',slippage:'auto',mev:true,gasLevel:'MEDIUM'};

function fixture({room=raw('10000000'),supply=raw('1000000000'),limit='.1',native='1',route={platform:'gang',kind:'v2',stage:'inner',quote:WBNB},unit,unitCost}={}){
  const calls=[];
  const service={cfg:{maxBuyBnb:limit},owner:async()=>OWNER,journal:{active:async()=>null},developer:async()=>{},nativeBalance:async()=>({balance:native}),router:{
    chain:{balance:async()=>0n},detect:async()=>route,supplyInfo:async()=>({supply,room,route,unit,unitCost}),tokenMeta:async()=>({decimals:18,symbol:'TEST'}),build:async(_r,i)=>{calls.push(i.amount);return {out:fmt(raw(i.amount)*100000000n)};}
  }};
  return {service,calls,planner:new SupplyBuy(service)};
}

test('buy 1% means token supply, with remaining wallet room and existing budget respected',async()=>{
  const {planner,calls}=fixture({room:raw('2000000')});const plan=await planner.plan(input);
  assert.equal(plan.buyTarget.targetTokens,'1980000.0');assert.equal(plan.input.amount,'0.0198');assert.equal(plan.buyTarget.requestedPct,'1');assert.match(plan.buyTarget.note,/剩余额度/);assert.ok(calls.length<=6);
});

test('supply, metadata, balance and developer checks start together and failure prevents quoting',async()=>{
  const {service,planner,calls}=fixture();const started=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  for(const [object,key] of [[service.router,'supplyInfo'],[service.router,'tokenMeta'],[service,'nativeBalance'],[service,'developer']]){
    const original=object[key];object[key]=async(...args)=>{started.push(key);await gate;if(key==='developer')throw new Error('developer disabled');return original(...args);};
  }
  const planned=planner.plan(input);const failure=assert.rejects(planned,/developer disabled/);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started.sort(),['developer','nativeBalance','supplyInfo','tokenMeta']);release();await failure;assert.equal(calls.length,0);
});

test('requested chips above the local buy limit become a smaller disclosed purchase, never a higher limit',async()=>{
  const {planner}=fixture({room:null,limit:'.003'});const plan=await planner.plan(input);
  assert.equal(plan.input.amount,'0.003');assert.equal(plan.buyTarget.estimatedPct,'0.03');assert.match(plan.buyTarget.note,/单笔上限/);
});

test('no remaining room or unverified zero supply stops before quoting or submitting',async()=>{
  const capped=fixture({room:0n});await assert.rejects(capped.planner.plan(input),/单钱包上限/);assert.equal(capped.calls.length,0);
  const missing=fixture({supply:0n});await assert.rejects(missing.planner.plan(input),/总量为零/);assert.equal(missing.calls.length,0);
});

test('chip inputs reject sell requests and malformed or out-of-range percentages',async()=>{
  const {planner}=fixture();
  for(const pctSupply of ['0','101','1;exec','1e2'])await assert.rejects(planner.plan({...input,pctSupply}));
  await assert.rejects(planner.plan({...input,side:'sell'}),/仅用于买入/);
});

test('Gang inverse curve cost returns the requested chips with only rounding error',()=>{
  const c={realQuote:'0',gradAmt:String(raw('2025')),virtualQuote:String(raw('675')),sold:'0'},target=raw('9900000');
  const cost=gangCost(c,target),result=gangBuy(c,cost,raw('10000000'));
  assert.ok(result.tokens>=target);assert.ok(result.tokens-target<1000000000n);
});

test('nonlinear budget solver stays bounded and never returns an unquoted budget',async()=>{
  const quoted=[];const quote=async budget=>{quoted.push(budget);return budget*1000n/(1000n+budget);};
  const result=await solveSupplyBudget({target:100n,maxBudget:1000n,seed:10n,quote});
  assert.ok(quoted.includes(result.budget));assert.ok(result.out<=100n);assert.ok(result.out>=99n);assert.ok(quoted.length<=6);
});

test('fixed-price Gang fair launch rounds to whole shares within room and budget',async()=>{
  const {planner}=fixture({route:{platform:'gang',kind:'fair',stage:'inner',quote:WBNB},unit:raw('100000'),unitCost:raw('.001'),supply:raw('1000000000'),room:raw('10000000'),limit:'.05'});
  const plan=await planner.plan(input);assert.equal(plan.input.amount,'0.05');assert.equal(plan.buyTarget.estimatedTokens,'5000000.0');
});

test('Four cap is 1% of official maxSupply minus this wallet holdings; Flap uses chain quota',async()=>{
  const router=new Router({}, {},{balance:async()=>raw('3000000'),supply:async()=>raw('1000000000'),meta:async()=>({symbol:'TEST',decimals:18}),call:async()=>({remaining:raw('15000000')})});
  const four=await router.supplyInfo({platform:'four',stage:'inner',info:{curve:{maxSupply:'1000000000'}}},TOKEN,OWNER);assert.equal(four.room,raw('7000000'));
  const flap=await router.supplyInfo({platform:'flap',kind:'portal',stage:'inner',quote:ZERO},TOKEN,OWNER);assert.equal(flap.room,raw('15000000'));
  router.chain.call=async()=>({remaining:ethers.MaxUint256});assert.equal((await router.supplyInfo({platform:'flap',kind:'portal',stage:'inner'},TOKEN,OWNER)).room,null);
});

test('Four uses one official exact-token quote instead of iterative capped-budget quotes',async()=>{
  const {planner,service,calls}=fixture({route:{platform:'four',kind:'agent',stage:'inner',quote:WBNB}});let exact=0;
  service.wallet={four:async(command,p)=>{exact++;assert.equal(command,'quote-buy');assert.equal(p.tokenAmount,'9900000.0');assert.equal(p.amount,undefined);return {estimate:{userPays:'0.02',tokenAmount:'9900000'}};}};
  const plan=await planner.plan(input);assert.equal(plan.input.amount,'0.02');assert.equal(exact,1);assert.equal(calls.length,0);
});

test('Flap finite quota may be filled directly while its shortcut still respects the local budget',async()=>{
  const {planner}=fixture({route:{platform:'flap',kind:'portal',stage:'inner',quote:ZERO},room:raw('1000000')});
  const plan=await planner.plan({...input,pctSupply:'2'});assert.equal(plan.buyTarget.targetTokens,'1000000.0');assert.match(plan.buyTarget.note,/剩余额度/);assert.ok(raw(plan.input.amount)<=raw('.1'));
});
