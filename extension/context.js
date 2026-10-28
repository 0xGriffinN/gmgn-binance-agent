export function gmgnContext(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !['gmgn.ai', 'www.gmgn.ai'].includes(u.hostname)) return { supported: false, reason: '请打开 GMGN 的 BSC 页面' };
    const match = u.pathname.match(/^\/bsc\/token\/(?:[a-zA-Z0-9]+_)?(0x[0-9a-fA-F]{40})\/?$/);
    if (match) return { supported: true, chainId: '56', token: match[1], url: u.href, source: 'page' };
    const home = u.pathname === '/' && u.searchParams.get('chain') === 'bsc';
    if (home || /^\/bsc(?:\/|$)/.test(u.pathname)) return { supported: true, chainId: '56', token: '', url: u.href, source: 'manual' };
    return { supported: false, reason: '当前仅支持 BSC，请切到 GMGN 的 BSC 页面', url: u.href };
  } catch { return { supported: false, reason: '无法识别 GMGN 页面' }; }
}
