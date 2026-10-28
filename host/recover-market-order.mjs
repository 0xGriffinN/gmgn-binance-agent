import {raw,same} from './routes/chain.mjs';
// Never infer failure from an empty search. Require one exact wallet-history
// candidate, bounded to the original submission, and never reuse another step's ID.
export function recoverMarketOrder(data,step,decimals,usedIds=new Set()){
  if(!Array.isArray(data?.list)||!Number.isSafeInteger(step.createdAt)||Number(data.total)>data.list.length)return null;
  const matches=data.list.filter(o=>{
    if(!o.orderId||String(o.chain)!=='56'||!same(o.fromToken,step.fromToken)||!same(o.toToken,step.toToken))return false;
    const time=Date.parse(o.bookTime);if(!Number.isFinite(time)||time<step.createdAt-2000||time>step.createdAt+30000)return false;
    const exact=v=>typeof v==='string'&&/^\d+(\.\d+)?$/.test(v)&&!/[1-9]/.test((v.split('.')[1]||'').slice(decimals));
    try{return exact(o.fromTokenQty)&&exact(step.amount)&&raw(o.fromTokenQty,decimals)===raw(step.amount,decimals);}catch{return false;}
  });
  return matches.length===1&&!usedIds.has(String(matches[0].orderId))?matches[0]:null;
}
