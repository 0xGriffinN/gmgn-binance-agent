import { BNB, AppError, address, decimal, percentage, requireThat, safeOrder, tradeInput, units } from './domain.mjs';
import { officialLoginUrl } from '../extension/login-url.js';
const TERMINAL = new Set(['FINISHED', 'FAILED', 'PARTIAL']);
function balanceRow(rows, token) {
  requireThat(Array.isArray(rows), 'BALANCE_PROTOCOL', '余额响应格式异常，无法确认可用数量');
  const row = rows.find(x => String(x.binanceChainId) === '56' && x.address?.toLowerCase() === token.toLowerCase());
  return row ? { address: row.address, symbol: row.symbol, balance: decimal(String(row.balance), { positive: false }), price: row.price, value: row.value } : { address: token, balance: '0', symbol: token === BNB ? 'BNB' : '' };
}
export class Service {
  constructor(wallet, journal, cfg = {}) {
    this.wallet = wallet; this.journal = journal; this.cfg = cfg; this.previews = new Map(); this.auth = null; this.verifyJob = null; this.polling = new Set();
  }
  async status() { return this.wallet.cli(['wallet', 'status']); }
  async walletSettings() { return this.wallet.cli(['wallet','settings']); }
  async owner() {
    const [status,data]=await Promise.all([this.status(),this.wallet.cli(['wallet','address'])]);
    requireThat(status.status === 'CONNECTED', 'UNCONNECTED', '钱包未连接，请先在币安 App 完成登录');
    return address(data.addresses?.find(x => String(x.binanceChainId) === '56')?.address);
  }
  async balance(token) {
    return balanceRow(await this.wallet.cli(['wallet', 'balance', '--tokenAddress', token, '--binanceChainId', '56', '--hideLowValue', 'false']), token);
  }
  async snapshot(input = {}) {
    const s = await this.status();
    if (s.status !== 'CONNECTED') return { status: s.status, chainId: '56' };
    const token = input.token ? address(input.token) : null;
    const [owner, native, settings, holding] = await Promise.all([
      this.owner(), this.balance(BNB), this.walletSettings(), token ? this.balance(token) : null
    ]);
    return { status: 'CONNECTED', chainId: '56', address: owner, native, holding,
      settings: { sessionExpireTime: settings.sessionExpireTime, inactiveSignOutTime: settings.inactiveSignOutTime, quotaLeft: settings.quotaLeft, dailyLimit: settings.dailyLimit },
      maxBuyBnb: this.cfg.maxBuyBnb || '0.1', gasReserveBnb: this.cfg.gasReserveBnb || '0.00005' };
  }
  async startLogin() {
    if ((await this.status()).status === 'CONNECTED') return { status: 'CONNECTED' };
    if (this.verifyJob && this.auth) return this.loginView();
    if (this.auth && Date.now() < Number(this.auth.expireAt)) return this.loginView();
    const a = await this.wallet.cli(['auth', 'signin']);
    if (a.status === 'ALREADY_CONNECTED') return { status: 'CONNECTED' };
    try { officialLoginUrl(a.urlForWeb); } catch (e) { throw new AppError('AUTH_URL', e.message); }
    this.auth = a;
    return this.loginView();
  }
  loginView() { return { status: 'WAITING_APP', pairingCode: this.auth.pairingCode, urlForWeb: this.auth.urlForWeb, expireAt: this.auth.expireAt }; }
  async verifyLogin() {
    requireThat(this.auth, 'NO_LOGIN', '请先获取新的登录配对码');
    if (!this.verifyJob) {
      this.verifyJob = this.wallet.cli(['auth', 'verify', '--qrCodeId', this.auth.qrCodeId], 310000)
        .then(async () => { this.auth = null; return this.status(); })
        .catch(error => { this.auth = null; throw error; })
        .finally(() => { this.verifyJob = null; });
    }
    return this.verifyJob;
  }
  async prepare(raw) {
    const input = tradeInput(raw), owner = await this.owner();
    requireThat(!(await this.journal.active()), 'INFLIGHT', '已有未确认交易，请先查看最近订单');
    if (input.side === 'buy') requireThat(units(input.amount) <= units(this.cfg.maxBuyBnb || '0.1'), 'BUY_LIMIT', `单笔买入上限为 ${this.cfg.maxBuyBnb || '0.1'} BNB，可在本地配置中调整`);
    const [native, holding] = await Promise.all([this.balance(BNB), input.side === 'sell' ? this.balance(input.token) : null]);
    const amount = input.side === 'buy' ? input.amount : percentage(holding.balance, input.percent);
    const fromToken = input.side === 'buy' ? BNB : input.token, toToken = input.side === 'buy' ? input.token : BNB;
    const reserve = units(this.cfg.gasReserveBnb || '0.00005');
    requireThat(units(native.balance) >= reserve + (input.side === 'buy' ? units(amount) : 0n), 'INSUFFICIENT_BNB', `BNB 不足；需保留 ${this.cfg.gasReserveBnb || '0.00005'} BNB 作为 Gas 预留（非实际手续费报价）`);
    const [quote, audit] = await Promise.all([
      this.wallet.cli(['market-order', 'quote', '--fromTokenQty', amount, '--fromToken', fromToken, '--toToken', toToken, '--binanceChainId', '56', '--slippage', input.slippage]),
      input.side === 'buy' ? this.wallet.audit(input.token) : Promise.resolve({ available: true, trusted: true, hits: [] }),
      this.wallet.route(input.token, owner)
    ]);
    requireThat(audit.riskLevel !== 5, 'AUDIT_BLOCKED', '币安安全审计返回最高风险等级 5，本工具不提交此交易');
    requireThat(quote.toCoinAmount && quote.fromCoinAmount && units(String(quote.toCoinAmount)) > 0n, 'NO_QUOTE', '未获取有效的币安交易报价');
    requireThat(units(String(quote.fromCoinAmount)) === units(amount), 'QUOTE_MISMATCH', '报价支付数量与请求不一致，请重新报价');
    const preview = { id: crypto.randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + 45000, owner, input, amount, fromToken, toToken,
      quote: { fromCoinSymbol: quote.fromCoinSymbol, fromCoinAmount: quote.fromCoinAmount, toCoinSymbol: quote.toCoinSymbol, toCoinAmount: quote.toCoinAmount, slippage: quote.slippage }, audit };
    for (const [id, p] of this.previews) if (p.expiresAt < Date.now()) this.previews.delete(id);
    this.previews.set(preview.id, preview);
    return preview;
  }
  async submit(input) {
    const id = input?.previewId;
    requireThat(typeof id === 'string', 'INVALID_ID', '缺少报价编号');
    // A repeated request returns its original record, even after a restart. Never re-submit it.
    const existing = await this.journal.get(id);
    if (existing) return existing;
    const p = this.previews.get(id);
    requireThat(p && p.expiresAt > Date.now(), 'QUOTE_EXPIRED', '报价已过期或助手已重启，请重新报价');
    requireThat(input.confirmed === true, 'NOT_CONFIRMED', '请在面板中明确确认真实交易');
    requireThat(p.audit.available || input.acknowledgeUnavailable === true, 'AUDIT_ACK', '安全审计不可用，请明确确认后再继续');
    let submitting = false;
    const row = { id, createdAt: Date.now(), updatedAt: Date.now(), wallet: p.owner, chainId: '56', token: p.input.token, side: p.input.side,
      amount: p.amount, fromToken: p.fromToken, toToken: p.toToken, slippage: p.input.slippage, status: 'VALIDATING', orderId: null, message: '检查钱包状态' };
    await this.journal.lock(id, row);
    try {
      await this.journal.save(row);
      requireThat((await this.owner()).toLowerCase() === p.owner.toLowerCase(), 'WALLET_CHANGED', '钱包已切换，请重新报价');
      const [native, source, lock] = await Promise.all([this.balance(BNB), this.balance(p.fromToken), this.wallet.cli(['wallet', 'tx-lock', '--binanceChainId', '56']), this.wallet.route(p.input.token, p.owner)]);
      requireThat(lock.status === 'UNLOCKED', 'WALLET_LOCKED', '钱包有待处理交易或 App 审批，请先在币安 App 核对');
      requireThat(units(source.balance) >= units(p.amount), 'BALANCE_CHANGED', '可用余额已变化，请重新报价');
      requireThat(units(native.balance) >= units(this.cfg.gasReserveBnb || '0.00005') + (p.input.side === 'buy' ? units(p.amount) : 0n), 'INSUFFICIENT_BNB', 'BNB 不足以支付数量并保留 Gas');
      requireThat(p.expiresAt > Date.now(), 'QUOTE_EXPIRED', '检查期间报价已过期，请重新报价');
      row.status = 'SUBMITTING'; row.message = '已开始提交；可能需要币安 App 确认';
      await this.journal.save(row);
      submitting = true;
      const data = await this.wallet.cli(['market-order', 'swap', '--fromTokenQty', p.amount, '--fromToken', p.fromToken, '--toToken', p.toToken,
        '--binanceChainId', '56', '--slippage', p.input.slippage, '--mev', String(p.input.mev), '--gasLevel', p.input.gasLevel], 310000);
      row.orderId = data.orderId ? String(data.orderId) : null;
      row.status = row.orderId ? 'PENDING' : 'UNKNOWN'; row.updatedAt = Date.now();
      row.message = row.orderId ? '已提交，等待钱包成交确认' : '未返回订单编号，结果待核对；不会自动重试';
      await this.journal.save(row);
      return row;
    } catch (e) {
      row.status = submitting ? 'UNKNOWN' : 'NOT_SUBMITTED'; row.message = e.message; row.errorCode = e.code; row.updatedAt = Date.now();
      await this.journal.save(row);
      if (!submitting) await this.journal.unlock(id);
      return row;
    } finally { this.previews.delete(id); }
  }
  async refreshOrder(input) {
    const row = await this.journal.get(input.id);
    requireThat(row, 'NOT_FOUND', '找不到本地下单记录');
    if (!row.orderId || TERMINAL.has(row.status)) return row;
    requireThat((await this.owner()).toLowerCase() === row.wallet.toLowerCase(), 'WALLET_CHANGED', '请连接提交此订单的钱包后查单');
    if (this.polling.has(row.id)) return row;
    this.polling.add(row.id);
    try {
      const data = await this.wallet.cli(['market-order', 'list', '--orderId', row.orderId]);
      const match = data.list?.find(x => String(x.orderId) === row.orderId);
      if (!match) return row;
      requireThat(String(match.chain) === '56', 'ORDER_CHAIN', '订单链与 BSC 不一致，暂不更新');
      requireThat(match.fromToken?.toLowerCase() === row.fromToken.toLowerCase() && match.toToken?.toLowerCase() === row.toToken.toLowerCase(), 'ORDER_PAIR', '订单交易对不匹配，暂不更新');
      row.result = safeOrder(match); row.updatedAt = Date.now();
      row.status = match.status === 'FINISHED' && row.result.refund.length ? 'PARTIAL' : match.status;
      row.message = { FINISHED: '已成交', FAILED: '交易失败', PENDING: '钱包处理中', PARTIAL: '部分成交，有退款' }[row.status] || '钱包处理中';
      await this.journal.save(row);
      if (TERMINAL.has(row.status)) await this.journal.unlock(row.id);
      return row;
    } finally { this.polling.delete(row.id); }
  }
  async reconcileUnknown(input) {
    const row = await this.journal.get(input.id);
    requireThat(row && !row.orderId && ['UNKNOWN', 'SUBMITTING', 'VALIDATING'].includes(row.status), 'NOT_UNKNOWN', '此记录无需人工核对');
    requireThat((await this.owner()).toLowerCase() === row.wallet.toLowerCase(), 'WALLET_CHANGED', '请连接原钱包后核对');
    return { record: row, walletLock: await this.wallet.cli(['wallet', 'tx-lock', '--binanceChainId', '56']),
      recent: (await this.wallet.cli(['market-order', 'list', '--binanceChainId', '56', '--pageSize', '20'])).list?.map(safeOrder) || [],
      holding: await this.balance(row.token), native: await this.balance(BNB) };
  }
  async resolveUnknown(input) {
    const row = await this.journal.get(input.id);
    requireThat(row?.status === 'UNKNOWN' && !row.orderId, 'NOT_UNKNOWN', '仅可处理无订单编号且结果未知的请求');
    requireThat(input.confirmation === '我已核对订单、链上记录及余额，确认本次请求未成交', 'RECONCILE_ACK', '请先核对币安订单、链上记录和余额，并输入完整确认文字');
    requireThat((await this.owner()).toLowerCase() === row.wallet.toLowerCase(), 'WALLET_CHANGED', '请连接原钱包后核对');
    const [lock, history, orders] = await Promise.all([
      this.wallet.cli(['wallet', 'tx-lock', '--binanceChainId', '56']),
      this.wallet.cli(['wallet', 'tx-history', '--type', 'pending', '--binanceChainId', '56', '--size', '100']),
      this.wallet.cli(['market-order', 'list', '--status', 'PENDING', '--binanceChainId', '56', '--pageSize', '100'])
    ]);
    requireThat(lock.status === 'UNLOCKED' && Array.isArray(history.transactions) && history.transactions.length === 0 && Array.isArray(orders.list) && orders.list.length === 0, 'WALLET_PENDING', '钱包仍有待处理交易或无法确认状态，暂不解除本地锁');
    row.status = 'MANUALLY_RECONCILED'; row.updatedAt = Date.now(); row.message = '用户人工核对并确认本次请求未成交；此状态不代表链上失败证明';
    await this.journal.save(row); await this.journal.unlock(row.id); return row;
  }
  async dispatch(method, params) {
    switch (method) {
      case 'health': return { version: '0.5.10', chainId: '56', mode: 'live', maxBuyBnb: this.cfg.maxBuyBnb || '0.1' };
      case 'wallet.snapshot': return this.snapshot(params);
      case 'auth.start': return this.startLogin();
      case 'auth.verify': return this.verifyLogin();
      case 'trade.prepare': return this.prepare(params);
      case 'trade.submit': return this.submit(params);
      case 'orders.list': { const active = await this.journal.active(); return { records: await this.journal.list(), active }; }
      case 'orders.refresh': return this.refreshOrder(params);
      case 'orders.reconcile': return this.reconcileUnknown(params);
      case 'orders.resolve': return this.resolveUnknown(params);
      default: throw new AppError('METHOD_NOT_ALLOWED', '不支持此操作');
    }
  }
}
