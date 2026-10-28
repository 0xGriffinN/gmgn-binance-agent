import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverMarketOrder} from '../host/recover-market-order.mjs';
const step={createdAt:Date.parse('2026-10-28T07:48:06Z'),fromToken:'0xaaa',toToken:'0xbbb',amount:'0.1'};
const order={orderId:'123',chain:'56',fromToken:'0xAAA',toToken:'0xBBB',fromTokenQty:'0.100000000000000000',bookTime:'2026-10-28T15:48:11+08:00',status:'FAILED'};
test('recover one exact order despite an error response lacking its ID',()=>assert.equal(recoverMarketOrder({total:1,list:[order]},step,18),order));
test('ambiguous, incomplete, unrelated and already-owned orders never resolve unknown submission',()=>{
  for(const data of [{total:2,list:[order]},{list:[order,{...order,orderId:'456'}]},{list:[]},{list:[{...order,chain:'1'}]},{list:[{...order,fromTokenQty:'0.2'}]},{list:[{...order,bookTime:'2026-10-28T15:50:00+08:00'}]},{list:[{...order,bookTime:undefined}]}])assert.equal(recoverMarketOrder(data,step,18),null);
  assert.equal(recoverMarketOrder({list:[order]},step,18,new Set(['123'])),null);
  assert.equal(recoverMarketOrder({list:[{...order,fromTokenQty:'0.1000001'}]},step,6),null);
});
