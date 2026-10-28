(() => {
const mount = globalThis.__GMGN_AGENT_MOUNT__;
const panelRoot = mount?.root || document;
const panelBody = mount?.body || document.body;
const $ = id => panelRoot.getElementById(id);
const tabId = mount ? undefined : Number(new URLSearchParams(location.search).get('tabId')) || undefined;
const isExtension = !!mount || location.protocol === 'chrome-extension:';
if (!isExtension) {
  panelRoot.querySelector('.live').textContent = '只读';
  $('notice').textContent = '只读预览，不能提交交易；买卖请在 GMGN 扩展中操作。';
}
let context = {}, snapshot = null, preview = null, manual = false, revision = 0, busy = false, walletAddress = '', lastContextKey = '', verifying = false, activeWorkflow = false;
const prefsKey = 'agentPrefsV1';
let presetGroups=AgentPresets.defaults(),presetGroup=0;
let receiptPosition=null;
function layout(type, extra = {}) { if (mount) mount.layout(type, extra); }
async function rpc(method, params = {}) {
  const message = { method, params: { ...params, tabId } };
  const result = isExtension ? await chrome.runtime.sendMessage(message) : await fetch('/api/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) }).then(r => r.json());
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.data;
}
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function text(id, value) { $(id).textContent = value ?? '—'; }
function short(v) { return v ? `${v.slice(0, 6)}…${v.slice(-4)}` : '—'; }
function money(v) { if (v == null || Number(v) === 0) return '价格未知'; return `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: Number(v) < .01 ? 8 : 2 })}`; }
function number(v, precision = 8) { if (v == null) return '—'; const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: precision }) : '—'; }
function invalidate() { revision++; preview = null; $('review').hidden = true; $('audit-ack').checked = false; updateButtons(); }
function validCa() { return /^0x[0-9a-fA-F]{40}$/.test($('ca').value.trim()); }
function blocksTrading(row){
  if(!row||row.queued||['FINISHED','PARTIAL','FAILED','NOT_SUBMITTED','MANUALLY_RECONCILED'].includes(row.status))return false;
  const idle=!!row.afterSell&&['WAITING_NEXT','PAUSED'].includes(row.status)&&!row.blocked&&(!row.quick||row.status==='PAUSED'||row.quick.expiresAt<=Date.now())&&row.steps?.length>0&&row.steps.every(s=>s.status==='FINISHED');
  return !idle;
}
function updateButtons() {
  const enabled = !busy && snapshot?.status === 'CONNECTED' && context.supported && validCa();
  $('buy').disabled = !enabled; $('sell').disabled = !enabled;
  $('buy').textContent='买入';$('sell').textContent='卖出';
  for(const container of ['buy-presets','buy-supply-presets','sell-presets'])for(const button of $(container).querySelectorAll('button'))button.disabled=!enabled;
  $('confirm').disabled = busy || !preview || (!preview.audit.available && !$('audit-ack').checked);
}
function setBusy(value) { busy = value; updateButtons(); }
async function getPrefs() {
  if (isExtension) return (await chrome.storage.local.get(prefsKey))[prefsKey] || {};
  try { return JSON.parse(localStorage.getItem(prefsKey) || '{}'); } catch { return {}; }
}
async function savePrefs() {
  const p = Object.fromEntries(['buy-amount', 'sell-percent', 'buy-slippage', 'sell-slippage', 'buy-custom', 'sell-custom', 'gas'].map(id => [id, $(id).value]));
  p.presetGroups=presetGroups;p.presetGroup=presetGroup;
  p.mev = $('mev').checked; p.dark = panelBody.classList.contains('dark');
  p.approvalCap=$('approval-cap').checked;p.sellToBnb=$('sell-to-bnb').checked;
  if (isExtension) await chrome.storage.local.set({ [prefsKey]: p }); else localStorage.setItem(prefsKey, JSON.stringify(p));
}
async function syncContext() {
  const next = await rpc('context');
  const key = `${next.url}|${next.supported}|${next.token || ''}`;
  if (key !== lastContextKey) {
    lastContextKey = key; context = next; manual = false; invalidate();
    $('ca').value = next.token || '';snapshot = null;receiptPosition=null;text('token-name',next.token?'识别中…':'待选择代币');text('holding-balance', '—'); text('holding-value', '—');text('position-cost','成本 / 盈亏：暂无可核对记录');
    renderSupplyPresets(null);
    text('context-note', next.supported ? (next.token ? '已跟随当前 GMGN · BSC 代币' : 'BSC 页面 · 可手动粘贴 CA') : next.reason);
    text('ca-source', '自动识别');
    if (next.supported) {void refreshRoute();void refreshWallet();}
  }
  context = next; updateButtons();
}
let routeRequest=0;
function showRoute(route){
  if(!route?.platform)return;
  text('context-note',`${route.platform.toUpperCase()} · ${route.kind} · ${route.stage==='inner'?'内盘':route.stage==='outer'?'外盘':'迁移中'}`);
  renderSupplyPresets(route);
}
async function refreshRoute(force=false){
  if(!isExtension||!validCa())return;
  const token=$('ca').value.trim(),generation=++routeRequest;
  try{
    const route=await rpc('token.route',{chainId:'56',token,manual,force});
    if(generation!==routeRequest||token!==$('ca').value.trim())return;
    showRoute(route);
  }catch(e){if(generation===routeRequest&&token===$('ca').value.trim())text('context-note',`平台识别未完成：${e.message}`);}
}
let walletRequest = 0,walletJob=null;
async function refreshWallet() {
  const token=validCa()?$('ca').value.trim():undefined;
  if(walletJob&&walletJob.token===token)return walletJob.promise;
  const job={token,promise:null};walletJob=job;
  job.promise=loadWallet(token).finally(()=>{if(walletJob===job)walletJob=null;});return job.promise;
}
async function loadWallet(token){
  const generation = ++walletRequest;
  try {
    const data = await rpc('wallet.snapshot', { token,amount:$('buy-amount').value.trim(),slippage:getSlippage('buy') });
    if (generation !== walletRequest || token !== (validCa() ? $('ca').value.trim() : undefined)) return;
    if(receiptPosition&&receiptPosition.wallet.toLowerCase()===data.address?.toLowerCase()&&receiptPosition.token.toLowerCase()===token?.toLowerCase()&&
      ((data.holding?.blockNumber||0)<receiptPosition.blockNumber)&&(data.holding?.blockNumber||Date.now()-receiptPosition.confirmedAt<30000)){
      const price=Number(data.holding?.price);data.holding={...data.holding,...receiptPosition,value:Number(receiptPosition.balance)===0?'0':price>0?String(Number(receiptPosition.balance)*price):null};data.accounting=null;
    }
    snapshot = data;
    text('token-name',data.token?.symbol||data.holding?.symbol||(token?'代币':'待选择代币'));
    $('ca').title=token||'';
    $('status').parentElement.classList.toggle('connected', data.status === 'CONNECTED');
    $('status').replaceChildren(Object.assign(document.createElement('i')), document.createTextNode(data.status === 'CONNECTED' ? '已连接钱包' : '钱包未连接'));
    $('login').hidden = data.status === 'CONNECTED';
    walletAddress = data.address || ''; text('wallet-address', short(walletAddress)); $('wallet-address').title = walletAddress || '钱包未连接';
    text('native-balance', data.native ? `${number(data.native.balance)} BNB` : '— BNB');
    text('quota', data.settings?.quotaLeft != null ? `日额度余 $${number(data.settings.quotaLeft, 2)}` : '');
    text('holding-balance', data.holding ? `${number(data.holding.balance, 10)} ${data.holding.symbol || 'Token'}` : '—');
    $('holding-balance').title=data.holding?.blockNumber?`链上余额 · 区块 ${data.holding.blockNumber}`:'钱包余额';
    showAccounting(data.accounting);
    text('holding-value', !data.holding ? '—' : Number(data.holding.balance) === 0 ? '$0.00' : money(data.holding.value));
    const expires = data.settings?.sessionExpireTime;
    text('session', expires ? `会话至 ${new Date(expires).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}` : '会话未连接');
    if (expires && new Date(expires) - Date.now() < 3 * 3600000) notice('钱包会话即将到期，届时需在币安 App 重新登录。');
    if (data.status !== 'CONNECTED') invalidate();
    if(data.route)showRoute(data.route);
    updateButtons();
  } catch (e) {
    if (generation !== walletRequest) return;
    snapshot = null; walletAddress = ''; text('native-balance', '— BNB'); text('holding-balance', '—'); text('holding-value', '—');
    text('wallet-address', '—'); text('status', '助手未连接'); $('status').parentElement.classList.remove('connected');
    $('login').hidden = false; notice(e.message, true); invalidate();
  }
}
function showAccounting(a){
  const el=$('position-cost');if(!a){el.textContent='成本 / 盈亏：暂无可核对记录';return;}
  el.textContent=a.costBnb!=null?`成本估算 ${number(a.costBnb)} BNB · 估算浮盈 ${a.unrealizedBnb==null?'价格未知':number(a.unrealizedBnb)+' BNB'}`:`成本 / 盈亏：${a.reason}`;
  el.title=`仅按本面板链上已核实成交计算；买入 BNB 等值为估算。已实现盈亏：${a.realizedBnb==null?'暂不可核对':number(a.realizedBnb)+' BNB'}。${a.note||''}`;
}
function applyReceiptPosition(p){
  if(!p||p.wallet?.toLowerCase()!==walletAddress.toLowerCase()||p.token?.toLowerCase()!==$('ca').value.trim().toLowerCase()||!Number.isSafeInteger(p.blockNumber))return;
  if(p.blockNumber<Math.max(receiptPosition?.blockNumber||0,snapshot?.holding?.blockNumber||0))return;
  receiptPosition=p;
  const price=Number(snapshot?.holding?.price),value=Number(p.balance)===0?'$0.00':price>0?money(Number(p.balance)*price):'价格未知';
  text('holding-balance',`${number(p.balance,10)} ${p.symbol||'Token'}`);text('holding-value',value);$('holding-balance').title=`已核实成交后的链上余额 · 区块 ${p.blockNumber}`;
  text('position-cost','成交已确认 · 正在更新成本');
  const previousJob=walletJob;void refreshWallet().then(()=>{if(previousJob)return refreshWallet();});
}
function getSlippage(side) { return $(`${side}-slippage`).value === 'custom' ? $(`${side}-custom`).value.trim() : $(`${side}-slippage`).value; }
async function prepare(side, event, pctSupply) {
  if (!event.isTrusted || busy) return;
  invalidate(); setBusy(true); notice('正在保存交易指令…');
  try {
    const row = await rpc('trade.quick', { chainId: '56', token: $('ca').value.trim(), side, amount: $('buy-amount').value.trim(), percent: $('sell-percent').value.trim(),
      clickedAt:Date.now(),expectedWallet:walletAddress,requestId:crypto.randomUUID(),slippage: getSlippage(side), mev: $('mev').checked, gasLevel: $('gas').value, manual, quick: true, acknowledgeUnavailable: true,
      approvalCap:$('approval-cap').checked,sellToBnb:$('sell-to-bnb').checked,...(pctSupply?{pctSupply}:{}) });
    notice(row.message, ['UNKNOWN','NOT_SUBMITTED','FAILED','PAUSED'].includes(row.status));
    void refreshOrders();
  } catch (e) { notice(e.message, true); }
  finally { setBusy(false); }
}
function detail(parent, label, value) {
  const line = document.createElement('div');
  const strong = document.createElement('strong'); strong.textContent = label;
  line.append(strong, document.createTextNode(` ${value ?? '—'}`)); parent.append(line);
}
function renderReview(p) {
  const d = $('review-details'); d.replaceChildren();
  detail(d, '网络', 'BSC · 56'); detail(d, '钱包', p.owner); detail(d, 'CA', p.input.token);
  if(p.route)detail(d,'交易路由',p.route.label);
  if(p.step)detail(d,'本次确认步骤',p.step.label);
  if(p.note)detail(d,'说明',p.note);
  detail(d, p.input.side === 'buy' ? p.route?'预算（BNB 等值）':'支付' : '卖出', `${p.amount} ${p.quote.fromCoinSymbol}`);
  if(p.step?.spendToken)detail(d,'本步实际支付',`${p.step.spendAmount} ${p.step.spendSymbol}（${p.step.spendToken}）`);
  detail(d, p.step&&p.step.role!=='trade'?'最终交易预估（继续时重报）':'预计收到', `${p.quote.toCoinAmount} ${p.quote.toCoinSymbol}`);
  if(p.step?.kind==='market')detail(d,'本步兑换',`${p.step.amount} ${p.step.quote.fromCoinSymbol} → 预计 ${p.step.quote.toCoinAmount} ${p.step.quote.toCoinSymbol}`);
  detail(d, '滑点', p.input.slippage === 'auto' ? `自动（本次报价 ${Number(p.quote.slippage) * 100}%）` : `${p.input.slippage}%`);
  detail(d, 'MEV / Gas', `${p.input.mev ? '开启' : '关闭'} / ${p.input.gasLevel}`);
  if(p.step?.kind==='contract'){
    detail(d,'合约地址',p.step.to);detail(d,'本步支付 BNB',p.step.value==='0'?'0':String(Number(p.step.value)/1e18));
    detail(d,'Gas / MEV','合约调用由钱包估算 Gas；面板 Gas/MEV 档位仅作用于币安聚合步骤');
    const parsed=document.createElement('details'),summary=document.createElement('summary');summary.textContent='查看钱包解析、模拟结果、风险和权限变更';parsed.append(summary);
    const pre=document.createElement('pre');pre.style.whiteSpace='pre-wrap';pre.style.wordBreak='break-all';pre.textContent=JSON.stringify(p.contractPreview,null,2);parsed.append(pre);d.append(parsed);
  }
  const a = p.audit;
  const lines = a.trusted ? ['收款资产为内置常用资产。'] : !a.available ? [a.message] : [
    `审计：${a.level || '未知'} · 合约验证：${a.verified === true ? '已验证' : a.verified === false ? '未验证' : '未知'}`,
    `买税 ${a.buyTax ?? '未知'}% / 卖税 ${a.sellTax ?? '未知'}%`, ...a.hits.map(h => `${h.title}：${h.description}`), '审计仅供参考，请自行研究。'
  ];
  text('audit', lines.join('\n')); $('audit-ack-wrap').hidden = a.available; $('audit-ack').checked = false;
  $('confirm').textContent = p.step?`确认本步：${p.step.label}`:p.input.side === 'buy' ? `确认买入 · ${p.amount} BNB` : `确认卖出 · ${p.input.percent}%`;
  $('review').hidden = false; $('review').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); updateButtons();
}
async function submit(event) {
  if (!event.isTrusted || busy || !preview) return;
  const p = preview; setBusy(true);
  try {
    if (Date.now() >= p.expiresAt) throw new Error('报价已过期，请重新点击买入或卖出获取报价');
    notice('正在提交真实交易；如触发风控，请在币安 App 审批。');
    const row = await rpc('trade.submit', { previewId: p.id, confirmed: true, acknowledgeUnavailable: $('audit-ack').checked });
    invalidate(); notice(row.message, ['UNKNOWN', 'NOT_SUBMITTED', 'FAILED'].includes(row.status));
    await refreshOrders(); void refreshWallet();
  } catch (e) { invalidate(); notice(e.message, true); void refreshOrders(); }
  finally { setBusy(false); }
}
const labels = { QUEUED:'排队中',QUEUE_STARTING:'最新报价中',DISPATCHED:'已进入交易',CANCELLED:'已取消排队',EXPIRED:'排队已过期',REJECTED:'未执行', VALIDATING: '检查中', SUBMITTING: '提交中 / 可能待 App 审批', PENDING: '处理中', APP_CONFIRM:'待 App 审批',WAITING_NEXT:'等待确认下一步',PAUSED:'流程暂停', FINISHED: '已成交', PARTIAL: '部分完成 / 有退款', FAILED: '失败', UNKNOWN: '结果待核对', NOT_SUBMITTED: '未提交', MANUALLY_RECONCILED: '已人工核对' };
let checkingOrders = false;
async function refreshOrders() {
  if (checkingOrders) return;
  checkingOrders = true;
  try {
    const data = await rpc('orders.list');
    activeWorkflow = blocksTrading(data.active); updateButtons();
    const rows = data.records.slice(0, 10);
    if (data.active && !rows.some(r => r.id === data.active.id)) rows.unshift(data.active);
    renderOrders(rows);
    if(data.active?.quick)notice(data.active.message, ['UNKNOWN','PAUSED'].includes(data.active.status));
    for (const row of rows.filter(r => (r.orderId||r.steps?.length) && !['FINISHED', 'PARTIAL', 'FAILED','WAITING_NEXT','PAUSED','NOT_SUBMITTED'].includes(r.status)).slice(0, 3)) {
      try {
        const updated = await rpc('orders.refresh', { id: row.id });
        if (updated.status !== row.status) { rows[rows.indexOf(row)] = updated; renderOrders(rows); void refreshWallet(); }
      } catch (e) { notice(`查单暂未完成：${e.message}`, true); }
    }
  } catch (e) { notice(e.message, true); }
  finally { checkingOrders = false; }
}
let lastOrdersFingerprint = '';
let latestOrderRows=[];
function renderOrders(rows) {
  latestOrderRows=rows;
  const fingerprint = JSON.stringify(rows);
  if (fingerprint === lastOrdersFingerprint) return;
  lastOrdersFingerprint = fingerprint;
  const box = $('orders'); box.replaceChildren();
  if (!rows.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '暂无本地订单'; box.append(p); return; }
  for (const row of rows) {
    const el = document.createElement('article'); el.className = 'order-row';
    const head = document.createElement('div'); head.className = 'order-head';
    const side = document.createElement('b'); side.className = row.side === 'buy' ? 'buy-text' : 'sell-text'; side.textContent = `${row.side === 'buy' ? '买入' : '卖出'} ${row.amount || ''}`;
    if(row.queued&&row.pctSupply)side.textContent=`买入 百${row.pctSupply}`;
    if(row.buyTarget)side.textContent=`买入 百${row.buyTarget.requestedPct} · ${row.amount} BNB 等值`;
    const status = document.createElement('span'); status.textContent = row.quick&&row.status==='WAITING_NEXT'?'自动执行下一步':row.afterSell&&row.status==='WAITING_NEXT'?'已卖出 · 待换回 BNB':labels[row.status] || row.status; head.append(side, status); el.append(head);
    if(row.quick||row.afterSell||row.queued){const progress=document.createElement('p');progress.textContent=row.message;el.append(progress);}
    const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = `${short(row.token)} · ${new Date(row.createdAt || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })}`;
    details.append(summary); detail(details, 'CA', row.token); detail(details, '请求', row.id); if (row.orderId) detail(details, '订单', row.orderId); detail(details, '说明', row.message);
    if(row.blockedBy){detail(details,'正在等待的前单',row.blockedBy.id);detail(details,'前单步骤',`${row.blockedBy.step} · ${labels[row.blockedBy.status]||row.blockedBy.status}`);}
    if(row.buyTarget){const b=row.buyTarget;detail(details,'筹码目标',`总量 ${b.requestedPct}% · 预计 ${b.estimatedTokens} ${b.symbol}（约 ${b.estimatedPct}%）`);if(b.note)detail(details,'数量调整',b.note);}
    if (row.result?.toTokenActualQty) detail(details, '实际收到', row.result.toTokenActualQty);
    if(row.status==='FINISHED'&&row.requestedAt&&row.steps?.at(-1)?.confirmedAt)detail(details,'请求至完成',`${((row.steps.at(-1).confirmedAt-row.requestedAt)/1000).toFixed(2)} 秒`);
    for(const [index,step] of (row.steps||[]).entries()){
      detail(details,`步骤 ${index+1}`,`${step.label} · ${labels[step.status]||step.status}`);
      if(step.inputRemainderAmount)detail(details,'本步实际兑换',`${step.actualInputAmount} ${step.inputSymbol||''}；未使用 ${step.inputRemainderAmount}，保留在钱包`);
      if(step.prepareMs!=null)detail(details,'耗时',`准备 ${step.prepareMs}ms · 检查 ${step.validationMs??'—'}ms · 提交 ${step.submitMs??'—'}ms · 确认 ${step.confirmationMs??'—'}ms`);
      if(step.prepareTiming){const t=step.prepareTiming;detail(details,'准备明细',`身份 ${t.identityMs}ms · 路由/余额/审计 ${t.contextMs}ms · 构造报价 ${t.routeBuildMs}ms · 合约预演 ${t.previewMs}ms`);}
      if(step.txHash&&/^0x[0-9a-fA-F]{64}$/.test(step.txHash)){const link=document.createElement('a');link.href=`https://bscscan.com/tx/${step.txHash}`;link.textContent=`查看步骤 ${index+1} 交易 ↗`;link.target='_blank';link.rel='noreferrer';details.append(link);}
    }
    for (const r of row.result?.refund || []) detail(details, '退款', `${r.amount} ${r.symbol} (${r.tokenAddress})`);
    el.append(details);
    if(row.queued&&row.status==='QUEUED'){const cancel=document.createElement('button');cancel.textContent='取消排队';cancel.onclick=async e=>{if(!e.isTrusted)return;try{await rpc('orders.cancel-queued',{id:row.id});await refreshOrders();}catch(e){notice(e.message,true);}};el.append(cancel);}
    if(['WAITING_NEXT','PAUSED'].includes(row.status)&&!row.blocked){
      if(row.quick){
        if(row.status==='PAUSED'){
          const resume=document.createElement('button');resume.textContent='恢复快捷交易';resume.onclick=async event=>{
            if(!event.isTrusted||busy)return;setBusy(true);
            try{const result=await rpc('orders.quick-resume',{id:row.id});notice(result.message);await refreshOrders();}catch(e){notice(e.message,true);}finally{setBusy(false);}
          };el.append(resume);
        }
      }else{
      const next=document.createElement('button');next.textContent=row.afterSell?'换回 BNB':'继续完成交易';next.onclick=async event=>{
        if(!event.isTrusted||busy)return;invalidate();setBusy(true);
        try{const result=await rpc('orders.quick-resume',{id:row.id,confirmed:true,acknowledgeUnavailable:true});notice(result.message);await refreshOrders();}catch(err){notice(err.message,true);}finally{setBusy(false);}
      };el.append(next);
      }
    }
    const last=row.steps?.at(-1);
    if(last?.kind==='contract'&&!last.txHash&&['APP_CONFIRM','UNKNOWN','PENDING'].includes(row.status)){
      const hash=document.createElement('input');hash.placeholder='App 批准后的完整交易哈希';hash.setAttribute('aria-label','交易哈希');hash.style.width='100%';
      const attach=document.createElement('button');attach.textContent='核对该哈希并继续查单';attach.onclick=async event=>{if(!event.isTrusted)return;try{await rpc('orders.attach-hash',{id:row.id,txHash:hash.value.trim()});void refreshOrders();}catch(err){notice(err.message,true);}};details.append(hash,attach);
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(row.result?.txHash)) { const a = document.createElement('a'); a.href = `https://bscscan.com/tx/${row.result.txHash}`; a.textContent = `查看交易 ${short(row.result.txHash)} ↗`; a.target = '_blank'; a.rel = 'noreferrer'; el.append(a); }
    if (['UNKNOWN', 'SUBMITTING', 'VALIDATING'].includes(row.status) && !row.orderId) {
      const b = document.createElement('button'); b.textContent = '核对钱包近期订单'; b.onclick = async e => {
        if (!e.isTrusted) return;
        try {
          const info = await rpc('orders.reconcile', { id: row.id });
          details.open = true; detail(details, '钱包锁', info.walletLock.status);
          for (const r of info.recent.slice(0, 10)) detail(details, `${r.orderId} · ${r.status}`, `${r.fromToken} → ${r.toToken} / ${r.fromTokenQty} / ${r.txHash || '无哈希'}`);
          notice('结果未知时不会重试或自动解除锁；请结合币安订单、链上记录和余额核对。');
          if (row.status === 'UNKNOWN' && !details.querySelector('.resolve-input')) {
            detail(details, '如确认未成交，可输入下列全文后人工解除本地锁：', '我已核对订单、链上记录及余额，确认本次请求未成交');
            const field = document.createElement('textarea'); field.className = 'resolve-input'; field.setAttribute('aria-label', '人工核对确认文字');
            const resolve = document.createElement('button'); resolve.textContent = '确认未成交，解除本地锁';
            resolve.onclick = async event => {
              if (!event.isTrusted) return;
              resolve.disabled = true;
              try { const result = await rpc('orders.resolve', { id: row.id, confirmation: field.value }); notice(result.message); void refreshOrders(); }
              catch (err) { notice(err.message, true); }
              finally { resolve.disabled = false; }
            };
            details.append(field, resolve);
          }
        } catch (err) { notice(err.message, true); }
      }; el.append(b);
    }
    box.append(el);
  }
}
function presetButtons(id, values, suffix, target) {
  for (const value of values) { const b = document.createElement('button'); b.textContent = `${value}${suffix}`;b.title=`点击立即${suffix?'卖出':'买入'} ${value}${suffix||' BNB'}`;b.dataset.tradePreset='true';b.disabled=true;b.addEventListener('click', e => { if (!e.isTrusted||busy) return; $(target).value = value; invalidate(); void savePrefs();void prepare(suffix?'sell':'buy',e); }); $(id).append(b); }
}
let supplyPresetKey='';
function renderSupplyPresets(route){
  const key=route?`${route.platform}:${route.kind}:${route.stage}`:'unknown';if(key===supplyPresetKey)return;supplyPresetKey=key;
  const box=$('buy-supply-presets');box.replaceChildren();
  if(!route){text('buy-supply-note','识别平台后显示筹码按钮');return;}
  const capped=route.stage==='inner'&&['gang','four'].includes(route.platform);
  const values=capped?['1']:route.stage==='inner'&&route.platform==='flap'?['1','2']:['0.1','0.5','1','2'];
  text('buy-supply-note',route.kind==='fair'?'按认购剩余份额计算，数量受单笔上限约束':capped?'单钱包最多总量 1%，按剩余额度计算':route.stage==='inner'?'按链上剩余额度计算，数量受单笔上限约束':'按代币总量比例计算，数量受单笔上限约束');
  for(const value of values){const b=document.createElement('button');b.textContent=`百${value}`;b.title=`点击买入总量 ${value}%；按钱包剩余额度和单笔上限调整`;b.disabled=true;b.onclick=e=>{if(e.isTrusted&&!busy)void prepare('buy',e,value);};box.append(b);}
  updateButtons();
}
function renderPresetGroup(){
  $('buy-presets').replaceChildren();$('sell-presets').replaceChildren();
  const group=presetGroups[presetGroup];presetButtons('buy-presets',group.buy,'','buy-amount');presetButtons('sell-presets',group.sell,'%','sell-percent');
  $('preset-buy').value=group.buy.join(', ');$('preset-sell').value=group.sell.join(', ');
  for(const [i,b]of Array.from($('preset-groups').querySelectorAll('button')).entries())b.classList.toggle('selected',i===presetGroup);
  updateButtons();
}
for(let i=0;i<3;i++){const b=document.createElement('button');b.textContent=`P${i+1}`;b.onclick=e=>{if(!e.isTrusted)return;presetGroup=i;renderPresetGroup();void savePrefs();};$('preset-groups').append(b);}
$('preset-save').onclick=e=>{if(!e.isTrusted)return;try{presetGroups[presetGroup]={buy:AgentPresets.values($('preset-buy').value,'buy',snapshot?.maxBuyBnb||'0.1'),sell:AgentPresets.values($('preset-sell').value,'sell')};renderPresetGroup();void savePrefs();notice('快捷数值已保存');}catch(e){notice(e.message,true);}};
$('preset-reset').onclick=e=>{if(!e.isTrusted)return;presetGroups[presetGroup]=AgentPresets.defaults()[presetGroup];renderPresetGroup();void savePrefs();};
renderPresetGroup();
$('buy').addEventListener('click', e => void prepare('buy', e)); $('sell').addEventListener('click', e => void prepare('sell', e));
$('confirm').addEventListener('click', submit); $('cancel-review').addEventListener('click', invalidate); $('audit-ack').addEventListener('change', updateButtons);
for (const id of ['buy-amount', 'sell-percent', 'buy-slippage', 'sell-slippage', 'buy-custom', 'sell-custom', 'gas', 'mev']) {
  $(id).addEventListener('input', () => { invalidate(); void savePrefs(); });
}
for(const id of ['approval-cap','sell-to-bnb'])$(id).addEventListener('change',()=>{invalidate();void savePrefs();});
for (const side of ['buy', 'sell']) $(`${side}-slippage`).addEventListener('change', () => { $(`${side}-custom`).hidden = $(`${side}-slippage`).value !== 'custom'; });
$('ca').addEventListener('input', () => { manual = true; invalidate();renderSupplyPresets(null);text('token-name',validCa()?'识别中…':'待选择代币');text('ca-source', '手动 CA'); text('holding-balance', '—'); text('holding-value', '—'); });
$('ca').addEventListener('change', () => {void refreshRoute();void refreshWallet();});
$('copy-ca').onclick=async e=>{if(!e.isTrusted||!validCa())return;try{await navigator.clipboard.writeText($('ca').value.trim());notice('完整 CA 已复制。');}catch{notice('无法复制，请直接选择 CA 文本复制。',true);}};
$('follow').onclick = () => { lastContextKey = ''; void syncContext(); };
$('paste').onclick = async e => { if (!e.isTrusted) return; try { $('ca').value = (await navigator.clipboard.readText()).trim(); manual = true; text('ca-source', '手动 CA'); invalidate(); void refreshRoute();void refreshWallet(); } catch { notice('无法读取剪贴板，请直接粘贴到 CA 输入框。', true); } };
$('wallet-address').onclick = async () => { if (walletAddress) { try { await navigator.clipboard.writeText(walletAddress); notice(`钱包地址已复制：${walletAddress}`); } catch { notice(walletAddress); } } };
$('refresh').onclick = () => { void refreshRoute(true);void refreshWallet(); void refreshOrders(); };
$('orders-refresh').onclick = () => void refreshOrders();
$('connect').onclick = async e => {
  if (!e.isTrusted || verifying) return;
  $('connect').disabled = true; $('connect').textContent = '正在连接钱包…';
  text('pairing', '正在检查本地助手并获取币安登录信息…');
  $('login-link').hidden = true; $('verify').hidden = true;
  $('login').scrollIntoView({ block: 'nearest' });
  try {
    const a = await rpc('auth.start');
    if (a.status === 'CONNECTED') {
      await refreshWallet();
      if (snapshot?.status === 'CONNECTED') notice('币安 Agent 钱包已连接。');
      else text('pairing', $('notice').textContent);
      return;
    }
    text('pairing', `请在币安 App 核对配对码：\n${a.pairingCode}\n${a.loginPageOpened ? '官方登录页已打开，请扫码并在 App 确认。' : '请点击下方链接打开官方登录页。'}`);
    $('login-link').href = a.urlForWeb; $('login-link').hidden = false; $('verify').hidden = false;
    // The background opens the exact official URL with tabs.create, avoiding popup blocking.
    void verify();
  } catch (err) { text('pairing', `连接未完成：${err.message}`); notice(err.message, true); }
  finally { $('connect').disabled = verifying; $('connect').textContent = verifying ? '等待币安 App 确认…' : '连接币安 Agent 钱包'; }
};
$('login-link').onclick = async e => {
  if (!e.isTrusted || !isExtension) return;
  e.preventDefault();
  try { await rpc('auth.open'); }
  catch (err) { text('pairing', `打开登录页失败：${err.message}`); notice(err.message, true); }
};
async function verify() {
  if (verifying) return;
  verifying = true; $('verify').disabled = true; notice('等待币安 App 确认，登录验证最长约 5 分钟…');
  try {
    const a = await rpc('auth.verify');
    const message = a.status === 'CONNECTED' ? '币安 Agent 钱包已连接。' : '登录尚未完成，请重新点击连接获取新的配对码。';
    text('pairing', message); notice(message); await refreshWallet();
  }
  catch (e) { text('pairing', `登录验证未完成：${e.message}\n请重新点击连接，获取新的配对码。`); $('login-link').hidden = true; $('verify').hidden = true; notice(e.message, true); }
  finally { verifying = false; $('verify').disabled = false; $('connect').disabled = false; $('connect').textContent = '连接币安 Agent 钱包'; }
}
$('verify').onclick = e => { if (e.isTrusted) void verify(); };
$('theme').onclick = () => { panelBody.classList.toggle('dark'); void savePrefs(); };
let collapsed = false;
if (mount) mount.show = () => {
  collapsed = false; $('main').hidden = false; layout('collapse', { collapsed: false });
  void chrome.storage.local.set({ panelCollapsed: false });
};
$('collapse').onclick = async () => { collapsed = !collapsed; $('main').hidden = collapsed; layout('collapse', { collapsed }); if (isExtension) await chrome.storage.local.set({ panelCollapsed: collapsed }); };
$('close').onclick = () => layout('close');
let dragging = null;
$('dragbar').addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('button')) return;
  e.preventDefault(); dragging = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  layout('move-start'); $('dragbar').setPointerCapture(e.pointerId);
});
$('dragbar').addEventListener('pointermove', e => {
  if (!dragging || e.pointerId !== dragging.pointerId) return;
  layout('move', { dx: e.clientX - dragging.x, dy: e.clientY - dragging.y });
});
function finishDrag(e) {
  if (!dragging || e.pointerId !== dragging.pointerId) return;
  dragging = null; layout('move-end');
}
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('dragbar').addEventListener(event, finishDrag);
async function start() {
  const prefs = await getPrefs();
  presetGroups=AgentPresets.load(prefs.presetGroups);presetGroup=Number.isInteger(prefs.presetGroup)&&prefs.presetGroup>=0&&prefs.presetGroup<3?prefs.presetGroup:0;renderPresetGroup();
  for (const [id, value] of Object.entries(prefs)) if ($(id) && typeof value === 'string') $(id).value = value;
  if (typeof prefs.mev === 'boolean') $('mev').checked = prefs.mev;
  if(typeof prefs.approvalCap==='boolean')$('approval-cap').checked=prefs.approvalCap;
  if(typeof prefs.sellToBnb==='boolean')$('sell-to-bnb').checked=prefs.sellToBnb;
  panelBody.classList.toggle('dark', !!prefs.dark);
  for (const side of ['buy', 'sell']) $(`${side}-custom`).hidden = $(`${side}-slippage`).value !== 'custom';
  if (isExtension) { collapsed = !!(await chrome.storage.local.get('panelCollapsed')).panelCollapsed; $('main').hidden = collapsed; layout('collapse', { collapsed }); }
  updateButtons();
  try { await rpc('health'); await syncContext(); await refreshOrders(); }
  catch (e) { notice(e.message, true); $('login').hidden = false; }
}
void start();
if(isExtension)chrome.runtime.onMessage.addListener(message=>{
  if(message.type==='agent-position-update'){applyReceiptPosition(message.position);return;}
  if(message.type!=='agent-order-update'||!message.row?.id)return;
  const row=message.row;
  const previous=latestOrderRows.filter(r=>r.id!==row.id&&r.id!==row.queueId);
  renderOrders((row.status==='DISPATCHED'?previous:[row,...previous]).sort((a,b)=>b.createdAt-a.createdAt).slice(0,10));
  activeWorkflow=latestOrderRows.some(blocksTrading);updateButtons();
  if(row.quick)notice(row.message,['UNKNOWN','PAUSED','FAILED'].includes(row.status));
  if(!row.queued&&!activeWorkflow)void refreshWallet();
});
setInterval(() => { if (!document.hidden) void syncContext().catch(e => notice(e.message, true)); }, 1200);
setInterval(() => { if (!document.hidden) { void refreshWallet(); void refreshOrders(); } }, 20000);
setInterval(() => { if (!document.hidden && activeWorkflow) void refreshOrders(); }, 5000);
setInterval(() => {
  if (!preview) return;
  if (preview.expiresAt <= Date.now()) { invalidate(); notice('报价已过期，请重新获取。'); }
  else $('confirm').textContent = `${preview.step?`确认：${preview.step.label}`:preview.input.side === 'buy' ? '确认买入' : '确认卖出'} · ${Math.ceil((preview.expiresAt - Date.now()) / 1000)}s`;
}, 1000);
})();
