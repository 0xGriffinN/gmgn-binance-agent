import { decimal,tradeInput,requireThat } from './domain.mjs';
import { raw,fmt,same,ZERO,WBNB,ceil } from './routes/chain.mjs';
import { gangBuy,gangCost } from './routes/gang.mjs';

const min=(a,b)=>a<b?a:b;
export const supplyPct=(tokens,supply)=>fmt(tokens*10000000000n/supply,8);

// Fixed-input quote inversion, bounded by the existing local budget. Never signs.
export async function solveSupplyBudget({target,maxBudget,seed=raw('.01'),quote,iterations=6}){
  requireThat(target>0n&&maxBudget>0n,'SUPPLY_TARGET','筹码目标或可用预算为零');
  let budget=min(seed,maxBudget),under=null,low=0n,high=null;
  for(let i=0;i<iterations;i++){
    const out=await quote(budget);requireThat(out>0n,'NO_QUOTE','未获得有效筹码报价');
    const result={budget,out};
    if(out<=target&&(!under||out>under.out))under=result;
    const diff=out>target?out-target:target-out;
    if(diff*1000n<=target*2n)return result;
    if(out<target)low=budget;else high=budget;
    if(budget===maxBudget&&out<target)return result;
    let next=min(ceil(budget*target,out),maxBudget);
    if(high!==null&&(next<=low||next>=high))next=(low+high)/2n;
    if(next<=0n||next===budget)break;
    budget=next;
  }
  requireThat(under,'SUPPLY_QUOTE','筹码报价未收敛，请使用 BNB 金额下单');
  return under;
}

export class SupplyBuy {
  constructor(service){this.service=service;}
  async plan(input){
    requireThat(input.side==='buy','SUPPLY_SIDE','筹码百分比仅用于买入');
    const requestedPct=decimal(String(input.pctSupply),{maxDecimals:2});
    requireThat(raw(requestedPct,2)<=10000n,'SUPPLY_PERCENT','筹码比例必须大于 0 且不超过 100%');
    const base=tradeInput({...input,amount:'0.000001'}),s=this.service,r=s.router,owner=await s.owner();
    requireThat(!await s.journal.active(),'INFLIGHT','已有待确认交易，请先核对');
    let route=await r.detect(base.token,owner);
    if(route.stage==='inner')await s.developer();
    let info;
    try{info=await r.supplyInfo(route,base.token,owner);}catch(e){
      if(e.code==='CALL_EXCEPTION'||e.code==='BAD_DATA')requireThat(false,'SUPPLY_UNAVAILABLE','无法核实该代币或曲线份额总量，请使用 BNB 金额买入');
      throw e;
    }
    requireThat(info.supply>0n,'SUPPLY_UNAVAILABLE','链上总量为零或尚未发行，请使用 BNB 金额买入');
    route=info.route;
    const meta=await r.tokenMeta(base.token),asked=info.supply*raw(requestedPct,2)/10000n;
    let target=asked;
    if(info.room!==null&&info.room!==undefined){
      requireThat(info.room>0n,'HOLDING_CAP','已达单钱包上限，未下单');
      const exactQuota=info.unit||route.platform==='flap'&&route.kind==='portal';
      target=min(target,exactQuota?info.room:info.room*99n/100n);
    }
    if(info.unit)target=target/info.unit*info.unit;
    requireThat(target>0n,'SUPPLY_TARGET','所选比例不足最小交易份数');
    const native=raw((await s.nativeBalance(owner)).balance),reserve=raw(s.cfg.gasReserveBnb||'.00005');
    requireThat(native>reserve,'INSUFFICIENT_BNB','BNB 不足以保留 Gas');
    let maxBudget=raw(s.cfg.maxBuyBnb||'.1');
    if(info.unit||route.stage==='outer'||same(route.quote,ZERO))maxBudget=min(maxBudget,native-reserve);
    else if(await r.chain.balance(route.quote,owner)===0n)maxBudget=min(maxBudget,native-reserve);
    let solved;
    if(info.unit){
      const wanted=target/info.unit,shares=min(wanted,maxBudget/info.unitCost);
      requireThat(shares>0n,'BUY_LIMIT','单笔上限不足一份筹码');
      solved={budget:shares*info.unitCost,out:shares*info.unit};
    }else if(route.platform==='four'&&route.stage==='inner'){
      // The official helper accepts exact tokenAmount; use its native cost to
      // avoid iterative full helper quotes and cap-clipped quote plateaus.
      const exact=await s.wallet.four('quote-buy',{token:base.token,wallet:owner,tokenAmount:fmt(target,meta.decimals),slippageBps:0});
      const cost=raw(String(exact.estimate?.userPays||'0'));
      requireThat(cost>0n,'NO_QUOTE','Four 未返回有效的筹码支付金额');
      if(cost<=maxBudget)solved={budget:cost,out:raw(exact.estimate.tokenAmount,meta.decimals)};
      else{const built=await r.build(route,{...base,amount:fmt(maxBudget)},owner,fmt(maxBudget));solved={budget:maxBudget,out:raw(built.out,meta.decimals)};}
    }else{
      let seed=min(raw('.01'),maxBudget),quote;
      if(route.platform==='gang'&&route.c){
        const qMeta=await r.chain.meta(route.quote),cost=gangCost(route.c,target);
        if(same(route.quote,WBNB)){seed=min(cost,maxBudget);quote=async budget=>gangBuy(route.c,budget,info.room).tokens;}
        else{
          const fx=await r.fundingQuote(route.quote,fmt(seed),base),pay=raw(fx.required,qMeta.decimals);
          requireThat(pay>0n,'NO_QUOTE','支付币报价为零');seed=min(ceil(seed*cost,pay),maxBudget);
          quote=async budget=>{const f=await r.fundingQuote(route.quote,fmt(budget),base);return gangBuy(route.c,raw(f.required,qMeta.decimals),info.room).tokens;};
        }
      }else quote=async budget=>{const built=await r.build(route,{...base,amount:fmt(budget),approvalCap:false},owner,fmt(budget));return raw(built.out,meta.decimals);};
      solved=await solveSupplyBudget({target,maxBudget,seed,quote});
    }
    const notes=[];
    if(target<asked)notes.push('已按钱包剩余额度或可售数量调整');
    if(solved.out*1000n<target*998n)notes.push('受单笔上限或余额限制，预计数量低于目标');
    return {owner,input:{...base,amount:fmt(solved.budget)},buyTarget:{requestedPct,supply:fmt(info.supply,meta.decimals),targetTokens:fmt(target,meta.decimals),estimatedTokens:fmt(solved.out,meta.decimals),estimatedPct:supplyPct(solved.out,info.supply),budgetBnb:fmt(solved.budget),note:notes.join('；'),symbol:meta.symbol}};
  }
}
