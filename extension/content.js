(() => {
  if (document.getElementById('binance-agent-host')) return;
  const root = document.createElement('div'); root.id = 'binance-agent-host';
  const shadow = root.attachShadow({ mode: 'closed' });
  const body = document.createElement('div'); body.className = 'agent-panel-body';
  Object.assign(body.style, { height: '100%', overflowY: 'auto' });
  function element(node) {
    if (typeof node === 'string') return document.createTextNode(node);
    const el = document.createElement(node.tag);
    for (const [name, value] of Object.entries(node.attrs)) el.setAttribute(name, value);
    for (const child of node.children) el.append(element(child));
    return el;
  }
  const assets = globalThis.__GMGN_AGENT_TEMPLATE__;
  if (!assets) body.textContent = '面板资源未加载，请重新加载扩展并刷新 GMGN。';
  else {
    const sheet = new CSSStyleSheet();
    // Only rewrite selector tokens, never hyphenated class names such as editor-body.
    sheet.replaceSync(assets.css.replace(/:root/g, ':host').replace(/(?<![\w-])body(?=[\s.{:#>+~\[,])/g, '.agent-panel-body'));
    shadow.adoptedStyleSheets = [sheet];
    for (const node of assets.nodes) body.append(element(node));
  }
  Object.assign(root.style, { position: 'fixed', top: '0', left: '0', width: 'min(380px, calc(100vw - 16px))', height: 'min(840px, calc(100vh - 24px))', zIndex: '2147483647', borderRadius: '18px', overflow: 'hidden', boxShadow: '0 18px 65px #0008', colorScheme: 'light' });
  root.style.background = '#f8faf9';
  shadow.append(body); document.documentElement.append(root);
  let left = 28, top = 90, dragOrigin = null, paintFrame = null;
  chrome.storage.local.get(['panelPosition', 'panelCollapsed']).then(s => {
    if (s.panelPosition) { left = s.panelPosition.left; top = s.panelPosition.top; clamp(); }
    if (s.panelCollapsed) root.style.height = '56px';
  });
  function clamp() {
    const width = Math.min(380, Math.max(0, innerWidth - 16));
    left = Math.max(0, Math.min(left, innerWidth - width)); top = Math.max(0, Math.min(top, innerHeight - 56));
    root.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  }
  clamp();
  function paint() { paintFrame = null; clamp(); }
  addEventListener('resize', clamp);
  function layout(type, data = {}) {
    if (type === 'move-start') { dragOrigin = { left, top }; root.style.willChange = 'transform'; }
    if (type === 'move' && dragOrigin && Number.isFinite(data.dx) && Number.isFinite(data.dy)) {
      left = dragOrigin.left + data.dx; top = dragOrigin.top + data.dy;
      if (paintFrame === null) paintFrame = requestAnimationFrame(paint);
    }
    if (type === 'move-end') {
      if (paintFrame !== null) { cancelAnimationFrame(paintFrame); paintFrame = null; }
      clamp(); dragOrigin = null; root.style.willChange = 'auto';
      void chrome.storage.local.set({ panelPosition: { left, top } });
    }
    if (type === 'collapse') root.style.height = data.collapsed ? '56px' : 'min(840px, calc(100vh - 24px))';
    if (type === 'close') root.style.display = 'none';
  }
  // Binding is private to this extension's isolated world; no page message -> wallet RPC bridge.
  globalThis.__GMGN_AGENT_MOUNT__ = { root: shadow, body, layout };
  for (const event of ['click', 'keydown', 'keyup', 'pointerdown']) root.addEventListener(event, e => e.stopPropagation());
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type !== 'show-panel') return;
    root.style.display = 'block'; clamp();
    globalThis.__GMGN_AGENT_MOUNT__.show?.();
    reply({ ok: true });
  });
})();
