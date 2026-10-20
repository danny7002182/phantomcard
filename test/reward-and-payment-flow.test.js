const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Test server did not start.');
}

function startSiteA(t, env) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
  t.after(() => server.kill());
  return server;
}

function addWalletCredit(dataFile, userId, amount) {
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  db.transactions.push({
    id: `seed_${userId}`,
    userId,
    type: 'credit',
    amount,
    account: 'wallet',
    reference: `SEED_${userId}`,
    status: 'completed',
    reason: 'Deposit',
    related: {},
    createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(dataFile, JSON.stringify(db));
}

test('future card redemptions use the backend x3.52-x4.42 reward range', { timeout: 20000 }, async t => {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-reward-test-${process.pid}-${Date.now()}.json`);
  const server = startSiteA(t, { PORT: String(port), PHANTOM_DATA_FILE: dataFile });
  t.after(() => fs.rmSync(dataFile, { force: true }));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  const request = async (pathname, options = {}, cookie = '') => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) },
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') || cookie };
  };

  const signup = await request('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name: 'Reward User', phone: '0241234501', email: 'reward-user@gmail.com', password: 'simple' }),
  });
  assert.equal(signup.status, 201);
  addWalletCredit(dataFile, signup.data.user.id, 10000);
  const state = await request('/api/state', {}, signup.cookie);
  const cards = [];
  for (const card of state.data.cards) {
    if (card.active && card.stock > 0 && !cards.some(item => item.displayPriceUsd === card.displayPriceUsd)) cards.push(card);
    if (cards.length === 3) break;
  }
  assert.equal(cards.length, 3);
  assert.ok(cards.every(card => card.rewardMinRate === 3.52 && card.rewardMaxRate === 4.42));

  for (const [index, card] of cards.entries()) {
    const purchase = await request('/api/purchases', {
      method: 'POST',
      body: JSON.stringify({ cardId: card.id, idempotencyKey: `reward_card_key_${index}_0001` }),
    }, signup.cookie);
    assert.equal(purchase.status, 201);
    const reveal = await request(`/api/purchases/${encodeURIComponent(purchase.data.purchase.id)}/code`, { method: 'POST', body: '{}' }, signup.cookie);
    assert.equal(reveal.status, 200);
    const redeemed = await request('/api/redemptions', { method: 'POST', body: JSON.stringify({ code: reveal.data.code }) }, signup.cookie);
    assert.equal(redeemed.status, 200);
    const purchaseAmount = Number(redeemed.data.code.purchaseAmount);
    const rewardAmount = Number(redeemed.data.code.rewardAmount);
    const multiplier = Number(redeemed.data.code.rewardMultiplier);
    assert.ok(multiplier >= 3.52 && multiplier <= 4.42, `multiplier ${multiplier} is outside the new range`);
    assert.equal(rewardAmount, Math.round(purchaseAmount * multiplier * 100) / 100);
    assert.ok(rewardAmount > purchaseAmount, 'redemption must credit the calculated reward, not the purchase price');
    assert.equal(Number(redeemed.data.receipt.related.rewardMultiplier), multiplier);
  }
});

test('users receive persistent allowed Paystack emails and repeated top-ups get new references', { timeout: 20000 }, async t => {
  const siteAPort = await freePort();
  const paymentPort = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-payment-test-${process.pid}-${Date.now()}.json`);
  const callbackSecret = 'payment-callback-secret-for-tests';
  const initializedPayloads = [];
  let paymentCounter = 0;
  const paymentService = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/v1/payments/initialize') {
      res.writeHead(404);
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    initializedPayloads.push(payload);
    paymentCounter += 1;
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      transactionId: `pay_test_${paymentCounter}`,
      paystackReference: `PCS_TOPUP_TEST_${paymentCounter}`,
      authorizationUrl: `http://127.0.0.1:${paymentPort}/checkout/${paymentCounter}`,
      handoffUrl: `http://127.0.0.1:${paymentPort}/payment/handoff?token=reward_handoff_token_${paymentCounter}`,
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    }));
  });
  await new Promise((resolve, reject) => paymentService.listen(paymentPort, '127.0.0.1', error => error ? reject(error) : resolve()));
  t.after(async () => {
    await new Promise(resolve => paymentService.close(resolve));
    fs.rmSync(dataFile, { force: true });
  });

  const server = startSiteA(t, {
    PORT: String(siteAPort),
    PHANTOM_DATA_FILE: dataFile,
    SITE_B_BASE_URL: `http://127.0.0.1:${paymentPort}`,
    SITE_A_TO_SITE_B_SECRET: 'site-a-payment-service-secret',
    SITE_B_TO_SITE_A_SECRET: callbackSecret,
  });
  const baseUrl = `http://127.0.0.1:${siteAPort}`;
  await waitForHealth(baseUrl);
  const request = async (pathname, options = {}, cookie = '') => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) },
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') || cookie };
  };
  const signup = async (name, phone, email) => request('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name, phone, email, password: 'simple' }),
  });

  const first = await signup('Payment User One', '0241234511', 'real-one@gmail.com');
  const second = await signup('Payment User Two', '0241234512', 'real-two@gmail.com');
  const third = await signup('Payment User Three', '0241234513', 'real-three@gmail.com');
  for (const result of [first, second, third]) {
    assert.equal(result.status, 201);
    assert.equal(result.data.user.paystackPaymentEmail, undefined);
  }

  const firstTopupResponse = await request('/api/deposits', { method: 'POST', body: JSON.stringify({ amount: 30 }) }, first.cookie);
  const secondTopupResponse = await request('/api/deposits', { method: 'POST', body: JSON.stringify({ amount: 30 }) }, first.cookie);
  assert.equal(firstTopupResponse.status, 201);
  assert.equal(secondTopupResponse.status, 201);
  const savedAfterTopups = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const userDeposits = savedAfterTopups.deposits.filter(item => item.userId === first.data.user.id);
  const firstTopup = { data: userDeposits[0] };
  const secondTopup = { data: userDeposits[1] };
  assert.notEqual(firstTopup.data.transactionId, secondTopup.data.transactionId);
  assert.notEqual(firstTopup.data.reference, secondTopup.data.reference);
  assert.equal(initializedPayloads.length, 2);
  assert.deepEqual(initializedPayloads.map(payload => payload.customer.email), ['bridgetfegerson2007+1@gmail.com', 'bridgetfegerson2007+1@gmail.com']);
  assert.ok(initializedPayloads.every(payload => !payload.customer.email.includes('real-')));

  const successfulPayload = {
    event: 'wallet_topup.success',
    siteATransactionId: firstTopup.data.transactionId,
    siteAUserId: first.data.user.id,
    amountMinor: 3000,
    currency: 'GHS',
    purpose: 'WALLET_TOPUP',
    paystackReference: 'PCS_TOPUP_TEST_1',
    paymentServiceTransactionId: 'pay_test_1',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
  };
  const sendCallback = async (requestId) => {
    const raw = JSON.stringify(successfulPayload);
    const timestamp = String(Date.now());
    const signature = crypto.createHmac('sha256', callbackSecret).update(`${timestamp}.${requestId}.${raw}`).digest('hex');
    return request('/api/v1/webhooks/payment-status', {
      method: 'POST',
      body: raw,
      headers: { authorization: `Bearer ${callbackSecret}`, 'x-request-id': requestId, 'x-timestamp': timestamp, 'x-sitea-signature': signature },
    });
  };
  assert.equal((await sendCallback('topup_callback_1')).status, 200);
  assert.equal((await sendCallback('topup_callback_1')).status, 200);
  assert.equal((await sendCallback('topup_callback_2')).status, 200);

  const finalState = await request('/api/state', {}, first.cookie);
  assert.equal(finalState.data.user.paystackPaymentEmail, undefined);
  assert.equal(finalState.data.user.walletBalance, 30);
  assert.equal(finalState.data.transactions.filter(tx => tx.reference === firstTopup.data.reference).length, 1);
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(db.deposits.filter(item => item.userId === first.data.user.id).length, 2);
  assert.equal(db.deposits.find(item => item.transactionId === firstTopup.data.transactionId).status, 'SUCCESS');
  assert.equal(db.deposits.find(item => item.transactionId === secondTopup.data.transactionId).status, 'PAYMENT_INITIALIZED');
});
