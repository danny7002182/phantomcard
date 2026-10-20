const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NETWORKS = Object.freeze({
  mtn: { label: 'MTN Ghana', rate: 4 },
  telecel: { label: 'Telecel', rate: 5 },
  airteltigo: { label: 'AirtelTigo', rate: 6 }
});
const SIZES = Object.freeze([1, 2, 3, 4, 5, 6, 10, 15, 20, 25, 30, 35, 40]);
const CURRENCY = 'GHS';
const PAYMENT_WINDOW_MS = 15 * 60 * 1000;

const now = () => new Date().toISOString();
const makeId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const safeText = (value, max = 200) => String(value || '').trim().slice(0, max);

function filePath() {
  return process.env.DATA_BUNDLE_DATA_FILE || path.join(__dirname, 'data/data-bundles.json');
}

function loadStore() {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) return { orders: [], requestIds: [] };
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { orders: Array.isArray(value.orders) ? value.orders : [], requestIds: Array.isArray(value.requestIds) ? value.requestIds : [] };
  } catch {
    return { orders: [], requestIds: [] };
  }
}

function saveStore(store) {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function normalizeRecipient(value) {
  const digits = String(value || '').replace(/\D/g, '');
  let local = digits.startsWith('233') ? digits.slice(3) : digits;
  if (local.startsWith('0')) local = local.slice(1);
  return /^[25]\d{8}$/.test(local) ? `+233${local}` : '';
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function orderView(order) {
  return {
    reference: order.reference,
    network: order.network,
    networkLabel: NETWORKS[order.network]?.label || order.network,
    recipient: order.recipient,
    sizeGb: order.sizeGb,
    amount: order.amountMinor / 100,
    currency: order.currency,
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    createdAt: order.createdAt,
    paidAt: order.paidAt || null,
    fulfilledAt: order.fulfilledAt || null
  };
}

function paymentPage(reference) {
  const escaped = String(reference).replace(/[^A-Za-z0-9_-]/g, '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirm bundle payment</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbfaf7;color:#1e2421;font:15px system-ui,-apple-system,sans-serif}.box{width:min(430px,calc(100% - 42px));background:#fff;border:1px solid #e8e6df;border-radius:18px;padding:34px;box-shadow:0 20px 60px rgba(26,43,36,.1)}.mark{width:48px;height:48px;display:grid;place-items:center;border-radius:14px;background:#d6e45a;color:#183f35;font-size:25px;font-weight:800}h1{font-size:11px;letter-spacing:.15em;color:#235c4b;margin:25px 0 9px}h2{font-size:27px;line-height:1.1;margin:0 0 13px;letter-spacing:-.05em}p{line-height:1.6;color:#78807b}.ref{font:12px monospace;word-break:break-all;background:#f1f0eb;padding:12px;border-radius:8px;margin-top:16px}button{width:100%;margin-top:20px;padding:14px;border:0;border-radius:8px;background:#235c4b;color:#fff;font-weight:700;font-size:15px;cursor:pointer}.note{font-size:12px;text-align:center;margin-bottom:0}</style></head><body><main class="box"><div class="mark">↗</div><h1>SECURE BUNDLE PAYMENT</h1><h2>Confirming your Paystack payment</h2><p>Your payment is being reconciled securely. You can continue when Paystack has completed the transaction.</p><div class="ref">${escaped}</div><button id="check" type="button">Check payment status</button><p class="note" id="message"></p></main><script>const reference=${JSON.stringify(escaped)};const check=document.getElementById('check'),message=document.getElementById('message');async function confirmPayment(){check.disabled=true;message.textContent='Checking Paystack…';try{const response=await fetch('/api/v1/data-bundles/'+encodeURIComponent(reference)+'/complete',{method:'POST'});const data=await response.json();if(data.status==='SUCCESS'){location.assign('/?bundle_order='+encodeURIComponent(reference));return}if(data.status==='FAILED'||data.status==='EXPIRED'){location.assign('/?bundle_payment='+data.status.toLowerCase());return}message.textContent=data.message||'Payment is still pending. Try again in a moment.'}catch{message.textContent='We could not check the payment right now.'}check.disabled=false}check.addEventListener('click',confirmPayment);confirmPayment();</script></body></html>`;
}

function adminAuthorized(req) {
  const configured = String(process.env.DATA_BUNDLE_ADMIN_TOKEN || '');
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const supplied = String(req.headers['x-data-bundle-admin-token'] || bearer);
  const expected = Buffer.from(configured);
  const actual = Buffer.from(supplied);
  return Boolean(configured && supplied && expected.length === actual.length && crypto.timingSafeEqual(expected, actual));
}

function networkOrder(body) {
  const network = String(body.network || '').toLowerCase();
  const sizeGb = Number(body.sizeGb);
  const recipient = normalizeRecipient(body.recipient);
  if (!NETWORKS[network] || !SIZES.includes(sizeGb) || !recipient) return null;
  const amountMinor = sizeGb * NETWORKS[network].rate * 100;
  return { network, sizeGb, recipient, amountMinor };
}

function matchingPayment(order, payment) {
  const metadata = payment.metadata || {};
  return payment.reference === order.paystackReference
    && Number(payment.amount) === order.amountMinor
    && String(payment.currency).toUpperCase() === order.currency
    && metadata.service === 'PULSE_DATA'
    && metadata.orderReference === order.reference;
}

function createBundleRoute({ getBase, pay }) {
  return async function bundleRoute(req, res) {
    const url = new URL(req.url, getBase());
    const pathname = url.pathname;
    const store = loadStore();

    if (req.method === 'GET' && pathname === '/data/payment/return') {
      let reference = url.searchParams.get('reference') || '';
      if (!/^BNDL_[A-Za-z0-9_-]{16,100}$/.test(reference)) {
        const paystackReference = url.searchParams.get('trxref') || reference;
        const matchingOrder = store.orders.find((item) => item.paystackReference === paystackReference);
        reference = matchingOrder?.reference || '';
      }
      if (!/^BNDL_[A-Za-z0-9_-]{16,100}$/.test(reference)) return json(res, 400, { error: 'Invalid bundle payment reference.' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(paymentPage(reference));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/v1/data-bundles/initialize') {
      let body;
      try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return json(res, 400, { error: 'Malformed bundle order.' }); }
      const details = networkOrder(body);
      if (!details) return json(res, 400, { error: 'Choose a valid network, bundle size, and Ghana recipient number.' });
      const email = String(process.env.DATA_BUNDLE_PAYMENT_EMAIL || 'danny700218+1@gmail.com').trim().toLowerCase();
      if (!validEmail(email)) return json(res, 503, { error: 'Bundle payment email is not configured.' });
      const reference = makeId('BNDL');
      const paystackReference = makeId('PBD');
      const order = {
        reference, paystackReference, ...details, currency: CURRENCY, paymentProvider: 'paystack',
        paymentStatus: 'PENDING', status: 'PAYMENT_INITIALIZED', fulfillmentStatus: 'AWAITING_PAYMENT',
        customerEmail: email, createdAt: now(), updatedAt: now(), expiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS).toISOString()
      };
      try {
        const payment = await pay('/transaction/initialize', {
          method: 'POST',
          body: JSON.stringify({
            email, amount: order.amountMinor, currency: CURRENCY, reference: paystackReference,
            callback_url: `${getBase()}/data/payment/return?reference=${encodeURIComponent(reference)}`,
            metadata: { service: 'PULSE_DATA', orderReference: reference, network: details.network, sizeGb: details.sizeGb }
          })
        });
        order.authorizationUrl = payment.authorization_url;
        store.orders.push(order);
        saveStore(store);
        return json(res, 201, { reference, authorizationUrl: order.authorizationUrl, expiresAt: order.expiresAt });
      } catch (error) {
        return json(res, 502, { error: error.message || 'Bundle payment could not be initialized.' });
      }
    }

    const completeMatch = pathname.match(/^\/api\/v1\/data-bundles\/(BNDL_[A-Za-z0-9_-]{16,100})\/complete$/);
    if (req.method === 'POST' && completeMatch) {
      const order = store.orders.find((item) => item.reference === completeMatch[1]);
      if (!order) return json(res, 404, { error: 'Bundle order was not found.' });
      if (order.paymentStatus === 'SUCCESS') return json(res, 200, { status: 'SUCCESS', order: orderView(order) });
      if (['FAILED', 'EXPIRED'].includes(order.paymentStatus)) return json(res, 200, { status: order.paymentStatus, order: orderView(order) });
      try {
        const payment = await pay('/transaction/verify/' + encodeURIComponent(order.paystackReference));
        if (!matchingPayment(order, payment)) return json(res, 409, { error: 'Payment details did not reconcile.' });
        if (payment.status === 'success') {
          order.paymentStatus = 'SUCCESS';
          order.status = 'PAID_AWAITING_MANUAL_DELIVERY';
          order.fulfillmentStatus = 'AWAITING_MANUAL_DELIVERY';
          order.paidAt = now();
        } else if (['failed', 'abandoned', 'reversed'].includes(payment.status)) {
          order.paymentStatus = 'FAILED';
          order.status = 'PAYMENT_FAILED';
          order.fulfillmentStatus = 'NOT_REQUIRED';
        } else if (Date.parse(order.expiresAt) <= Date.now()) {
          order.paymentStatus = 'EXPIRED';
          order.status = 'PAYMENT_EXPIRED';
          order.fulfillmentStatus = 'NOT_REQUIRED';
        }
        order.updatedAt = now();
        saveStore(store);
        return json(res, order.paymentStatus === 'PENDING' ? 202 : 200, { status: order.paymentStatus, order: orderView(order), message: order.paymentStatus === 'PENDING' ? 'Payment is still being confirmed.' : undefined });
      } catch (error) {
        return json(res, 502, { error: error.message || 'Payment verification failed.' });
      }
    }

    const orderMatch = pathname.match(/^\/api\/v1\/data-bundles\/orders\/(BNDL_[A-Za-z0-9_-]{16,100})$/);
    if (req.method === 'GET' && orderMatch) {
      const order = store.orders.find((item) => item.reference === orderMatch[1]);
      return order ? json(res, 200, { order: orderView(order) }) : json(res, 404, { error: 'Bundle order was not found.' });
    }

    if (req.method === 'GET' && pathname === '/api/v1/data-bundles/admin/orders') {
      if (!adminAuthorized(req)) return json(res, process.env.DATA_BUNDLE_ADMIN_TOKEN ? 401 : 503, { error: process.env.DATA_BUNDLE_ADMIN_TOKEN ? 'Invalid bundle admin authentication.' : 'Bundle admin access is not configured.' });
      return json(res, 200, { orders: store.orders.slice().reverse().map(orderView) });
    }

    const fulfillMatch = pathname.match(/^\/api\/v1\/data-bundles\/admin\/orders\/(BNDL_[A-Za-z0-9_-]{16,100})\/fulfill$/);
    if (req.method === 'POST' && fulfillMatch) {
      if (!adminAuthorized(req)) return json(res, process.env.DATA_BUNDLE_ADMIN_TOKEN ? 401 : 503, { error: process.env.DATA_BUNDLE_ADMIN_TOKEN ? 'Invalid bundle admin authentication.' : 'Bundle admin access is not configured.' });
      const order = store.orders.find((item) => item.reference === fulfillMatch[1]);
      if (!order) return json(res, 404, { error: 'Bundle order was not found.' });
      if (order.paymentStatus !== 'SUCCESS') return json(res, 409, { error: 'Only successfully paid orders can be marked fulfilled.' });
      let body = {};
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'Malformed fulfillment note.' }); }
      order.fulfillmentStatus = 'FULFILLED';
      order.status = 'FULFILLED';
      order.fulfilledAt = now();
      order.deliveryNote = safeText(body.note, 500);
      order.updatedAt = now();
      saveStore(store);
      return json(res, 200, { order: orderView(order) });
    }

    return false;
  };
}

async function handleBundleWebhook(rawBody, headers) {
  const signature = String(headers['x-paystack-signature'] || '');
  const secret = String(process.env.PAYSTACK_SECRET_KEY || '');
  const expected = secret ? crypto.createHmac('sha512', secret).update(rawBody).digest('hex') : '';
  if (!expected || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch { return false; }
  const payment = event.data || {};
  const store = loadStore();
  const order = store.orders.find((item) => item.paystackReference === payment.reference);
  if (!order) return false;
  if (!matchingPayment(order, payment)) return false;
  const eventId = String(event.id || crypto.createHash('sha256').update(rawBody).digest('hex'));
  order.webhookEventIds = Array.isArray(order.webhookEventIds) ? order.webhookEventIds : [];
  if (order.webhookEventIds.includes(eventId)) return { duplicate: true };
  order.webhookEventIds.push(eventId);
  if (event.event === 'charge.success') {
    order.paymentStatus = 'SUCCESS';
    order.status = 'PAID_AWAITING_MANUAL_DELIVERY';
    order.fulfillmentStatus = 'AWAITING_MANUAL_DELIVERY';
    order.paidAt = order.paidAt || now();
  } else if (event.event === 'charge.failed') {
    order.paymentStatus = 'FAILED';
    order.status = 'PAYMENT_FAILED';
    order.fulfillmentStatus = 'NOT_REQUIRED';
  }
  order.updatedAt = now();
  saveStore(store);
  return { duplicate: false };
}

module.exports = { createBundleRoute, handleBundleWebhook };
