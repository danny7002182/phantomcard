const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Test server did not start.');
}

test('a confirmed GHS 70 KYC bypass auto-approves only its pending withdrawal', { timeout: 15000 }, async t => {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-withdrawal-test-${process.pid}-${Date.now()}.json`);
  const callbackSecret = 'test-payment-service-callback-secret';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      PHANTOM_DATA_FILE: dataFile,
      SITE_B_TO_SITE_A_SECRET: callbackSecret,
      PAYSTACK_CURRENCY: 'GHS',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    server.kill();
    fs.rmSync(dataFile, { force: true });
  });

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
    method: 'POST', body: JSON.stringify({ name: 'Withdrawal User', phone: '0241234577', email: '', password: 'simple' }),
  });
  assert.equal(signup.status, 201);
  const addMethod = await request('/api/methods', {
    method: 'POST',
    body: JSON.stringify({ network: 'MTN Mobile Money', accountName: 'Withdrawal User', phone: '0241234577', pin: '1234' }),
  }, signup.cookie);
  assert.equal(addMethod.status, 201);

  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const userId = signup.data.user.id;
  for (let index = 0; index < 3; index++) {
    db.codes.push({ id: `redeemed_${index}`, userId, cardId: 'CARD-0001', status: 'redeemed', amount: 100, rewardAmount: 100, purchaseAmount: 36, redeemedAt: new Date().toISOString() });
    db.transactions.push({ id: `credit_${index}`, userId, type: 'credit', amount: 100, account: 'redeemed', reference: `REDEMPTION_${index}`, status: 'completed', reason: 'Redeemed code', related: {}, createdAt: new Date().toISOString() });
  }
  fs.writeFileSync(dataFile, JSON.stringify(db));

  const withdrawalResult = await request('/api/withdrawals', {
    method: 'POST', body: JSON.stringify({ amount: 100, methodId: addMethod.data.method.id, pin: '1234' }),
  }, signup.cookie);
  assert.equal(withdrawalResult.status, 201);
  assert.equal(withdrawalResult.data.withdrawal.status, 'PENDING_KYC_VERIFICATION');
  assert.equal(withdrawalResult.data.withdrawal.operationalCharge, 10);
  assert.equal(withdrawalResult.data.withdrawal.actualAmount, 90);

  const afterWithdrawal = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const withdrawal = afterWithdrawal.withdrawals.find(item => item.reference === withdrawalResult.data.withdrawal.reference);
  const paymentReference = 'PH-KYC-TEST-0001';
  afterWithdrawal.kycBypassPayments.push({
    id: 'kycbyp_test', userId, withdrawalId: withdrawal.id, withdrawalReference: withdrawal.reference,
    amount: 70, currency: 'GHS', reference: paymentReference, status: 'PAYMENT_INITIALIZED',
    callbackRequestIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  fs.writeFileSync(dataFile, JSON.stringify(afterWithdrawal));

  const callback = {
    event: 'kyc_bypass.success', siteATransactionId: paymentReference, siteAUserId: userId,
    amountMinor: 7000, currency: 'GHS', purpose: 'KYC_BYPASS', paystackReference: 'PCS_TEST_PAYMENT_0001',
    paymentServiceTransactionId: 'pay_test_0001', status: 'SUCCESS', timestamp: new Date().toISOString(),
  };
  const raw = JSON.stringify(callback);
  const requestId = 'callback_kyc_0001';
  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', callbackSecret).update(`${timestamp}.${requestId}.${raw}`).digest('hex');
  const confirmed = await request('/api/v1/webhooks/kyc-bypass-payment-status', {
    method: 'POST', body: raw,
    headers: { authorization: `Bearer ${callbackSecret}`, 'x-request-id': requestId, 'x-timestamp': timestamp, 'x-sitea-signature': signature },
  });
  assert.equal(confirmed.status, 200);
  const duplicate = await request('/api/v1/webhooks/kyc-bypass-payment-status', {
    method: 'POST', body: raw,
    headers: { authorization: `Bearer ${callbackSecret}`, 'x-request-id': requestId, 'x-timestamp': timestamp, 'x-sitea-signature': signature },
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.duplicate, true);

  const state = await request('/api/state', {}, signup.cookie);
  const completedWithdrawal = state.data.withdrawals.find(item => item.reference === withdrawal.reference);
  assert.equal(completedWithdrawal.status, 'approved');
  assert.equal(completedWithdrawal.kycBypassUsed, true);
  assert.equal(completedWithdrawal.kycBypassFee, 70);
  assert.equal(completedWithdrawal.kycBypassRefunded, true);
  assert.equal(completedWithdrawal.kycBypassRefundAmount, 70);
  assert.ok(completedWithdrawal.kycBypassRefundReference);
  assert.ok(completedWithdrawal.kycBypassRefundedAt);
  assert.equal(state.data.user.kycStatus, 'NOT_VERIFIED', 'a per-withdrawal bypass must not verify the account');
  assert.equal(state.data.user.redeemedBalance, 200, 'the GHS 70 refund must not be credited to redeemed balance');
  const refundTransaction = state.data.transactions.find(item => item.reference === completedWithdrawal.kycBypassRefundReference);
  assert.equal(refundTransaction.reason, 'KYC Fee Refund');
  assert.equal(refundTransaction.type, 'credit');
  assert.equal(refundTransaction.account, 'external');
  assert.equal(refundTransaction.status, 'refunded');
  assert.equal(refundTransaction.entryType, 'REFUND');
  assert.equal(refundTransaction.related.transactionType, 'REFUND');
  assert.equal(refundTransaction.related.withdrawalReference, withdrawal.reference);
  const refundWithdrawal = state.data.withdrawals.find(item => item.reference === completedWithdrawal.kycBypassRefundReference);
  assert.equal(refundWithdrawal.isRefund, true);
  assert.equal(refundWithdrawal.refundType, 'KYC_FEE_REFUND');
  assert.equal(refundWithdrawal.status, 'refunded');
  assert.equal(refundWithdrawal.actualAmount, 70);
  assert.equal(refundWithdrawal.refundForWithdrawalReference, withdrawal.reference);
  const originalTransaction = state.data.transactions.find(item => item.reference === withdrawal.reference);
  assert.equal(originalTransaction.related.kycBypassRefundReference, completedWithdrawal.kycBypassRefundReference);
});

test('KYC bypass persists its payment session before Site B validates it', { timeout: 15000 }, async t => {
  const siteAPort = await freePort();
  const paymentPort = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-kyc-init-test-${process.pid}-${Date.now()}.json`);
  const siteAToSiteBSecret = 'test-site-a-to-site-b-secret';
  const siteBToSiteASecret = 'test-site-b-to-site-a-secret';
  let lookupResult;
  const paymentService = require('node:http').createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/v1/payments/initialize') {
      res.writeHead(404);
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const payload = JSON.parse(raw);
    const lookupPayload = { siteATransactionId: payload.siteATransactionId };
    const lookupRaw = JSON.stringify(lookupPayload);
    const requestId = 'lookup_kyc_0001';
    const timestamp = String(Date.now());
    const signature = crypto.createHmac('sha256', siteBToSiteASecret).update(`${timestamp}.${requestId}.${lookupRaw}`).digest('hex');
    const lookup = await fetch(`http://127.0.0.1:${siteAPort}/api/v1/internal/kyc-bypass/lookup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${siteBToSiteASecret}`,
        'x-request-id': requestId,
        'x-timestamp': timestamp,
        'x-sitea-signature': signature,
      },
      body: lookupRaw,
    });
    lookupResult = { status: lookup.status, data: await lookup.json() };
    res.writeHead(lookup.ok ? 201 : 502, { 'content-type': 'application/json' });
    res.end(JSON.stringify(lookup.ok ? {
      transactionId: 'pay_kyc_test',
      paystackReference: 'PCS_KYC_TEST',
      authorizationUrl: `http://127.0.0.1:${paymentPort}/checkout/PCS_KYC_TEST`,
      handoffUrl: `http://127.0.0.1:${paymentPort}/payment/handoff?token=kyc_handoff_token_123456`,
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    } : { error: lookupResult.data.error }));
  });
  await new Promise(resolve => paymentService.listen(paymentPort, '127.0.0.1', resolve));

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(siteAPort),
      PHANTOM_DATA_FILE: dataFile,
      SITE_B_BASE_URL: `http://127.0.0.1:${paymentPort}`,
      SITE_A_TO_SITE_B_SECRET: siteAToSiteBSecret,
      SITE_B_TO_SITE_A_SECRET: siteBToSiteASecret,
      PAYSTACK_CURRENCY: 'GHS',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    server.kill();
    await new Promise(resolve => paymentService.close(resolve));
    fs.rmSync(dataFile, { force: true });
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
  const signup = await request('/api/auth/signup', {
    method: 'POST', body: JSON.stringify({ name: 'KYC Init User', phone: '0241234588', email: '', password: 'simple' }),
  });
  assert.equal(signup.status, 201);
  const addMethod = await request('/api/methods', {
    method: 'POST',
    body: JSON.stringify({ network: 'MTN Mobile Money', accountName: 'KYC Init User', phone: '0241234588', pin: '1234' }),
  }, signup.cookie);
  assert.equal(addMethod.status, 201);

  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const userId = signup.data.user.id;
  for (let index = 0; index < 3; index++) {
    db.codes.push({ id: `redeemed_init_${index}`, userId, cardId: 'CARD-0001', status: 'redeemed', amount: 100, rewardAmount: 100, purchaseAmount: 36, redeemedAt: new Date().toISOString() });
    db.transactions.push({ id: `credit_init_${index}`, userId, type: 'credit', amount: 100, account: 'redeemed', reference: `REDEMPTION_INIT_${index}`, status: 'completed', reason: 'Redeemed code', related: {}, createdAt: new Date().toISOString() });
  }
  fs.writeFileSync(dataFile, JSON.stringify(db));

  const withdrawal = await request('/api/withdrawals', {
    method: 'POST', body: JSON.stringify({ amount: 100, methodId: addMethod.data.method.id, pin: '1234' }),
  }, signup.cookie);
  assert.equal(withdrawal.status, 201);
  const initialized = await request(`/api/withdrawals/${encodeURIComponent(withdrawal.data.withdrawal.reference)}/kyc-bypass`, {
    method: 'POST', body: JSON.stringify({ returnOrigin: baseUrl }),
  }, signup.cookie);
  assert.equal(initialized.status, 201);
  assert.equal(initialized.data.amount, 70);
  assert.equal(lookupResult.status, 200);
  assert.equal(lookupResult.data.purpose, 'KYC_BYPASS');
  assert.equal(lookupResult.data.amountMinor, 7000);

  const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(saved.kycBypassPayments[0].status, 'PAYMENT_INITIALIZED');
  assert.equal(saved.kycBypassPayments[0].amount, 70);
});
