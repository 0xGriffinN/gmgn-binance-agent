import { gmgnContext } from './context.js';
import { officialLoginUrl } from './login-url.js';
const HOST = 'com.gmgn.binance_agent';
let nativePort, loginUrl = null;
const waiting = new Map(), previews = new Map();
const panelTabs=new Set();
function native(method, params) {
  if (!nativePort) {
    nativePort = chrome.runtime.connectNative(HOST);
    nativePort.onMessage.addListener(message => {
      if(['order','position'].includes(message.event)){
        const event=message.event==='order'?{type:'agent-order-update',row:message.data}:{type:'agent-position-update',position:message.data};
        for(const tabId of panelTabs)void chrome.tabs.sendMessage(tabId,event).catch(()=>panelTabs.delete(tabId));
        return;
      }
      const p = waiting.get(message.id);
      if (!p) return;
      clearTimeout(p.timer); waiting.delete(message.id);
      if (message.error) p.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); else p.resolve(message.data);
    });
    nativePort.onDisconnect.addListener(() => {
      const why = chrome.runtime.lastError?.message;
      nativePort = null;
      for (const p of waiting.values()) { clearTimeout(p.timer); p.reject(new Error(`本地助手连接中断，请检查安装；已提交交易请先查单。${why || ''}`)); }
      waiting.clear(); previews.clear();
    });
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(['trade.submit','trade.quick','orders.quick-resume'].includes(method) ? '提交结果暂未返回，请在最近订单中核对，勿重复下单' : '请求超时，请重试查询')); }, ['trade.submit', 'trade.quick','orders.quick-resume','auth.verify'].includes(method) ? 325000 : 150000);
    waiting.set(id, { resolve, reject, timer });
    nativePort.postMessage({ id, method, params });
  });
}
async function tabContext(sender, params) {
  const tabId = isIsolatedPanel(sender) ? sender.tab.id : params.tabId ?? sender.tab?.id;
  if (!Number.isInteger(tabId)) throw new Error('请从 GMGN 页面打开面板');
  const tab = await chrome.tabs.get(tabId);
  return { ...gmgnContext(tab.url), tabId };
}
const methods = new Set(['health', 'wallet.snapshot', 'token.route', 'auth.start', 'auth.open', 'auth.verify', 'trade.prepare', 'trade.submit', 'trade.quick', 'orders.quick-resume', 'orders.cancel-queued', 'orders.list', 'orders.refresh', 'orders.reconcile', 'orders.resolve', 'orders.continue', 'orders.attach-hash']);
function isIsolatedPanel(sender) {
  return !!chrome.runtime.id && sender.id === chrome.runtime.id && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && /^https:\/\/(www\.)?gmgn\.ai\//.test(sender.url || '');
}
async function handle(message, sender) {
  if (message.method === 'panel.bootstrap' && sender.frameId === 0 && sender.tab?.id != null && /^https:\/\/(www\.)?gmgn\.ai\//.test(sender.url || '')) {
    return { tabId: sender.tab.id };
  }
  // Only our packaged isolated-world UI or extension-owned document can invoke RPC.
  if (!isIsolatedPanel(sender) && sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('panel.html')) throw new Error('请求来源不被允许');
  if(isIsolatedPanel(sender))panelTabs.add(sender.tab.id);
  const params = message.params || {}, method = message.method;
  if (method === 'context') return tabContext(sender, params);
  if (!methods.has(method)) throw new Error('不支持此操作');
  if (method === 'auth.start') {
    loginUrl = null;
    const data = await native(method, params);
    if (data.status === 'CONNECTED') { loginUrl = null; return data; }
    loginUrl = officialLoginUrl(data.urlForWeb);
    try { await chrome.tabs.create({ url: loginUrl }); return { ...data, loginPageOpened: true }; }
    catch { return { ...data, loginPageOpened: false }; }
  }
  if (method === 'auth.open') {
    if (!loginUrl) throw new Error('登录链接已失效，请重新点击连接钱包');
    await chrome.tabs.create({ url: officialLoginUrl(loginUrl) });
    return { opened: true };
  }
  if (method === 'auth.verify') {
    try { const data = await native(method, params); loginUrl = null; return data; }
    catch (e) { loginUrl = null; throw e; }
  }
  if (method === 'trade.prepare') {
    const ctx = await tabContext(sender, params);
    if (!ctx.supported) throw new Error(ctx.reason);
    if (!params.manual && ctx.token?.toLowerCase() !== params.token?.toLowerCase()) throw new Error('页面 CA 已变化，请重新报价');
    const p = await native(method, params);
    previews.set(p.id, { tabId: ctx.tabId, url: ctx.url });
    return p;
  }
  if(method==='token.route'){
    const ctx=await tabContext(sender,params);if(!ctx.supported)throw new Error(ctx.reason);
    if(!params.manual&&ctx.token?.toLowerCase()!==params.token?.toLowerCase())throw new Error('页面 CA 已变化');
    return native(method,params);
  }
  if(method==='trade.quick'){
    const ctx=await tabContext(sender,params);
    if(!ctx.supported)throw new Error(ctx.reason);
    if(!params.manual&&ctx.token?.toLowerCase()!==params.token?.toLowerCase())throw new Error('页面 CA 已变化，请重新下单');
    return native(method,params);
  }
  if(method==='orders.quick-resume'){
    const ctx=await tabContext(sender,params);if(!ctx.supported)throw new Error(ctx.reason);
    const data=await native('orders.list',{}),row=data.records.find(r=>r.id===params.id);
    if(!row?.steps||(ctx.token&&ctx.token.toLowerCase()!==row.token.toLowerCase()))throw new Error('请回到该订单对应代币页面，或 BSC 首页后恢复');
    return native(method,params);
  }
  if(method==='orders.continue'){
    const ctx=await tabContext(sender,params);if(!ctx.supported)throw new Error(ctx.reason);
    const p=await native(method,params);
    if(ctx.token&&ctx.token.toLowerCase()!==p.input.token.toLowerCase())throw new Error('请回到该订单对应代币页面，或 BSC 首页后继续');
    previews.set(p.id,{tabId:ctx.tabId,url:ctx.url});return p;
  }
  if (method === 'trade.submit') {
    const ctx = await tabContext(sender, params), bound = previews.get(params.previewId);
    if (!bound || !ctx.supported || ctx.tabId !== bound.tabId || ctx.url !== bound.url) throw new Error('页面或助手状态已变化，请重新报价');
    return native(method, params);
  }
  return native(method, params);
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(data => reply({ data })).catch(e => reply({ error: { message: e.message, code: e.code || 'BRIDGE_ERROR' } }));
  return true;
});
chrome.action.onClicked.addListener(async tab => {
  if (!Number.isInteger(tab.id)) return;
  let isGmgn = false;
  try { const u = new URL(tab.url); isGmgn = u.protocol === 'https:' && ['gmgn.ai', 'www.gmgn.ai'].includes(u.hostname); } catch {}
  if (!isGmgn) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: 'GMGN' });
    await chrome.action.setTitle({ tabId: tab.id, title: '请切到 GMGN 页面，再点击恢复悬浮面板' });
    return;
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'show-panel' });
    if (result?.ok !== true) throw new Error('Panel did not acknowledge');
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    await chrome.action.setTitle({ tabId: tab.id, title: '打开币安 Agent 下单面板' });
  } catch {
    await chrome.action.setBadgeText({ tabId: tab.id, text: '刷新' });
    await chrome.action.setTitle({ tabId: tab.id, title: '扩展刚更新或面板未加载，请刷新当前 GMGN 页面后重试' });
  }
});
