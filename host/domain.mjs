export const BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const USDT = '0x55d398326f99059fF775485246999027B3197955';
export const TRUSTED = new Set([BNB, USDT, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', '0xcE24439F2D9C6a2289F741120FE202248B666666', '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d'].map(x => x.toLowerCase()));
export class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function requireThat(ok, code, message) { if (!ok) throw new AppError(code, message); }
export function address(v) {
  requireThat(typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v), 'INVALID_CA', '请输入完整的 BSC 合约地址');
  requireThat(!/^0x0{40}$/i.test(v), 'INVALID_CA', '合约地址不能为零地址');
  return v;
}
export function decimal(v, { positive = true, maxDecimals = 36 } = {}) {
  requireThat(typeof v === 'string' && /^(0|[1-9]\d{0,39})(\.\d+)?$/.test(v), 'INVALID_AMOUNT', '数量必须是普通十进制数字');
  requireThat((v.split('.')[1] || '').length <= maxDecimals, 'INVALID_AMOUNT', '数量小数位过多');
  requireThat(!positive || /[1-9]/.test(v), 'INVALID_AMOUNT', '数量必须大于 0');
  return v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
export function units(v, precision = 36) {
  const [a, b = ''] = decimal(v, { positive: false }).split('.');
  requireThat(b.length <= precision, 'PRECISION', '数量超过支持的精度');
  return BigInt(a) * 10n ** BigInt(precision) + BigInt(b.padEnd(precision, '0') || '0');
}
export function percentage(balance, percent) {
  const p = decimal(percent, { maxDecimals: 2 });
  requireThat(units(p, 2) <= 10000n, 'INVALID_PERCENT', '卖出比例必须大于 0 且不超过 100%');
  const precision = (balance.split('.')[1] || '').length;
  const raw = units(balance, precision) * units(p, 2) / 10000n;
  const s = raw.toString().padStart(precision + 1, '0');
  return decimal(precision ? `${s.slice(0, -precision)}.${s.slice(-precision)}` : s);
}
export function tradeInput(input) {
  requireThat(input?.chainId === '56', 'UNSUPPORTED_CHAIN', '当前版本只支持 BSC（56）');
  const token = address(input.token);
  requireThat(token.toLowerCase() !== BNB.toLowerCase(), 'INVALID_PAIR', '目标代币不能是原生 BNB');
  requireThat(['buy', 'sell'].includes(input.side), 'INVALID_SIDE', '无效的交易方向');
  const slippage = input.slippage === 'auto' ? 'auto' : decimal(input.slippage, { positive: false, maxDecimals: 2 });
  requireThat(slippage === 'auto' || units(slippage, 2) <= 10000n, 'INVALID_SLIPPAGE', '滑点必须为自动或 0–100%');
  requireThat(typeof input.mev === 'boolean', 'INVALID_MEV', 'MEV 参数无效');
  requireThat(['LOW', 'MEDIUM', 'HIGH'].includes(input.gasLevel), 'INVALID_GAS', 'Gas 档位无效');
  if(input.side==='sell')requireThat(units(decimal(input.percent,{maxDecimals:2}),2)<=10000n,'INVALID_PERCENT','卖出比例必须大于 0 且不超过 100%');
  return { chainId: '56', token, side: input.side, amount: input.side === 'buy' ? decimal(input.amount, { maxDecimals: 18 }) : undefined,
    percent: input.side === 'sell' ? decimal(input.percent, { maxDecimals: 2 }) : undefined, slippage, mev: input.mev, gasLevel: input.gasLevel,
    approvalCap:input.approvalCap!==false,sellToBnb:input.sellToBnb!==false };
}
export function safeOrder(row) {
  return Object.fromEntries(['orderId', 'orderType', 'chain', 'fromToken', 'toToken', 'fromTokenName', 'toTokenName', 'fromTokenQty', 'toTokenActualQty', 'status', 'txHash', 'bookTime', 'updatedTime'].map(k => [k, row[k] ?? null]).concat([
    ['refund', Array.isArray(row.refund) ? row.refund.filter(x => x && x.amount && x.symbol && Number(x.amount) > 0).map(x => ({ amount: x.amount, symbol: x.symbol, tokenAddress: x.tokenAddress })) : []]
  ]));
}
export function auditSummary(raw) {
  if (raw?.hasResult !== true || raw?.isSupported !== true) return { available: false, message: '此代币暂无可靠的安全审计数据；继续前须明确确认。', hits: [] };
  return { available: true, riskLevel: raw.riskLevel, level: raw.riskLevelEnum, buyTax: raw.extraInfo?.buyTax ?? null, sellTax: raw.extraInfo?.sellTax ?? null,
    verified: raw.extraInfo?.isVerified ?? null, hits: (raw.riskItems || []).flatMap(g => (g.details || []).filter(d => d.isHit === true).map(d => ({ title: String(d.title || ''), description: String(d.description || ''), type: d.riskType }))) };
}
