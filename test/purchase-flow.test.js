const test = require('node:test');
const assert = require('node:assert/strict');
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
  let lastError;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('Test server did not start.');
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

test('purchase is idempotent and redeem codes are revealed only to their owner', { timeout: 15000 }, async t => {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-purchase-test-${process.pid}-${Date.now()}.json`);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile },
    stdio: 'ignore',
  });
  t.after(() => {
    server.kill();
    fs.rmSync(dataFile, { force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  const request = async (pathName, options = {}, cookie = '') => {
    const response = await fetch(`${baseUrl}${pathName}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) },
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') || cookie };
  };
  const signup = async (name, phone) => request('/api/auth/signup', {
    method: 'POST', body: JSON.stringify({ name, phone, email: '', password: 'simple' }),
  });

  const owner = await signup('Owner One', '0241234567');
  assert.equal(owner.status, 201);
  addWalletCredit(dataFile, owner.data.user.id, 100);
  const state = await request('/api/state', {}, owner.cookie);
  const card = state.data.cards.find(item => item.active && item.stock > 0 && item.priceGhs <= 100);
  assert.ok(card, 'a purchasable card is available');

  const idempotencyKey = 'purchase_test_key_000001';
  const [first, duplicate] = await Promise.all([
    request('/api/purchases', { method: 'POST', body: JSON.stringify({ cardId: card.id, idempotencyKey }) }, owner.cookie),
    request('/api/purchases', { method: 'POST', body: JSON.stringify({ cardId: card.id, idempotencyKey }) }, owner.cookie),
  ]);
  assert.deepEqual([first.status, duplicate.status].sort(), [200, 201]);
  const purchaseResult = first.status === 201 ? first : duplicate;
  assert.equal(purchaseResult.data.code, undefined, 'initial purchase response has no redeem code');
  assert.equal(purchaseResult.data.receipt.related.code, undefined, 'purchase receipt has no redeem code');
  assert.ok(purchaseResult.data.state.codes.every(code => code.code === undefined), 'ordinary state has no redeem codes');
  assert.ok(purchaseResult.data.state.transactions.every(tx => tx.related.code === undefined), 'purchase ledger response has no code');

  const recoveredState = await request('/api/state', {}, owner.cookie);
  assert.equal(recoveredState.status, 200);
  assert.equal(recoveredState.data.purchases.length, 1, 'purchase remains after a refresh');
  assert.equal(recoveredState.data.codes[0].status, 'unused', 'Later leaves the purchased card awaiting redemption');
  assert.equal(recoveredState.data.codes[0].code, undefined, 'refresh does not expose the code');

  let db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(db.purchases.length, 1, 'duplicate request creates one purchase');
  assert.equal(db.codes.length, 1, 'duplicate request creates one owned code');
  assert.equal(db.users.find(user => user.id === owner.data.user.id).walletBalance, 100 - card.priceGhs, 'wallet is debited once');

  const other = await signup('Owner Two', '0241234568');
  assert.equal(other.status, 201);
  const forbidden = await request(`/api/purchases/${purchaseResult.data.purchase.id}/code`, { method: 'POST', body: '{}' }, other.cookie);
  assert.equal(forbidden.status, 404, 'another user cannot retrieve the code');

  const reveal = await request(`/api/purchases/${purchaseResult.data.purchase.id}/code`, { method: 'POST', body: '{}' }, owner.cookie);
  assert.equal(reveal.status, 200);
  assert.match(reveal.data.code, /^[A-Z]{2}[A-Z0-9]{12}$/);

  const redeemed = await request('/api/redemptions', { method: 'POST', body: JSON.stringify({ code: reveal.data.code }) }, owner.cookie);
  assert.equal(redeemed.status, 200);
  const redeemedAgain = await request('/api/redemptions', { method: 'POST', body: JSON.stringify({ code: reveal.data.code }) }, owner.cookie);
  assert.equal(redeemedAgain.status, 409, 'a redeemed card cannot be redeemed twice');
  const revealAfterRedeem = await request(`/api/purchases/${purchaseResult.data.purchase.id}/code`, { method: 'POST', body: '{}' }, owner.cookie);
  assert.equal(revealAfterRedeem.status, 409, 'a redeemed card cannot be revealed again');

  const failedPurchase = await request('/api/purchases', { method: 'POST', body: JSON.stringify({ cardId: card.id, idempotencyKey: 'purchase_test_key_000002' }) }, other.cookie);
  assert.equal(failedPurchase.status, 400, 'insufficient wallet purchase fails');
  db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(db.purchases.filter(item => item.userId === other.data.user.id).length, 0, 'failed purchase creates no card');
  assert.equal(db.users.find(user => user.id === other.data.user.id).walletBalance, 0, 'failed purchase does not debit wallet');
});

test('each exact USD price allows two Ghana-calendar-day purchases and resets at midnight', { timeout: 15000 }, async t => {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-daily-limit-test-${process.pid}-${Date.now()}.json`);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile },
    stdio: 'ignore',
  });
  t.after(() => {
    server.kill();
    fs.rmSync(dataFile, { force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  const request = async (pathName, options = {}, cookie = '') => {
    const response = await fetch(`${baseUrl}${pathName}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) },
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') || cookie };
  };
  const owner = await request('/api/auth/signup', {
    method: 'POST', body: JSON.stringify({ name: 'Daily Buyer', phone: '0241234577', email: '', password: 'simple' }),
  });
  assert.equal(owner.status, 201);
  addWalletCredit(dataFile, owner.data.user.id, 5000);
  const initial = await request('/api/state', {}, owner.cookie);
  const cardA = initial.data.cards.find(item => item.active && item.stock > 4);
  const cardB = initial.data.cards.find(item => item.active && item.stock > 4 && item.id !== cardA.id && item.displayPriceUsd === cardA.displayPriceUsd);
  const cardC = initial.data.cards.find(item => item.active && item.stock > 4 && item.displayPriceUsd !== cardA.displayPriceUsd);
  assert.ok(cardA && cardB && cardC, 'same-price and different-price cards with enough stock are available');
  assert.match(initial.data.purchaseLimits.resetAt, /T00:00:00\.000Z$/, 'reset is at Ghana midnight/UTC midnight');

  const buy = (cardId, key) => request('/api/purchases', {
    method: 'POST', body: JSON.stringify({ cardId, idempotencyKey: key }),
  }, owner.cookie);
  assert.equal((await buy(cardA.id, 'daily_card_a_key_01')).status, 201);
  assert.equal((await buy(cardB.id, 'daily_card_b_key_01')).status, 201, 'a different card at the same price uses the shared price quota');
  const thirdA = await buy(cardA.id, 'daily_card_a_key_03');
  assert.equal(thirdA.status, 409, 'third purchase at the same price is rejected server-side');
  assert.match(thirdA.data.error, /limit.*reached/i);

  const rapidC = await Promise.all([
    buy(cardC.id, 'daily_card_c_key_01'),
    buy(cardC.id, 'daily_card_c_key_02'),
    buy(cardC.id, 'daily_card_c_key_03'),
  ]);
  assert.deepEqual(rapidC.map(result => result.status).sort(), [201, 201, 409], 'rapid requests cannot bypass a price limit');

  let db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(db.purchases.filter(item => item.userId === owner.data.user.id && item.cardId === cardA.id).length, 1);
  assert.equal(db.purchases.filter(item => item.userId === owner.data.user.id && item.cardId === cardB.id).length, 1);

  // Move Card A purchases to the previous calendar day. The server rebuilds
  // the aggregate from the purchase ledger, so this also proves the reset is
  // date-based rather than purchase-time-plus-24-hours based.
  const yesterday = new Date(Date.now() - 2 * 86400000).toISOString();
  db.purchases.filter(item => item.userId === owner.data.user.id && [cardA.id, cardB.id].includes(item.cardId)).forEach(item => { item.createdAt = yesterday; });
  fs.writeFileSync(dataFile, JSON.stringify(db));
  const resetState = await request('/api/state', {}, owner.cookie);
  assert.equal(resetState.data.purchaseLimits.counts[cardA.displayPriceUsd.toFixed(2)], undefined, 'the shared price quota resets on the new calendar day');
  assert.equal((await buy(cardB.id, 'daily_card_b_reset_02')).status, 201, 'a same-price card can be purchased again after the calendar reset');
});
