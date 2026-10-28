import { requireThat } from './domain.mjs';

const DONE = new Set(['FINISHED', 'PARTIAL', 'FAILED', 'NOT_SUBMITTED', 'MANUALLY_RECONCILED']);
const PENDING = new Set(['PENDING', 'APP_CONFIRM', 'SUBMITTING','UNKNOWN']);

// One user click authorizes this bounded workflow. Every transaction still goes
// through fresh quote/preview, budget checks, disk locks and receipt reconciliation.
export class QuickFlow {
  constructor(service, { interval = 150 } = {}) {
    this.service = service; this.interval = interval; this.running = new Map();
  }
  async start(input) {
    requireThat(input.quick === true, 'QUICK_INTENT', '请从快捷买入或卖出按钮发起');
    const p = input.pctSupply!==undefined?await this.service.prepareSupply(input):await this.service.prepare(input);
    if(input.expectedWallet)requireThat(p.owner.toLowerCase()===input.expectedWallet.toLowerCase(),'WALLET_CHANGED','钱包已切换，此排队指令未执行');
    p.queueId=input.queueId;p.requestedAt=input.requestedAt;
    const row = await this.submitPlan(p,{acknowledgeUnavailable:input.acknowledgeUnavailable===true,quick:true});
    this.kick(row.id); return row;
  }
  async resume(input) {
    const row = await this.service.journal.get(input.id);
    requireThat(row?.steps && !row.blocked && ['WAITING_NEXT', 'PAUSED'].includes(row.status)&&(row.quick||input.confirmed===true), 'NOT_READY', '当前流程不能恢复，请先核对订单');
    const p = await this.service.continueOrder(input);
    const next = await this.submitPlan(p,{acknowledgeUnavailable:row.quick?.acknowledgeUnavailable||input.acknowledgeUnavailable===true,quick:true,renewQuick:true});
    this.kick(row.id); return next;
  }
  async submitPlan(p,options){
    let row=await this.service.submit({previewId:p.id,confirmed:true,...options});
    if(row.errorCode!=='ROUTE_CHANGED'||!['PAUSED','NOT_SUBMITTED'].includes(row.status)||row.steps.some(s=>s.role==='trade'))return row;
    const route=await this.service.router.detect(p.input.token,p.owner,{force:true});
    if(p.route.stage!=='inner'||route.stage!=='outer'||route.platform!==p.route.platform)return row;
    const next=await this.service.prepare(p.input,row.steps.length?row:null);
    next.queueId=p.queueId;next.requestedAt=p.requestedAt;
    requireThat(next.owner.toLowerCase()===p.owner.toLowerCase(),'WALLET_CHANGED','钱包切换，已停止自动切换外盘');
    row=await this.service.submit({previewId:next.id,confirmed:true,...options});return row;
  }
  async tick(id) {
    let row = await this.service.journal.get(id);
    if (!row?.quick || row.blocked || DONE.has(row.status) || row.status==='PAUSED') return false;
    if (PENDING.has(row.status)) row = await this.service.refreshOrder({ id });
    if (row.status === 'WAITING_NEXT') {
      if (row.quick.expiresAt <= Date.now() || row.steps.length >= 10) {
        row.status = 'PAUSED'; row.message = '快捷流程已暂停；已到账资产保留，可点击恢复';
        await this.service.journal.save(row); return false;
      }
      try {
        const p = await this.service.continueOrder({ id });
        row = await this.submitPlan(p,{acknowledgeUnavailable:row.quick.acknowledgeUnavailable});
      } catch (e) {
        // Never turn an uncertain submission into a retryable step.
        row = await this.service.journal.get(id);
        if(['STEP_BUSY','STEP_CHANGED','INFLIGHT'].includes(e.code))return true;
        if (row.status === 'WAITING_NEXT') {
          row.status = 'PAUSED'; row.message = e.message; row.errorCode = e.code;
          await this.service.journal.save(row);
        }
        return false;
      }
    }
    return PENDING.has(row.status) || row.status === 'WAITING_NEXT';
  }
  kick(id) {
    if (this.running.has(id)) return;
    const task = { timer: null }; this.running.set(id, task);
    const run = async () => {
      let again = false;
      try { again = await this.tick(id); }
      catch { /* Read-only polling errors may retry; submit preserves UNKNOWN. */ again = true; }
      if (this.running.get(id) !== task) return;
      if (again) {
        const row=await this.service.journal.get(id).catch(()=>null),step=row?.steps?.at(-1);
        const delay=['APP_CONFIRM','UNKNOWN'].includes(row?.status)?2000:step?.kind==='market'&&!step.txHash?1500:step?.kind==='market'?250:this.interval;
        task.timer = setTimeout(run, delay); task.timer.unref?.();
      }
      else this.running.delete(id);
    };
    task.timer = setTimeout(run, 0); task.timer.unref?.();
  }
  async restore() {
    const row = await this.service.journal.active();
    if (row?.quick && (PENDING.has(row.status) || row.status === 'WAITING_NEXT')) this.kick(row.id);
  }
}
