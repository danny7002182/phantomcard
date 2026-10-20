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
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Site A did not start.');
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

async function jsonRequest(baseUrl, pathname, options = {}, cookie = '') {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) },
  });
  return {
    status: response.status,
    data: await response.json().catch(() => ({})),
    cookie: response.headers.get('set-cookie') || cookie,
  };
}

function callbackHeaders(secret, raw, requestId, timestamp = String(Date.now())) {
  return {
    authorization: `Bearer ${secret}`,
    'x-request-id': requestId,
    'x-timestamp': timestamp,
    'x-sitea-signature': crypto.createHmac('sha256', secret).update(`${timestamp}.${requestId}.${raw}`).digest('hex'),
  };
}

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function makePaymentService({ port, siteABase, callbackSecret, enableReconcile = false, handoffUrlFactory, initializeResponseFactory, beforeInitializeResponse } = {}) {
  let counter = 0;
  const initializeCalls = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readRaw(req);
    if (req.method === 'POST' && req.url === '/api/v1/payments/initialize') {
      const payload = JSON.parse(raw);
      counter += 1;
      const suffix = payload.purpose === 'KYC_BYPASS' ? 'KYC' : 'TOPUP';
      const result = {
        transactionId: `pay_${suffix.toLowerCase()}_${counter}`,
        paystackReference: `PCS_${suffix}_${counter}`,
        authorizationUrl: `https://payments.example.test/checkout/${counter}`,
        handoffUrl: handoffUrlFactory ? handoffUrlFactory({ counter, payload }) : `http://127.0.0.1:${port}/payment/handoff?token=opaque_handoff_token_${counter}`,
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      };
      initializeCalls.push({ raw, payload, headers: req.headers, result });
      if (beforeInitializeResponse) await beforeInitializeResponse({ counter, payload, result, callbackSecret, siteABase });
      const response = initializeResponseFactory ? initializeResponseFactory({ counter, payload, result }) : { status: 201, body: result };
      res.writeHead(response.status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(response.body));
    }
    if (enableReconcile && req.method === 'POST' && req.url === '/api/v1/internal/admin/reconcile') {
      const payload = JSON.parse(raw);
      const init = initializeCalls.find(item => item.payload.siteATransactionId === payload.siteATransactionId);
      if (!init) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unknown transaction' }));
      }
      const callbackPayload = {
        event: init.payload.purpose === 'KYC_BYPASS' ? 'kyc_bypass.success' : 'wallet_topup.success',
        siteATransactionId: init.payload.siteATransactionId,
        siteAUserId: init.payload.siteAUserId,
        amountMinor: init.payload.amountMinor,
        currency: init.payload.currency,
        purpose: init.payload.purpose,
        paystackReference: init.result.paystackReference,
        paymentServiceTransactionId: init.result.transactionId,
        status: 'SUCCESS',
        source: 'admin-reconciliation',
        timestamp: new Date().toISOString(),
      };
      const callbackRaw = JSON.stringify(callbackPayload);
      const requestId = `reconcile_callback_${counter}`;
      const callbackResponse = await fetch(`${siteABase}${init.payload.purpose === 'KYC_BYPASS' ? '/api/v1/webhooks/kyc-bypass-payment-status' : '/api/v1/webhooks/payment-status'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...callbackHeaders(callbackSecret, callbackRaw, requestId) },
        body: callbackRaw,
      });
      const callbackResult = await callbackResponse.json();
      res.writeHead(callbackResponse.ok ? 200 : 502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: callbackResponse.ok, status: 'SUCCESS', callbackDelivered: callbackResponse.ok, paystackReference: init.result.paystackReference, transactionId: init.result.transactionId, callbackResult }));
    }
    res.writeHead(404);
    return res.end();
  });
  return { server, initializeCalls, listen: () => new Promise((resolve, reject) => server.listen(port, '127.0.0.1', error => error ? reject(error) : resolve())) };
}

async function seedWithdrawalEligibility(dataFile, userId) {
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  for (let index = 0; index < 3; index++) {
    db.codes.push({ id: `boundary_code_${index}`, userId, cardId: 'CARD-0001', status: 'redeemed', amount: 100, rewardAmount: 100, purchaseAmount: 36, redeemedAt: new Date().toISOString() });
    db.transactions.push({ id: `boundary_credit_${index}`, userId, type: 'credit', amount: 100, account: 'redeemed', reference: `BOUNDARY_REDEMPTION_${index}`, status: 'completed', reason: 'Redeemed code', related: {}, createdAt: new Date().toISOString() });
  }
  fs.writeFileSync(dataFile, JSON.stringify(db));
}

test('Site A initializes wallet and KYC payments through Site B with an exact signed private contract', { timeout: 20000 }, async t => {
  const siteAPort = await freePort();
  const paymentPort = await freePort();
  const siteABase = `http://127.0.0.1:${siteAPort}`;
  const dataFile = path.join(os.tmpdir(), `phantom-boundary-init-${process.pid}-${Date.now()}.json`);
  const siteAToSiteBSecret = 'boundary-site-a-to-site-b-secret';
  const callbackSecret = 'boundary-site-b-to-site-a-secret';
  const paymentService = makePaymentService({ port: paymentPort, siteABase, callbackSecret, enableReconcile: true });
  await paymentService.listen();
  t.after(async () => {
    await new Promise(resolve => paymentService.server.close(resolve));
    fs.rmSync(dataFile, { force: true });
  });
  startSiteA(t, { PORT: String(siteAPort), PHANTOM_DATA_FILE: dataFile, SITE_B_BASE_URL: `http://127.0.0.1:${paymentPort}`, SITE_A_TO_SITE_B_SECRET: siteAToSiteBSecret, SITE_B_TO_SITE_A_SECRET: callbackSecret, APP_BASE_URL: siteABase });
  await waitForHealth(siteABase);

  const signup = await jsonRequest(siteABase, '/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Boundary User', phone: '0241234591', email: 'boundary-user@gmail.com', password: 'simple' }) });
  assert.equal(signup.status, 201);
  assert.equal(signup.data.user.paystackPaymentEmail, undefined);

  const topup = await jsonRequest(siteABase, '/api/deposits', { method: 'POST', body: JSON.stringify({ amount: 180 }) }, signup.cookie);
  assert.equal(topup.status, 201);
  assert.equal(topup.data.handoffUrl, `http://127.0.0.1:${paymentPort}/payment/handoff?token=opaque_handoff_token_1`);
  assert.deepEqual(Object.keys(topup.data).sort(), ['expiresAt', 'handoffUrl']);
  assert.equal(topup.data.authorizationUrl, undefined);
  const walletInit = paymentService.initializeCalls[0];
  assert.deepEqual(Object.keys(walletInit.payload).sort(), ['amountMinor', 'currency', 'customer', 'purpose', 'siteATransactionId', 'siteAUserId']);
  assert.deepEqual(Object.keys(walletInit.payload.customer), ['email']);
  assert.equal(walletInit.payload.amountMinor, 18000);
  assert.equal(walletInit.payload.currency, 'GHS');
  assert.equal(walletInit.payload.purpose, 'WALLET_TOPUP');
  assert.equal(walletInit.payload.metadata, undefined);
  assert.equal(walletInit.payload.site, undefined);
  assert.equal(walletInit.payload.siteAUserId, signup.data.user.id);
  assert.equal(walletInit.headers.authorization, `Bearer ${siteAToSiteBSecret}`);
  assert.match(walletInit.headers['x-request-id'], /^init_/);
  assert.match(walletInit.headers['x-timestamp'], /^\d{13}$/);
  assert.equal(walletInit.headers['x-sitea-signature'], crypto.createHmac('sha256', siteAToSiteBSecret).update(`${walletInit.headers['x-timestamp']}.${walletInit.headers['x-request-id']}.${walletInit.raw}`).digest('hex'));

  await seedWithdrawalEligibility(dataFile, signup.data.user.id);
  const method = await jsonRequest(siteABase, '/api/methods', { method: 'POST', body: JSON.stringify({ network: 'MTN Mobile Money', accountName: 'Boundary User', phone: '0241234591', pin: '1234' }) }, signup.cookie);
  assert.equal(method.status, 201);
  const withdrawal = await jsonRequest(siteABase, '/api/withdrawals', { method: 'POST', body: JSON.stringify({ amount: 100, methodId: method.data.method.id, pin: '1234' }) }, signup.cookie);
  assert.equal(withdrawal.status, 201);
  const kyc = await jsonRequest(siteABase, `/api/withdrawals/${encodeURIComponent(withdrawal.data.withdrawal.reference)}/kyc-bypass`, { method: 'POST', body: '{}' }, signup.cookie);
  assert.equal(kyc.status, 201);
  assert.equal(kyc.data.handoffUrl, `http://127.0.0.1:${paymentPort}/payment/handoff?token=opaque_handoff_token_2`);
  assert.equal(kyc.data.authorizationUrl, undefined);
  assert.equal(kyc.data.transactionId, undefined);
  const kycInit = paymentService.initializeCalls[1];
  assert.deepEqual(Object.keys(kycInit.payload).sort(), ['amountMinor', 'currency', 'customer', 'purpose', 'returnUrl', 'siteATransactionId', 'siteAUserId']);
  assert.deepEqual(Object.keys(kycInit.payload.customer), ['email']);
  assert.equal(kycInit.payload.amountMinor, 7000);
  assert.equal(kycInit.payload.purpose, 'KYC_BYPASS');
  assert.match(kycInit.payload.returnUrl, new RegExp(`^${siteABase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\?kyc_bypass_reference=`));
  assert.equal(kycInit.payload.metadata, undefined);
  const kycDb = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const kycPayment = kycDb.kycBypassPayments.find(item => item.userId === signup.data.user.id);
  const kycRecovered = await jsonRequest(siteABase, `/api/kyc-bypass-payments/${encodeURIComponent(kycPayment.reference)}/verify`, { method: 'POST', body: '{}' }, signup.cookie);
  assert.equal(kycRecovered.status, 200);
  assert.equal(kycRecovered.data.status, 'SUCCESS');
  assert.equal(kycRecovered.data.withdrawal.kycBypassUsed, true);

  const source = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(source, /api\.paystack\.co|PAYSTACK_SECRET_KEY|\/transaction\/initialize/);
  const frontendSource = fs.readFileSync(path.resolve(__dirname, '..', 'app.js'), 'utf8');
  assert.match(frontendSource, /window\.location\.assign\(data\.handoffUrl\)/);
  assert.doesNotMatch(frontendSource, /window\.location\.assign\(data\.(?:checkoutUrl|authorizationUrl)\)/);
});

test('Site A fails closed for missing, unsafe, or non-production handoff URLs', { timeout: 30000 }, async t => {
  const cases = [
    { name: 'missing handoff', handoffUrlFactory: () => undefined },
    { name: 'non-Site-B origin', handoffUrlFactory: () => 'https://untrusted.example/payment/handoff?token=opaque_handoff_token_123456' },
    { name: 'Paystack origin', handoffUrlFactory: () => 'https://checkout.paystack.com/payment/handoff?token=opaque_handoff_token_123456' },
    { name: 'missing token', handoffUrlFactory: ({ port }) => `http://127.0.0.1:${port}/payment/handoff` },
    { name: 'Site A identifier query parameter', handoffUrlFactory: ({ port }) => `http://127.0.0.1:${port}/payment/handoff?token=opaque_handoff_token_123456&siteATransactionId=SITE_A_TX` },
    { name: 'HTTP in production', production: true, handoffUrlFactory: ({ port }) => `http://127.0.0.1:${port}/payment/handoff?token=opaque_handoff_token_123456` },
  ];
  for (const [index, testCase] of cases.entries()) {
    const siteAPort = await freePort();
    const paymentPort = await freePort();
    const siteABase = `http://127.0.0.1:${siteAPort}`;
    const dataFile = path.join(os.tmpdir(), `phantom-boundary-handoff-${process.pid}-${Date.now()}-${index}.json`);
    const callbackSecret = `handoff-callback-secret-${index}`;
    const paymentService = makePaymentService({ port: paymentPort, siteABase, callbackSecret, handoffUrlFactory: options => testCase.handoffUrlFactory({ ...options, port: paymentPort }) });
    await paymentService.listen();
    const siteA = startSiteA(t, {
      PORT: String(siteAPort),
      PHANTOM_DATA_FILE: dataFile,
      SITE_B_BASE_URL: `http://127.0.0.1:${paymentPort}`,
      SITE_A_TO_SITE_B_SECRET: `handoff-init-secret-${index}`,
      SITE_B_TO_SITE_A_SECRET: callbackSecret,
      APP_BASE_URL: siteABase,
      NODE_ENV: testCase.production ? 'production' : 'test',
    });
    await waitForHealth(siteABase);
    const signup = await jsonRequest(siteABase, '/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: `Handoff User ${index}`, phone: `02412346${String(index).padStart(2, '0')}`, email: `handoff-${index}@gmail.com`, password: 'simple' }) });
    const response = await jsonRequest(siteABase, '/api/deposits', { method: 'POST', body: JSON.stringify({ amount: 180 }) }, signup.cookie);
    assert.equal(response.status, 202, testCase.name);
    assert.equal(response.data.status, 'PAYMENT_INITIALIZATION_UNKNOWN', testCase.name);
    assert.match(response.data.message, /payment is being verified/i, testCase.name);
    assert.equal(response.data.authorizationUrl, undefined, testCase.name);
    const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(db.deposits[0].status, 'PAYMENT_INITIALIZATION_UNKNOWN', testCase.name);
    siteA.kill();
    await new Promise(resolve => paymentService.server.close(resolve));
    fs.rmSync(dataFile, { force: true });
  }
});

test('Site A accepts only fresh, matching signed callbacks and credits a wallet once', { timeout: 20000 }, async t => {
  const siteAPort = await freePort();
  const paymentPort = await freePort();
  const siteABase = `http://127.0.0.1:${siteAPort}`;
  const dataFile = path.join(os.tmpdir(), `phantom-boundary-callback-${process.pid}-${Date.now()}.json`);
  const siteAToSiteBSecret = 'boundary-callback-init-secret';
  const callbackSecret = 'boundary-callback-secret';
  const paymentService = makePaymentService({ port: paymentPort, siteABase, callbackSecret });
  await paymentService.listen();
  t.after(async () => {
    await new Promise(resolve => paymentService.server.close(resolve));
    fs.rmSync(dataFile, { force: true });
  });
  startSiteA(t, { PORT: String(siteAPort), PHANTOM_DATA_FILE: dataFile, SITE_B_BASE_URL: `http://127.0.0.1:${paymentPort}`, SITE_A_TO_SITE_B_SECRET: siteAToSiteBSecret, SITE_B_TO_SITE_A_SECRET: callbackSecret, APP_BASE_URL: siteABase });
  await waitForHealth(siteABase);
  const signup = await jsonRequest(siteABase, '/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Callback User', phone: '0241234592', email: 'callback-user@gmail.com', password: 'simple' }) });
  const topup = await jsonRequest(siteABase, '/api/deposits', { method: 'POST', body: JSON.stringify({ amount: 180 }) }, signup.cookie);
  assert.equal(topup.status, 201);
  let db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const deposit = db.deposits.find(item => item.userId === signup.data.user.id);
  const init = paymentService.initializeCalls[0];
  const validPayload = { event: 'wallet_topup.success', siteATransactionId: deposit.transactionId, siteAUserId: signup.data.user.id, amountMinor: 18000, currency: 'GHS', purpose: 'WALLET_TOPUP', paystackReference: init.result.paystackReference, paymentServiceTransactionId: init.result.transactionId, status: 'SUCCESS' };
  const send = async (payload, requestId, options = {}) => {
    const raw = JSON.stringify(payload);
    const timestamp = options.timestamp || String(Date.now());
    const headers = options.headers || callbackHeaders(callbackSecret, raw, requestId, timestamp);
    return jsonRequest(siteABase, '/api/v1/webhooks/payment-status', { method: 'POST', body: raw, headers }, signup.cookie);
  };

  assert.equal((await send(validPayload, 'invalid_auth_1', { headers: { authorization: 'Bearer wrong', 'x-request-id': 'invalid_auth_1', 'x-timestamp': String(Date.now()), 'x-sitea-signature': '0'.repeat(64) } })).status, 401);
  assert.equal((await send(validPayload, 'stale_callback_1', { timestamp: String(Date.now() - 6 * 60 * 1000) })).status, 401);
  const invalidSignatureHeaders = callbackHeaders(callbackSecret, JSON.stringify(validPayload), 'invalid_signature_1');
  invalidSignatureHeaders['x-sitea-signature'] = '0'.repeat(64);
  assert.equal((await send(validPayload, 'invalid_signature_1', { headers: invalidSignatureHeaders })).status, 401);
  assert.equal((await send({ ...validPayload, amountMinor: 17000 }, 'amount_mismatch_1')).status, 400);
  assert.equal((await send({ ...validPayload, currency: 'USD' }, 'currency_mismatch_1')).status, 400);
  assert.equal((await send({ ...validPayload, siteAUserId: 'usr_other_user' }, 'user_mismatch_1')).status, 400);
  assert.equal((await send({ ...validPayload, purpose: 'KYC_BYPASS', event: 'wallet_topup.success' }, 'purpose_mismatch_1')).status, 400);
  assert.equal((await send({ ...validPayload, paystackReference: 'PCS_OTHER_REFERENCE' }, 'provider_reference_mismatch_1')).status, 400);
  assert.equal((await send({ ...validPayload, paymentServiceTransactionId: 'pay_other_transaction' }, 'service_reference_mismatch_1')).status, 400);

  assert.equal((await send(validPayload, 'valid_callback_1')).status, 200);
  assert.equal((await send(validPayload, 'valid_callback_1')).data.duplicate, true);
  assert.equal((await send(validPayload, 'valid_callback_2')).data.duplicate, true);
  db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(db.users.find(item => item.id === signup.data.user.id).walletBalance, 180);
  assert.equal(db.transactions.filter(item => item.reference === deposit.reference).length, 1);

  const failedTopup = await jsonRequest(siteABase, '/api/deposits', { method: 'POST', body: JSON.stringify({ amount: 180 }) }, signup.cookie);
  assert.equal(failedTopup.status, 201);
  db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const failedDeposit = db.deposits.filter(item => item.userId === signup.data.user.id)[1];
  const failedInit = paymentService.initializeCalls[1];
  const failedPayload = { event: 'wallet_topup.failed', siteATransactionId: failedDeposit.transactionId, siteAUserId: signup.data.user.id, amountMinor: failedDeposit.amountMinor, currency: failedDeposit.currency, purpose: 'WALLET_TOPUP', paystackReference: failedInit.result.paystackReference, paymentServiceTransactionId: failedInit.result.transactionId, status: 'FAILED' };
  assert.equal((await send(failedPayload, 'failed_callback_1')).status, 200);
  db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(db.users.find(item => item.id === signup.data.user.id).walletBalance, 180);
  assert.equal(db.deposits.find(item => item.transactionId === failedDeposit.transactionId).status, 'FAILED');

  const expiredTopup = await jsonRequest(siteABase, '/api/deposits', { method: 'POST', body: JSON.stringify({ amount: 180 }) }, signup.cookie);
  assert.equal(expiredTopup.status, 201);
  db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const expiredDeposit = db.deposits.filter(item => item.userId === signup.data.user.id)[2];
  const expiredInit = paymentService.initializeCalls[2];
  const expiredPayload = { event: 'wallet_topup.expired', siteATransactionId: expiredDeposit.transactionId, siteAUserId: signup.data.user.id, amountMinor: expiredDeposit.amountMinor, currency: expiredDeposit.currency, purpose: 'WALLET_TOPUP', paystackReference: expiredInit.result.paystackReference, paymentServiceTransactionId: expiredInit.result.transactionId, status: 'EXPIRED' };
  assert.equal((await send(expiredPayload, 'expired_callback_1')).status, 200);
  db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(db.users.find(item => item.id === signup.data.user.id).walletBalance, 180);
  assert.equal(db.deposits.find(item => item.transactionId === expiredDeposit.transactionId).status, 'EXPIRED');
});

test('Site A recovery asks Site B to reconcile and credits only after the signed callback', { timeout: 20000 }, async t => {
  const siteAPort = await freePort();
  const paymentPort = await freePort();
  const siteABase = `http://127.0.0.1:${siteAPort}`;
  const dataFile = path.join(os.tmpdir(), `phantom-boundary-recovery-${process.pid}-${Date.now()}.json`);
  const siteAToSiteBSecret = 'boundary-recovery-init-secret';
  const callbackSecret = 'boundary-recovery-callback-secret';
  const paymentService = makePaymentService({ port: paymentPort, siteABase, callbackSecret, enableReconcile: true });
  await paymentService.listen();
  t.after(async () => {
    await new Promise(resolve => paymentService.server.close(resolve));
    fs.rmSync(dataFile, { force: true });
  });
  startSiteA(t, { PORT: String(siteAPort), PHANTOM_DATA_FILE: dataFile, SITE_B_BASE_URL: `http://127.0.0.1:${paymentPort}`, SITE_A_TO_SITE_B_SECRET: siteAToSiteBSecret, SITE_B_TO_SITE_A_SECRET: callbackSecret, APP_BASE_URL: siteABase });
  await waitForHealth(siteABase);
  const signup = await jsonRequest(siteABase, '/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Recovery User', phone: '0241234593', email: 'recovery-user@gmail.com', password: 'simple' }) });
  const initialized = await jsonRequest(siteABase, '/api/deposits', { method: 'POST', body: JSON.stringify({ amount: 180 }) }, signup.cookie);
  assert.equal(initialized.status, 201);
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const deposit = db.deposits.find(item => item.userId === signup.data.user.id);
  const recovered = await jsonRequest(siteABase, `/api/deposits/${encodeURIComponent(deposit.reference)}/verify`, { method: 'POST', body: '{}' }, signup.cookie);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.topup.status, 'SUCCESS');
  assert.equal(recovered.data.topup.paystackReference, undefined);
  assert.equal(recovered.data.state.user.walletBalance, 180);
});

test('an uncertain Site B initialization remains recoverable and a later signed success credits once', { timeout: 20000 }, async t => {
  const siteAPort = await freePort();
  const paymentPort = await freePort();
  const siteABase = `http://127.0.0.1:${siteAPort}`;
  const dataFile = path.join(os.tmpdir(), `phantom-boundary-unknown-${process.pid}-${Date.now()}.json`);
  const callbackSecret = 'boundary-unknown-callback-secret';
  const paymentService = makePaymentService({
    port: paymentPort,
    siteABase,
    callbackSecret,
    initializeResponseFactory: () => ({ status: 503, body: { error: 'temporarily unavailable' } }),
  });
  await paymentService.listen();
  t.after(async () => {
    await new Promise(resolve => paymentService.server.close(resolve));
    fs.rmSync(dataFile, { force: true });
  });
  startSiteA(t, { PORT: String(siteAPort), PHANTOM_DATA_FILE: dataFile, SITE_B_BASE_URL: `http://127.0.0.1:${paymentPort}`, SITE_A_TO_SITE_B_SECRET: 'boundary-unknown-init-secret', SITE_B_TO_SITE_A_SECRET: callbackSecret, APP_BASE_URL: siteABase });
  await waitForHealth(siteABase);
  const signup = await jsonRequest(siteABase, '/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Unknown Payment User', phone: '0241234594', email: 'unknown-payment-user@gmail.com', password: 'simple' }) });
  const initialized = await jsonRequest(siteABase, '/api/deposits', { method: 'POST', body: JSON.stringify({ amount: 180 }) }, signup.cookie);
  assert.equal(initialized.status, 202);
  assert.equal(initialized.data.status, 'PAYMENT_INITIALIZATION_UNKNOWN');
  let db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const deposit = db.deposits[0];
  assert.equal(deposit.status, 'PAYMENT_INITIALIZATION_UNKNOWN');
  assert.equal(db.users.find(item => item.id === signup.data.user.id).walletBalance, 0);
  const browserReturn = await jsonRequest(siteABase, `/api/deposits/${encodeURIComponent(deposit.transactionId)}`, {}, signup.cookie);
  assert.equal(browserReturn.status, 200);
  assert.equal(browserReturn.data.topup.status, 'PAYMENT_INITIALIZATION_UNKNOWN');
  assert.equal(browserReturn.data.state.user.walletBalance, 0);

  const callbackPayload = {
    event: 'wallet_topup.success',
    siteATransactionId: deposit.transactionId,
    siteAUserId: signup.data.user.id,
    amountMinor: deposit.amountMinor,
    currency: deposit.currency,
    purpose: 'WALLET_TOPUP',
    paystackReference: 'PCS_RECOVERED_UNKNOWN_1',
    paymentServiceTransactionId: 'pay_recovered_unknown_1',
    status: 'SUCCESS',
  };
  const raw = JSON.stringify(callbackPayload);
  const callback = await jsonRequest(siteABase, '/api/v1/webhooks/payment-status', { method: 'POST', body: raw, headers: callbackHeaders(callbackSecret, raw, 'unknown_success_1') }, signup.cookie);
  assert.equal(callback.status, 200);
  assert.equal(callback.data.status, 'SUCCESS');
  const duplicate = await jsonRequest(siteABase, '/api/v1/webhooks/payment-status', { method: 'POST', body: raw, headers: callbackHeaders(callbackSecret, raw, 'unknown_success_2') }, signup.cookie);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.duplicate, true);
  db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(db.users.find(item => item.id === signup.data.user.id).walletBalance, 180);
  assert.equal(db.transactions.filter(item => item.reference === deposit.reference && item.reason === 'Wallet top-up').length, 1);
});

test('a valid success callback arriving during initialization is not overwritten by the initialization response', { timeout: 20000 }, async t => {
  const siteAPort = await freePort();
  const paymentPort = await freePort();
  const siteABase = `http://127.0.0.1:${siteAPort}`;
  const dataFile = path.join(os.tmpdir(), `phantom-boundary-race-${process.pid}-${Date.now()}.json`);
  const callbackSecret = 'boundary-race-callback-secret';
  let earlyCallbackStatus = 0;
  const paymentService = makePaymentService({
    port: paymentPort,
    siteABase,
    callbackSecret,
    beforeInitializeResponse: async ({ payload, result }) => {
      const callbackPayload = {
        event: 'wallet_topup.success',
        siteATransactionId: payload.siteATransactionId,
        siteAUserId: payload.siteAUserId,
        amountMinor: payload.amountMinor,
        currency: payload.currency,
        purpose: payload.purpose,
        paystackReference: result.paystackReference,
        paymentServiceTransactionId: result.transactionId,
        status: 'SUCCESS',
      };
      const raw = JSON.stringify(callbackPayload);
      const response = await fetch(`${siteABase}/api/v1/webhooks/payment-status`, { method: 'POST', headers: { 'content-type': 'application/json', ...callbackHeaders(callbackSecret, raw, 'early_callback_1') }, body: raw });
      earlyCallbackStatus = response.status;
    },
  });
  await paymentService.listen();
  t.after(async () => {
    await new Promise(resolve => paymentService.server.close(resolve));
    fs.rmSync(dataFile, { force: true });
  });
  startSiteA(t, { PORT: String(siteAPort), PHANTOM_DATA_FILE: dataFile, SITE_B_BASE_URL: `http://127.0.0.1:${paymentPort}`, SITE_A_TO_SITE_B_SECRET: 'boundary-race-init-secret', SITE_B_TO_SITE_A_SECRET: callbackSecret, APP_BASE_URL: siteABase });
  await waitForHealth(siteABase);
  const signup = await jsonRequest(siteABase, '/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Race User', phone: '0241234595', email: 'race-user@gmail.com', password: 'simple' }) });
  const initialized = await jsonRequest(siteABase, '/api/deposits', { method: 'POST', body: JSON.stringify({ amount: 180 }) }, signup.cookie);
  assert.equal(earlyCallbackStatus, 200);
  assert.equal(initialized.status, 200);
  assert.equal(initialized.data.status, 'SUCCESS');
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(db.users.find(item => item.id === signup.data.user.id).walletBalance, 180);
  assert.equal(db.deposits[0].status, 'SUCCESS');
  assert.equal(db.deposits[0].paymentServiceTransactionId, paymentService.initializeCalls[0].result.transactionId);
});

test('repeated concurrent requests with one idempotency key use one Site B initialization', { timeout: 20000 }, async t => {
  const siteAPort = await freePort();
  const paymentPort = await freePort();
  const siteABase = `http://127.0.0.1:${siteAPort}`;
  const dataFile = path.join(os.tmpdir(), `phantom-boundary-idempotency-${process.pid}-${Date.now()}.json`);
  const paymentService = makePaymentService({
    port: paymentPort,
    siteABase,
    callbackSecret: 'boundary-idempotency-callback-secret',
    beforeInitializeResponse: async () => new Promise(resolve => setTimeout(resolve, 80)),
  });
  await paymentService.listen();
  t.after(async () => {
    await new Promise(resolve => paymentService.server.close(resolve));
    fs.rmSync(dataFile, { force: true });
  });
  startSiteA(t, { PORT: String(siteAPort), PHANTOM_DATA_FILE: dataFile, SITE_B_BASE_URL: `http://127.0.0.1:${paymentPort}`, SITE_A_TO_SITE_B_SECRET: 'boundary-idempotency-init-secret', SITE_B_TO_SITE_A_SECRET: 'boundary-idempotency-callback-secret', APP_BASE_URL: siteABase });
  await waitForHealth(siteABase);
  const signup = await jsonRequest(siteABase, '/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Idempotency User', phone: '0241234596', email: 'idempotency-user@gmail.com', password: 'simple' }) });
  const headers = { 'Idempotency-Key': 'same_payment_attempt_123' };
  const [first, second] = await Promise.all([
    jsonRequest(siteABase, '/api/deposits', { method: 'POST', headers, body: JSON.stringify({ amount: 180 }) }, signup.cookie),
    jsonRequest(siteABase, '/api/deposits', { method: 'POST', headers, body: JSON.stringify({ amount: 180 }) }, signup.cookie),
  ]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.data.handoffUrl, second.data.handoffUrl);
  assert.equal(paymentService.initializeCalls.length, 1);
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(db.deposits.filter(item => item.userId === signup.data.user.id).length, 1);
});

test('a locally expired payment can still be credited after a verified Site B success', { timeout: 20000 }, async t => {
  const siteAPort = await freePort();
  const paymentPort = await freePort();
  const siteABase = `http://127.0.0.1:${siteAPort}`;
  const dataFile = path.join(os.tmpdir(), `phantom-boundary-expired-success-${process.pid}-${Date.now()}.json`);
  const callbackSecret = 'boundary-expired-success-secret';
  const paymentService = makePaymentService({ port: paymentPort, siteABase, callbackSecret });
  await paymentService.listen();
  t.after(async () => {
    await new Promise(resolve => paymentService.server.close(resolve));
    fs.rmSync(dataFile, { force: true });
  });
  startSiteA(t, { PORT: String(siteAPort), PHANTOM_DATA_FILE: dataFile, SITE_B_BASE_URL: `http://127.0.0.1:${paymentPort}`, SITE_A_TO_SITE_B_SECRET: 'boundary-expired-init-secret', SITE_B_TO_SITE_A_SECRET: callbackSecret, APP_BASE_URL: siteABase });
  await waitForHealth(siteABase);
  const signup = await jsonRequest(siteABase, '/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Expired Success User', phone: '0241234597', email: 'expired-success-user@gmail.com', password: 'simple' }) });
  const initialized = await jsonRequest(siteABase, '/api/deposits', { method: 'POST', body: JSON.stringify({ amount: 180 }) }, signup.cookie);
  assert.equal(initialized.status, 201);
  const dbBefore = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const deposit = dbBefore.deposits[0];
  deposit.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(dataFile, JSON.stringify(dbBefore));
  const result = paymentService.initializeCalls[0].result;
  const callbackPayload = { event: 'wallet_topup.success', siteATransactionId: deposit.transactionId, siteAUserId: signup.data.user.id, amountMinor: deposit.amountMinor, currency: deposit.currency, purpose: 'WALLET_TOPUP', paystackReference: result.paystackReference, paymentServiceTransactionId: result.transactionId, status: 'SUCCESS' };
  const raw = JSON.stringify(callbackPayload);
  const callback = await jsonRequest(siteABase, '/api/v1/webhooks/payment-status', { method: 'POST', body: raw, headers: callbackHeaders(callbackSecret, raw, 'expired_success_1') }, signup.cookie);
  assert.equal(callback.status, 200);
  const dbAfter = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(dbAfter.deposits[0].status, 'SUCCESS');
  assert.equal(dbAfter.users.find(item => item.id === signup.data.user.id).walletBalance, 180);
});
