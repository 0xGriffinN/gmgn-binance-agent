import { config, Wallet, ROOT } from './wallet.mjs';
import { Journal } from './journal.mjs';
import { RoutedService } from './routed-service.mjs';
import { join } from 'node:path';
const cfg = await config();
const origin = process.argv[2];
if (origin !== `chrome-extension://${cfg.extensionId}/`) process.exit(1);
const journal = new Journal(join(ROOT, '.local', 'orders'));
await journal.init();
const service = new RoutedService(new Wallet(cfg), journal, cfg);
const readOnly = process.argv.includes('--read-only');
if (!readOnly) {service.startBackgroundState();await service.quickFlow.restore();await service.queue.restore();}
let buffer = Buffer.alloc(0), pending = 0, ended = false, outputClosed = false;
process.stdout.on('error', () => { outputClosed = true; });
function send(message) {
  if (outputClosed) return;
  const data = Buffer.from(JSON.stringify(message));
  if (data.length > 900000) return send({ id: message.id, error: { code: 'TOO_LARGE', message: '响应过大，请缩小查询范围' } });
  const size = Buffer.alloc(4); size.writeUInt32LE(data.length);
  process.stdout.write(Buffer.concat([size, data]));
}
if(!readOnly)journal.onSave=row=>send({event:'order',data:row});
if(!readOnly)journal.onPosition=position=>send({event:'position',data:position});
async function handle(message) {
  if (!message || typeof message.id !== 'string' || message.id.length > 100) return;
  if (readOnly && !['health', 'wallet.snapshot', 'token.route', 'orders.list'].includes(message.method)) return send({ id: message.id, error: { code: 'READ_ONLY', message: '只读自检禁止交易及流程恢复' } });
  if (pending >= 12) return send({ id: message.id, error: { code: 'BUSY', message: '本地助手繁忙，请稍后重试' } });
  pending++;
  try { send({ id: message.id, data: await service.dispatch(message.method, message.params || {}) }); }
  catch (e) { send({ id: message.id, error: { code: e.code || 'LOCAL_ERROR', message: e.code ? e.message : '本地助手异常，请检查安装或订单记录' } }); }
  finally { pending--; if (ended && !pending) process.exit(0); }
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (length > 65536) process.exit(1);
    if (buffer.length < length + 4) break;
    const body = buffer.subarray(4, length + 4); buffer = buffer.subarray(length + 4);
    try { void handle(JSON.parse(body)); } catch { process.exit(1); }
  }
});
process.stdin.on('end', () => { service.stopBackgroundState();ended = true; if (!pending) process.exit(0); });
