import { mkdir, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './domain.mjs';
export function idleSettlement(row){
  return !!row?.afterSell&&['WAITING_NEXT','PAUSED'].includes(row.status)&&!row.blocked&&(!row.quick||row.status==='PAUSED'||row.quick.expiresAt<=Date.now())&&row.steps?.length>0&&row.steps.every(s=>s.status==='FINISHED');
}
export class Journal {
  constructor(dir) { this.dir = dir; this.lockPath = join(dir, 'transaction.lock'); }
  async init() { await mkdir(this.dir, { recursive: true }); }
  path(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError('INVALID_ID', '无效的订单请求编号');
    return join(this.dir, `${id}.json`);
  }
  async get(id) { try { return JSON.parse(await readFile(this.path(id), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async save(row) {
    const path = this.path(row.id), tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(row), { mode: 0o600 });
    await rename(tmp, path);
    try{this.onSave?.(row);}catch{/* UI notifications never affect persistence. */}
    return row;
  }
  async lock(id, record) {
    try { await writeFile(this.lockPath, JSON.stringify({ id, createdAt: Date.now(), pid: process.pid, record }), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code === 'EEXIST') throw new AppError('INFLIGHT', '已有未确认交易，请先在最近订单中查明结果。'); throw e; }
  }
  async active() {
    try {
      const lock = JSON.parse(await readFile(this.lockPath, 'utf8'));
      const row = await this.get(lock.id) || lock.record || { id: lock.id, status: 'UNKNOWN', message: '交易进程中断，提交结果待核对。' };
      if (['FINISHED', 'FAILED', 'PARTIAL', 'NOT_SUBMITTED', 'MANUALLY_RECONCILED'].includes(row.status)) { await this.unlock(lock.id); return null; }
      // A confirmed sale awaiting optional quote-asset settlement has no wallet
      // transaction in flight. Preserve its history without blocking new trades.
      if(idleSettlement(row)){
        const token=`detach-${crypto.randomUUID()}`;
        try{await this.claimStep(row.id,token);}catch(e){if(e.code==='STEP_BUSY')return row;throw e;}
        try{
          const current=await this.get(row.id)||row;
          if(idleSettlement(current)){await this.unlock(lock.id);return null;}
          return current;
        }finally{await this.releaseStep(row.id,token);}
      }
      let alive = true;
      try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      // SUBMITTING is persisted BEFORE invoking swap. A dead VALIDATING process cannot have submitted.
      if (!alive && row.status === 'VALIDATING') {
        row.status = 'NOT_SUBMITTED'; row.message = '助手在提交前中断，未调用交易命令'; await this.save(row); await this.unlock(lock.id); return null;
      }
      if (!alive && row.status === 'SUBMITTING') { row.status = 'UNKNOWN'; row.message = '提交期间助手中断，结果待核对；不会自动重试'; await this.save(row); }
      return row;
    }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async unlock(id) {
    let lock;
    try { lock = JSON.parse(await readFile(this.lockPath, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (lock.id === id) await unlink(this.lockPath);
  }
  async claimStep(id,token){
    this.path(id);const file=join(this.dir,`${id}.step.lock`);
    for(let attempt=0;attempt<2;attempt++){
      try{await writeFile(file,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});return;}
      catch(e){
        if(e.code!=='EEXIST')throw e;
        const old=JSON.parse(await readFile(file,'utf8'));let alive=true;
        try{process.kill(old.pid,0);}catch(err){if(err.code==='ESRCH')alive=false;}
        if(alive)throw new AppError('STEP_BUSY','另一个面板正在处理此步骤，请先查单');
        // This only removes a dead process's execution mutex, never the transaction journal/lock.
        await unlink(file);
      }
    }
    throw new AppError('STEP_BUSY','此步骤正在恢复，请先查单');
  }
  async releaseStep(id,token){
    const file=join(this.dir,`${id}.step.lock`);
    try{const old=JSON.parse(await readFile(file,'utf8'));if(old.token===token)await unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  async list(limit=50) {
    const files = (await readdir(this.dir)).filter(n => /^[a-f0-9-]{36}\.json$/.test(n));
    const rows = await Promise.all(files.map(n => this.get(n.slice(0, -5))));
    const sorted=rows.filter(Boolean).sort((a,b)=>b.createdAt-a.createdAt);return limit?sorted.slice(0,limit):sorted;
  }
}
