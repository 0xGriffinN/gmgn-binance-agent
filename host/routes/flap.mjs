import { ethers,ZERO,same,raw,fmt,percent,minimum,contractStep } from './chain.mjs';
import { requireThat } from '../domain.mjs';
export const FLAP='0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',AGENT_PORTAL='0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062',FACTORY='0xC55820f24015bE7c4f18949D9e1363A3609B300e',READER='0x18Aa6C93f1887a243fdc348C9A77F5136555174a';
const MAP=new ethers.Interface(['function marketOfToken(address) view returns(address)']);
export const PORTAL=new ethers.Interface(['function nftGate(address) view returns(address)','function buyQuotaOf(address,address) view returns(uint256 bought,uint256 remaining)','function quoteExactInput((address inputToken,address outputToken,uint256 inputAmount) p) returns(uint256)','function swapExactInput((address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,bytes permitData) p) payable returns(uint256)']);
export const AGENT=new ethers.Interface(['function quoteBuy(address,address,uint256) view returns(uint256 gross,uint256 fee,uint256 extra,uint256 shares)','function buy(address,uint256) payable','function buyWithQuote(address,uint256,uint256)','function sell(address,uint256,uint256,uint256) returns(uint256,uint256)','function sellAll(address,uint256) returns(uint256)','function claim(address) returns(uint256)','function sharesOf(address) view returns(uint256)']);
export class Flap {
  constructor(chain){this.chain=chain;}
  async detect(token){
    const ordinary=this.portal(token).then(value=>({value}),error=>({error}));
    const market=await this.chain.probe(FACTORY,MAP,'marketOfToken',[token]);
    if(market&&market[0]!==ZERO)return this.agent(market[0]);
    const result=await ordinary;if(result.error)throw result.error;return result.value;
  }
  async check(route,token){return route.kind==='agent'?this.agent(route.market):this.portal(token);}
  async agent(market){
      const data=await this.chain.run(p=>p.call({to:READER,data:ethers.id('marketDetail(address)').slice(0,10)+ethers.zeroPadValue(market,32).slice(2)}));
      requireThat(data.length>=2+12*64,'FLAP_READER','Flap Reader 响应格式异常');
      const word=n=>BigInt('0x'+data.slice(2+n*64,2+(n+1)*64)),addr=n=>ethers.getAddress('0x'+data.slice(2+n*64+24,2+(n+1)*64));
      const phase=Number(word(8));
      return {platform:'flap',kind:'agent',market,phase,stage:phase===1?'inner':phase===3?'outer':'migrating',quote:addr(2),quoteDecimals:Number(word(3)),pair:addr(11)};
  }
  async portal(token){
    let data;
    try{data=await this.chain.run(p=>p.call({to:FLAP,data:'0x62fafcca'+ethers.zeroPadValue(token,32).slice(2)}));}catch(e){if(e.code==='RPC_UNAVAILABLE'||e.code==='WRONG_CHAIN')throw e;return null;}
    if(data.length<2+16*64)return null;
    const w=n=>BigInt('0x'+data.slice(2+n*64,2+(n+1)*64)),status=Number(w(0));
    if(![1,2,3,4].includes(status))return null;
    const quote=ethers.getAddress('0x'+data.slice(2+9*64+24,2+10*64));
    return {platform:'flap',kind:'portal',status,stage:status===1?'inner':status===4?'outer':'migrating',quote,nativeSwap:w(10)!==0n};
  }
  async shares(route,owner){return (await this.chain.call(route.market,AGENT,'sharesOf',[owner]))[0];}
  async build(route,input,owner,amount,engine){
    const token=input.token,meta=await engine.tokenMeta(token),base={route:`Flap ${route.kind==='agent'?'Agent Curve':'Portal'} ${route.stage==='outer'?'外盘前领取':'内盘'}`,symbol:meta.symbol};
    const approve=(tk,spender,n,kind='quote')=>engine.approval?engine.approval(tk,owner,spender,n,input,kind):this.chain.allowance(tk,owner,spender,n);
    if(route.kind==='agent'){
      if(route.stage==='outer'){
        const shares=await this.shares(route,owner);
        if(shares>0n){const out=(await this.chain.call(AGENT_PORTAL,AGENT,'claim',[route.market],owner))[0];return {...base,out:fmt(out),receive:token,step:contractStep('领取已毕业的 Flap 曲线代币',AGENT_PORTAL,AGENT,'claim',[route.market],0n,'claim')};}
        return engine.outer(route,input,owner,amount);
      }
      const native=same(route.quote,ZERO),q=native?ZERO:route.quote;
      if(input.side==='buy'){
        const funding=native?{amount:raw(input.amount)}:await engine.funding(q,input.amount,owner,input);
        const quote=await this.chain.call(AGENT_PORTAL,AGENT,'quoteBuy',[route.market,owner,funding.amount]);
        let approval=null;
        if(!native&&!funding.step){
          const approvals=await Promise.all([AGENT_PORTAL,route.market].map(spender=>approve(q,spender,funding.amount)));
          approval=approvals.find(Boolean)||null;
        }
        return {...base,out:fmt(quote.shares),receive:token,step:funding.step||approval||contractStep('Flap Agent 买入',AGENT_PORTAL,AGENT,native?'buy':'buyWithQuote',native?[route.market,minimum(quote.shares,input)]:[route.market,funding.amount,minimum(quote.shares,input)],native?raw(input.amount):0n)};
      }
      const shares=await this.shares(route,owner);requireThat(shares>0n,'NO_BALANCE','没有可卖出的 Flap 曲线份额');
      const all=(await this.chain.call(AGENT_PORTAL,AGENT,'sellAll',[route.market,0n],owner))[0];
      if(input.percent==='100')return {...base,out:fmt(all,route.quoteDecimals),receive:q,step:contractStep('Flap Agent 全部卖出',AGENT_PORTAL,AGENT,'sellAll',[route.market,minimum(all,input)])};
      const gross=percent(all,input.percent),sim=await this.chain.call(AGENT_PORTAL,AGENT,'sell',[route.market,gross,shares,0n],owner);
      return {...base,out:fmt(sim[1],route.quoteDecimals),receive:q,step:contractStep('Flap Agent 按比例卖出',AGENT_PORTAL,AGENT,'sell',[route.market,gross,shares,minimum(sim[1],input)])};
    }
    const gate=await this.chain.probe(FLAP,PORTAL,'nftGate',[token]);
    if(gate&&gate[0]!==ZERO)requireThat(await this.chain.balance(gate[0],owner)>0n,'NFT_GATE',`钱包缺少 Flap 门槛 NFT：${gate[0]}`);
    let from,to,n,value=0n,prerequisite;
    if(input.side==='buy'){
      to=token;
      if(same(route.quote,ZERO)||route.nativeSwap){from=ZERO;n=raw(input.amount);value=n;}
      else{from=route.quote;const funding=await engine.funding(from,input.amount,owner,input);n=funding.amount;prerequisite=funding.step||await approve(from,FLAP,n);}
    }else{from=token;to=same(route.quote,ZERO)||route.nativeSwap?ZERO:route.quote;n=raw(amount,meta.decimals);prerequisite=await approve(token,FLAP,n,'sell');}
    const out=(await this.chain.call(FLAP,PORTAL,'quoteExactInput',[[from,to,n]],owner))[0],dec=to===token?meta.decimals:to===ZERO?18:(await this.chain.meta(to)).decimals;
    return {...base,out:fmt(out,dec),receive:to,step:prerequisite||contractStep(`Flap Portal ${input.side==='buy'?'买入':'卖出'}`,FLAP,PORTAL,'swapExactInput',[[from,to,n,minimum(out,input),'0x']],value)};
  }
}
