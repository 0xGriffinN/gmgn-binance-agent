import { mkdir,readFile,writeFile,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Journal } from './journal.mjs';
import { tradeInput,decimal,address,requireThat } from './domain.mjs';
import { raw,same } from './routes/chain.mjs';
const STORE='00000000-0000-0000-0000-000000000011',DISPATCH='00000000-0000-0000-0000-000000000012';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class TradeQueue {
  constructor(service){this.service=service;this.dir=join(service.journal.dir,'queue');this.file=join(this.dir,'state.json');this.locks=new Journal(this.dir);this.running=false;}
  async state(){try{return JSON.parse(await readFile(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')return {pending:[],recent:[]};throw e;}}
  async change(fn){
    await this.locks.init();const token=crypto.randomUUID();let claimed=false;
    try{
      for(let i=0;i<20;i++){try{await this.locks.claimStep(STORE,token);claimed=true;break;}catch(e){if(e.code!=='STEP_BUSY')throw e;await sleep(25);}}
      requireThat(claimed,'QUEUE_BUSY','队列正在更新，请稍后重试');
      const state=await this.state(),result=await fn(state),temp=this.file+'.'+crypto.randomUUID()+'.tmp';
      state.recent=state.recent.slice(-100);await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,this.file);return result;
    }finally{if(claimed)await this.locks.releaseStep(STORE,token);}
  }
  publish(row){try{this.service.journal.onSave?.(row);}catch{}}
  async list(){return (await this.state()).pending;}
  async records(){const state=await this.state();return [...state.pending,...state.recent.filter(r=>r.status!=='DISPATCHED')];}
  async enqueue(rawInput){
    const receivedAt=Date.now(),clickedAt=Number.isSafeInteger(rawInput.clickedAt)&&rawInput.clickedAt<=receivedAt&&receivedAt-rawInput.clickedAt<60000?rawInput.clickedAt:receivedAt;
    requireThat(rawInput.quick===true,'QUICK_INTENT','请点击快捷交易按钮');
    const input=tradeInput(rawInput),wallet=await this.service.owner();
    this.service.reads?.values.set('prepare-owner',{at:Date.now(),value:wallet});
    if(rawInput.expectedWallet)requireThat(same(wallet,address(rawInput.expectedWallet)),'WALLET_CHANGED','钱包已切换，请刷新后下单');
    if(input.side==='buy')requireThat(raw(input.amount)<=raw(this.service.cfg.maxBuyBnb||'.1')||rawInput.pctSupply!==undefined,'BUY_LIMIT','超过本地单笔买入上限');
    if(rawInput.pctSupply!==undefined){input.pctSupply=decimal(String(rawInput.pctSupply),{maxDecimals:2});requireThat(input.side==='buy'&&raw(input.pctSupply,2)<=10000n,'SUPPLY_PERCENT','筹码比例无效');}
    const id=rawInput.requestId||crypto.randomUUID();this.service.journal.path(id);
    const signature=JSON.stringify([wallet.toLowerCase(),input.token.toLowerCase(),input.side,input.pctSupply?'pct:'+input.pctSupply:input.side==='buy'?input.amount:input.percent]);
    const row=await this.change(state=>{
      const old=[...state.pending,...state.recent].find(r=>r.id===id||r.signature===signature&&Date.now()-r.createdAt<5000);
      if(old)return old;
      requireThat(state.pending.length<20,'QUEUE_FULL','队列最多保留 20 笔待执行指令');
      const row={id,queued:true,signature,wallet,chainId:'56',token:input.token,side:input.side,amount:input.side==='buy'?input.amount:input.percent,pctSupply:input.pctSupply,input:{...input,quick:true,acknowledgeUnavailable:rawInput.acknowledgeUnavailable===true},createdAt:Date.now(),clickedAt,receivedAt,expiresAt:Date.now()+10*60000,status:'QUEUED',message:'已排队，按执行时的余额和报价处理'};
      state.pending.push(row);return row;
    });
    this.publish(row);this.kick();return row;
  }
  async finish(id,status,message,executionId){
    const row=await this.change(state=>{const index=state.pending.findIndex(r=>r.id===id);if(index<0)return null;const [row]=state.pending.splice(index,1);Object.assign(row,{status,message,executionId,updatedAt:Date.now()});state.recent.push(row);return row;});
    if(row)this.publish(row);return row;
  }
  async cancel(input){
    const row=await this.change(state=>{const index=state.pending.findIndex(r=>r.id===input.id);requireThat(index>=0&&state.pending[index].status==='QUEUED','NOT_QUEUED','指令已开始执行，不能取消排队');const [row]=state.pending.splice(index,1);row.status='CANCELLED';row.message='排队已取消，未执行';row.updatedAt=Date.now();state.recent.push(row);return row;});
    this.publish(row);return row;
  }
  async markWaiting(active){
    const blocker=active?{id:active.id,token:active.token,status:active.status,step:active.steps?.at(-1)?.label||'交易'}:null;
    const wait=active?.status==='APP_CONFIRM'?'待币安 App 审批':active?.status==='UNKNOWN'?'结果待核对':active?.status==='PAUSED'?'流程暂停，需先处理':active?.status==='WAITING_NEXT'?'正在准备下一步':'等待确认';
    const describe=(row,index)=>{
      const queuePosition=index+1,waitKey=JSON.stringify([blocker,queuePosition]);
      const short=blocker?.token?`${blocker.token.slice(0,6)}…${blocker.token.slice(-4)}`:'';
      const message=blocker?`等待前单 ${short} · ${blocker.step}：${wait}；队列第 ${queuePosition} 笔`:
        index?`前方还有 ${index} 笔指令，按顺序执行`:'即将执行，正在检查钱包状态';
      return {waitKey,blockedBy:blocker,queuePosition,message};
    };
    const pending=await this.list();
    if(!pending.some((row,i)=>row.status==='QUEUED'&&row.waitKey!==describe(row,i).waitKey))return;
    const changed=await this.change(state=>state.pending.flatMap((row,i)=>{
      const next=describe(row,i);if(row.status!=='QUEUED'||row.waitKey===next.waitKey)return [];
      Object.assign(row,next);return [row];
    }));
    for(const row of changed)this.publish(row);
  }
  async tick(){
    await this.locks.init();const token=crypto.randomUUID();let claimed=false;
    try{
      try{await this.locks.claimStep(DISPATCH,token);claimed=true;}catch(e){if(e.code==='STEP_BUSY')return;throw e;}
      const list=await this.list(),entry=list[0];if(!entry)return;
      if(entry.status!=='QUEUED')return; // STARTING requires restart reconciliation, never blind retry.
      if(entry.expiresAt<=Date.now()){await this.finish(entry.id,'EXPIRED','等待超过 10 分钟，指令已过期，未执行');return;}
      const active=await this.service.journal.active();
      await this.markWaiting(active);
      if(active){if(active.quick)this.service.quickFlow.kick(active.id);return;}
      // Preparation checks cached admission identity; submit always checks live identity.
      const owner=this.service.reads?await this.service.reads.get('prepare-owner',1000,()=>this.service.owner()):await this.service.owner();
      if(!same(owner,entry.wallet)){await this.finish(entry.id,'REJECTED','钱包已切换，排队指令未执行');return;}
      const started=await this.change(state=>{const row=state.pending.find(r=>r.id===entry.id);if(!row||row.status!=='QUEUED')return null;delete row.blockedBy;delete row.waitKey;delete row.queuePosition;row.status='QUEUE_STARTING';row.startedBy=process.pid;row.startedAt=Date.now();row.message='已轮到此指令，正在获取最新报价';return row;});
      if(!started)return;this.publish(started);
      try{
        const row=await this.service.quickFlow.start({...started.input,queueId:started.id,expectedWallet:started.wallet,requestedAt:started.clickedAt||started.createdAt});
        await this.finish(started.id,'DISPATCHED','已进入交易流程',row.id);
      }catch(e){
        const execution=(await this.service.journal.list(0)).find(r=>r.queueId===started.id);
        if(execution){await this.finish(started.id,'DISPATCHED','已提交，请查交易结果',execution.id);return;}
        if(e.code==='INFLIGHT'){await this.change(state=>{const row=state.pending.find(r=>r.id===started.id);if(row)row.status='QUEUED';});return;}
        await this.finish(started.id,'REJECTED',e.message);
      }
    }finally{if(claimed)await this.locks.releaseStep(DISPATCH,token);}
  }
  kick(){
    if(this.running)return;this.running=true;
    const run=async()=>{
      try{await this.tick();}catch{/* Keep persisted intent; a failed read cannot authorize another send. */}
      if((await this.list().catch(()=>[])).length){const timer=setTimeout(run,750);timer.unref?.();}
      else{this.running=false;if((await this.list().catch(()=>[])).length)this.kick();}
    };
    const timer=setTimeout(run,0);timer.unref?.();
  }
  async restore(){
    const state=await this.state();if(!state.pending.length)return;
    const records=await this.service.journal.list(0);
    for(const entry of state.pending.filter(r=>r.status==='QUEUE_STARTING')){
      const execution=records.find(r=>r.queueId===entry.id);
      if(execution){await this.finish(entry.id,'DISPATCHED','已恢复交易记录',execution.id);continue;}
      let alive=true;try{process.kill(entry.startedBy,0);}catch(e){if(e.code==='ESRCH')alive=false;}
      if(!alive)await this.change(s=>{const row=s.pending.find(r=>r.id===entry.id);if(row)row.status='QUEUED';});
    }
    this.kick();
  }
}
