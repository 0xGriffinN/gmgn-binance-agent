import test from 'node:test';
import assert from 'node:assert/strict';
const extension = 'chrome-extension://test/';
const TOKEN = '0x1111111111111111111111111111111111111111';
let listener, actionClick, nativeReceive, url = `https://gmgn.ai/bsc/token/${TOKEN}`, nativeCalls = [], actionCalls = [], missingReceiver = false, openedTabs = [], authResponse;
globalThis.chrome = {
  runtime: {
    id: 'test',
    getURL: name => extension + name,
    onMessage: { addListener: fn => { listener = fn; } },
    connectNative: () => {
      let onMessage;
      return { onMessage: { addListener: fn => { onMessage = fn;nativeReceive=fn; } }, onDisconnect: { addListener() {} }, postMessage: m => {
        nativeCalls.push(m);
        queueMicrotask(() => onMessage({ id: m.id, data: m.method === 'auth.start' ? authResponse : m.method === 'trade.prepare' ? { id: 'preview-1' } : { ok: true } }));
      } };
    }
  },
  tabs: { get: async id => ({ id, url }), sendMessage: async (id, message) => { actionCalls.push({ type: 'message', id, message }); if (missingReceiver) throw new Error('No receiver'); return { ok: true }; }, create: async options => { openedTabs.push(options.url); } },
  action: { onClicked: { addListener(fn) { actionClick = fn; } }, setBadgeText: async options => actionCalls.push({ type: 'badge', ...options }), setTitle: async options => actionCalls.push({ type: 'title', ...options }) }
};
await import('../extension/background.js');
function request(method, params = {}, sender = { url: extension + 'panel.html', tab: { id: 1 } }) {
  return new Promise(resolve => listener({ method, params }, sender, resolve));
}
test('webpage and other-extension senders cannot access wallet bridge', async () => {
  nativeCalls = [];
  const a = await request('trade.submit', {}, { url: url, tab: { id: 1 } });
  assert.ok(a.error); assert.equal(nativeCalls.length, 0);
  assert.ok((await request('health', {}, { id: 'other-extension', url, frameId: 0, tab: { id: 1 } })).error);
  assert.ok((await request('health', {}, { url: extension + 'panel.html.fake' })).error);
});
test('CA changed in real browser tab cannot prepare old token', async () => {
  const result = await request('trade.prepare', { token: '0x2222222222222222222222222222222222222222' });
  assert.match(result.error.message, /CA 已变化/);
});

test('quick orders bind to actual BSC tab and reject stale CA and untrusted senders',async()=>{
  url=`https://gmgn.ai/bsc/token/${TOKEN}`;nativeCalls=[];
  assert.ok((await request('trade.quick',{token:'0x2222222222222222222222222222222222222222',quick:true})).error);
  assert.equal(nativeCalls.length,0);
  assert.ok((await request('trade.quick',{token:TOKEN,quick:true},{url,tab:{id:1}})).error);
  assert.equal(nativeCalls.length,0);
  assert.ok((await request('trade.quick',{token:TOKEN,quick:true})).data.ok);
  assert.equal(nativeCalls[0].method,'trade.quick');
});
test('page navigation between quote and confirm prevents swap invocation', async () => {
  url = `https://gmgn.ai/bsc/token/${TOKEN}`;
  const p = await request('trade.prepare', { token: TOKEN }); assert.equal(p.data.id, 'preview-1');
  url = 'https://gmgn.ai/?chain=bsc';
  const before = nativeCalls.length; const r = await request('trade.submit', { previewId: 'preview-1' });
  assert.ok(r.error); assert.equal(nativeCalls.length, before);
});
test('arbitrary methods including contract-call and send are not exposed', async () => {
  for (const method of ['wallet.send', 'contract-call', 'exec', 'auth.signout']) assert.ok((await request(method)).error);
});
test('content bootstrap returns only its own tab id and no wallet capability', async () => {
  const before = nativeCalls.length;
  const result = await request('panel.bootstrap', {}, { url: 'https://gmgn.ai/?chain=bsc', frameId: 0, tab: { id: 7 } });
  assert.deepEqual(result.data, { tabId: 7 }); assert.equal(nativeCalls.length, before);
  assert.ok((await request('panel.bootstrap', {}, { url: 'https://evil.com/', frameId: 0, tab: { id: 7 } })).error);
});
test('packaged isolated-world panel can read wallet health and cannot spoof another tab context', async () => {
  url = `https://gmgn.ai/bsc/token/${TOKEN}`;
  const sender = { id: 'test', url, frameId: 0, tab: { id: 9 } };
  assert.ok((await request('health', {}, sender)).data.ok);
  const ctx = await request('context', { tabId: 777 }, sender);
  assert.equal(ctx.data.tabId, 9); assert.equal(ctx.data.token, TOKEN);
  assert.ok((await request('health', {}, { ...sender, frameId: 2 })).error);
});
test('toolbar restores panel on any GMGN page instead of navigating', async () => {
  actionCalls = []; openedTabs = []; missingReceiver = false;
  await actionClick({ id: 1, url: 'https://gmgn.ai/?chain=sol' });
  assert.equal(actionCalls[0].type, 'message'); assert.equal(actionCalls[0].message.type, 'show-panel');
  assert.ok(actionCalls.some(x => x.type === 'badge' && x.text === ''));
  assert.equal(openedTabs.length, 0);
});
test('missing panel receiver asks to refresh current page without creating any tab', async () => {
  actionCalls = []; openedTabs = []; missingReceiver = true;
  await actionClick({ id: 1, url: 'https://gmgn.ai/?chain=bsc' });
  assert.ok(actionCalls.some(x => x.type === 'badge' && x.text === '刷新'));
  assert.equal(openedTabs.length, 0);
  missingReceiver = false;
});
test('toolbar on an unrelated website never opens GMGN or sends a panel command', async () => {
  actionCalls = []; openedTabs = [];
  await actionClick({ id: 1, url: 'https://example.com/' });
  assert.equal(actionCalls.filter(x => x.type === 'message').length, 0);
  assert.ok(actionCalls.some(x => x.type === 'badge' && x.text === 'GMGN'));
  assert.equal(openedTabs.length, 0);
});
test('login opens exact official URL from background and ignores page-supplied URLs', async () => {
  openedTabs = [];
  const official = 'https://app.binance.com/uni-qr/test?url=test%2Fpair&expireAt=9999999999999';
  authResponse = { status: 'WAITING_APP', urlForWeb: official, pairingCode: '123456' };
  const result = await request('auth.start');
  assert.equal(result.data.loginPageOpened, true); assert.deepEqual(openedTabs, [official]);
  await request('auth.open', { url: 'https://evil.com/' });
  assert.deepEqual(openedTabs, [official, official]);
});
test('invalid official-login origin is rejected before opening a tab', async () => {
  openedTabs = []; authResponse = { status: 'WAITING_APP', urlForWeb: 'https://web3.binance.com.evil.com/login' };
  assert.ok((await request('auth.start')).error); assert.equal(openedTabs.length, 0);
});

test('native order events reach registered isolated panels immediately without another order query',async()=>{
  url=`https://gmgn.ai/bsc/token/${TOKEN}`;actionCalls=[];
  await request('health',{}, {id:'test',url,frameId:0,tab:{id:77}});
  const before=nativeCalls.length;nativeReceive({event:'order',data:{id:'order-1',status:'PENDING'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(actionCalls.some(x=>x.id===77&&x.message?.type==='agent-order-update'&&x.message.row.id==='order-1'));
  assert.equal(nativeCalls.length,before);
});

test('fast platform lookup is limited to the actual BSC tab token',async()=>{
  url=`https://gmgn.ai/bsc/token/${TOKEN}`;nativeCalls=[];
  assert.ok((await request('token.route',{chainId:'56',token:'0x2222222222222222222222222222222222222222'})).error);assert.equal(nativeCalls.length,0);
  const result=await request('token.route',{chainId:'56',token:TOKEN});assert.ok(result.data.ok);assert.equal(nativeCalls[0].method,'token.route');
});

test('verified position updates reach isolated panels without creating a new wallet request',async()=>{
  url=`https://gmgn.ai/bsc/token/${TOKEN}`;actionCalls=[];
  await request('health',{}, {id:'test',url,frameId:0,tab:{id:77}});
  const before=nativeCalls.length;nativeReceive({event:'position',data:{token:TOKEN,balance:'127.5',blockNumber:102}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(actionCalls.some(x=>x.id===77&&x.message?.type==='agent-position-update'&&x.message.position.balance==='127.5'));
  assert.equal(nativeCalls.length,before);
});
