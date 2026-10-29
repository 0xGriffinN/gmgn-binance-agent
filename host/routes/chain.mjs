import { ethers } from 'ethers';
import { AppError, requireThat } from '../domain.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
export { ethers };
export const ZERO = ethers.ZeroAddress;
export const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
export const ERC = new ethers.Interface(['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)', 'function decimals() view returns(uint8)', 'function symbol() view returns(string)', 'function totalSupply() view returns(uint256)', 'function deposit() payable', 'function withdraw(uint256)']);
export const lower = value => String(value).toLowerCase();
export const same = (a,b) => lower(a) === lower(b);
export const raw = (amount, decimals = 18) => {
  const [a,b=''] = String(amount).split('.'); return ethers.parseUnits(a + (decimals ? '.' + b.slice(0,decimals).padEnd(decimals,'0') : ''), decimals);
};
export const fmt = (amount, decimals=18) => ethers.formatUnits(amount,decimals);
export const percent = (amount,pct) => amount * raw(pct,2) / 10000n;
export function slipBps(input) { return input.slippage === 'auto' ? 100n : raw(input.slippage,2); }
export const minimum = (amount,input) => amount * (10000n-slipBps(input)) / 10000n;
export const ceil = (a,b) => (a+b-1n)/b;
export function expiryMs(value){if(typeof value==='string'&&value.includes('T'))return Date.parse(value);const n=Number(value);return n<1e12?n*1000:n;}
export function contractStep(label,to,iface,fn,args=[],value=0n,role='trade') {
  return { kind:'contract',label,to,value:String(value),inputData:iface.encodeFunctionData(fn,args),role };
}
export class Chain {
  constructor(cfg={}) {
    this.urls=cfg.rpcUrls || ['https://bsc-dataseed.bnbchain.org','https://bsc-rpc.publicnode.com'];
    this.trade=cfg.rpcPurpose==='trade';
    this.providers=this.urls.map(url=>{ const req=new ethers.FetchRequest(url);req.timeout=this.trade?5000:12000;return new ethers.JsonRpcProvider(req,56,{staticNetwork:true,batchMaxCount:1}); });
    this.verified=new Set();this.verifyJobs=new Map();this.metas=new Map();this.metaJobs=new Map();this.scope=new AsyncLocalStorage();this.cooldowns=new Map();this.bans=new Map();
  }
  available(){return this.providers.map((_,i)=>i).filter(i=>(this.bans.get(i)||0)<=Date.now());}
  penalize(i,e){
    const message=[e.message,e.shortMessage,e.info?.responseBody,e.info?.responseStatus,e.status].filter(Boolean).join(' ');
    const forbidden=/\b403\b|forbidden/i.test(message),delay=forbidden?600000:/monthly quota/i.test(message)?3600000:/429|rate|quota|limit|retry/i.test(message)?20000:5000;
    this.cooldowns.set(i,Date.now()+delay);if(forbidden)this.bans.set(i,Date.now()+delay);
  }
  withReadScope(fn){return this.scope.getStore()?fn():this.scope.run(new Map(),fn);}
  async verifyProvider(i){
    if(this.verified.has(i))return;
    if(!this.verifyJobs.has(i))this.verifyJobs.set(i,Promise.resolve().then(()=>this.providers[i].send('eth_chainId',[])).then(id=>{requireThat(BigInt(id)===56n,'WRONG_CHAIN','RPC 不是 BSC 主网');this.verified.add(i);}).finally(()=>this.verifyJobs.delete(i)));
    await this.verifyJobs.get(i);
  }
  async run(fn) {
    for(let round=0;round<(this.trade?2:1);round++){
    const all=this.available(),warm=all.filter(i=>(this.cooldowns.get(i)||0)<=Date.now()),order=warm.length?warm:all.sort((a,b)=>(this.cooldowns.get(a)||0)-(this.cooldowns.get(b)||0));
    for (const i of order) {
      try {
        const p=this.providers[i];
        await this.verifyProvider(i);
        return await fn(p);
      } catch(e) {
        if(e instanceof AppError || ['CALL_EXCEPTION','BAD_DATA','INVALID_ARGUMENT','NUMERIC_FAULT'].includes(e.code))throw e;
        this.penalize(i,e);
      }
    }
    if(round===0&&this.trade)await new Promise(resolve=>setTimeout(resolve,400));
    }
    throw new AppError('RPC_UNAVAILABLE','BSC RPC 暂不可用，请稍后重新查询');
  }
  async call(to,iface,fn,args=[],from,blockTag) {
    const tx={to,data:iface.encodeFunctionData(fn,args),...(from?{from}:{}),...(blockTag!=null?{blockTag}:{})},scope=this.scope.getStore(),key=JSON.stringify(tx).toLowerCase(),hit=scope?.get(key);
    if(hit&&(hit.pending||Date.now()-hit.at<750))return hit.job;
    const job=this.run(p=>p.call(tx)).then(data=>iface.decodeFunctionResult(fn,data));
    if(scope){const entry={job,at:Date.now(),pending:true};scope.set(key,entry);job.then(()=>{entry.pending=false;entry.at=Date.now();},()=>{if(scope.get(key)===entry)scope.delete(key);});}
    return job;
  }
  async probe(to,iface,fn,args=[]) { try{return await this.call(to,iface,fn,args);}catch(e){if(e instanceof AppError)throw e;return null;} }
  async meta(token) {
    const key=lower(token);if(this.metas.has(key))return this.metas.get(key);
    if(this.metaJobs.has(key))return this.metaJobs.get(key);
    const job=this.loadMeta(token,key).finally(()=>this.metaJobs.delete(key));this.metaJobs.set(key,job);return job;
  }
  async loadMeta(token,key){
    const [d,s]=await Promise.all([this.call(token,ERC,'decimals'),this.call(token,ERC,'symbol')]);
    requireThat(Number(d[0])<=36,'TOKEN_DECIMALS','代币精度超过支持范围');
    const data={decimals:Number(d[0]),symbol:String(s[0])};this.metas.set(key,data);return data;
  }
  async balance(token,owner){return (await this.call(token,ERC,'balanceOf',[owner]))[0];}
  async balanceAt(token,owner,blockTag){return (await this.call(token,ERC,'balanceOf',[owner],undefined,blockTag))[0];}
  async holding(token,owner){const blockNumber=await this.block();return {balanceRaw:String(await this.balanceAt(token,owner,blockNumber)),blockNumber};}
  async supply(token){return (await this.call(token,ERC,'totalSupply'))[0];}
  async nativeBalance(owner){return this.run(p=>p.getBalance(owner));}
  async nonce(owner){return this.run(async p=>Number(await p.send('eth_getTransactionCount',[owner,'latest'])));}
  async approvalHashes(token,owner,spender,fromBlock){
    const logs=await this.run(p=>p.getLogs({address:token,fromBlock,toBlock:'latest',topics:[ethers.id('Approval(address,address,uint256)'),ethers.zeroPadValue(owner,32),ethers.zeroPadValue(spender,32)]}));
    return [...new Set(logs.map(l=>l.transactionHash))];
  }
  async allowance(token,owner,spender,amount) {
    const current=(await this.call(token,ERC,'allowance',[owner,spender]))[0];
    return current>=amount?null:contractStep('授权本次需要的数量',token,ERC,'approve',[spender,amount],0n,'approval');
  }
  async receipt(hash){return this.run(p=>p.getTransactionReceipt(hash));}
  async confirmation(hash){
    // Race at most two endpoints for a complete, internally consistent pair.
    // Null is pending, never a winning confirmation. No transaction is broadcast.
    const all=this.available(),warm=all.filter(i=>(this.cooldowns.get(i)||0)<=Date.now());
    const indexes=(warm.length?warm:all).slice(0,2);
    if(!indexes.length)throw new AppError('RPC_UNAVAILABLE','没有可用的 BSC RPC');
    const pending=Symbol('pending');
    const jobs=indexes.map(async i=>{
      try{
        await this.verifyProvider(i);const p=this.providers[i];
        const [receipt,tx]=await Promise.all([p.getTransactionReceipt(hash),p.getTransaction(hash)]);
        if(!receipt||!tx||tx.blockNumber==null)throw pending;
        requireThat(same(receipt.hash,hash)&&same(tx.hash,hash)&&receipt.blockNumber===tx.blockNumber&&same(receipt.blockHash,tx.blockHash),'TX_MISMATCH','RPC 返回的回执和交易不一致');
        return [receipt,tx];
      }catch(e){if(e!==pending)this.penalize(i,e);throw e;}
    });
    try{return await Promise.any(jobs);}
    catch(e){if(e.errors?.includes(pending))return [null,null];throw e.errors?.[0]||e;}
  }
  async transaction(hash){return this.run(p=>p.getTransaction(hash));}
  async block(){return this.run(p=>p.getBlockNumber());}
  transfers(receipt,token,owner) {
    let received=0n;
    for(const log of receipt.logs||[])if(same(log.address,token)&&log.topics?.[0]===ethers.id('Transfer(address,address,uint256)')&&log.topics.length===3){
      if(same('0x'+log.topics[2].slice(-40),owner))received+=BigInt(log.data);
    }
    return received;
  }
}
