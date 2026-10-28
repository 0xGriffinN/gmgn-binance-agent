import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BNB, USDT, percentage, decimal, auditSummary, tradeInput } from '../host/domain.mjs';
import { Journal } from '../host/journal.mjs';
import { Service } from '../host/service.mjs';
import { parseCli } from '../host/wallet.mjs';
import { gmgnContext } from '../extension/context.js';
const OWNER = '0x1234567890123456789012345678901234567890';
const TOKEN = '0x1111111111111111111111111111111111111111';
const input = (extra = {}) => ({ chainId: '56', token: USDT, side: 'buy', amount: '0.01', slippage: 'auto', mev: true, gasLevel: 'MEDIUM', ...extra });
class FakeWallet {
  calls = []; owner = OWNER; bnb = '2'; holding = '123456789.123456789123456789'; swaps = 0; status = 'PENDING'; refund = []; swapError = null;
  async cli(args) {
    this.calls.push(args);
    if (args[1] === 'status') return { status: 'CONNECTED' };
    if (args[1] === 'address') return { addresses: [{ binanceChainId: '56', address: this.owner }] };
    if (args[1] === 'settings') return { quotaLeft: 1000, sessionToken: 'must-not-escape', clientId: 'must-not-escape' };
    if (args[1] === 'balance') { const token = args[args.indexOf('--tokenAddress') + 1]; return [{ address: token, binanceChainId: '56', balance: token === BNB ? this.bnb : this.holding, symbol: token === BNB ? 'BNB' : 'TOKEN' }]; }
    if (args[1] === 'tx-lock') return { status: 'UNLOCKED' };
    if (args[1] === 'quote') return { fromCoinSymbol: 'BNB', fromCoinAmount: args[3], toCoinSymbol: 'TOKEN', toCoinAmount: '7.4', slippage: .005 };
    if (args[1] === 'swap') { this.swaps++; if (this.swapError) throw this.swapError; return { orderId: '123' }; }
    if (args[1] === 'list') return { list: args.includes('--status') && this.status === 'FINISHED' ? [] : [{ orderId: '123', chain: '56', status: this.status, fromToken: BNB, toToken: USDT, refund: this.refund, toTokenActualQty: '7.3', txHash: '0x' + 'a'.repeat(64) }] };
    if (args[1] === 'tx-history') return { transactions: [] };
    throw new Error('Unexpected call');
  }
  async audit() { return { available: true, hits: [] }; }
  async route() { return { route: 'market-order' }; }
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gmgn-agent-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new Journal(dir); await journal.init(); const wallet = new FakeWallet();
  return { journal, wallet, service: new Service(wallet, journal) };
}
test('percentage preserves token precision and floors to existing decimal precision', () => {
  assert.equal(percentage('123456789.123456789123456789', '100'), '123456789.123456789123456789');
  assert.equal(percentage('0.000000000000000003', '50'), '0.000000000000000001');
  assert.throws(() => percentage('10', '101'));
  assert.throws(() => percentage('0', '100'));
});
test('rejects unsupported chains, exponent notation, malformed CA, invalid slippage and shell fragments', () => {
  for (const x of [input({ chainId: '1' }), input({ token: '$(whoami)' }), input({ amount: '1e-3' }), input({ slippage: '101' }), input({ mev: 'false' }), input({ amount: '-1' })]) assert.throws(() => tradeInput(x));
  assert.equal(decimal('0.0100'), '0.01');
});
test('GMGN context does not confuse BSC with Solana or a malicious hostname', () => {
  assert.equal(gmgnContext(`https://gmgn.ai/bsc/token/${USDT}`).token, USDT);
  assert.equal(gmgnContext(`https://gmgn.ai/bsc/token/ref123_${USDT}`).token, USDT);
  assert.equal(gmgnContext(`https://gmgn.ai/sol/token/${USDT}`).supported, false);
  assert.equal(gmgnContext(`https://gmgn.ai.evil.com/bsc/token/${USDT}`).supported, false);
  assert.equal(gmgnContext('https://gmgn.ai/?chain=bsc').supported, true);
});
test('invalid audit never presents unreliable LOW risk metadata', () => {
  const a = auditSummary({ hasResult: false, isSupported: true, riskLevel: 1, riskLevelEnum: 'LOW', riskItems: [] });
  assert.equal(a.available, false); assert.equal(a.level, undefined);
});
test('CLI error parsing preserves official message and never outputs raw protocol text', () => {
  assert.throws(() => parseCli(JSON.stringify({ success: false, error: { name: 'DENIED', message: 'Actual rejection' } })), /Actual rejection/);
  assert.throws(() => parseCli('sessionToken=secret'), e => !e.message.includes('secret'));
});
test('wallet snapshot strips credential fields', async t => {
  const { service } = await setup(t); const s = await service.snapshot();
  assert.equal(s.address, OWNER); assert.ok(!JSON.stringify(s).includes('must-not-escape'));
});
test('prepare and all read operations never call swap', async t => {
  const { service, wallet } = await setup(t);
  const p = await service.prepare(input()); assert.equal(p.amount, '0.01');
  assert.equal(wallet.swaps, 0); assert.equal(p.owner, OWNER);
});
test('expired quote and missing confirmation cannot submit', async t => {
  const { service, wallet } = await setup(t); const p = await service.prepare(input());
  await assert.rejects(service.submit({ previewId: p.id }), /明确确认/);
  p.expiresAt = 0; await assert.rejects(service.submit({ previewId: p.id, confirmed: true }), /报价已过期/);
  assert.equal(wallet.swaps, 0);
});
test('insufficient gas reserve and per-order cap block before swap', async t => {
  const { service, wallet } = await setup(t);
  await assert.rejects(service.prepare(input({ amount: '0.2' })), /上限/);
  wallet.bnb = '0.01001'; await assert.rejects(service.prepare(input()), /BNB 不足/);
  assert.equal(wallet.swaps, 0);
});
test('unavailable audit requires explicit acknowledgment and highest risk blocks', async t => {
  const { service, wallet } = await setup(t);
  wallet.audit = async () => ({ available: false, hits: [] }); const p = await service.prepare(input({ token: TOKEN }));
  await assert.rejects(service.submit({ previewId: p.id, confirmed: true }), /安全审计不可用/);
  assert.equal(wallet.swaps, 0);
  wallet.audit = async () => ({ available: true, riskLevel: 5, hits: [] });
  await assert.rejects(service.prepare(input({ token: TOKEN })), /最高风险/);
});
test('wallet switch after quote cannot use original authorization', async t => {
  const { service, wallet, journal } = await setup(t); const p = await service.prepare(input());
  wallet.owner = TOKEN; const row = await service.submit({ previewId: p.id, confirmed: true });
  assert.equal(row.status, 'NOT_SUBMITTED'); assert.equal(wallet.swaps, 0); assert.equal(await journal.active(), null);
});
test('idempotent replay after service restart never submits again', async t => {
  const { service, wallet, journal } = await setup(t); const p = await service.prepare(input());
  const first = await service.submit({ previewId: p.id, confirmed: true }); assert.equal(first.status, 'PENDING');
  const restarted = new Service(wallet, journal); const second = await restarted.submit({ previewId: p.id, confirmed: true });
  assert.equal(second.orderId, first.orderId); assert.equal(wallet.swaps, 1);
});
test('parallel prepares and multiple host instances cannot submit two orders', async t => {
  const { service, wallet, journal } = await setup(t);
  const other = new Service(wallet, journal); const [p, q] = await Promise.all([service.prepare(input()), other.prepare(input())]);
  const result = await Promise.allSettled([service.submit({ previewId: p.id, confirmed: true }), other.submit({ previewId: q.id, confirmed: true })]);
  assert.equal(wallet.swaps, 1); assert.equal(result.filter(r => r.status === 'rejected').length, 1);
});
test('uncertain submission persists global lock and cannot be automatically retried', async t => {
  const { service, wallet, journal } = await setup(t); const p = await service.prepare(input());
  wallet.swapError = new Error('timeout'); const row = await service.submit({ previewId: p.id, confirmed: true });
  assert.equal(row.status, 'UNKNOWN'); assert.equal((await journal.active()).id, p.id);
  const restarted = new Service(wallet, journal); await assert.rejects(restarted.prepare(input()), /未确认交易/);
  await restarted.submit({ previewId: p.id, confirmed: true }); assert.equal(wallet.swaps, 1);
});
test('PENDING remains locked and partial fill preserves exact actual amount and refunds', async t => {
  const { service, wallet, journal } = await setup(t); const p = await service.prepare(input()); await service.submit({ previewId: p.id, confirmed: true });
  assert.equal((await service.refreshOrder({ id: p.id })).status, 'PENDING'); assert.ok(await journal.active());
  wallet.status = 'FINISHED'; wallet.refund = [{ amount: '.001', symbol: 'BNB', tokenAddress: BNB }];
  const done = await service.refreshOrder({ id: p.id }); assert.equal(done.status, 'PARTIAL'); assert.equal(done.result.toTokenActualQty, '7.3'); assert.equal(done.result.refund.length, 1); assert.equal(await journal.active(), null);
});
test('terminal record persisted before crash can safely release leftover lock', async t => {
  const { journal } = await setup(t); const id = crypto.randomUUID();
  await journal.lock(id); await journal.save({ id, status: 'FINISHED', createdAt: Date.now() });
  assert.equal(await journal.active(), null);
});
test('failed on-chain order is not presented as success', async t => {
  const { service, wallet, journal } = await setup(t); const p = await service.prepare(input()); await service.submit({ previewId: p.id, confirmed: true });
  wallet.status = 'FAILED'; assert.equal((await service.refreshOrder({ id: p.id })).status, 'FAILED'); assert.equal(await journal.active(), null);
});
test('pre-submission interrupted process recovers without a swap', async t => {
  const { journal } = await setup(t); const id = crypto.randomUUID();
  await writeFile(journal.lockPath, JSON.stringify({ id, pid: 2147483647, record: { id, status: 'VALIDATING', createdAt: Date.now() } }));
  assert.equal(await journal.active(), null); assert.equal((await journal.get(id)).status, 'NOT_SUBMITTED');
});
test('unknown recovery requires exact acknowledgment and rejects while any order is pending', async t => {
  const { service, wallet, journal } = await setup(t); const p = await service.prepare(input()); wallet.swapError = new Error('timeout'); await service.submit({ previewId: p.id, confirmed: true });
  await assert.rejects(service.resolveUnknown({ id: p.id, confirmation: 'yes' }), /完整确认/);
  const confirmation = '我已核对订单、链上记录及余额，确认本次请求未成交';
  await assert.rejects(service.resolveUnknown({ id: p.id, confirmation }), /待处理交易/); assert.ok(await journal.active());
  wallet.status = 'FINISHED';
  const row = await service.resolveUnknown({ id: p.id, confirmation });
  assert.equal(row.status, 'MANUALLY_RECONCILED'); assert.equal(await journal.active(), null); assert.equal(wallet.swaps, 1);
});
