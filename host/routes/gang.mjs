import { ethers,ZERO,WBNB,same,raw,fmt,percent,minimum,ceil,contractStep,ERC } from './chain.mjs';
import { requireThat } from '../domain.mjs';
import { firstVerified } from '../read-cache.mjs';
// ABIs and fixed mainnet deployments adapted from TMTN dd777dd (MIT).
export const PADS=['0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E','0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb','0x60aee38576035E757deD30fF8db8A8DA476430C1'];
export const OLD='0x315Ba2e8952D06094CC636b2B84229FA32fb23A7';
export const FAIR='0x15cfd2dc8278fb87a1783ef42111618e20874365', FAIR_ROUTER='0xe040445690aa56c8b68b7f7038c7b2562b5079c4';
export const V2=new ethers.Interface(['function curves(address) view returns(address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,bool taxed,address pair,address refPair)','function walletRoom(address,address) view returns(uint256)','function buy(address,uint256,uint256) returns(uint256)','function sell(address,uint256,uint256) returns(uint256)']);
const V3=new ethers.Interface(['function curves(address) view returns(address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,uint16 buyTaxBps,uint16 sellTaxBps,uint16 dividendBps,address pair,address refPair)']);
const LEGACY=new ethers.Interface(['function quoteBuy(address,address,uint256) view returns(uint256 tokensOut,uint256 bnbIn,uint256 fee,uint256 refund)','function quoteSell(address,uint256) view returns(uint256 out,uint256 fee)','function walletRoom(address,address) view returns(uint256)','function buy(address,uint256) payable returns(uint256)','function sell(address,uint256,uint256) returns(uint256)']);
const SALES=new ethers.Interface(['function sales(address) view returns(address creator,uint64 progressAt,uint16 capShares,uint16 holdBps,address quote,uint16 sold,bool launched,uint16 mintFeeBps,uint16 exitFeeBps,address gate,uint128 sharePrice,address pair,address refPool,uint16 markSold)','function positions(address,address) view returns(uint16)','function TOKENS_PER_SHARE() view returns(uint256)','function fairMintBNB(address,uint256,uint256,uint256) payable returns(uint256)','function withdraw(address,uint256,uint256) returns(uint256)']);
const VT=1066666666666666666666666667n;
export function gangBuy(c,budget,room){
  const raised=BigInt(c.realQuote),grad=BigInt(c.gradAmt),vq=BigInt(c.virtualQuote),tr=VT-BigInt(c.sold),k=vq*VT;
  let net=budget-budget*100n/10000n;net=net>(grad-raised)?grad-raised:net;
  requireThat(net>0n,'GANG_MIGRATING','曲线已达毕业门槛，等待迁移');
  let tokens=tr-ceil(k,vq+raised+net);
  if(tokens>room){tokens=room;net=ceil(k,tr-tokens)-(vq+raised);}
  return {tokens,spent:ceil(net*10000n,9900n)>budget?budget:ceil(net*10000n,9900n)};
}
export function gangSell(c,amount){const gross=BigInt(c.virtualQuote)+BigInt(c.realQuote)-ceil(BigInt(c.virtualQuote)*VT,VT-BigInt(c.sold)+amount);return gross-gross*100n/10000n;}
export function gangCost(c,tokens){
  const tr=VT-BigInt(c.sold),k=BigInt(c.virtualQuote)*VT;
  requireThat(tokens>0n&&tokens<tr,'SUPPLY_TARGET','筹码目标超出剩余曲线数量');
  const net=ceil(k,tr-tokens)-BigInt(c.virtualQuote)-BigInt(c.realQuote);
  requireThat(net>0n&&net<=BigInt(c.gradAmt)-BigInt(c.realQuote),'SUPPLY_TARGET','筹码目标超过内盘剩余可售数量');
  return ceil(net*10000n,9900n);
}
export class Gang {
  constructor(chain,cfg={}){this.chain=chain;this.v3Pads=[...new Set([FAIR,...(cfg.gangV3Pads||[])])];}
  async detect(token){
    const curve=await firstVerified([...PADS.map(p=>({p,i:V2,kind:'v2'})),...this.v3Pads.map(p=>({p,i:V3,kind:'v3'}))].map(async x=>{
      const r=await this.chain.probe(x.p,x.i,'curves',[token]);
      if(r&&r.creator!==ZERO)return {platform:'gang',kind:x.kind,pad:x.p,stage:r.graduated?'outer':'inner',quote:r.quote,pair:r.pair,c:Object.fromEntries(['realQuote','sold','gradAmt','virtualQuote'].map(k=>[k,String(r[k])]))};return null;
    }));
    if(curve)return curve;
    const sale=await this.chain.probe(FAIR,SALES,'sales',[token]);
    if(sale&&sale.creator!==ZERO)return {platform:'gang',kind:'fair',pad:FAIR,stage:sale.launched?'outer':'inner',quote:sale.quote,pair:sale.pair};
    const old=await this.chain.probe(OLD,LEGACY,'quoteBuy',[token,ZERO,raw('0.00001')]);
    if(old&&old.tokensOut>0n)return {platform:'gang',kind:'legacy',pad:OLD,stage:'inner',quote:ZERO};
    return null;
  }
  async check(route,token){
    const pad=route.pad||route.target;
    if(!pad||!['v2','v3'].includes(route.kind)||!this.chain.probe)return this.detect(token);
    const c=await this.chain.probe(pad,route.kind==='v3'?V3:V2,'curves',[token]);
    if(!c||c.creator===ZERO)return null;
    return {platform:'gang',kind:route.kind,pad,stage:c.graduated?'outer':'inner',quote:c.quote,pair:c.pair,c:Object.fromEntries(['realQuote','sold','gradAmt','virtualQuote'].map(k=>[k,String(c[k])]))};
  }
  async supplyInfo(route,token,owner){
    if(route.kind==='fair'){
      const [c,held,tps]=await Promise.all([this.chain.call(FAIR,SALES,'sales',[token]),this.chain.call(FAIR,SALES,'positions',[token,owner]),this.chain.call(FAIR,SALES,'TOKENS_PER_SHARE')]);
      requireThat(!c.launched,'ROUTE_CHANGED','打新已发射，请重新计算筹码');
      const unit=ceil(c.sharePrice*(10000n+c.mintFeeBps),10000n),room=BigInt(c.capShares)>held[0]?BigInt(c.capShares)-held[0]:0n,left=10000n-BigInt(c.sold);
      return {supply:tps[0]*10000n,room:(room<left?room:left)*tps[0],unit:tps[0],unitCost:unit,route};
    }
    const [supply,room,fresh]=await Promise.all([this.chain.supply(token),this.chain.call(route.pad||OLD,route.kind==='legacy'?LEGACY:V2,'walletRoom',[token,owner]),route.kind==='legacy'?Promise.resolve(route):this.check(route,token)]);
    requireThat(fresh?.stage==='inner','ROUTE_CHANGED','代币已毕业，请重新计算筹码');
    let available=room[0];
    if(fresh.c){const maxCost=ceil((BigInt(fresh.c.gradAmt)-BigInt(fresh.c.realQuote))*10000n,9900n)+2n;const remaining=gangBuy(fresh.c,maxCost,available).tokens;available=available<remaining?available:remaining;}
    return {supply,room:available,route:fresh};
  }
  async build(route,input,owner,amount,engine){
    const {chain}=this,token=input.token,meta=await engine.tokenMeta(token),base={route:`Gang ${route.kind} 内盘`,symbol:meta.symbol,receive:input.side==='buy'?token:route.quote};
    const approve=(tk,spender,n,kind='quote')=>engine.approval?engine.approval(tk,owner,spender,n,input,kind):chain.allowance(tk,owner,spender,n);
    if(route.kind==='fair')return this.fair(route,input,owner,engine,base);
    if(route.kind==='legacy'){
      if(input.side==='buy') {const q=await chain.call(OLD,LEGACY,'quoteBuy',[token,owner,raw(input.amount)]);return {...base,out:fmt(q.tokensOut),receive:token,step:contractStep('Gang 老盘买入',OLD,LEGACY,'buy',[token,minimum(q.tokensOut,input)],raw(input.amount))};}
      const n=raw(amount,meta.decimals),approval=await approve(token,OLD,n,'sell'),q=await chain.call(OLD,LEGACY,'quoteSell',[token,n]);
      return {...base,out:fmt(q.out),receive:ZERO,step:approval||contractStep('Gang 老盘卖出',OLD,LEGACY,'sell',[token,n,minimum(q.out,input)])};
    }
    const q=route.quote;
    // Only reads run in parallel. A new workflow step always gets a new scope.
    const jobs=[this.check(route,token).then(value=>({value,at:Date.now()})),chain.meta(q)];
    if(input.side==='buy')jobs.push(engine.funding(q,input.amount,owner,input),chain.call(route.pad,V2,'walletRoom',[token,owner]));
    const [checked,qmeta,funding,quota]=await Promise.all(jobs);
    const fresh=Date.now()-checked.at>750?await this.check(route,token):checked.value;
    requireThat(fresh&&fresh.stage==='inner'&&same(fresh.pad,route.pad)&&same(fresh.quote,route.quote),'ROUTE_CHANGED','Gang 已迁移或路由变化，请重新报价');
    if(input.side==='buy'){
      const room=Date.now()-checked.at>750?(await chain.call(route.pad,V2,'walletRoom',[token,owner]))[0]:quota[0];
      requireThat(room>0n,'HOLDING_CAP','已达本钱包持仓上限');
      const quote=gangBuy(fresh.c,funding.amount,room);requireThat(quote.tokens>0n,'NO_QUOTE','Gang 报价数量为零');
      const approval=funding.step?null:await approve(q,route.pad,funding.amount);
      const buy={...contractStep('Gang 曲线买入',route.pad,V2,'buy',[token,quote.spent,minimum(quote.tokens,input)]),spendToken:q,spendAmount:fmt(quote.spent,qmeta.decimals),spendSymbol:qmeta.symbol};
      return {...base,receive:token,out:fmt(quote.tokens,meta.decimals),note:`支付币 ${qmeta.symbol}（${q}）；必要兑换与授权由快捷流程处理`,step:funding.step||approval||buy};
    }
    const n=raw(amount,meta.decimals),out=gangSell(fresh.c,n),approval=await approve(token,route.pad,n,'sell');
    return {...base,out:fmt(out,qmeta.decimals),receive:q,receiveSymbol:qmeta.symbol,step:approval||contractStep('Gang 曲线卖出',route.pad,V2,'sell',[token,n,minimum(out,input)])};
  }
  async fair(route,input,owner,engine,base){
    const c=await this.chain.call(FAIR,SALES,'sales',[input.token]);requireThat(!c.launched,'ROUTE_CHANGED','打新已发射，请重新报价');
    requireThat(same(c.quote,WBNB),'FAIR_QUOTE','当前打新路由仅支持 WBNB 计价');
    if(c.gate!==ZERO)requireThat(await this.chain.balance(c.gate,owner)>0n,'NFT_GATE',`钱包缺少门槛 NFT：${c.gate}`);
    const held=(await this.chain.call(FAIR,SALES,'positions',[input.token,owner]))[0],tps=(await this.chain.call(FAIR,SALES,'TOKENS_PER_SHARE'))[0];
    if(input.side==='buy'){
      const unit=ceil(c.sharePrice*(10000n+c.mintFeeBps),10000n),budget=raw(input.amount);
      let shares=budget/unit;const room=BigInt(c.capShares)-held,left=10000n-BigInt(c.sold);shares=shares<room?shares:room;shares=shares<left?shares:left;
      requireThat(shares>0n,'FAIR_CAP','预算不足一份或已达打新上限');
      return {...base,out:fmt(shares*tps),receive:input.token,step:contractStep('Gang 固定价认购',FAIR_ROUTER,SALES,'fairMintBNB',[input.token,shares,shares,BigInt(Math.floor(Date.now()/1000)+300)],shares*unit)};
    }
    const shares=percent(held,input.percent);requireThat(shares>0n,'NO_BALANCE','没有可退出的认购份数');
    const out=(await this.chain.call(FAIR,SALES,'withdraw',[input.token,shares,0n],owner))[0];
    return {...base,out:fmt(out),receive:WBNB,receiveSymbol:'WBNB',step:contractStep('Gang 打新退出',FAIR,SALES,'withdraw',[input.token,shares,minimum(out,input)])};
  }
}
