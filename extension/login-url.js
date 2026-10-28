const LOGIN_HOSTS = new Set(['web3.binance.com', 'www.binance.com', 'app.binance.com']);
// Accept exact official hosts, including the app.binance.com/uni-qr link returned
// by the current official CLI. Return the original string without rewriting it.
export function officialLoginUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('币安登录地址校验失败：地址格式无效'); }
  if (typeof value !== 'string' || url.protocol !== 'https:' || !LOGIN_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    throw new Error('币安登录地址校验失败：不是已核实的币安 HTTPS 登录地址');
  }
  return value;
}
