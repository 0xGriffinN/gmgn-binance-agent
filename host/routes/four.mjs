// Minimal read-only classification, using the selectors and registry from the
// bundled official helper. Quotes and execution still use that official helper.
import { ethers,ZERO } from './chain.mjs';
import { ReadCache } from '../read-cache.mjs';
import { requireThat } from '../domain.mjs';
export const FOUR_REGISTRY='0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94';
export const AGENT_PRESET=1778027615735n;
const word=(data,n)=>BigInt('0x'+data.slice(2+n*64,2+(n+1)*64));
const address=(data,n)=>ethers.getAddress('0x'+data.slice(2+n*64+24,2+(n+1)*64));
export class FourIdentity {
  constructor(chain){this.chain=chain;this.cache=new ReadCache();}
  async call(to,data){return this.chain.run(p=>p.call({to,data}));}
  async detect(token,{force=false}={}){
    const core=await this.cache.get('core',30000,async()=>{
      const data=await this.call(FOUR_REGISTRY,'0x7ba9413c');
      requireThat(data?.length>=66,'FOUR_CHECK','Four Registry 响应异常');
      const core=address(data,0);requireThat(core!==ZERO,'FOUR_CHECK','Four Core 地址无效');return core;
    },{force});
    const cfg=await this.call(core,'0xe4860339'+ethers.zeroPadValue(token,32).slice(2));
    requireThat(cfg?.length>=2+20*64,'FOUR_CHECK','Four 代币配置响应异常');
    if(word(cfg,17)!==1n||word(cfg,2)!==AGENT_PRESET)return null;
    const vault=address(cfg,10),quote=address(cfg,9),preset=word(cfg,2);
    const [phaseData,activeData]=await Promise.all([
      this.call(token,'0x51d1b100').then(data=>data?.length>=66?data:this.call(vault,'0xb1c9fe6e')).catch(()=>this.call(vault,'0xb1c9fe6e')),
      this.call(FOUR_REGISTRY,'0x3c3ef33c'+ethers.zeroPadValue(ethers.toBeHex(preset),32).slice(2))
    ]);
    requireThat(phaseData?.length>=66&&activeData?.length>=66,'FOUR_CHECK','Four 阶段或预设状态响应异常');
    const phase=Number(word(phaseData,0)),active=word(activeData,0)===1n,paused=word(cfg,18)===1n;
    requireThat(phase===3||phase===1&&!paused&&active,'TOKEN_PAUSED',phase===2||phase===5?'Four 正在迁移，暂不可交易':'Four 已暂停或预设不可用');
    return {platform:'four',kind:'agent',stage:phase===3?'outer':'inner',quote,
      info:{isAgentIdExclusive:true,contracts:{core},curve:{maxSupplyRaw:String(word(cfg,6))}}};
  }
}
