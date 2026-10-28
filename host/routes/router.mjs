import { ethers,Chain,ZERO,WBNB,ERC,same,raw,fmt,minimum,contractStep } from './chain.mjs';
import { Gang } from './gang.mjs';
import { Flap,FLAP,PORTAL } from './flap.mjs';
import { BNB,USDT,requireThat,AppError } from '../domain.mjs';
import { ReadCache,firstVerified } from '../read-cache.mjs';
import { FourIdentity } from './four.mjs';
const ROUTER='0x10ED43C718714eb63d5aA57B78B54704E256024E',FACTORY='0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const DEX=new ethers.Interface(['function getPair(address,address) view returns(address)','function getReserves() view returns(uint112,uint112,uint32)','function getAmountsOut(uint256,address[]) view returns(uint256[])','function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable','function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)','function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)']);
export class Router {
  constructor(wallet,cfg={},chain=new Chain(cfg)){this.wallet=wallet;this.chain=chain;this.cfg=cfg;this.gang=new Gang(chain,cfg);this.flap=new Flap(chain);this.fourIdentity=new FourIdentity(chain);this.knownRoutes=new Map();this.protocolMetas=new Map();this.reads=new ReadCache();this.fundingReads=new ReadCache();this.usdtRoutes=new Set();}
  async tokenMeta(token){if(this.protocolMetas.has(token.toLowerCase()))return this.protocolMetas.get(token.toLowerCase());try{return await this.chain.meta(token);}catch(e){if(e instanceof AppError)throw e;throw new AppError('TOKEN_META','无法读取代币精度，已停止构造交易');}}
  async detect(token,owner,{force=false}={}){
    const key=token.toLowerCase(),route=await this.reads.get(`route:${key}`,15000,()=>this.identify(token,owner,{force}),{force});
    if(route.platform!=='dex'){if(this.knownRoutes.size>=512)this.knownRoutes.delete(this.knownRoutes.keys().next().value);this.knownRoutes.set(key,route);}
    if(route.platform==='flap'&&route.kind==='agent'&&route.stage==='inner')this.protocolMetas.set(key,{symbol:'曲线份额',decimals:18});else this.protocolMetas.delete(key);
    return route;
  }
  async identify(token,owner,{force=false}={}){
    const known=this.knownRoutes.get(token.toLowerCase());
    if(known){
      const route=known.platform==='gang'?await this.gang.check(known,token):known.platform==='flap'?await this.flap.check(known,token):await this.fourIdentity.detect(token,{force});
      if(route)return route;this.knownRoutes.delete(token.toLowerCase());
    }
    const found=await firstVerified([this.gang.detect(token),this.flap.detect(token),this.fourIdentity.detect(token,{force})]);
    return found||{platform:'dex',kind:'ordinary',stage:'outer',quote:WBNB};
  }
  async recheck(route,token,owner){
    const latest=route.platform==='gang'?await this.gang.check(route,token):route.platform==='flap'?await this.flap.detect(token):await this.detect(token,owner,{force:true});
    return latest||this.detect(token,owner,{force:true});
  }
  async supplyInfo(route,token,owner){
    if(route.platform==='gang'&&route.stage==='inner')return this.gang.supplyInfo(route,token,owner);
    const meta=await this.tokenMeta(token);
    const supply=route.platform==='four'&&route.info?.curve?.maxSupplyRaw?BigInt(route.info.curve.maxSupplyRaw):route.platform==='four'&&route.info?.curve?.maxSupply?raw(route.info.curve.maxSupply,meta.decimals):await this.chain.supply(token);
    let room=null;
    if(route.stage==='inner'&&route.platform==='four'){
      const held=await this.chain.balance(token,owner),cap=supply/100n;room=cap>held?cap-held:0n;
    }else if(route.stage==='inner'&&route.platform==='flap'&&route.kind==='portal'){
      const q=await this.chain.call(FLAP,PORTAL,'buyQuotaOf',[token,owner]);
      if(q.remaining!==ethers.MaxUint256)room=q.remaining;
    }else if(route.stage==='inner'&&route.platform==='flap'&&route.kind==='agent'){
      const limits=new ethers.Interface(['function maxSharesPerWallet() view returns(uint256)','function sharesOf(address) view returns(uint256)']);
      const [cap,held]=await Promise.all([this.chain.call(route.market,limits,'maxSharesPerWallet'),this.chain.call(route.market,limits,'sharesOf',[owner])]);
      if(cap[0]>0n)room=cap[0]>held[0]?cap[0]-held[0]:0n;
    }
    return {supply,room,route};
  }
  async market(from,to,amount,input,label='币安聚合兑换',role='trade'){
    const quote=await this.wallet.cli(['market-order','quote','--fromTokenQty',String(amount),'--fromToken',from,'--toToken',to,'--binanceChainId','56','--slippage',input.slippage]);
    requireThat(quote.toCoinAmount&&Number(quote.toCoinAmount)>0,'NO_QUOTE','币安未返回有效报价');
    return {kind:'market',label,role,fromToken:from,toToken:to,amount:String(amount),quote};
  }
  async approval(token,owner,spender,amount,input,kind='quote'){
    const step=await this.chain.allowance(token,owner,spender,amount);
    if(!step)return null;
    let cap=amount;
    if(input.approvalCap!==false){
      if(kind==='sell'){const balance=await this.chain.balance(token,owner);cap=(balance*101n+99n)/100n;}
      else if(input.amount){const budget=raw(input.amount),limit=raw(this.cfg.maxBuyBnb||'0.1');cap=amount*limit*2n/budget;}
      if(cap<amount)cap=amount;
    }
    return {...step,label:input.approvalCap===false?'授权本次需要的数量':'设置可复用授权额度',inputData:ERC.encodeFunctionData('approve',[spender,cap]),approval:{token,spender,required:String(amount),cap:String(cap)}};
  }
  async fundingQuote(q,budget,input){
    const key=`fund:${q.toLowerCase()}:${budget}:${input.slippage}`;
    // Estimates only: swap still quotes on execution and continuation uses receipt amounts.
    const refresh=()=>this.fundingReads.get(key,8000,async()=>{
      if(!this.usdtRoutes.has(q.toLowerCase())){
        try{const direct=await this.market(BNB,q,budget,input);return {required:direct.quote.toCoinAmount,viaUsdt:false,firstStep:direct,quotedAt:Date.now()};}
        catch(e){if(!/one side must be a supported stablecoin|Unsupported token pair for Ondo/i.test(e.message))throw e;this.usdtRoutes.add(q.toLowerCase());}
      }
      const first=await this.market(BNB,USDT,budget,input),quotedAt=Date.now(),second=await this.market(USDT,q,first.quote.toCoinAmount,input);
      return {required:second.quote.toCoinAmount,viaUsdt:true,firstStep:first,lastStep:second,quotedAt};
    });
    const now=Date.now();
    const candidates=[...this.fundingReads.values.entries()].filter(([k,h])=>k.startsWith(`fund:${q.toLowerCase()}:`)&&k.endsWith(`:${input.slippage}`)&&!h.value.viaUsdt&&now-h.value.quotedAt<30000&&h.value.firstStep);
    const hit=candidates.find(([k])=>k===key)||candidates.sort((a,b)=>b[1].value.quotedAt-a[1].value.quotedAt)[0];
    if(hit){
      const source=hit[1].value,step=source.firstStep;
      if(hit[0]!==key||now-source.quotedAt>=8000)void refresh().catch(()=>{});
      const meta=await this.chain.meta(q),estimated=raw(source.required,meta.decimals)*raw(budget)/raw(step.amount);
      if(estimated>0n){const required=fmt(estimated,meta.decimals);return {...source,required,estimated:true,firstStep:{...step,amount:String(budget),quote:{...step.quote,fromCoinAmount:String(budget),toCoinAmount:required}}};}
    }
    return refresh();
  }
  async funding(q,budget,owner,input){
    if(input._funded?.[q.toLowerCase()]){
      const amount=BigInt(input._funded[q.toLowerCase()]);
      requireThat(await this.chain.balance(q,owner)>=amount,'FUNDING_CHANGED','本流程兑换所得余额已变化，请核对持仓后再继续');return {amount,step:null};
    }
    if(same(q,WBNB)){
      const amount=raw(budget),held=await this.chain.balance(q,owner);
      return {amount,step:held>=amount?null:{...contractStep('BNB 包装为 WBNB',WBNB,ERC,'deposit',[],amount-held,'funding'),toToken:WBNB,existingContribution:String(held)}};
    }
    const meta=await this.chain.meta(q),plan=input._fundingPlans?.[q.toLowerCase()];
    if(plan&&input._funded?.[USDT.toLowerCase()]&&!same(q,USDT)){
      const qty=BigInt(input._funded[USDT.toLowerCase()]);
      requireThat(await this.chain.balance(USDT,owner)>=qty,'FUNDING_CHANGED','本流程中转 USDT 余额已变化');
      const step=await this.market(USDT,q,fmt(qty),input,'USDT 兑换内盘支付币','funding');
      return {amount:BigInt(plan.existing)+raw(step.quote.toCoinAmount,meta.decimals),step:{...step,existingContribution:plan.existing}};
    }
    const [held,quote]=await Promise.all([this.chain.balance(q,owner),this.fundingQuote(q,budget,input)]),required=raw(quote.required,meta.decimals);
    requireThat(required>0n,'NO_QUOTE','支付币报价为零');
    if(held>=required)return {amount:required,step:null};
    // Spend existing quote assets first, then exchange only the missing proportion.
    const budgetWei=raw(budget),short=(budgetWei*(required-held)+required-1n)/required;
    const reuse=short===budgetWei&&quote.firstStep&&Date.now()-quote.quotedAt<(quote.estimated?30000:2000);
    const step=reuse?{...quote.firstStep,label:quote.viaUsdt?'BNB → USDT 中转':'BNB 兑换支付币差额',role:'funding'}:await this.market(BNB,quote.viaUsdt?USDT:q,fmt(short),input,quote.viaUsdt?'BNB → USDT 中转':'BNB 兑换支付币差额','funding');
    if(!quote.viaUsdt)return {amount:held+raw(step.quote.toCoinAmount,meta.decimals),step:{...step,existingContribution:String(held)}};
    const end=reuse?quote.lastStep:await this.market(USDT,q,step.quote.toCoinAmount,input);
    return {amount:held+raw(end.quote.toCoinAmount,meta.decimals),step:{...step,fundingPlan:{token:q,existing:String(held)}}};
  }
  async pool(token,quote){
    for(const q of [...new Set([quote&&quote!==ZERO?quote:WBNB,WBNB])]){
      const p=await this.chain.call(FACTORY,DEX,'getPair',[token,q]);if(p[0]===ZERO)continue;
      const r=await this.chain.call(p[0],DEX,'getReserves');if(r[0]>0n&&r[1]>0n)return {pair:p[0],quote:q};
    }return null;
  }
  async outer(route,input,owner,amount){
    const funded=input.side==='buy'?Object.entries(input._funded||{}).find(([,n])=>BigInt(n)>0n):null;
    const from=input.side==='buy'?(funded?.[0]||BNB):input.token,to=input.side==='buy'?input.token:input.sellToBnb===false&&route.quote&&!same(route.quote,ZERO)?route.quote:BNB;
    const qty=funded?fmt(BigInt(funded[1]),(await this.tokenMeta(from)).decimals):input.side==='buy'?input.amount:amount;
    try{const step=await this.market(from,to,qty,input);return {route:`${route.platform} 外盘 · 币安聚合`,symbol:(await this.tokenMeta(input.token)).symbol,out:step.quote.toCoinAmount,receive:to,step};}
    catch(e){if(route.platform==='dex')throw e;}
    const pool=await this.pool(input.token,funded?.[0]||route.quote);requireThat(pool,'NO_POOL','币安无路由，链上也没有可用的 PancakeSwap V2 储备池');
    if(funded)requireThat(same(pool.quote,funded[0]),'FUNDING_PAIR','已兑换支付币与外盘池不匹配，资产保留在钱包');
    const settings=await this.wallet.cli(['wallet','settings']);requireThat(settings.devMode?.enabled===true,'DEVELOPER_MODE','PancakeSwap 直连需要在币安 App 开启开发者模式');
    const isNative=same(pool.quote,WBNB),meta=await this.tokenMeta(input.token);let n,pre,value=0n,path,fn,receive;
    if(input.side==='buy'){
      receive=input.token;path=[pool.quote,input.token];
      if(isNative&&!funded){n=raw(input.amount);value=n;fn='swapExactETHForTokensSupportingFeeOnTransferTokens';}
      else{const fund=await this.funding(pool.quote,input.amount,owner,input);n=fund.amount;pre=fund.step||await this.approval(pool.quote,owner,ROUTER,n,input);fn='swapExactTokensForTokensSupportingFeeOnTransferTokens';}
    }else{n=raw(amount,meta.decimals);path=[input.token,pool.quote];receive=isNative&&input.sellToBnb!==false?ZERO:pool.quote;pre=await this.approval(input.token,owner,ROUTER,n,input,'sell');fn=isNative&&input.sellToBnb!==false?'swapExactTokensForETHSupportingFeeOnTransferTokens':'swapExactTokensForTokensSupportingFeeOnTransferTokens';}
    const amounts=(await this.chain.call(ROUTER,DEX,'getAmountsOut',[n,path]))[0],out=amounts[amounts.length-1],deadline=BigInt(Math.floor(Date.now()/1000)+300);
    const args=value>0n?[minimum(out,input),path,owner,deadline]:[n,minimum(out,input),path,owner,deadline];
    return {route:`${route.platform} 外盘 · PancakeSwap V2`,symbol:meta.symbol,out:fmt(out,input.side==='buy'?meta.decimals:isNative?18:(await this.chain.meta(pool.quote)).decimals),receive,note:'链上池报价未扣转账税；最低到账由滑点参数约束。',step:pre||contractStep('PancakeSwap V2 交易',ROUTER,DEX,fn,args,value)};
  }
  async build(route,input,owner,amount){
    requireThat(route.stage!=='migrating','TOKEN_MIGRATING','代币正在迁移，暂不可交易');
    if(route.platform==='flap'&&(route.stage==='inner'||route.kind==='agent'&&input.side==='sell'))return this.flap.build(route,input,owner,amount,this);
    if(route.stage==='outer')return this.outer(route,input,owner,amount);
    if(route.platform==='gang')return this.gang.build(route,input,owner,amount,this);
    if(route.platform==='four'){
      const params={token:input.token,wallet:owner,amount:input.side==='buy'?input.amount:amount,slippageBps:Number(input.slippage==='auto'?100n:raw(input.slippage,2)),...(input.side==='sell'?{receive:input.sellToBnb===false?'QUOTE':'BNB'}:{})};
      const q=await this.wallet.four(input.side==='buy'?'quote-buy':'quote-sell',params);
      requireThat(q.simulation?.ok!==false,'FOUR_SIMULATION',q.simulation?.error?.reason||'Four 模拟失败');
      let tx=q.approveTx||q.tx;requireThat(tx?.to&&tx?.inputData,'FOUR_TX','官方 Four 脚本未返回可执行交易');
      if(q.approveTx){const [spender,n]=ERC.decodeFunctionData('approve',tx.inputData);tx=await this.approval(tx.to,owner,spender,n,input,input.side==='sell'?'sell':'quote')||q.tx;}
      return {route:'Four Agent 专属内盘',symbol:(await this.tokenMeta(input.token)).symbol,out:input.side==='buy'?q.estimate.tokenAmount:q.estimate.userReceives,receive:input.side==='buy'?input.token:input.sellToBnb===false?route.quote:ZERO,
        note:q.estimate.budgetNotFullyUsed?'本次预算可能部分退回':null,step:{kind:'contract',label:tx.approval?tx.label:q.approveTx?'Four 本次数量授权':'Four 内盘交易',role:tx.approval||q.approveTx&&tx!==q.tx?'approval':'trade',to:tx.to,value:String(tx.value||'0'),inputData:tx.inputData,approval:tx.approval}};
    }
    throw new AppError('UNSUPPORTED_ROUTE','未识别出可执行的平台路由');
  }
}
