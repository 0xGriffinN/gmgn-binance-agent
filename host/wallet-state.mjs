// A bounded, read-only wallet snapshot. In-flight refreshes cannot resurrect
// state invalidated by a submission, sign-in, or uncertain result.
export class WalletState {
  constructor(read,{ttl=6000,now=()=>Date.now()}={}){this.read=read;this.ttl=ttl;this.now=now;this.epoch=0;this.value=null;this.job=null;}
  invalidate(){this.epoch++;this.value=null;this.job=null;}
  async get({force=false}={}){
    if(!force&&this.value&&this.now()-this.value.at<this.ttl)return this.value.data;
    if(this.job)return this.job;
    const epoch=this.epoch;
    const job=Promise.resolve().then(()=>this.read()).then(data=>{
      if(epoch!==this.epoch)throw Object.assign(new Error('钱包状态已变化，请重新查询'),{code:'WALLET_STATE_CHANGED'});
      this.value={at:this.now(),data};return data;
    }).catch(e=>{if(epoch===this.epoch)this.value=null;throw e;}).finally(()=>{if(this.job===job)this.job=null;});
    this.job=job;return job;
  }
}
