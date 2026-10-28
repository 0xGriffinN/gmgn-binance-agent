import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { config, Wallet, ROOT } from '../host/wallet.mjs';
import { Service } from '../host/service.mjs';
import { Journal } from '../host/journal.mjs';
import { join } from 'node:path';
const cfg = await config(), journal = new Journal(join(ROOT, '.local', 'orders')); await journal.init();
const service = new Service(new Wallet(cfg), journal, cfg);
const files = { '/': ['panel.html', 'text/html'], '/panel.html': ['panel.html', 'text/html'], '/panel.css': ['panel.css', 'text/css'], '/preset-model.js':['preset-model.js','text/javascript'], '/panel.js': ['panel.js', 'text/javascript'] };
const port = Number(process.env.PREVIEW_PORT || 8796);
const server = createServer(async (req, res) => {
  const origin = `http://127.0.0.1:${port}`;
  if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403); return res.end(); }
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'");
  try {
    if (req.url === '/api/read' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 10000) throw new Error('请求过大'); }
      const m = JSON.parse(body); let data;
      if (m.method === 'context') data = { supported: false, reason: '只读预览 · 真实钱包数据；下单请安装 GMGN 扩展', url: origin };
      else if (['health', 'wallet.snapshot', 'orders.list'].includes(m.method)) data = await service.dispatch(m.method, m.params);
      else throw new Error('预览页只允许读取钱包；不支持登录、签名或下单');
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); return res.end(JSON.stringify({ data }));
    }
    const file = files[req.url];
    if (!file || req.method !== 'GET') { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', `${file[1]}; charset=utf-8`); res.end(await readFile(join(ROOT, 'extension', file[0])));
  } catch (e) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: { message: e.code ? e.message : '只读预览请求失败' } })); }
});
server.listen(port, '127.0.0.1', () => console.log(`只读预览： http://127.0.0.1:${port}`));
