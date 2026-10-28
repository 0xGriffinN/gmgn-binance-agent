import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const path = fileURLToPath(new URL('../extension/manifest.json', import.meta.url));
let manifest;
if (existsSync(path)) manifest = JSON.parse(readFileSync(path, 'utf8'));
else {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
  manifest = {
    manifest_version: 3, name: 'GMGN · 币安 Agent 快捷交易', version: '0.5.10', description: '在 GMGN BSC 页面通过 Binance Agentic Wallet 真实报价与买卖',
    key: publicKey.toString('base64'), permissions: ['nativeMessaging', 'storage', 'clipboardRead', 'clipboardWrite'],
    host_permissions: ['https://gmgn.ai/*', 'https://www.gmgn.ai/*'],
    background: { service_worker: 'background.js', type: 'module' }, action: { default_title: '打开币安 Agent 下单面板' },
    content_scripts: [{ matches: ['https://gmgn.ai/*', 'https://www.gmgn.ai/*'], js: ['panel-template.js', 'content.js', 'preset-model.js', 'panel.js'], world: 'ISOLATED', run_at: 'document_idle' }],
    web_accessible_resources: [{ resources: ['panel.html', 'panel.css', 'preset-model.js', 'panel.js'], matches: ['https://gmgn.ai/*', 'https://www.gmgn.ai/*'] }],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'" }
  };
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}
const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
process.stdout.write(id);
