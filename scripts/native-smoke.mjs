import { spawn } from 'node:child_process';
import { config, ROOT } from '../host/wallet.mjs';
import { join } from 'node:path';
const cfg = await config();
const child = spawn(cfg.nodePath, ['--use-env-proxy', join(ROOT, 'host', 'native.mjs'), `chrome-extension://${cfg.extensionId}/`, '--read-only'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = Buffer.alloc(0), waiting = new Map();
child.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
    const length = buffer.readUInt32LE(0), result = JSON.parse(buffer.subarray(4, 4 + length)); buffer = buffer.subarray(4 + length);
    const done = waiting.get(result.id); if (done) { waiting.delete(result.id); result.error ? done.reject(new Error(result.error.message)) : done.resolve(result.data); }
  }
});
function request(method, params = {}) {
  const id = crypto.randomUUID(), body = Buffer.from(JSON.stringify({ id, method, params })), size = Buffer.alloc(4); size.writeUInt32LE(body.length);
  const promise = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  // Deliberately split the length prefix to verify streaming framing.
  child.stdin.write(size.subarray(0, 2)); child.stdin.write(Buffer.concat([size.subarray(2), body]));
  return promise;
}
const timer = setTimeout(() => { child.kill(); console.error('Native Messaging smoke timeout'); process.exitCode = 1; }, 90000);
try {
  const [health, wallet, orders] = await Promise.all([request('health'), request('wallet.snapshot'), request('orders.list')]);
  if (health.chainId !== '56' || wallet.status !== 'CONNECTED' || !wallet.address) throw new Error('真实钱包连接未通过');
  let rejected = false; try { await request('exec', { cmd: 'echo forbidden' }); } catch { rejected = true; }
  if (!rejected) throw new Error('方法白名单未生效');
  console.log(JSON.stringify({ nativeProtocol: 'PASS', disallowedMethod: 'REJECTED', health, wallet: { status: wallet.status, address: wallet.address, balance: wallet.native.balance }, orders: orders.records.length }, null, 2));
} finally { clearTimeout(timer); child.stdin.end(); }
