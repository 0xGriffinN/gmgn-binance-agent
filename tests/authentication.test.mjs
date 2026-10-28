import test from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../host/service.mjs';
import { officialLoginUrl } from '../extension/login-url.js';
test('official app QR and web login links pass unchanged, lookalikes and unsafe URLs fail', () => {
  for (const url of ['https://app.binance.com/uni-qr/test?url=x%2Fy', 'https://web3.binance.com/en/agent-login?url=x%2Fy', 'https://www.binance.com/en/agent-login']) assert.equal(officialLoginUrl(url), url);
  for (const url of ['https://app.binance.com.evil.com/uni-qr/test', 'https://evil.com/app.binance.com', 'http://app.binance.com/uni-qr/test', 'https://user:password@app.binance.com/uni-qr/test', 'https://app.binance.com:8443/uni-qr/test', 'javascript:alert(1)']) assert.throws(() => officialLoginUrl(url));
});
test('host accepts app.binance.com URL from CLI without altering pairing fields', async () => {
  const raw = { urlForWeb: 'https://app.binance.com/uni-qr/test?url=x%2Fy', pairingCode: 'a1b2c3', qrCodeId: 'qr-test', expireAt: Date.now() + 300000 };
  const service = new Service({ cli: async args => args[1] === 'status' ? { status: 'UNCONNECTED' } : raw }, {});
  const login = await service.startLogin();
  assert.equal(login.urlForWeb, raw.urlForWeb); assert.equal(login.pairingCode, raw.pairingCode);
});
test('rejected or expired QR is discarded so reconnect requests a fresh code', async () => {
  let starts = 0;
  const wallet = { cli: async args => {
    if (args[1] === 'status') return { status: 'UNCONNECTED' };
    if (args[1] === 'signin') { starts++; return { urlForWeb: 'https://web3.binance.com/en/agent-login?test', pairingCode: '123456', qrCodeId: `qr-${starts}`, expireAt: Date.now() + 300000 }; }
    if (args[1] === 'verify') throw new Error('QR code does not exist or expired');
    throw new Error('Unexpected command');
  } };
  const service = new Service(wallet, {});
  await service.startLogin(); await service.startLogin(); assert.equal(starts, 1);
  await assert.rejects(service.verifyLogin(), /expired/);
  await service.startLogin(); assert.equal(starts, 2);
});
test('parallel login verifications share one foreground command until completion', async () => {
  let verifications = 0, complete, connected = false;
  const wallet = { cli: async args => {
    if (args[1] === 'status') return { status: connected ? 'CONNECTED' : 'UNCONNECTED' };
    if (args[1] === 'signin') return { urlForWeb: 'https://web3.binance.com/en/agent-login?test', pairingCode: '123456', qrCodeId: 'qr-test', expireAt: Date.now() + 300000 };
    if (args[1] === 'verify') { verifications++; await new Promise(resolve => { complete = resolve; }); connected = true; return { status: 'SUCCESS' }; }
    throw new Error('Unexpected command');
  } };
  const service = new Service(wallet, {}); await service.startLogin();
  const one = service.verifyLogin(), two = service.verifyLogin();
  assert.equal(verifications, 1); complete();
  assert.equal((await one).status, 'CONNECTED'); assert.equal((await two).status, 'CONNECTED');
});
