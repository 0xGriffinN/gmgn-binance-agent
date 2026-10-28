import { config, Wallet, ROOT } from '../host/wallet.mjs';
import { Journal } from '../host/journal.mjs';
import { Service } from '../host/service.mjs';
import { join } from 'node:path';
const cfg = await config(), wallet = new Wallet(cfg), journal = new Journal(join(ROOT, '.local', 'orders'));
await journal.init();
const service = new Service(wallet, journal, cfg);
const checks = {};
checks.cli = await wallet.cli(['cli-check', '--required-version', '1.12.0']);
checks.wallet = await service.snapshot();
checks.activeOrder = await journal.active();
// Read-only real quote. Does not buy, sell, approve, sign, transfer or change wallet settings.
if (checks.wallet.status === 'CONNECTED') {
  checks.bscQuote = await wallet.cli(['market-order', 'quote', '--fromTokenQty', '0.01', '--fromToken', '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', '--toToken', '0x55d398326f99059fF775485246999027B3197955', '--binanceChainId', '56', '--slippage', 'auto']);
}
console.log(JSON.stringify(checks, null, 2));
