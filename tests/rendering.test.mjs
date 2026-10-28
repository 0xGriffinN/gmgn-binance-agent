import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = path => readFile(new URL(path, import.meta.url), 'utf8');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.attrs = {}; }
  append(child) { this.children.push(child); }
  setAttribute(name, value) { this.attrs[name] = value; if (name === 'id') this.id = value; }
  attachShadow() { return this.shadow = new Element('shadow'); }
  addEventListener() {}
  getElementById(id) { if (this.id === id) return this; for (const child of this.children) { const match = child.getElementById?.(id); if (match) return match; } return null; }
}
test('suspended wallet/background cannot leave floating panel blank: static DOM renders before any RPC', async () => {
  const tree = new Element('html');
  const document = { documentElement: tree, getElementById: id => tree.getElementById(id), createElement: tag => new Element(tag), createTextNode: text => ({ text }) };
  let rpcCalls = 0, receiveMessage, queuedFrame = null, frameRequests = 0, savedPosition;
  const context = { document, innerWidth: 1400, innerHeight: 900, addEventListener() {},
    requestAnimationFrame(fn) { frameRequests++; queuedFrame = fn; return frameRequests; }, cancelAnimationFrame() { queuedFrame = null; },
    CSSStyleSheet: class { replaceSync(css) { this.css = css; } },
    chrome: { storage: { local: { get: async () => ({}), set: async data => { if (data.panelPosition) savedPosition = data.panelPosition; } } }, runtime: { onMessage: { addListener(fn) { receiveMessage = fn; } }, sendMessage: () => { rpcCalls++; throw new Error('bridge unavailable'); } } }
  };
  runInNewContext(await source('../extension/panel-template.js'), context);
  context.__GMGN_AGENT_TEMPLATE__.css += '\n.editor-body{padding:12px}body.dark .editor-body{color:red}';
  runInNewContext(await source('../extension/content.js'), context);
  const mount = context.__GMGN_AGENT_MOUNT__;
  assert.ok(mount.root.getElementById('dragbar'));
  assert.ok(mount.root.getElementById('buy'));
  assert.ok(mount.root.getElementById('sell'));
  assert.ok(mount.root.getElementById('connect'));
  assert.equal(rpcCalls, 0);
  let reply, restored = false;
  mount.show = () => { restored = true; };
  receiveMessage({ type: 'show-panel' }, {}, response => { reply = response; });
  assert.equal(reply.ok, true); assert.equal(restored, true);
  // Many pointer samples within one frame should repaint once using the final absolute delta.
  mount.layout('move-start');
  mount.layout('move', { dx: 10, dy: 10 }); mount.layout('move', { dx: 50, dy: 20 });
  assert.equal(frameRequests, 1); queuedFrame();
  const host = tree.getElementById('binance-agent-host');
  const css = host.shadow.adoptedStyleSheets[0].css;
  assert.ok(css.includes('.editor-body{padding:12px}'));
  assert.ok(css.includes('.agent-panel-body.dark .editor-body{color:red}'));
  assert.ok(!css.includes('.editor-.agent-panel-body'));
  assert.equal(host.style.transform, 'translate3d(78px, 110px, 0)');
  // Pointer cancellation/end must flush the last sample even before the next animation frame.
  mount.layout('move', { dx: 70, dy: 30 }); mount.layout('move-end');
  assert.equal(queuedFrame, null); assert.equal(host.style.transform, 'translate3d(98px, 120px, 0)');
  assert.equal(savedPosition.left, 98); assert.equal(savedPosition.top, 120);
  // Reversing from beyond the viewport edge uses the original anchor, avoiding a sticky drag.
  mount.layout('move-start'); mount.layout('move', { dx: 5000, dy: 0 }); queuedFrame();
  assert.equal(host.style.transform, 'translate3d(1020px, 120px, 0)');
  mount.layout('move', { dx: 2, dy: 0 }); mount.layout('move-end');
  assert.equal(host.style.transform, 'translate3d(100px, 120px, 0)');
  assert.equal(JSON.stringify(tree, (key, value) => key === 'shadow' ? undefined : value).includes('iframe'), false);
});
test('generated panel includes every original control exactly once and no embedded scripts', async () => {
  const context = {}; runInNewContext(await source('../extension/panel-template.js'), context);
  const nodes = context.__GMGN_AGENT_TEMPLATE__.nodes, ids = [], tags = [];
  function scan(node) { if (typeof node === 'string') return; tags.push(node.tag); if (node.attrs.id) ids.push(node.attrs.id); node.children.forEach(scan); }
  nodes.forEach(scan);
  const expected = [...(await source('../extension/panel.html')).matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual([...ids].sort(), expected.sort()); assert.equal(new Set(ids).size, ids.length);
  assert.ok(!tags.includes('script')); assert.ok(!tags.includes('iframe'));
});
