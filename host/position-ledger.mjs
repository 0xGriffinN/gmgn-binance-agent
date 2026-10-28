import { BNB } from './domain.mjs';
import { raw,fmt,same } from './routes/chain.mjs';
// Quantities come from verified receipts, never from quoted output. BNB cost
// is a budget-equivalent estimate for routes funded with existing quote assets.
export function positionLedger(records,{wallet,token,decimals=18,balance='0',value,nativePrice}={}){
  let qty=0n,cost=0n,realized=0n,known=true,realizedKnown=true,seen=false;
  const rows=records.filter(r=>same(r.wallet,wallet)&&same(r.token,token)&&!r.queued)
    .sort((a,b)=>(a.steps?.find(s=>s.role==='trade')?.confirmedAt||a.createdAt)-(b.steps?.find(s=>s.role==='trade')?.confirmedAt||b.createdAt));
  for(const row of rows){
    const trade=row.steps?.find(s=>s.role==='trade'&&s.status==='FINISHED');if(!trade)continue;
    seen=true;
    const gas=(row.steps||[]).reduce((v,s)=>v+BigInt(s.gasFeeRaw||0),0n);
    if(row.side==='buy'){
      const received=BigInt(trade.receivedRaw||0);
      if(received<=0n||!same(trade.receive||trade.toToken,token)){known=false;continue;}
      qty+=received;cost+=raw(trade.costBnbEstimate||row.input?.amount||row.amount)+gas;
    }else{
      let sold;try{if(trade.route?.kind==='fair'&&!trade.sellAmount)throw new Error('unknown shares');sold=raw(trade.sellAmount||row.amount,decimals);}catch{known=false;realizedKnown=false;continue;}
      if(sold<=0n||sold>qty){known=false;realizedKnown=false;qty=sold>=qty?0n:qty-sold;continue;}
      const basis=cost*sold/qty;cost-=basis;qty-=sold;
      const result=row.result;
      if(known&&['FINISHED','PARTIAL'].includes(row.status)&&same(result?.toToken,BNB)&&result.toTokenActualQty!=null){realized+=raw(result.toTokenActualQty)-basis-gas;}
      else realizedKnown=false;
      if(qty===0n){cost=0n;known=true;}
    }
  }
  const actual=raw(balance,decimals),matches=actual===qty;
  const usable=known&&matches;
  const mark=Number(value),price=Number(nativePrice);
  const unrealized=usable&&Number.isFinite(mark)&&mark>=0&&price>0?mark/price-Number(fmt(cost)):actual===0n&&usable?0:null;
  return {estimated:true,costBnb:usable?fmt(cost):null,averageBnb:usable&&qty>0n?String(Number(fmt(cost))/Number(fmt(qty,decimals))):null,
    realizedBnb:realizedKnown&&seen?fmt(realized):null,unrealizedBnb:unrealized==null?null:String(unrealized),
    reason:!seen&&actual>0n?'持仓来源未核实':!matches?'持仓与本地记录不一致':!known?'成交数量或成本记录不完整':'暂无持仓',
    note:'仅统计本面板已核实成交；买入成本按 BNB 预算等值估算，可能包含未用完预算。已记录 Gas 计入成本，旧订单可能缺少 Gas；保留支付币的卖出不折算为已实现 BNB 盈亏。'};
}
