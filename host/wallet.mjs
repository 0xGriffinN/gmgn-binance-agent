import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AppError, auditSummary, TRUSTED } from './domain.mjs';
const exec = promisify(execFile);
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export async function config() {
  try { return JSON.parse((await readFile(join(ROOT, '.local', 'config.json'), 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new AppError('NOT_INSTALLED', '本地钱包助手尚未安装，请运行 install.ps1'); }
}
export function parseCli(stdout) {
  let result;
  try { result = JSON.parse(stdout.trim()); }
  catch { throw new AppError('CLI_PROTOCOL', '币安 CLI 未返回有效 JSON；未自动重试'); }
  if (result.success !== true) {
    const e = new AppError(result.error?.name || String(result.error?.code || 'WALLET_ERROR'), result.error?.message || '币安钱包请求失败');
    e.walletRejected = true;
    throw e;
  }
  return result.data;
}
export class Wallet {
  constructor(cfg) { this.cfg = cfg; }
  async four(command,params) {
    if(!this.cfg.fourPath)throw new AppError('FOUR_SCRIPT','缺少官方 Four 路由脚本');
    try {
      const {stdout}=await exec(this.cfg.nodePath,['--use-env-proxy',this.cfg.fourPath,command,JSON.stringify(params)],{windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
      return parseCli(stdout);
    } catch(e) {if(e instanceof AppError)throw e;if(e.stdout)return parseCli(e.stdout);throw new AppError('FOUR_RPC','Four 官方脚本查询失败，请稍后重试');}
  }
  async cli(args, timeout = 40000) {
    try {
      const { stdout } = await exec(this.cfg.nodePath, ['--use-env-proxy', this.cfg.bawPath, ...args, '--json'], {
        windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NODE_USE_ENV_PROXY: '1' }
      });
      return parseCli(stdout);
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Never expose stderr, environment or the full command: they may contain credentials.
      if (error.stdout) return parseCli(error.stdout);
      throw new AppError(error.killed ? 'CLI_TIMEOUT' : 'CLI_UNAVAILABLE', error.killed ? '币安 CLI 请求超时；提交结果可能未知，请先查单。' : '无法运行币安 CLI，请检查本地运行环境。');
    }
  }
  async route(token, wallet) {
    if (!/(4444|ffff)$/i.test(token)) return { route: 'market-order' };
    if (!this.cfg.fourPath) throw new AppError('ROUTE_CHECK', '缺少内盘识别脚本，请重新安装助手');
    try {
      const { stdout } = await exec(this.cfg.nodePath, ['--use-env-proxy', this.cfg.fourPath, 'info', JSON.stringify({ token, wallet })], { timeout: 45000, windowsHide: true, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout);
      if (!result.success) return { route: 'market-order', checkUnavailable: true };
      const d = result.data;
      if (d.route === 'contract-call') throw new AppError('INNER_UNSUPPORTED', '这是 Agent ID 专属内盘，需开发者模式合约交易；首版仅接入官方市价路由。');
      if (d.route === 'wait' || (d.route === 'unavailable' && d.isAgentIdExclusive)) throw new AppError('TOKEN_PAUSED', '此代币正在迁移或暂停交易，请稍后重试。');
      return { route: 'market-order' };
    } catch (e) {
      if (e instanceof AppError) throw e;
      // Official reference allows market-order when identity RPC is unavailable.
      return { route: 'market-order', checkUnavailable: true };
    }
  }
  async audit(token) {
    if (TRUSTED.has(token.toLowerCase())) return { available: true, trusted: true, hits: [] };
    try {
      const r = await fetch('https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'binance-web3/1.4 (Skill)', source: 'agent' },
        body: JSON.stringify({ binanceChainId: '56', contractAddress: token, requestId: crypto.randomUUID() })
      });
      const body = await r.json();
      if (!r.ok || body.success !== true) throw new Error();
      return auditSummary(body.data);
    } catch { return { available: false, hits: [], message: '代币安全审计暂不可用；继续前须明确确认。' }; }
  }
}
