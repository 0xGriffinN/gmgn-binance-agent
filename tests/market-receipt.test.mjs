import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRelayedMarket } from '../host/market-receipt.mjs';
import { ethers,raw } from '../host/routes/chain.mjs';
import { BNB,USDT } from '../host/domain.mjs';
const OWNER='0x'+'1'.repeat(40),Q='0x'+'2'.repeat(40),RELAY='0x'+'3'.repeat(40),HASH='0x'+'a'.repeat(64);
const log=(token,from,to,amount)=>({address:token,topics:[ethers.id('Transfer(address,address,uint256)'),ethers.zeroPadValue(from,32),ethers.zeroPadValue(to,32)],data:ethers.toBeHex(raw(amount))});
function fixture(){const step={kind:'market',orderId:'123',amount:'37.282962681560604912',fromToken:USDT,toToken:Q,txHash:HASH,blockBefore:100};step.result={status:'FINISHED',chain:'56',orderId:'123',txHash:HASH,fromToken:USDT,toToken:Q,fromTokenQty:step.amount};return {row:{wallet:OWNER},step,tx:{from:RELAY,hash:HASH},receipt:{status:1,blockNumber:101,logs:[log(USDT,OWNER,RELAY,step.amount),log(Q,RELAY,OWNER,'1.140597636367665565')]}};}
const verify=f=>verifyRelayedMarket(f.row,f.step,f.tx,f.receipt,18);
test('authenticated completed order plus exact owner debit and actual receipt accepts a relayed swap',()=>{assert.deepEqual(verify(fixture()),{relayed:true,receivedRaw:String(raw('1.140597636367665565'))});});
test('an unrelated incoming transfer cannot establish market order ownership',()=>{const f=fixture();f.receipt.logs.shift();assert.throws(()=>verify(f),{code:'TX_OWNER'});});
test('foreign wallet, wrong amount and missing output fail closed',()=>{for(const edit of [f=>f.row.wallet=RELAY,f=>f.receipt.logs[0].data=ethers.toBeHex(raw('1')),f=>f.receipt.logs.pop()]){const f=fixture();edit(f);assert.throws(()=>verify(f),{code:'TX_OWNER'});}});
test('pending orders and mismatched order ID, chain or hash cannot prove relayer ownership',()=>{for(const edit of [f=>f.step.result.status='PENDING',f=>f.step.result.orderId='456',f=>f.step.result.chain='1',f=>f.tx.hash='0x'+'b'.repeat(64),f=>f.receipt.blockNumber=99]){const f=fixture();edit(f);assert.throws(()=>verify(f),{code:'TX_OWNER'});}});
test('reported input must agree with the submitted amount, without relying on quoted output',()=>{const f=fixture();f.step.result.fromTokenQty='37';assert.throws(()=>verify(f),{code:'ORDER_AMOUNT'});});
test('contract calls and native-asset swaps cannot use the ERC20 relayer exception',()=>{for(const edit of [f=>f.step.kind='contract',f=>{f.step.fromToken=BNB;f.step.result.fromToken=BNB;}]){const f=fixture();edit(f);assert.throws(()=>verify(f),{code:'TX_OWNER'});}});
test('partial input requires the exact authenticated actual output and records the unspent input',()=>{
  const f=fixture();f.receipt.logs[0].data=ethers.toBeHex(raw('37'));f.step.result.toTokenActualQty='1.140597636367665565';
  const proof=verifyRelayedMarket(f.row,f.step,f.tx,f.receipt,18,18);assert.equal(proof.spentRaw,String(raw('37')));assert.equal(proof.inputRemainderRaw,String(raw('0.282962681560604912')));
  f.step.result.toTokenActualQty='1.2';assert.throws(()=>verifyRelayedMarket(f.row,f.step,f.tx,f.receipt,18,18),{code:'TX_OWNER'});
});
test('partial input cannot exceed the authorized request or be zero, even if output matches',()=>{
  for(const amount of ['0','38']){const f=fixture();f.receipt.logs[0].data=ethers.toBeHex(raw(amount));f.step.result.toTokenActualQty='1.140597636367665565';assert.throws(()=>verifyRelayedMarket(f.row,f.step,f.tx,f.receipt,18,18),{code:'TX_OWNER'});}
});
