const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { PAYSTACK_PAYMENT_EMAILS, isAllowedPaystackPaymentEmail } = require('../payment-config');
const { createBundleRoute, handleBundleWebhook } = require('./bundle-service');

const ROOT = __dirname;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{8,160}$/;

function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 4000);
const normalizeBase = value => String(value || '').trim().replace(/\/+$/, '');
const BASE = normalizeBase(process.env.SITE_B_BASE_URL || `http://127.0.0.1:${PORT}`);
const SITE_A_BASE_URL = normalizeBase(process.env.SITE_A_BASE_URL);
const SITE_A_TO_SITE_B_SECRET = String(process.env.SITE_A_TO_SITE_B_SECRET || '').trim();
const SITE_B_TO_SITE_A_SECRET = String(process.env.SITE_B_TO_SITE_A_SECRET || '').trim();
const PAYSTACK_SECRET_KEY = String(process.env.PAYSTACK_SECRET_KEY || '').trim();
const PAYSTACK_API_BASE_URL = normalizeBase(process.env.PAYSTACK_API_BASE_URL || 'https://api.paystack.co');
const PAYMENT_DATA_FILE = process.env.PAYMENT_DATA_FILE || path.join(ROOT, 'data/payment-service.json');
const PUBLIC_ROOT = path.join(ROOT, 'public');

const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const createHandoffToken = () => crypto.randomBytes(32).toString('base64url');

function read(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function load() {
  fs.mkdirSync(path.dirname(PAYMENT_DATA_FILE), { recursive: true });
  if (!fs.existsSync(PAYMENT_DATA_FILE)) return { transactions: [], webhookEvents: [], requestIds: [] };
  const data = JSON.parse(fs.readFileSync(PAYMENT_DATA_FILE, 'utf8'));
  return { transactions: data.transactions || [], webhookEvents: data.webhookEvents || [], requestIds: data.requestIds || [] };
}

function save(data) {
  fs.mkdirSync(path.dirname(PAYMENT_DATA_FILE), { recursive: true });
  fs.writeFileSync(PAYMENT_DATA_FILE, JSON.stringify(data, null, 2));
}

function out(response, status, payload, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  response.end(JSON.stringify(payload));
}

function signed(secret, payload, requestId = id('req')) {
  const timestamp = String(Date.now());
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
      'x-request-id': requestId,
      'x-timestamp': timestamp,
      'x-sitea-signature': crypto.createHmac('sha256', secret).update(`${timestamp}.${requestId}.${body}`).digest('hex'),
    },
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authenticated(request, rawBody, secret) {
  const requestId = String(request.headers['x-request-id'] || '');
  const timestamp = String(request.headers['x-timestamp'] || '');
  const signature = String(request.headers['x-sitea-signature'] || '');
  const bearer = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || !safeEqual(bearer, secret)) return false;
  if (!REFERENCE_PATTERN.test(requestId) || !/^\d{13}$/.test(timestamp)) return false;
  if (!/^[a-f0-9]{64}$/i.test(signature) || Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${requestId}.${rawBody}`).digest('hex');
  return safeEqual(signature, expected);
}

function validInitializePayload(payload) {
  return Boolean(payload && REFERENCE_PATTERN.test(String(payload.siteATransactionId || '')) && REFERENCE_PATTERN.test(String(payload.siteAUserId || '')) && Number.isInteger(payload.amountMinor) && payload.amountMinor > 0 && /^[A-Z]{3}$/.test(String(payload.currency || '')) && ['WALLET_TOPUP', 'KYC_BYPASS'].includes(payload.purpose) && isAllowedPaystackPaymentEmail(payload.customer?.email));
}

async function callSiteA(endpoint, payload) {
  const request = signed(SITE_B_TO_SITE_A_SECRET, payload);
  const response = await fetch(`${SITE_A_BASE_URL}${endpoint}`, { method: 'POST', headers: request.headers, body: request.body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Site A rejected the payment update.');
  return data;
}

async function paystack(endpoint, options = {}) {
  if (!PAYSTACK_SECRET_KEY) throw new Error('Payment service is not configured.');
  const response = await fetch(`${PAYSTACK_API_BASE_URL}${endpoint}`, { ...options, headers: { authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.status) throw new Error(data.message || 'Paystack request failed.');
  return data.data;
}

function paymentMatches(transaction, providerPayment) {
  const metadata = providerPayment.metadata || {};
  return providerPayment.reference === transaction.paystackReference && providerPayment.amount === transaction.amountMinor && providerPayment.currency === transaction.currency && metadata.site === 'SITE_A' && metadata.siteATransactionId === transaction.siteATransactionId && metadata.siteAUserId === transaction.siteAUserId && metadata.purpose === transaction.purpose;
}

function validKycReturnUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) && url.pathname === '/' && url.searchParams.has('kyc_bypass_reference') ? url.toString() : '';
  } catch { return ''; }
}

function validPaystackAuthorizationUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && /(^|\.)paystack\.com$/.test(url.hostname);
  } catch { return false; }
}

function ensureHandoff(transaction) {
  if (!transaction.handoffTokenHash || !transaction.handoffUrl) {
    const token = createHandoffToken();
    transaction.handoffTokenHash = hashToken(token);
    transaction.handoffUrl = `${BASE}/payment/handoff?token=${encodeURIComponent(token)}`;
  }
  return transaction.handoffUrl;
}

async function notifySiteA(transaction, source = 'payment-service', force = false) {
  if (!force && transaction.callbackDeliveredAt) return;
  const prefix = transaction.purpose === 'KYC_BYPASS' ? 'kyc_bypass' : 'wallet_topup';
  const event = transaction.status === 'SUCCESS' ? `${prefix}.success` : transaction.status === 'EXPIRED' ? `${prefix}.expired` : `${prefix}.failed`;
  const endpoint = transaction.purpose === 'KYC_BYPASS' ? '/api/v1/webhooks/kyc-bypass-payment-status' : '/api/v1/webhooks/payment-status';
  await callSiteA(endpoint, { event, source, siteATransactionId: transaction.siteATransactionId, siteAUserId: transaction.siteAUserId, amountMinor: transaction.amountMinor, currency: transaction.currency, purpose: transaction.purpose, paystackReference: transaction.paystackReference, paymentServiceTransactionId: transaction.id, status: transaction.status, timestamp: now() });
  transaction.callbackDeliveredAt = now();
}

async function reconcile(data, transaction, { allowExpired = false, forceCallback = false } = {}) {
  if (!allowExpired && Date.parse(transaction.expiresAt) <= Date.now() && transaction.status === 'PENDING') transaction.status = 'EXPIRED';
  if (transaction.status === 'PENDING' || (allowExpired && ['EXPIRED', 'FAILED'].includes(transaction.status))) {
    const providerPayment = await paystack(`/transaction/verify/${encodeURIComponent(transaction.paystackReference)}`);
    if (!paymentMatches(transaction, providerPayment)) throw new Error('Payment mismatch.');
    if (providerPayment.status === 'success') transaction.status = 'SUCCESS';
    else if (['failed', 'abandoned', 'reversed'].includes(providerPayment.status)) transaction.status = 'FAILED';
    else transaction.status = 'PENDING';
  }
  if (transaction.status !== 'PENDING') await notifySiteA(transaction, allowExpired ? 'admin-reconciliation' : 'payment-service', forceCallback);
  save(data);
}

function confirmationPage(reference) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Payment confirmation</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f5f8;color:#16212b;font:16px system-ui}.box{width:min(420px,calc(100% - 42px));background:#fff;border:1px solid #dbe2e8;border-radius:18px;padding:34px}h1{font-size:12px;letter-spacing:.16em;color:#64748b}h2{font-size:27px;margin:.3em 0}p{line-height:1.55;color:#52616e}.ref{font:13px monospace;word-break:break-all;background:#f6f8fa;padding:12px;border-radius:8px;margin-top:12px}button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:9px;background:#164e63;color:#fff;font-weight:700;font-size:16px}.note{font-size:13px}</style><main class=box><h1>SECURE PAYSTACK CONFIRMATION</h1><h2>Payment confirmation</h2><p>Your payment is being confirmed securely.</p><div class=ref>${reference}</div><button id=done>Check payment confirmation</button><p class=note id=msg></p></main><script>done.onclick=async()=>{done.disabled=true;msg.textContent='Checking Paystack confirmation…';let r=await fetch('/api/v1/payments/${encodeURIComponent(reference)}/complete',{method:'POST'}),d=await r.json();if(d.redirect)location.assign(d.redirect);else msg.textContent=d.message||'Payment is still being confirmed.';done.disabled=false}</script>`;
}

function servePublic(response, pathname) {
  const files = { '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/app.js': 'app.js' };
  const name = files[pathname];
  if (!name) return false;
  const file = path.join(PUBLIC_ROOT, name);
  if (!fs.existsSync(file)) return false;
  const type = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html';
  response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': name === 'index.html' || name === 'app.js' ? 'no-cache' : 'public, max-age=300', 'x-content-type-options': 'nosniff' });
  response.end(fs.readFileSync(file));
  return true;
}

async function route(request, response) {
  const url = new URL(request.url, BASE);
  const data = load();
  try {
    if (request.method === 'GET' && url.pathname === '/api/health') return out(response, 200, { ok: true, paystackConfigured: Boolean(PAYSTACK_SECRET_KEY) });

    if (request.method === 'GET' && url.pathname === '/payment/handoff') {
      const token = url.searchParams.get('token') || '';
      const transaction = data.transactions.find(item => item.handoffTokenHash === hashToken(token));
      if (!TOKEN_PATTERN.test(token) || !transaction || transaction.status !== 'PENDING' || Date.parse(transaction.expiresAt) <= Date.now() || !validPaystackAuthorizationUrl(transaction.authorizationUrl)) return out(response, 404, { error: 'Payment handoff was not found or has expired.' });
      response.writeHead(302, { location: transaction.authorizationUrl, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
      return response.end();
    }

    if (request.method === 'GET' && url.pathname === '/payment/return') {
      const reference = url.searchParams.get('reference') || '';
      if (!REFERENCE_PATTERN.test(reference)) return out(response, 400, { error: 'Invalid payment reference.' });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(confirmationPage(reference));
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/payments/initialize') {
      const raw = await read(request);
      if (!authenticated(request, raw, SITE_A_TO_SITE_B_SECRET)) return out(response, 401, { error: 'Invalid Site A authentication.' });
      let payload;
      try { payload = JSON.parse(raw.toString() || '{}'); } catch { return out(response, 400, { error: 'Malformed request.' }); }
      if (!validInitializePayload(payload)) return out(response, 400, { error: 'Malformed payment request.' });

      let transaction = data.transactions.find(item => item.siteATransactionId === payload.siteATransactionId && item.purpose === payload.purpose);
      if (transaction) {
        ensureHandoff(transaction);
        save(data);
        return out(response, 200, { transactionId: transaction.id, paystackReference: transaction.paystackReference, handoffUrl: transaction.handoffUrl, expiresAt: transaction.expiresAt });
      }

      const lookupPath = payload.purpose === 'KYC_BYPASS' ? '/api/v1/internal/kyc-bypass/lookup' : '/api/v1/internal/topups/lookup';
      const account = await callSiteA(lookupPath, { siteATransactionId: payload.siteATransactionId });
      if (account.userId !== payload.siteAUserId || account.amountMinor !== payload.amountMinor || account.currency !== payload.currency || account.purpose !== payload.purpose || !isAllowedPaystackPaymentEmail(account.customer?.email) || String(account.customer.email).toLowerCase() !== String(payload.customer.email).toLowerCase()) return out(response, 400, { error: 'Payment data did not reconcile.' });

      transaction = { id: id('pay'), siteATransactionId: payload.siteATransactionId, siteAUserId: payload.siteAUserId, amountMinor: payload.amountMinor, currency: payload.currency, purpose: payload.purpose, paystackReference: `PCS_${crypto.randomBytes(16).toString('hex')}`, status: 'PENDING', expiresAt: account.expiresAt, createdAt: now(), updatedAt: now(), customerEmail: payload.customer.email, returnUrl: payload.purpose === 'KYC_BYPASS' ? validKycReturnUrl(payload.returnUrl) : '' };
      const provider = await paystack('/transaction/initialize', { method: 'POST', body: JSON.stringify({ email: transaction.customerEmail, amount: transaction.amountMinor, currency: transaction.currency, reference: transaction.paystackReference, callback_url: `${BASE}/payment/return?reference=${encodeURIComponent(transaction.paystackReference)}`, metadata: { site: 'SITE_A', siteATransactionId: transaction.siteATransactionId, siteAUserId: transaction.siteAUserId, purpose: transaction.purpose } }) });
      transaction.authorizationUrl = provider.authorization_url;
      if (!validPaystackAuthorizationUrl(transaction.authorizationUrl)) return out(response, 502, { error: 'Paystack returned an invalid checkout URL.' });
      ensureHandoff(transaction);
      data.transactions.push(transaction);
      save(data);
      return out(response, 201, { transactionId: transaction.id, paystackReference: transaction.paystackReference, handoffUrl: transaction.handoffUrl, expiresAt: transaction.expiresAt });
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/webhooks/paystack') {
      const raw = await read(request);
      const signature = String(request.headers['x-paystack-signature'] || '');
      const expected = PAYSTACK_SECRET_KEY && crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(raw).digest('hex');
      if (!expected || !safeEqual(signature, expected)) return out(response, 401, { error: 'Invalid Paystack signature.' });
      const event = JSON.parse(raw.toString() || '{}');
      const eventId = String(event.id || crypto.createHash('sha256').update(raw).digest('hex'));
      if (data.webhookEvents.some(item => item.eventId === eventId)) return out(response, 200, { ok: true, duplicate: true });
      const providerPayment = event.data || {};
      const transaction = data.transactions.find(item => item.paystackReference === providerPayment.reference);
      data.webhookEvents.push({ id: id('evt'), provider: 'paystack', eventId, eventType: event.event, transactionReference: providerPayment.reference || '', receivedAt: now(), processed: false });
      if (transaction && paymentMatches(transaction, providerPayment)) {
        if (event.event === 'charge.success') transaction.status = 'SUCCESS';
        else if (event.event === 'charge.failed') transaction.status = 'FAILED';
        if (transaction.status !== 'PENDING') { await notifySiteA(transaction); data.webhookEvents.at(-1).processed = true; data.webhookEvents.at(-1).processedAt = now(); }
      }
      save(data);
      return out(response, 200, { ok: true });
    }

    if (request.method === 'POST' && /^\/api\/v1\/payments\/[^/]+\/complete$/.test(url.pathname)) {
      const reference = decodeURIComponent(url.pathname.split('/')[4] || '');
      const transaction = data.transactions.find(item => item.paystackReference === reference);
      if (!transaction) return out(response, 404, { error: 'Payment session was not found.' });
      await reconcile(data, transaction);
      const key = transaction.purpose === 'KYC_BYPASS' ? 'kyc_bypass_reference' : 'wallet_topup';
      if (transaction.status === 'SUCCESS' && transaction.callbackDeliveredAt) {
        if (transaction.purpose === 'KYC_BYPASS' && transaction.returnUrl) return out(response, 200, { redirect: transaction.returnUrl });
        return out(response, 200, { redirect: `${SITE_A_BASE_URL}/?${key}=${encodeURIComponent(transaction.siteATransactionId)}` });
      }
      if (['FAILED', 'EXPIRED'].includes(transaction.status)) return out(response, 200, { redirect: `${SITE_A_BASE_URL}/?payment=${transaction.status.toLowerCase()}` });
      return out(response, 202, { message: 'Payment is still being confirmed. Please wait a moment.' });
    }

    return out(response, 404, { error: 'Not found.' });
  } catch (error) {
    console.error('[payment-service]', error);
    return out(response, 500, { error: 'Payment service could not process this request.' });
  }
}

const bundleRoute = createBundleRoute({ getBase: () => BASE, pay: (...args) => paystack(...args) });

http.createServer(async (request, response) => {
  const pathname = new URL(request.url, BASE).pathname;

  if (request.method === 'POST' && pathname === '/api/v1/internal/admin/reconcile') {
    const raw = await read(request);
    if (!authenticated(request, raw, SITE_A_TO_SITE_B_SECRET)) return out(response, 401, { error: 'Invalid Site A authentication.' });
    let payload;
    try { payload = JSON.parse(raw.toString() || '{}'); } catch { return out(response, 400, { error: 'Malformed reconciliation request.' }); }
    if (!REFERENCE_PATTERN.test(String(payload.siteATransactionId || ''))) return out(response, 400, { error: 'A valid Site A transaction ID is required.' });
    const data = load();
    const transaction = data.transactions.find(item => item.siteATransactionId === String(payload.siteATransactionId) && (!payload.paystackReference || item.paystackReference === String(payload.paystackReference)));
    if (!transaction) return out(response, 404, { error: 'Payment transaction was not found in the payment-service database.' });
    try {
      await reconcile(data, transaction, { allowExpired: true, forceCallback: true });
      return out(response, 200, { ok: true, transactionId: transaction.id, siteATransactionId: transaction.siteATransactionId, paystackReference: transaction.paystackReference, status: transaction.status, paystackStatus: transaction.status === 'SUCCESS' ? 'success' : transaction.status === 'FAILED' ? 'failed' : transaction.status === 'EXPIRED' ? 'expired' : 'pending', callbackDelivered: Boolean(transaction.callbackDeliveredAt), amountMinor: transaction.amountMinor, currency: transaction.currency, callbackDeliveredAt: transaction.callbackDeliveredAt || null });
    } catch (error) {
      return out(response, 502, { error: error.message || 'Payment-service reconciliation failed.' });
    }
  }

  if (request.method === 'GET' && servePublic(response, pathname)) return;

  if (request.method === 'POST' && pathname === '/api/v1/webhooks/paystack') {
    const raw = await read(request);
    const handled = await handleBundleWebhook(raw, request.headers);
    if (handled) return out(response, 200, handled.duplicate ? { ok: true, duplicate: true } : { ok: true });
    const replay = Readable.from([raw]);
    replay.method = request.method;
    replay.url = request.url;
    replay.headers = request.headers;
    return route(replay, response);
  }

  await bundleRoute(request, response);
  if (response.writableEnded) return;
  return route(request, response);
}).listen(PORT, () => console.log(`Payment service: ${BASE}`));
