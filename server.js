const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PAYSTACK_PAYMENT_EMAILS, isAllowedPaystackPaymentEmail } = require('./payment-config');

const ROOT = __dirname;

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

const DATA_FILE = process.env.PHANTOM_DATA_FILE || path.join(ROOT, 'data', 'phantom-cards.json');
const KYC_DOCUMENTS_DIR = process.env.KYC_DOCUMENTS_DIR || path.join(path.dirname(DATA_FILE), 'kyc-documents');
const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || process.env.APP_URL || '';
const PAYSTACK_CURRENCY = process.env.PAYSTACK_CURRENCY || 'GHS';
const SITE_B_BASE_URL = String(process.env.SITE_B_BASE_URL || '').replace(/\/$/, '');
const SITE_A_TO_SITE_B_SECRET = process.env.SITE_A_TO_SITE_B_SECRET || '';
const SITE_B_TO_SITE_A_SECRET = process.env.SITE_B_TO_SITE_A_SECRET || '';
const PAYMENT_SESSION_MS = Number(process.env.PAYMENT_SESSION_MINUTES || 15) * 60 * 1000;
const PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{8,160}$/;
const HANDOFF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const ADMIN_APPROVAL_TOKEN = process.env.ADMIN_APPROVAL_TOKEN || '';
const ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL || '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const ADMIN_SESSION_MAX_AGE = 1000 * 60 * 60 * 8;
const MAX_MANUAL_WALLET_CREDIT = 100000;
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 30;
const SESSION_SHORT_MAX_AGE = 1000 * 60 * 60 * 8;
const RATE_WINDOW_MS = 1000 * 60 * 15;
const RATE_LIMITS = {
  '/api/auth/login': 20,
  '/api/auth/signup': 15,
  '/api/auth/forgot': 10,
  '/api/auth/reset': 10,
  '/api/auth/password': 10,
  '/api/auth/pin': 10,
  '/api/purchases': 30,
  '/api/redemptions': 30,
  '/api/withdrawals': 20,
  '/api/support/messages': 10,
};
const rateBuckets = new Map();
// Prevent concurrent retries for the same Site A payment from creating more
// than one Site B initialization request within this process. Site B must also
// enforce the same idempotency contract durably across processes.
const paymentInitializationLocks = new Map();
const MIN_DEPOSIT = 30;
const MIN_WITHDRAWAL = 10;
const MIN_REDEEMED_CARDS_FOR_WITHDRAWAL = 3;
const OPERATIONAL_CHARGE_RATE = 0.10;
const KYC_BYPASS_FEE = 70;
const KYC_STATUS = {
  NOT_VERIFIED: 'NOT_VERIFIED',
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
};
const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  PAYMENT_INITIALIZED: 'PAYMENT_INITIALIZED',
  PAYMENT_INITIALIZATION_UNKNOWN: 'PAYMENT_INITIALIZATION_UNKNOWN',
  PENDING_RECONCILIATION: 'PENDING_RECONCILIATION',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
};
const RECOVERABLE_PAYMENT_STATUSES = new Set([
  PAYMENT_STATUS.PENDING,
  PAYMENT_STATUS.PAYMENT_INITIALIZED,
  PAYMENT_STATUS.PAYMENT_INITIALIZATION_UNKNOWN,
  PAYMENT_STATUS.PENDING_RECONCILIATION,
]);
const RECOVERABLE_KYC_PAYMENT_STATUSES = new Set([
  'initialized',
  PAYMENT_STATUS.PAYMENT_INITIALIZED,
  PAYMENT_STATUS.PAYMENT_INITIALIZATION_UNKNOWN,
  PAYMENT_STATUS.PENDING_RECONCILIATION,
]);
const WITHDRAWAL_STATUS = {
  PENDING_KYC_VERIFICATION: 'PENDING_KYC_VERIFICATION',
  PENDING: 'pending',
  APPROVED: 'approved',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
};
const CODE_PATTERN = /^[A-Z]{2}[A-Z0-9]{12}$/;
const GHS_PER_USD = 12;
const REWARD_MULTIPLIER_MIN = 3.52;
const REWARD_MULTIPLIER_MAX = 4.42;
const REWARD_BANDS = [
  { key: 'band-a', label: '$3 Band', minUsd: 3, maxUsd: 3 },
  { key: 'band-b', label: '$4-$5 Band', minUsd: 4, maxUsd: 5 },
  { key: 'band-c', label: '$6-$8 Band', minUsd: 6, maxUsd: 8 },
  { key: 'band-d', label: '$9-$12 Band', minUsd: 9, maxUsd: 12 },
  { key: 'band-e', label: '$13-$15 Band', minUsd: 13, maxUsd: 15 },
  { key: 'band-f', label: '$16-$20 Band', minUsd: 16, maxUsd: 20 },
  { key: 'band-g', label: '$21-$25 Band', minUsd: 21, maxUsd: 25 },
  { key: 'band-h', label: '$26-$30 Band', minUsd: 26, maxUsd: 30 },
  { key: 'band-i', label: '$31-$35 Band', minUsd: 31, maxUsd: 35 },
  { key: 'band-j', label: '$36-$40 Band', minUsd: 36, maxUsd: 40 },
  { key: 'band-k', label: '$41-$45 Band', minUsd: 41, maxUsd: 45 },
  { key: 'band-l', label: '$46-$50 Band', minUsd: 46, maxUsd: 50 },
].map(band => ({ ...band, minRate: REWARD_MULTIPLIER_MIN, maxRate: REWARD_MULTIPLIER_MAX }));

function uid(prefix) { return `${prefix}_${crypto.randomBytes(9).toString('hex')}`; }
function reference(kind) { return `PH-${kind}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }
function uniqueReference(db, kind) {
  const existing = new Set([
    ...db.deposits,
    ...db.purchases,
    ...db.withdrawals,
    ...(db.kycBypassPayments || []),
    ...db.transactions,
    ...db.receipts,
    ...(db.codes || []).map(x => ({ reference: x.redemptionReference })),
  ].flatMap(x => [x.reference, x.orderId, x.transactionId, x.paystackReference]).filter(Boolean));
  let value; do { value = reference(kind); } while (existing.has(value)); return value;
}
function uniqueCode(db) {
  let value;
  do {
    value = `${letters(2)}${token(6)}${token(6)}`;
  } while (db.codes.some(x => x.code === value));
  return value;
}
function letters(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let value = '';
  while (value.length < length) value += alphabet[crypto.randomInt(alphabet.length)];
  return value;
}
function token(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let value = '';
  while (value.length < length) value += alphabet[crypto.randomInt(alphabet.length)];
  return value;
}
function stableToken(seed, length) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = seeded(seed);
  let value = '';
  while (value.length < length) value += alphabet[Math.floor(random() * alphabet.length)];
  return value;
}
function rewardBandFor(priceGhs) {
  const priceUsd = money(priceGhs / GHS_PER_USD);
  return REWARD_BANDS.find(band => priceUsd >= band.minUsd && priceUsd <= band.maxUsd) || REWARD_BANDS[REWARD_BANDS.length - 1];
}
function rewardRangeForPrice(priceGhs) {
  const price = money(priceGhs);
  const band = rewardBandFor(price);
  return {
    min: money(price * band.minRate),
    max: money(price * band.maxRate),
    minRate: band.minRate,
    maxRate: band.maxRate,
  };
}
function rewardAllocationForPrice(priceGhs) {
  const multiplierMinor = crypto.randomInt(Math.round(REWARD_MULTIPLIER_MIN * 100), Math.round(REWARD_MULTIPLIER_MAX * 100) + 1);
  const rewardMultiplier = money(multiplierMinor / 100);
  return {
    rewardMultiplier,
    rewardAmount: money(money(priceGhs) * rewardMultiplier),
  };
}
function rewardForPrice(priceGhs) {
  return rewardAllocationForPrice(priceGhs).rewardAmount;
}
function validRewardMultiplier(value) {
  const multiplier = Number(value);
  return Number.isFinite(multiplier) && multiplier >= REWARD_MULTIPLIER_MIN && multiplier <= REWARD_MULTIPLIER_MAX;
}
function rewardMultiplierForAmount(rewardAmount, purchaseAmount) {
  const amount = Number(purchaseAmount);
  return amount > 0 ? money(Number(rewardAmount) / amount) : null;
}
function validPaystackPaymentEmail(value) {
  return isAllowedPaystackPaymentEmail(value);
}
function assignedPaystackPaymentEmail(index = 0) {
  return PAYSTACK_PAYMENT_EMAILS[Math.abs(Number(index) || 0) % PAYSTACK_PAYMENT_EMAILS.length];
}
function paystackEmailForUser(user) {
  const value = normalizeEmail(user?.paystackPaymentEmail);
  if (!validPaystackPaymentEmail(value)) throw new Error('User does not have a valid Paystack payment email assignment.');
  return value;
}
function normalizeCode(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14); }
function money(value) { return Math.round(Number(value) * 100) / 100; }
function now() { return new Date().toISOString(); }
const GHANA_TIME_ZONE = 'Africa/Accra';
const DAILY_CARD_PURCHASE_LIMIT = 2;
function ghanaCalendarDate(value = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: GHANA_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value)).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function nextGhanaMidnightIso(value = Date.now()) {
  const current = new Date(value);
  const date = ghanaCalendarDate(current);
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0));
  return next.toISOString();
}
function purchasePriceKey(card) {
  return money(Number(card?.displayPriceUsd ?? (Number(card?.priceGhs || card?.price || 0) / GHS_PER_USD))).toFixed(2);
}
function hash(value, salt = crypto.randomBytes(16).toString('hex')) { return new Promise((resolve, reject) => crypto.scrypt(value, salt, 64, (e, key) => e ? reject(e) : resolve(`${salt}:${key.toString('hex')}`))); }
async function passwordMatches(value, stored) { const [salt] = stored.split(':'); return crypto.timingSafeEqual(Buffer.from(await hash(value, salt)), Buffer.from(stored)); }
function normalizePhone(value) { return String(value || '').trim().replace(/[\s-]/g, ''); }
function validMobile(value) { return /^0\d{9}$/.test(value); }
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validGmail(value) { return /^[^\s@]+@gmail\.com$/i.test(value); }
function seeded(n) { let x = n >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
function makeCards() {
  const categories = ['Digital', 'Gaming', 'Crypto', 'Collectible', 'Access', 'Exclusive', 'Limited', 'Rare'];
  const visuals = ['205,220,235', '176,124,255', '94,215,255', '245,166,35', '143,232,196', '255,106,145', '131,147,255', '255,210,122'];
  const prices = [36, 48, 60, 72, 84, 96, 108, 120, 144, 168, 192, 216, 240, 288, 336, 420, 480, 540, 600];
  const random = seeded(0x5048414e);
  return Array.from({ length: 80 }, (_, i) => {
    const category = categories[i % categories.length]; const tier = ['Founders', 'Vault', 'Prime', 'Signature', 'Reserve', 'Crown'][Math.floor(i / categories.length) % 6];
    const priceGhs = prices[i % prices.length];
    const seed = 0x5048414e + i;
    const serial = stableToken(seed, 8);
    const stock = i % 17 === 0 ? 0 : 8 + Math.floor(random() * 42);
    const band = rewardBandFor(priceGhs);
    const rewardRange = rewardRangeForPrice(priceGhs);
    return { id: `CARD-${String(i + 1).padStart(4, '0')}`, seed, serial, title: `${category} ${tier} ${serial.slice(0, 4)}`, category, price: priceGhs, priceGhs, displayPriceUsd: money(priceGhs / GHS_PER_USD), stock, active: stock > 0, series: `${category.slice(0, 3).toUpperCase()}-${serial.slice(0, 5)}`, edition: serial.slice(5), rgb: visuals[i % visuals.length], rewardBand: band.key, rewardMinRate: band.minRate, rewardMaxRate: band.maxRate, rewardMinAmount: rewardRange.min, rewardMaxAmount: rewardRange.max, description: `${category} ${tier.toLowerCase()} sealed card with a ${band.label.toLowerCase()} reward band.` };
  });
}
function blankDb() { return { version: 5, cards: makeCards(), users: [], sessions: [], adminSessions: [], adminAuditLogs: [], supportMessages: [], deposits: [], purchases: [], dailyPurchaseCounts: [], codes: [], methods: [], withdrawals: [], transactions: [], receipts: [], passwordResets: [], kycBypassPayments: [] }; }
function paymentStatusEvent(payment, status, source, extra = {}) {
  payment.statusEvents = Array.isArray(payment.statusEvents) ? payment.statusEvents : [];
  payment.statusEvents.push({ status, source, at: now(), ...extra });
  payment.statusEvents = payment.statusEvents.slice(-100);
}
function normalizePaymentRecord(payment, defaultStatus) {
  if (!payment || typeof payment !== 'object') return payment;
  payment.status = payment.status || defaultStatus;
  payment.callbackRequestIds = Array.isArray(payment.callbackRequestIds) ? payment.callbackRequestIds : [];
  payment.statusEvents = Array.isArray(payment.statusEvents) ? payment.statusEvents : [];
  payment.initializationAttempts = Number.isInteger(payment.initializationAttempts) ? payment.initializationAttempts : 0;
  payment.reconciliationAttempts = Number.isInteger(payment.reconciliationAttempts) ? payment.reconciliationAttempts : 0;
  payment.callbackAttempts = Number.isInteger(payment.callbackAttempts) ? payment.callbackAttempts : 0;
  payment.lastInitializationAt = payment.lastInitializationAt || null;
  payment.lastReconciliationAt = payment.lastReconciliationAt || null;
  payment.lastCallbackAt = payment.lastCallbackAt || null;
  payment.reconciliationStatus = payment.reconciliationStatus || null;
  return payment;
}
function isRecoverablePaymentStatus(status) { return RECOVERABLE_PAYMENT_STATUSES.has(String(status || '')); }
function isRecoverableKycPaymentStatus(status) { return RECOVERABLE_KYC_PAYMENT_STATUSES.has(String(status || '')); }
function mergePaymentServiceMapping(payment, result, payload) {
  if (validProviderReference(result?.transactionId)) payment.paymentServiceTransactionId = result.transactionId;
  if (validProviderReference(result?.paystackReference)) payment.paystackReference = result.paystackReference;
  if (validPaymentExpiry(result?.expiresAt)) payment.paymentServiceExpiresAt = result.expiresAt;
  if (validSiteBHandoffUrl(result?.handoffUrl, payload)) payment.handoffUrl = result.handoffUrl;
}
function markInitializationUnknown(payment, result, payload, reason = 'unknown') {
  mergePaymentServiceMapping(payment, result, payload);
  payment.status = PAYMENT_STATUS.PAYMENT_INITIALIZATION_UNKNOWN;
  payment.initializationAttempts = (payment.initializationAttempts || 0) + 1;
  payment.lastInitializationAt = now();
  payment.initializationUncertaintyReason = reason;
  payment.reconciliationStatus = 'PENDING';
  payment.updatedAt = now();
  paymentStatusEvent(payment, payment.status, 'site-a-initialization', { reason });
}
function syncCardCatalog(cards) {
  const generated = makeCards();
  const generatedMap = new Map(generated.map(card => [card.id, card]));
  return (Array.isArray(cards) && cards.length ? cards : generated).map(card => {
    const template = generatedMap.get(card.id) || card;
    const priceGhs = money(card.priceGhs || card.price || template.priceGhs);
    const seed = card.seed || template.seed || 0x5048414e;
    const band = rewardBandFor(priceGhs);
    const stock = Number.isFinite(Number(card.stock)) ? Math.max(0, Math.trunc(Number(card.stock))) : template.stock;
    const serial = card.serial && !/#\d+/.test(String(card.serial)) ? card.serial : (template.serial || stableToken(seed, 8));
    return {
      ...card,
      seed,
      serial,
      title: template.title && !/#\d+/.test(String(template.title)) ? template.title : `${card.category || template.category} ${serial.slice(0, 4)}`,
      series: template.series || `${String(card.category || template.category || 'Card').slice(0, 3).toUpperCase()}-${serial.slice(0, 5)}`,
      edition: template.edition || serial.slice(5),
      description: template.description || `${card.category || template.category || 'Digital'} sealed card with a ${band.label.toLowerCase()} reward band.`,
      price: priceGhs,
      priceGhs,
      displayPriceUsd: money(priceGhs / GHS_PER_USD),
      stock,
      active: stock > 0 && (card.active === undefined ? true : Boolean(card.active)),
      rewardBand: band.key,
      rewardRate: undefined,
      rewardAmount: undefined,
      rewardMinRate: band.minRate,
      rewardMaxRate: band.maxRate,
      rewardMinAmount: rewardRangeForPrice(priceGhs).min,
      rewardMaxAmount: rewardRangeForPrice(priceGhs).max,
    };
  });
}
function migrateMoneyLedger(clean) {
  const cardMap = new Map(clean.cards.map(card => [card.id, card]));
  const purchaseMap = new Map(clean.purchases.map(purchase => [purchase.id, purchase]));
  clean.purchases.forEach(purchase => {
    const card = cardMap.get(purchase.cardId);
    const amountPaid = money(purchase.amountPaid ?? purchase.amount ?? card?.priceGhs ?? 0);
    purchase.amountPaid = amountPaid;
    purchase.amount = amountPaid;
    if (purchase.rewardAmount === undefined && card?.rewardAmount === undefined) {
      const allocation = rewardAllocationForPrice(amountPaid);
      purchase.rewardAmount = allocation.rewardAmount;
      purchase.rewardMultiplier = allocation.rewardMultiplier;
    } else {
      purchase.rewardAmount = money(purchase.rewardAmount ?? card?.rewardAmount);
      purchase.rewardMultiplier = purchase.rewardMultiplier ?? rewardMultiplierForAmount(purchase.rewardAmount, amountPaid);
    }
  });
  clean.codes.forEach(code => {
    const card = cardMap.get(code.cardId);
    const purchase = purchaseMap.get(code.purchaseId);
    const purchaseAmount = money(code.purchaseAmount ?? purchase?.amountPaid ?? card?.priceGhs ?? code.amount ?? 0);
    const rewardAmount = money(code.rewardAmount ?? purchase?.rewardAmount ?? card?.rewardAmount ?? rewardForPrice(purchaseAmount));
    code.code = normalizeCode(code.code);
    code.purchaseAmount = purchaseAmount;
    code.rewardAmount = rewardAmount;
    code.rewardMultiplier = code.rewardMultiplier ?? purchase?.rewardMultiplier ?? rewardMultiplierForAmount(rewardAmount, purchaseAmount);
    code.amount = rewardAmount;
  });
  clean.transactions.forEach(tx => {
    if (tx.reason === 'Card purchase') {
      const purchase = clean.purchases.find(item => item.reference === tx.reference || item.orderId === tx.related?.orderId);
      if (purchase) tx.related = { ...(tx.related || {}), purchaseAmount: purchase.amountPaid, rewardAmount: purchase.rewardAmount, rewardMultiplier: purchase.rewardMultiplier };
    }
    if (tx.reason === 'Redeemed code') {
      const code = clean.codes.find(item => item.redemptionReference === tx.reference || item.code === tx.related?.code);
      if (code) {
        tx.amount = code.rewardAmount;
        tx.related = { ...(tx.related || {}), purchaseAmount: code.purchaseAmount, rewardAmount: code.rewardAmount, rewardMultiplier: code.rewardMultiplier };
      }
    }
  });
  clean.receipts.forEach(rcpt => {
    if (rcpt.type === 'purchase') {
      const purchase = clean.purchases.find(item => item.reference === rcpt.reference || item.orderId === rcpt.related?.orderId);
      if (purchase) rcpt.related = { ...(rcpt.related || {}), purchaseAmount: purchase.amountPaid, rewardAmount: purchase.rewardAmount, rewardMultiplier: purchase.rewardMultiplier };
    }
    if (rcpt.type === 'redemption') {
      const code = clean.codes.find(item => item.redemptionReference === rcpt.reference || item.code === rcpt.related?.code);
      if (code) {
        rcpt.amount = code.rewardAmount;
        rcpt.related = { ...(rcpt.related || {}), purchaseAmount: code.purchaseAmount, rewardAmount: code.rewardAmount, rewardMultiplier: code.rewardMultiplier };
      }
    }
  });
  clean.users.forEach(user => {
    user.walletBalance = 0;
    user.redeemedBalance = 0;
    user.kycStatus = user.kycStatus || KYC_STATUS.NOT_VERIFIED;
  });
  clean.transactions.forEach(tx => {
    if (!transactionAffectsBalance(tx)) return;
    const user = clean.users.find(item => item.id === tx.userId);
    if (!user) return;
    const key = tx.account === 'wallet' ? 'walletBalance' : 'redeemedBalance';
    const delta = tx.type === 'credit' ? tx.amount : -tx.amount;
    user[key] = money(Math.max(0, user[key] + delta));
  });
}
function redeemedCardsCount(db, userId) {
  return db.codes.filter(code => code.userId === userId && code.status === 'redeemed').length;
}
function normalizeWithdrawalRecord(withdrawal) {
  const requestedAmount = money(withdrawal.requestedAmount ?? withdrawal.amount ?? 0);
  const isRefund = Boolean(withdrawal.isRefund || withdrawal.refundType === 'KYC_FEE_REFUND');
  const operationalCharge = money(withdrawal.operationalCharge ?? (isRefund ? 0 : requestedAmount * OPERATIONAL_CHARGE_RATE));
  const actualAmount = money(withdrawal.actualAmount ?? (isRefund ? requestedAmount : Math.max(0, requestedAmount - operationalCharge)));
  withdrawal.requestedAmount = requestedAmount;
  withdrawal.operationalCharge = operationalCharge;
  withdrawal.actualAmount = actualAmount;
  withdrawal.amount = requestedAmount;
  withdrawal.isRefund = isRefund;
  withdrawal.refundType = isRefund ? 'KYC_FEE_REFUND' : (withdrawal.refundType || null);
  withdrawal.refundForWithdrawalId = withdrawal.refundForWithdrawalId || null;
  withdrawal.refundForWithdrawalReference = withdrawal.refundForWithdrawalReference || null;
  withdrawal.refundedAt = withdrawal.refundedAt || null;
  withdrawal.kycRequired = Boolean(withdrawal.kycRequired);
  withdrawal.kycBypassUsed = Boolean(withdrawal.kycBypassUsed);
  withdrawal.kycBypassFee = money(withdrawal.kycBypassFee || 0);
  withdrawal.kycBypassRefunded = Boolean(withdrawal.kycBypassRefunded);
  withdrawal.kycBypassRefundAmount = money(withdrawal.kycBypassRefundAmount || 0);
  withdrawal.kycBypassRefundReference = withdrawal.kycBypassRefundReference || null;
  withdrawal.kycBypassRefundedAt = withdrawal.kycBypassRefundedAt || null;
  withdrawal.paymentStatus = withdrawal.paymentStatus || 'not_required';
  return withdrawal;
}
function withdrawalIsHeld(status) {
  return [WITHDRAWAL_STATUS.PENDING, WITHDRAWAL_STATUS.APPROVED, WITHDRAWAL_STATUS.PROCESSING, WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION].includes(status);
}
function normalizeDb(db) {
  const clean = { ...blankDb(), ...(db || {}) };
  for (const key of ['users', 'sessions', 'adminSessions', 'adminAuditLogs', 'supportMessages', 'deposits', 'purchases', 'dailyPurchaseCounts', 'codes', 'methods', 'withdrawals', 'transactions', 'receipts', 'passwordResets', 'kycBypassPayments']) {
    if (!Array.isArray(clean[key])) clean[key] = [];
  }
  clean.cards = syncCardCatalog(clean.cards);
  // Reassign the payment-only email pool on every database load. This migrates
  // existing users from the retired pool and keeps assignments deterministic
  // across restarts and deployments.
  clean.users.forEach((user, index) => {
    user.paystackPaymentEmail = assignedPaystackPaymentEmail(index);
  });
  clean.deposits.forEach(deposit => normalizePaymentRecord(deposit, PAYMENT_STATUS.PENDING));
  clean.kycBypassPayments.forEach(payment => normalizePaymentRecord(payment, 'initialized'));
  clean.withdrawals.forEach(withdrawal => normalizeWithdrawalRecord(withdrawal));
  // Older versions represented the KYC fee refund as a redeemed-balance
  // credit. Convert that legacy ledger entry into an external refund and
  // materialize the missing withdrawal-history record before rebuilding
  // balances, so loading old data cannot re-credit Redeemed Balance.
  clean.transactions.filter(tx => tx.reason === 'KYC bypass fee refund' || tx.related?.transactionType === 'REFUND').forEach(tx => {
    const related = tx.related || {};
    const original = clean.withdrawals.find(item => item.id === related.withdrawalId || item.reference === related.withdrawalReference);
    tx.account = 'external';
    tx.status = 'refunded';
    tx.entryType = 'REFUND';
    tx.reason = 'KYC Fee Refund';
    tx.related = { ...related, refund: true, transactionType: 'REFUND', withdrawalId: related.withdrawalId || original?.id || null, withdrawalReference: related.withdrawalReference || original?.reference || null };
    if (original && !clean.withdrawals.some(item => item.reference === tx.reference && item.isRefund)) {
      clean.withdrawals.push(normalizeWithdrawalRecord({
        id: uid('wdl_refund'), userId: tx.userId, methodId: original.methodId,
        amount: tx.amount, requestedAmount: tx.amount, operationalCharge: 0,
        actualAmount: tx.amount, reference: tx.reference, status: 'refunded',
        isRefund: true, refundType: 'KYC_FEE_REFUND',
        refundForWithdrawalId: original.id, refundForWithdrawalReference: original.reference,
        refundedAt: tx.createdAt, createdAt: tx.createdAt,
      }));
    }
  });
  clean.receipts.filter(rcpt => rcpt.type === 'kyc_bypass_refund' || rcpt.related?.transactionType === 'REFUND').forEach(rcpt => {
    rcpt.account = 'external';
    rcpt.status = 'refunded';
    rcpt.related = { ...(rcpt.related || {}), refund: true, transactionType: 'REFUND' };
  });
  migrateMoneyLedger(clean);
  rebuildDailyPurchaseCounts(clean);
  clean.users.forEach(user => {
    user.walletBalance = money(user.walletBalance || 0);
    user.redeemedBalance = money(user.redeemedBalance || 0);
    user.kycStatus = Object.values(KYC_STATUS).includes(user.kycStatus) ? user.kycStatus : KYC_STATUS.NOT_VERIFIED;
    user.kycVerifiedAt = user.kycStatus === KYC_STATUS.VERIFIED ? (user.kycVerifiedAt || now()) : null;
  });
  return clean;
}
function rebuildDailyPurchaseCounts(db) {
  const counts = new Map();
  for (const purchase of db.purchases) {
    const card = db.cards.find(item => item.id === purchase.cardId);
    if (!purchase.userId || !card) continue;
    const date = ghanaCalendarDate(purchase.createdAt || Date.now());
    const priceKey = purchasePriceKey(card);
    const key = `${purchase.userId}:${priceKey}:${date}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  db.dailyPurchaseCounts = [...counts.entries()].map(([key, count]) => {
    const [userId, priceKey, purchaseDate] = key.split(':');
    return { id: `daily_${userId}_${priceKey}_${purchaseDate}`, userId, priceKey, priceUsd: Number(priceKey), purchaseDate, count };
  });
}
function load() { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); if (!fs.existsSync(DATA_FILE)) { const db = blankDb(); save(db); return db; } return normalizeDb(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
function save(db) {
  const directory = path.dirname(DATA_FILE);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryFile = `${DATA_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(db, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryFile, DATA_FILE);
  } catch (error) {
    try { fs.unlinkSync(temporaryFile); } catch {}
    throw error;
  }
}
function receipt(db, { userId, type, amount, account, reference: ref, status = 'completed', related = {} }) { if (db.receipts.some(x => x.reference === ref)) return db.receipts.find(x => x.reference === ref); const item = { id: uid('rcpt'), userId, type, amount: money(amount), account, reference: ref, status, related, createdAt: now() }; db.receipts.push(item); return item; }
function transaction(db, { userId, type, entryType = null, amount, account, reference: ref, status = 'completed', reason, related = {} }) { if (db.transactions.some(x => x.reference === ref)) return db.transactions.find(x => x.reference === ref); const item = { id: uid('txn'), userId, type, ...(entryType ? { entryType } : {}), amount: money(amount), account, reference: ref, status, reason, related, createdAt: now() }; db.transactions.push(item); return item; }
function transactionAffectsBalance(tx) {
  if (!['wallet', 'redeemed'].includes(tx.account)) return false;
  if (['completed', 'success'].includes(tx.status)) return true;
  return tx.account === 'redeemed' && tx.type === 'debit' && /withdraw/i.test(tx.reason || '') && withdrawalIsHeld(tx.status);
}
function persistKycDocuments(userId, documents) {
  const userDirectory = path.join(KYC_DOCUMENTS_DIR, String(userId));
  fs.mkdirSync(userDirectory, { recursive: true });
  return documents.map(document => {
    const content = String(document.content || '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content)) throw new Error('One of the uploaded documents is invalid.');
    const binary = Buffer.from(content, 'base64');
    if (!binary.length || binary.length !== Number(document.size) || binary.length > 5 * 1024 * 1024) throw new Error('One of the uploaded documents is invalid.');
    const storageKey = `${uid('kyc')}.bin`;
    fs.writeFileSync(path.join(userDirectory, storageKey), binary, { flag: 'wx', mode: 0o600 });
    return { name: String(document.name).trim().slice(0, 180), type: document.type, size: binary.length, storageKey };
  });
}
function balance(user, account, amount) { const key = account === 'wallet' ? 'walletBalance' : 'redeemedBalance'; const next = money(user[key] + amount); if (next < 0) throw new Error('Balance cannot be negative'); user[key] = next; }
function cookie(req) { return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(x => x.trim().split('='))); }
function sessionCookie(token, req, maxAge = SESSION_MAX_AGE / 1000) {
  const secure = requestOrigin(req).startsWith('https://') ? '; Secure' : '';
  return `phantom_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}
function clearSessionCookie(req) {
  const secure = requestOrigin(req).startsWith('https://') ? '; Secure' : '';
  return `phantom_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}
function isLocalHost(hostname = '') {
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(String(hostname).toLowerCase());
}
function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}
function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');
  if (forwardedHost) return `${protocol}://${forwardedHost}`;
  if (APP_BASE_URL) {
    try {
      return new URL(APP_BASE_URL).origin;
    } catch {
      return APP_BASE_URL;
    }
  }
  return `http://127.0.0.1:${PORT}`;
}
function appBaseUrlForRoute(req) {
  return APP_BASE_URL || requestOrigin(req);
}
function userFor(req, db) { const token = cookie(req).phantom_session; const session = db.sessions.find(s => s.token === token && s.expiresAt > Date.now()); return session && db.users.find(u => u.id === session.userId); }
function clientKey(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local').split(',')[0].trim();
}
function rateLimit(req, res, pathname) {
  const limit = RATE_LIMITS[pathname];
  if (!limit) return false;
  const key = `${clientKey(req)}:${pathname}`;
  const nowMs = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: nowMs + RATE_WINDOW_MS };
  if (bucket.resetAt <= nowMs) {
    bucket.count = 0;
    bucket.resetAt = nowMs + RATE_WINDOW_MS;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count <= limit) return false;
  json(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' }, { 'retry-after': String(Math.ceil((bucket.resetAt - nowMs) / 1000)) });
  return true;
}
function originAllowed(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  if (req.url.startsWith('/api/paystack/webhook') || req.url.startsWith('/api/v1/webhooks/payment-status') || req.url.startsWith('/api/v1/internal/')) return true;
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  return normalizeOrigin(origin) === normalizeOrigin(requestOrigin(req));
}
function publicState(db, user) {
  const userId = user.id; const cardMap = new Map(db.cards.map(c => [c.id, c]));
  const cards = db.cards.map(publicCard);
  const codes = db.codes.filter(x => x.userId === userId).map(x => publicCode(x, cardMap.get(x.cardId)));
  const txs = db.transactions.filter(x => x.userId === userId).map(publicTransaction).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const receipts = db.receipts.filter(x => x.userId === userId).map(publicReceipt).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const purchases = db.purchases.filter(x => x.userId === userId).map(publicPurchase).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const withdrawals = db.withdrawals.filter(x => x.userId === userId).map(publicWithdrawal).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const purchaseDate = ghanaCalendarDate();
  const dailyPurchaseCounts = {};
  db.dailyPurchaseCounts
    .filter(item => item.userId === userId && item.purchaseDate === purchaseDate && item.count > 0)
    .forEach(item => { dailyPurchaseCounts[item.priceKey] = Math.min(Number(item.count) || 0, DAILY_CARD_PURCHASE_LIMIT); });
  return {
    user: { id: user.id, name: user.name, email: user.email || '', phone: user.phone, contactEmailCapturedAt: user.contactEmailCapturedAt || null, createdAt: user.createdAt, walletBalance: user.walletBalance, redeemedBalance: user.redeemedBalance, hasPin: Boolean(user.pinHash), kycStatus: user.kycStatus || KYC_STATUS.NOT_VERIFIED, kycVerifiedAt: user.kycVerifiedAt || null, lifetimeRedeemedCards: redeemedCardsCount(db, user.id) },
    cards, codes, methods: db.methods.filter(x => x.userId === userId), transactions: txs, receipts, purchases, withdrawals,
    purchaseLimits: { date: purchaseDate, maxPerPrice: DAILY_CARD_PURCHASE_LIMIT, counts: dailyPurchaseCounts, resetAt: nextGhanaMidnightIso() },
  };
}
function publicCard(card) {
  const { rewardAmount, rewardRate, ...safe } = card;
  return safe;
}
function publicPurchase(purchase) {
  const { userId, idempotencyKey, rewardAmount, rewardMultiplier, ...safe } = purchase;
  return safe;
}
function publicWithdrawal(withdrawal) {
  return { ...withdrawal };
}
function publicCode(code, card) {
  const redeemed = code.status === 'redeemed';
  // A redeem code is a secret until its owner explicitly asks to reveal it.
  // Never include it (or the owner id) in ordinary account-state responses.
  const { code: secretCode, userId, rewardAmount, rewardMultiplier, amount, ...safe } = code;
  return {
    ...safe,
    ...(redeemed ? { amount, rewardAmount, rewardMultiplier } : {}),
    card: card ? publicCard(card) : undefined,
  };
}
function sanitizeRelated(related = {}, revealReward = false) {
  const safe = { ...related };
  delete safe.code;
  for (const key of ['depositId', 'provider', 'purpose', 'paystackReference', 'paymentServiceTransactionId']) delete safe[key];
  if (!revealReward) delete safe.rewardAmount;
  return safe;
}
function publicTransaction(tx) {
  return { ...tx, related: sanitizeRelated(tx.related, tx.reason === 'Redeemed code') };
}
function publicReceipt(rcpt) {
  return { ...rcpt, related: sanitizeRelated(rcpt.related, rcpt.type === 'redemption') };
}
function publicTopup(deposit) {
  return {
    amount: deposit.amount,
    currency: deposit.currency,
    purpose: deposit.purpose,
    status: deposit.status,
    reference: deposit.reference,
    expiresAt: deposit.expiresAt,
    createdAt: deposit.createdAt,
    updatedAt: deposit.updatedAt,
    verifiedAt: deposit.verifiedAt || null,
  };
}
function purchasePayload(purchase, code, receipt) {
  return {
    purchase: publicPurchase(purchase),
    code: publicCode(code),
    receipt: publicReceipt(receipt),
  };
}
function json(res, status, data, extra = {}) { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(data)); }
function fail(res, status, message) { json(res, status, { error: message }); }
async function body(req) { const chunks=[]; for await (const chunk of req) chunks.push(chunk); try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new Error('Invalid JSON body'); } }
async function rawBody(req) { const chunks=[]; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }
function safeEqual(a, b) { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function signedRequest(secret, payload, requestId = uid('req')) {
  const timestamp = String(Date.now());
  const rawBody = JSON.stringify(payload);
  return {
    body: rawBody,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
      'x-request-id': requestId,
      'x-timestamp': timestamp,
      'x-sitea-signature': crypto.createHmac('sha256', secret).update(`${timestamp}.${requestId}.${rawBody}`).digest('hex'),
    },
  };
}
function verifySignedRequest(req, raw, secret, maxAgeMs = 5 * 60 * 1000) {
  if (!secret) return false;
  const requestId = String(req.headers['x-request-id'] || ''); const timestamp = String(req.headers['x-timestamp'] || ''); const signature = String(req.headers['x-sitea-signature'] || '');
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(bearer, secret) || !/^[A-Za-z0-9_-]{8,200}$/.test(requestId) || !/^\d{13}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature) || Math.abs(Date.now() - Number(timestamp)) > maxAgeMs) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${requestId}.${raw}`).digest('hex');
  return safeEqual(signature, expected);
}
async function askPaymentServiceToReconcile(deposit) {
  if (!SITE_B_BASE_URL || !SITE_A_TO_SITE_B_SECRET) throw new Error('Payment service is not configured.');
  const payload = { siteATransactionId: deposit.transactionId || deposit.reference, paystackReference: deposit.paystackReference || null };
  const requestId = uid('reconcile');
  const signed = signedRequest(SITE_A_TO_SITE_B_SECRET, payload, requestId);
  const response = await fetch(`${SITE_B_BASE_URL}/api/v1/internal/admin/reconcile`, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Payment service could not verify this transaction.');
  return result;
}
class PaymentInitializationError extends Error {
  constructor(message, result = {}, reason = 'unknown') {
    super(message);
    this.name = 'PaymentInitializationError';
    this.result = result;
    this.reason = reason;
  }
}
function validTopup(deposit, user) { return deposit && user && deposit.userId === user.id && deposit.purpose === 'WALLET_TOPUP' && deposit.currency === PAYSTACK_CURRENCY && Number.isInteger(deposit.amountMinor) && deposit.amountMinor > 0; }
function validKycBypass(payment, user) { return payment && user && payment.userId === user.id && Number(payment.amount) === KYC_BYPASS_FEE && payment.currency === PAYSTACK_CURRENCY; }
function validProviderReference(value) { return PROVIDER_REFERENCE_PATTERN.test(String(value || '')); }
function siteBRequiresHttps() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') return true;
  try {
    return !isLocalHost(new URL(SITE_B_BASE_URL).hostname);
  } catch {
    return true;
  }
}
function validPaymentExpiry(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) && timestamp > Date.now();
}
function validSiteBHandoffUrl(value, payload = {}) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw || raw.trim() !== raw || !SITE_B_BASE_URL) return false;
  let expectedOrigin;
  let candidate;
  try {
    expectedOrigin = new URL(SITE_B_BASE_URL).origin;
    candidate = new URL(raw);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(candidate.protocol) || candidate.origin !== expectedOrigin) return false;
  if (siteBRequiresHttps() && candidate.protocol !== 'https:') return false;
  if (candidate.username || candidate.password || candidate.hash || candidate.pathname !== '/payment/handoff') return false;
  const hostname = candidate.hostname.toLowerCase();
  if (hostname === 'paystack.com' || hostname.endsWith('.paystack.com') || hostname === 'paystack.co' || hostname.endsWith('.paystack.co')) return false;
  if (candidate.searchParams.size !== 1 || !candidate.searchParams.has('token')) return false;
  const token = candidate.searchParams.get('token') || '';
  if (!HANDOFF_TOKEN_PATTERN.test(token)) return false;
  for (const valueToAvoid of [payload.siteATransactionId, payload.siteAUserId, payload.purpose]) {
    if (valueToAvoid && token.includes(String(valueToAvoid))) return false;
  }
  return true;
}
function callbackMatchesStoredPayment(payment, payload) {
  const paystackReference = String(payload.paystackReference || '');
  const paymentServiceTransactionId = String(payload.paymentServiceTransactionId || '');
  if (!validProviderReference(paystackReference) || !validProviderReference(paymentServiceTransactionId)) return false;
  if (payment.paystackReference && payment.paystackReference !== paystackReference) return false;
  if (payment.paymentServiceTransactionId && payment.paymentServiceTransactionId !== paymentServiceTransactionId) return false;
  return true;
}
async function initializePaymentService(payload, requestId) {
  if (!SITE_B_BASE_URL || !SITE_A_TO_SITE_B_SECRET) throw new Error('Payment service is not configured.');
  const signed = signedRequest(SITE_A_TO_SITE_B_SECRET, payload, requestId);
  const response = await fetch(`${SITE_B_BASE_URL}/api/v1/payments/initialize`, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => ({}));
  const hasOptionalProviderReference = result.paystackReference === undefined || result.paystackReference === null || validProviderReference(result.paystackReference);
  if (!response.ok) throw new PaymentInitializationError('Payment service rejected initialization.', result, 'service_rejected');
  if (!validProviderReference(result.transactionId) || !validPaymentExpiry(result.expiresAt) || !hasOptionalProviderReference) throw new PaymentInitializationError('Payment service returned an incomplete payment mapping.', result, 'incomplete_response');
  if (!validSiteBHandoffUrl(result.handoffUrl, payload)) throw new PaymentInitializationError('Payment service did not return a valid checkout handoff.', result, 'handoff_unavailable');
  return result;
}
function initializePaymentOnce(lockKey, payload, requestId) {
  const active = paymentInitializationLocks.get(lockKey);
  if (active) return active;
  const pending = initializePaymentService(payload, requestId);
  const tracked = pending.finally(() => {
    if (paymentInitializationLocks.get(lockKey) === tracked) paymentInitializationLocks.delete(lockKey);
  });
  paymentInitializationLocks.set(lockKey, tracked);
  return tracked;
}
function completeDeposit(db, deposit, provider) {
  const user = db.users.find(u => u.id === deposit.userId);
  if (!user) throw new Error('Deposit user was not found.');
  if (!validTopup(deposit, user)) throw new Error('Invalid wallet top-up.');
  const existingCredit = db.transactions.find(item => item.reference === deposit.reference && item.userId === deposit.userId && item.type === 'credit' && item.account === 'wallet' && item.reason === 'Wallet top-up');
  if (existingCredit) {
    deposit.status = PAYMENT_STATUS.SUCCESS;
    deposit.verifiedAt = deposit.verifiedAt || existingCredit.createdAt || now();
    deposit.updatedAt = now();
    receipt(db, { userId: user.id, type: 'deposit', amount: deposit.amount, account: 'wallet', reference: deposit.reference, related: { depositId: deposit.id, provider } });
    return { user, receipt: db.receipts.find(r => r.reference === deposit.reference) };
  }
  if (deposit.status !== 'SUCCESS') {
    deposit.status = PAYMENT_STATUS.SUCCESS;
    deposit.verifiedAt = now();
    balance(user, 'wallet', deposit.amount);
    transaction(db, { userId: user.id, type: 'credit', amount: deposit.amount, account: 'wallet', reference: deposit.reference, reason: 'Wallet top-up', related: { depositId: deposit.id, provider, purpose: 'WALLET_TOPUP', paystackReference: deposit.paystackReference } });
    receipt(db, { userId: user.id, type: 'deposit', amount: deposit.amount, account: 'wallet', reference: deposit.reference, related: { depositId: deposit.id, provider } });
  }
  return { user, receipt: db.receipts.find(r => r.reference === deposit.reference) };
}
function approveWithdrawal(db, withdrawal, adminNote = '') {
  normalizeWithdrawalRecord(withdrawal);
  if (withdrawal.status === WITHDRAWAL_STATUS.APPROVED) {
    return {
      withdrawal,
      transaction: db.transactions.find(tx => tx.reference === withdrawal.reference),
      receipt: db.receipts.find(rcpt => rcpt.reference === withdrawal.reference),
    };
  }
  if (withdrawal.status !== WITHDRAWAL_STATUS.PENDING) throw new Error(`Only pending withdrawals can be approved. Current status is ${withdrawal.status}.`);
  const approvedAt = now();
  withdrawal.status = WITHDRAWAL_STATUS.APPROVED;
  withdrawal.approvedAt = approvedAt;
  withdrawal.completedAt = null;
  withdrawal.adminNote = String(adminNote || '').trim().slice(0, 500);
  const tx = db.transactions.find(item => item.reference === withdrawal.reference);
  if (tx) {
    tx.status = WITHDRAWAL_STATUS.APPROVED;
    tx.related = { ...(tx.related || {}), payoutStatus: WITHDRAWAL_STATUS.APPROVED, approvedAt, actualAmount: withdrawal.actualAmount, operationalCharge: withdrawal.operationalCharge };
  }
  const rcpt = db.receipts.find(item => item.reference === withdrawal.reference);
  if (rcpt) {
    rcpt.status = WITHDRAWAL_STATUS.APPROVED;
    rcpt.related = { ...(rcpt.related || {}), payoutStatus: WITHDRAWAL_STATUS.APPROVED, approvedAt, actualAmount: withdrawal.actualAmount, operationalCharge: withdrawal.operationalCharge };
  }
  return { withdrawal, transaction: tx, receipt: rcpt };
}
function processWithdrawal(db, withdrawal, adminNote = '') {
  normalizeWithdrawalRecord(withdrawal);
  if (withdrawal.status === WITHDRAWAL_STATUS.PROCESSING) return { withdrawal, transaction: db.transactions.find(tx => tx.reference === withdrawal.reference), receipt: db.receipts.find(rcpt => rcpt.reference === withdrawal.reference) };
  if (withdrawal.status !== WITHDRAWAL_STATUS.APPROVED) throw new Error(`Only approved withdrawals can be marked processing. Current status is ${withdrawal.status}.`);
  const processedAt = now();
  withdrawal.status = WITHDRAWAL_STATUS.PROCESSING;
  withdrawal.processedAt = processedAt;
  withdrawal.adminNote = String(adminNote || withdrawal.adminNote || '').trim().slice(0, 500);
  const tx = db.transactions.find(item => item.reference === withdrawal.reference);
  if (tx) {
    tx.status = WITHDRAWAL_STATUS.PROCESSING;
    tx.related = { ...(tx.related || {}), payoutStatus: WITHDRAWAL_STATUS.PROCESSING, processedAt };
  }
  const rcpt = db.receipts.find(item => item.reference === withdrawal.reference);
  if (rcpt) {
    rcpt.status = WITHDRAWAL_STATUS.PROCESSING;
    rcpt.related = { ...(rcpt.related || {}), payoutStatus: WITHDRAWAL_STATUS.PROCESSING, processedAt };
  }
  return { withdrawal, transaction: tx, receipt: rcpt };
}
function completeWithdrawal(db, withdrawal, adminNote = '') {
  normalizeWithdrawalRecord(withdrawal);
  if (withdrawal.status === WITHDRAWAL_STATUS.COMPLETED) return { withdrawal, transaction: db.transactions.find(tx => tx.reference === withdrawal.reference), receipt: db.receipts.find(rcpt => rcpt.reference === withdrawal.reference) };
  if (![WITHDRAWAL_STATUS.APPROVED, WITHDRAWAL_STATUS.PROCESSING].includes(withdrawal.status)) throw new Error(`Only approved or processing withdrawals can be completed. Current status is ${withdrawal.status}.`);
  const completedAt = now();
  withdrawal.status = WITHDRAWAL_STATUS.COMPLETED;
  withdrawal.completedAt = completedAt;
  withdrawal.adminNote = String(adminNote || withdrawal.adminNote || '').trim().slice(0, 500);
  const tx = db.transactions.find(item => item.reference === withdrawal.reference);
  if (tx) {
    tx.status = WITHDRAWAL_STATUS.COMPLETED;
    tx.related = { ...(tx.related || {}), payoutStatus: WITHDRAWAL_STATUS.COMPLETED, completedAt };
  }
  const rcpt = db.receipts.find(item => item.reference === withdrawal.reference);
  if (rcpt) {
    rcpt.status = WITHDRAWAL_STATUS.COMPLETED;
    rcpt.related = { ...(rcpt.related || {}), payoutStatus: WITHDRAWAL_STATUS.COMPLETED, completedAt };
  }
  return { withdrawal, transaction: tx, receipt: rcpt };
}
function rejectWithdrawal(db, withdrawal, adminNote = '') {
  normalizeWithdrawalRecord(withdrawal);
  if (withdrawal.status === WITHDRAWAL_STATUS.REJECTED) {
    return {
      withdrawal,
      transaction: db.transactions.find(tx => tx.reference === withdrawal.reference),
      receipt: db.receipts.find(rcpt => rcpt.reference === withdrawal.reference),
    };
  }
  if (![WITHDRAWAL_STATUS.PENDING, WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION, WITHDRAWAL_STATUS.APPROVED].includes(withdrawal.status)) throw new Error(`Only pending withdrawals can be rejected. Current status is ${withdrawal.status}.`);
  const activeBypassPayment = db.kycBypassPayments.find(payment => payment.withdrawalId === withdrawal.id && ['initialized', 'PAYMENT_INITIALIZED'].includes(payment.status));
  if (activeBypassPayment) throw new Error('This withdrawal has a GHS 70.00 checkout awaiting confirmation and cannot be rejected yet.');
  const user = db.users.find(item => item.id === withdrawal.userId);
  if (!user) throw new Error('Withdrawal user was not found.');
  const rejectedAt = now();
  balance(user, 'redeemed', withdrawal.requestedAmount);
  withdrawal.status = WITHDRAWAL_STATUS.REJECTED;
  withdrawal.rejectedAt = rejectedAt;
  withdrawal.completedAt = null;
  withdrawal.adminNote = String(adminNote || '').trim().slice(0, 500);
  const tx = db.transactions.find(item => item.reference === withdrawal.reference);
  if (tx) {
    tx.status = WITHDRAWAL_STATUS.REJECTED;
    tx.related = { ...(tx.related || {}), payoutStatus: WITHDRAWAL_STATUS.REJECTED, rejectedAt, fundsReturned: true, actualAmount: withdrawal.actualAmount, operationalCharge: withdrawal.operationalCharge };
  }
  const rcpt = db.receipts.find(item => item.reference === withdrawal.reference);
  if (rcpt) {
    rcpt.status = WITHDRAWAL_STATUS.REJECTED;
    rcpt.related = { ...(rcpt.related || {}), payoutStatus: WITHDRAWAL_STATUS.REJECTED, rejectedAt, fundsReturned: true, actualAmount: withdrawal.actualAmount, operationalCharge: withdrawal.operationalCharge };
  }
  return { user, withdrawal, transaction: tx, receipt: rcpt };
}
function markWithdrawalKycReady(db, userId, adminNote = '') {
  const updatedAt = now();
  const withdrawals = db.withdrawals.filter(item => item.userId === userId && item.status === WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION);
  withdrawals.forEach(withdrawal => {
    normalizeWithdrawalRecord(withdrawal);
    withdrawal.status = WITHDRAWAL_STATUS.PENDING;
    withdrawal.kycResolvedAt = updatedAt;
    withdrawal.adminNote = String(adminNote || withdrawal.adminNote || '').trim().slice(0, 500);
    const tx = db.transactions.find(item => item.reference === withdrawal.reference);
    if (tx) {
      tx.status = WITHDRAWAL_STATUS.PENDING;
      tx.related = { ...(tx.related || {}), payoutStatus: WITHDRAWAL_STATUS.PENDING, kycResolvedAt: updatedAt };
    }
    const rcpt = db.receipts.find(item => item.reference === withdrawal.reference);
    if (rcpt) {
      rcpt.status = WITHDRAWAL_STATUS.PENDING;
      rcpt.related = { ...(rcpt.related || {}), payoutStatus: WITHDRAWAL_STATUS.PENDING, kycResolvedAt: updatedAt };
    }
  });
  return withdrawals;
}
function completeKycBypassPayment(db, payment, provider) {
  const withdrawal = db.withdrawals.find(item => item.id === payment.withdrawalId && item.userId === payment.userId);
  if (!withdrawal) throw new Error('Withdrawal was not found.');
  normalizeWithdrawalRecord(withdrawal);
  if (payment.status !== 'success') {
    payment.status = 'success';
    payment.verifiedAt = now();
    payment.provider = provider;
    withdrawal.kycBypassUsed = true;
    withdrawal.kycBypassFee = KYC_BYPASS_FEE;
    withdrawal.paymentStatus = 'success';
    approveWithdrawalAfterBypass(db, withdrawal, payment.reference);
    transaction(db, { userId: payment.userId, type: 'debit', amount: KYC_BYPASS_FEE, account: 'external', reference: payment.reference, reason: 'KYC bypass fee', related: { withdrawalId: withdrawal.id, withdrawalReference: withdrawal.reference, provider } });
    receipt(db, { userId: payment.userId, type: 'kyc_bypass', amount: KYC_BYPASS_FEE, account: 'external', reference: payment.reference, related: { withdrawalId: withdrawal.id, withdrawalReference: withdrawal.reference, provider } });
    const refundReference = withdrawal.kycBypassRefundReference || uniqueReference(db, 'REF');
    withdrawal.kycBypassRefunded = true;
    withdrawal.kycBypassRefundAmount = KYC_BYPASS_FEE;
    withdrawal.kycBypassRefundReference = refundReference;
    withdrawal.kycBypassRefundedAt = now();
    const refundedAt = withdrawal.kycBypassRefundedAt;
    // The fee is refunded as a separate payout-history entry. It is an
    // external refund, not a Redeemed Balance credit, so it must never affect
    // the balance ledger.
    db.withdrawals.push(normalizeWithdrawalRecord({
      id: uid('wdl_refund'), userId: payment.userId, methodId: withdrawal.methodId,
      amount: KYC_BYPASS_FEE, requestedAmount: KYC_BYPASS_FEE, operationalCharge: 0,
      actualAmount: KYC_BYPASS_FEE, reference: refundReference, status: 'refunded',
      isRefund: true, refundType: 'KYC_FEE_REFUND',
      refundForWithdrawalId: withdrawal.id, refundForWithdrawalReference: withdrawal.reference,
      refundedAt, createdAt: refundedAt,
    }));
    transaction(db, { userId: payment.userId, type: 'credit', entryType: 'REFUND', amount: KYC_BYPASS_FEE, account: 'external', reference: refundReference, status: 'refunded', reason: 'KYC Fee Refund', related: { withdrawalId: withdrawal.id, withdrawalReference: withdrawal.reference, originalPaymentReference: payment.reference, refund: true, transactionType: 'REFUND', refundType: 'KYC_FEE_REFUND', provider } });
    receipt(db, { userId: payment.userId, type: 'kyc_bypass_refund', amount: KYC_BYPASS_FEE, account: 'external', reference: refundReference, status: 'refunded', related: { withdrawalId: withdrawal.id, withdrawalReference: withdrawal.reference, originalPaymentReference: payment.reference, refund: true, transactionType: 'REFUND', refundType: 'KYC_FEE_REFUND', provider } });
    const originalTransaction = db.transactions.find(item => item.reference === withdrawal.reference);
    if (originalTransaction) originalTransaction.related = { ...(originalTransaction.related || {}), kycBypassRefunded: true, kycBypassRefundAmount: KYC_BYPASS_FEE, kycBypassRefundReference: refundReference };
    const originalReceipt = db.receipts.find(item => item.reference === withdrawal.reference);
    if (originalReceipt) originalReceipt.related = { ...(originalReceipt.related || {}), kycBypassRefunded: true, kycBypassRefundAmount: KYC_BYPASS_FEE, kycBypassRefundReference: refundReference };
  }
  return { withdrawal, receipt: db.receipts.find(r => r.reference === payment.reference) };
}
function approveWithdrawalAfterBypass(db, withdrawal, paymentReference) {
  const approvedAt = now();
  withdrawal.status = WITHDRAWAL_STATUS.APPROVED;
  withdrawal.approvedAt = approvedAt;
  withdrawal.completedAt = null;
  withdrawal.autoApprovedReason = 'kyc_bypass_fee_paid';
  const tx = db.transactions.find(item => item.reference === withdrawal.reference);
  if (tx) {
    tx.status = WITHDRAWAL_STATUS.APPROVED;
    tx.related = { ...(tx.related || {}), payoutStatus: WITHDRAWAL_STATUS.APPROVED, approvedAt, kycBypassUsed: true, kycBypassPaymentReference: paymentReference, actualAmount: withdrawal.actualAmount, operationalCharge: withdrawal.operationalCharge };
  }
  const rcpt = db.receipts.find(item => item.reference === withdrawal.reference);
  if (rcpt) {
    rcpt.status = WITHDRAWAL_STATUS.APPROVED;
    rcpt.related = { ...(rcpt.related || {}), payoutStatus: WITHDRAWAL_STATUS.APPROVED, approvedAt, kycBypassUsed: true, kycBypassPaymentReference: paymentReference, actualAmount: withdrawal.actualAmount, operationalCharge: withdrawal.operationalCharge };
  }
}
function adminAuthorized(req) {
  if (!ADMIN_APPROVAL_TOKEN) return false;
  const header = String(req.headers['x-admin-token'] || '');
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const submitted = header || auth;
  return submitted.length === ADMIN_APPROVAL_TOKEN.length && crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(ADMIN_APPROVAL_TOKEN));
}
function adminCredentialsConfigured() { return Boolean(ADMIN_EMAIL && (ADMIN_PASSWORD || ADMIN_PASSWORD_HASH)); }
function adminSessionCookie(token, req, maxAge = ADMIN_SESSION_MAX_AGE / 1000) {
  const secure = requestOrigin(req).startsWith('https://') ? '; Secure' : '';
  return `phantom_admin_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}
function clearAdminSessionCookie(req) {
  const secure = requestOrigin(req).startsWith('https://') ? '; Secure' : '';
  return `phantom_admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}
function adminSessionFor(req, db) {
  const token = cookie(req).phantom_admin_session;
  return db.adminSessions.find(session => session.token === token && session.expiresAt > Date.now());
}
function adminIdentity(req, db) {
  const session = adminSessionFor(req, db);
  if (session) return { id: session.id, email: session.email, role: session.role || 'owner', auth: 'session' };
  if (adminAuthorized(req)) return { id: 'env-admin', email: ADMIN_EMAIL || 'token-admin', role: 'owner', auth: 'token' };
  return null;
}
function requireAdmin(req, res, db) {
  const admin = adminIdentity(req, db);
  if (!admin) { fail(res, 401, 'Admin authentication is required.'); return null; }
  return admin;
}
function adminAudit(db, { admin, action, targetType, targetId, before = null, after = null, reason = '' }) {
  db.adminAuditLogs.push({
    id: uid('audit'),
    adminId: admin?.id || 'unknown',
    adminEmail: admin?.email || 'unknown',
    action,
    targetType,
    targetId,
    before,
    after,
    reason: String(reason || '').trim().slice(0, 500),
    createdAt: now(),
  });
}
function adminSafeUser(user, db) {
  if (!user) return null;
  const purchases = db.purchases.filter(item => item.userId === user.id);
  const redemptions = db.codes.filter(item => item.userId === user.id && item.status === 'redeemed');
  const withdrawals = db.withdrawals.filter(item => item.userId === user.id && !item.isRefund);
  const deposits = db.deposits.filter(item => item.userId === user.id);
  const transactions = db.transactions.filter(item => item.userId === user.id);
  const activityDates = [
    user.createdAt,
    user.lastLoginAt,
    user.lastActivityAt,
    user.kycSubmittedAt,
    ...purchases.map(item => item.createdAt),
    ...redemptions.map(item => item.redeemedAt || item.createdAt),
    ...withdrawals.map(item => item.updatedAt || item.createdAt),
    ...deposits.map(item => item.updatedAt || item.createdAt),
    ...transactions.map(item => item.createdAt),
  ].map(value => ({ value, time: Date.parse(value || '') })).filter(item => Number.isFinite(item.time));
  const lastActivityAt = activityDates.length ? activityDates.sort((a, b) => b.time - a.time)[0].value : null;
  return {
    id: user.id,
    name: user.name,
    email: user.email || '',
    phone: user.phone || '',
    walletBalance: user.walletBalance,
    redeemedBalance: user.redeemedBalance,
    createdAt: user.createdAt,
    kycStatus: user.kycStatus || KYC_STATUS.NOT_VERIFIED,
    kycVerifiedAt: user.kycVerifiedAt || null,
    kycSubmittedAt: user.kycSubmittedAt || null,
    hasPin: Boolean(user.pinHash),
    paystackPaymentEmail: user.paystackPaymentEmail || '',
    purchaseCount: purchases.length,
    redemptionCount: redemptions.length,
    withdrawalCount: withdrawals.length,
    depositCount: deposits.length,
    transactionCount: transactions.length,
    lastLoginAt: user.lastLoginAt || null,
    lastActivityAt,
    sessionCount: db.sessions.filter(session => session.userId === user.id && session.expiresAt > Date.now()).length,
  };
}
function adminSupportMessageRow(db, message) {
  const user = db.users.find(item => item.id === message.userId);
  return {
    ...message,
    userName: user?.name || 'Unknown user',
    userEmail: user?.email || message.email || '',
  };
}
function adminSafeCode(code, card, user) {
  return {
    id: code.id,
    status: code.status,
    cardId: code.cardId,
    cardTitle: card?.title || 'Unknown card',
    userId: code.userId,
    userName: user?.name || 'Unknown user',
    purchaseId: code.purchaseId,
    orderId: code.orderId,
    purchaseAmount: code.purchaseAmount ?? null,
    rewardAmount: code.rewardAmount ?? code.amount ?? null,
    rewardMultiplier: code.rewardMultiplier ?? null,
    createdAt: code.createdAt,
    redeemedAt: code.redeemedAt || null,
    redemptionReference: code.redemptionReference || null,
  };
}
function adminPage(items, url, searchFields = [], statusField = 'status') {
  const query = url.searchParams;
  const search = String(query.get('search') || '').trim().toLowerCase();
  const status = String(query.get('status') || '').trim();
  const pageSize = Math.min(100, Math.max(1, Number(query.get('pageSize') || 25)));
  const page = Math.max(1, Number(query.get('page') || 1));
  let filtered = items;
  if (search) filtered = filtered.filter(item => searchFields.some(field => String(field(item) ?? '').toLowerCase().includes(search)));
  if (status && status.toLowerCase() !== 'all') filtered = filtered.filter(item => String(item[statusField] || '').toLowerCase() === status.toLowerCase());
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  return { items: filtered.slice((safePage - 1) * pageSize, safePage * pageSize), total, page: safePage, pageSize, pages };
}
function adminStatusCounts(items) {
  return items.reduce((result, item) => { const key = String(item.status || 'unknown').trim().toUpperCase(); result[key] = (result[key] || 0) + 1; return result; }, {});
}
function adminDayKey(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? 'unknown' : ghanaCalendarDate(date);
}
function adminTrend(db, days = 14) {
  const result = Array.from({ length: days }, (_, index) => {
    const date = ghanaCalendarDate(Date.now() - (days - index - 1) * 86400000);
    return { date, deposits: 0, purchases: 0, redemptions: 0, withdrawals: 0 };
  });
  const byDate = new Map(result.map(item => [item.date, item]));
  db.deposits.filter(item => String(item.status || '').toUpperCase() === PAYMENT_STATUS.SUCCESS).forEach(item => { const row = byDate.get(adminDayKey(item.verifiedAt || item.createdAt)); if (row) row.deposits += Number(item.amount || 0); });
  db.purchases.forEach(item => { const row = byDate.get(adminDayKey(item.createdAt)); if (row) row.purchases += Number(item.amountPaid ?? item.amount ?? 0); });
  db.codes.filter(item => item.status === 'redeemed').forEach(item => { const row = byDate.get(adminDayKey(item.redeemedAt)); if (row) row.redemptions += Number(item.rewardAmount ?? item.amount ?? 0); });
  db.withdrawals.filter(item => !item.isRefund).forEach(item => { const row = byDate.get(adminDayKey(item.createdAt)); if (row) row.withdrawals += Number(item.requestedAmount ?? item.amount ?? 0); });
  return result;
}
function adminPurchaseRow(db, purchase) {
  const user = db.users.find(item => item.id === purchase.userId);
  const card = db.cards.find(item => item.id === purchase.cardId);
  const code = db.codes.find(item => item.purchaseId === purchase.id);
  const transactionItem = db.transactions.find(item => item.reference === purchase.reference);
  return {
    ...purchase,
    idempotencyKey: undefined,
    userName: user?.name || 'Unknown user',
    userEmail: user?.email || '',
    cardTitle: card?.title || 'Unknown card',
    cardCategory: card?.category || '',
    codeStatus: code?.status || 'missing',
    redemptionReference: code?.redemptionReference || null,
    transactionStatus: transactionItem?.status || null,
  };
}
function adminDepositRow(db, deposit) {
  const user = db.users.find(item => item.id === deposit.userId);
  const transactionItem = db.transactions.find(item => item.reference === deposit.reference);
  return {
    ...deposit,
    userName: user?.name || 'Unknown user',
    userEmail: user?.email || '',
    ledgerStatus: transactionItem?.status || null,
    receiptExists: db.receipts.some(item => item.reference === deposit.reference),
  };
}
function adminWithdrawalRow(db, withdrawal) {
  const user = db.users.find(item => item.id === withdrawal.userId);
  const method = db.methods.find(item => item.id === withdrawal.methodId);
  const transactionItem = db.transactions.find(item => item.reference === withdrawal.reference);
  return {
    ...withdrawal,
    userName: user?.name || 'Unknown user',
    userEmail: user?.email || '',
    userKycStatus: user?.kycStatus || KYC_STATUS.NOT_VERIFIED,
    method: method ? { id: method.id, network: method.network, accountName: method.accountName, phone: method.phone } : null,
    transactionStatus: transactionItem?.status || null,
  };
}
function adminTransactionRow(db, transactionItem) {
  const user = db.users.find(item => item.id === transactionItem.userId);
  const related = { ...(transactionItem.related || {}) };
  delete related.code;
  return { ...transactionItem, related, userName: user?.name || 'Unknown user', userEmail: user?.email || '' };
}
function kycBypassCallback(req, referenceValue, browserOrigin = '') {
  const browser = normalizeOrigin(browserOrigin);
  const origin = browser || requestOrigin(req);
  return `${origin}/?kyc_bypass_reference=${encodeURIComponent(referenceValue)}`;
}
function requireUser(req, res, db) { const user = userFor(req, db); if (!user) { fail(res, 401, 'Please sign in.'); return null; } return user; }
function staticFile(res, file) { const safe = path.normalize(file).replace(/^\.\.([/\\]|$)/, ''); const target = path.join(ROOT, safe === '/' ? 'index.html' : safe); if (!target.startsWith(ROOT) || !fs.existsSync(target)) return false; const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css' }; res.writeHead(200, { 'content-type': types[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-store, max-age=0' }); fs.createReadStream(target).pipe(res); return true; }
function appBaseUrlPortMismatch() {
  try {
    const parsed = new URL(APP_BASE_URL);
    if (!isLocalHost(parsed.hostname)) return false;
    return Number(parsed.port || 80) !== PORT;
  } catch {
    return false;
  }
}
let purchaseMutationQueue = Promise.resolve();
function withPurchaseMutation(task) {
  const previous = purchaseMutationQueue;
  let release;
  purchaseMutationQueue = new Promise(resolve => { release = resolve; });
  return previous.catch(() => {}).then(async () => {
    try { return await task(); } finally { release(); }
  });
}
async function handlePurchaseRequest(req, res) {
  return withPurchaseMutation(async () => {
    const db = load();
    const user = requireUser(req, res, db);
    if (!user) return;
    const p = await body(req);
    const idempotencyKey = String(p.idempotencyKey || '');
    if (!/^[A-Za-z0-9_-]{16,160}$/.test(idempotencyKey)) return fail(res, 400, 'Purchase request is missing a valid idempotency key.');

    const existing = db.purchases.find(item => item.userId === user.id && item.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.cardId !== p.cardId) return fail(res, 409, 'This purchase key belongs to a different card.');
      const existingReceipt = db.receipts.find(item => item.reference === existing.reference);
      return json(res, 200, { duplicate: true, state: publicState(db, user), purchase: publicPurchase(existing), receipt: existingReceipt && publicReceipt(existingReceipt) });
    }

    const card = db.cards.find(c => c.id === p.cardId && c.active);
    if (!card || card.stock < 1) return fail(res, 404, 'This card is unavailable.');
    if (user.walletBalance < MIN_DEPOSIT) return fail(res, 400, `Deposit at least GHS ${MIN_DEPOSIT.toFixed(2)} before buying cards.`);
    if (user.walletBalance < card.priceGhs) return fail(res, 400, `Wallet balance is insufficient. This card costs GHS ${card.priceGhs.toFixed(2)}.`);

    const purchaseDate = ghanaCalendarDate();
    const priceKey = purchasePriceKey(card);
    const dailyRecord = db.dailyPurchaseCounts.find(item => item.userId === user.id && item.priceKey === priceKey && item.purchaseDate === purchaseDate);
    const purchasedToday = Number(dailyRecord?.count || 0);
    if (purchasedToday >= DAILY_CARD_PURCHASE_LIMIT) {
      return fail(res, 409, `Your purchase limit for $${Number(priceKey).toFixed(2)} cards has been reached for today. It resets at midnight Ghana time.`);
    }

    // This mutation is serialized per process and committed as one JSON-ledger
    // write: the idempotency check, daily limit, wallet debit, stock decrement,
    // purchase, code, transaction, and receipt cannot race each other.
    const orderId = uniqueReference(db, 'ORD');
    const purchaseReference = uniqueReference(db, 'PUR');
    const code = uniqueCode(db);
    const purchaseAmount = money(card.priceGhs);
    const reward = rewardAllocationForPrice(purchaseAmount);
    const rewardAmount = reward.rewardAmount;
    const rewardMultiplier = reward.rewardMultiplier;
    balance(user, 'wallet', -purchaseAmount);
    card.stock--;
    card.active = card.stock > 0;
    const purchase = { id: uid('order'), orderId, reference: purchaseReference, userId: user.id, cardId: card.id, idempotencyKey, amount: purchaseAmount, amountPaid: purchaseAmount, rewardAmount, rewardMultiplier, status: 'sealed', createdAt: now() };
    db.purchases.push(purchase);
    if (dailyRecord) dailyRecord.count = purchasedToday + 1;
    else db.dailyPurchaseCounts.push({ id: uid('daily'), userId: user.id, priceKey, priceUsd: Number(priceKey), purchaseDate, count: 1 });
    const redemption = { id: uid('code'), code, userId: user.id, cardId: card.id, orderId, purchaseId: purchase.id, amount: rewardAmount, purchaseAmount, rewardAmount, rewardMultiplier, status: 'unused', createdAt: now(), redeemedAt: null, redemptionReference: null };
    db.codes.push(redemption);
    transaction(db, { userId: user.id, type: 'debit', amount: purchaseAmount, account: 'wallet', reference: purchaseReference, reason: 'Card purchase', related: { cardId: card.id, orderId, code, purchaseAmount, rewardAmount, rewardMultiplier } });
    const rcpt = receipt(db, { userId: user.id, type: 'purchase', amount: purchaseAmount, account: 'wallet', reference: purchaseReference, related: { cardId: card.id, orderId, code, purchaseAmount, rewardAmount, rewardMultiplier } });
    user.lastActivityAt = purchase.createdAt;
    save(db);
    console.log('[purchase:complete]', orderId, { purchaseAmount, purchaseDate, purchasedToday: purchasedToday + 1 });
    return json(res, 201, { state: publicState(db, user), purchase: publicPurchase(purchase), receipt: publicReceipt(rcpt) });
  });
}
async function route(req, res) {
  const url = new URL(req.url, appBaseUrlForRoute(req)); let db = load(); const { pathname } = url;
  if (!pathname.startsWith('/api/')) {
    if (pathname === '/admin' || pathname === '/admin/') return staticFile(res, '/admin.html') || fail(res, 404, 'Not found');
    return staticFile(res, decodeURIComponent(pathname)) || fail(res, 404, 'Not found');
  }
  try {
    if (!originAllowed(req)) return fail(res, 403, 'Request origin is not allowed.');
    if (rateLimit(req, res, pathname)) return;
    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, paymentServiceConfigured: Boolean(SITE_B_BASE_URL && SITE_A_TO_SITE_B_SECRET && SITE_B_TO_SITE_A_SECRET), appBaseUrl: APP_BASE_URL || requestOrigin(req) });
    if (req.method === 'GET' && pathname === '/api/config') return json(res, 200, { minDeposit: MIN_DEPOSIT, minWithdrawal: MIN_WITHDRAWAL, minRedeemedCardsForWithdrawal: MIN_REDEEMED_CARDS_FOR_WITHDRAWAL, operationalChargeRate: OPERATIONAL_CHARGE_RATE, kycBypassFee: KYC_BYPASS_FEE, rewardMultiplierMin: REWARD_MULTIPLIER_MIN, rewardMultiplierMax: REWARD_MULTIPLIER_MAX, appBaseUrl: APP_BASE_URL || requestOrigin(req) });
    // Site B can only initialize against a payment already persisted by Site A.
    if (req.method === 'POST' && pathname === '/api/v1/internal/topups/lookup') {
      const raw = await rawBody(req); db = load(); if (!verifySignedRequest(req, raw, SITE_B_TO_SITE_A_SECRET)) return fail(res, 401, 'Invalid payment-service authentication.');
      const p = JSON.parse(raw.toString() || '{}'); const deposit = db.deposits.find(x => x.transactionId === String(p.siteATransactionId || '')); const customer = deposit && db.users.find(x => x.id === deposit.userId);
      const canLookup = deposit && (isRecoverablePaymentStatus(deposit.status) || deposit.status === PAYMENT_STATUS.EXPIRED);
      const locallyExpired = deposit && new Date(deposit.expiresAt).getTime() <= Date.now();
      if (!validTopup(deposit, customer) || !canLookup || (locallyExpired && !['PAYMENT_INITIALIZATION_UNKNOWN', 'PENDING_RECONCILIATION', PAYMENT_STATUS.EXPIRED].includes(deposit.status))) return fail(res, 404, 'Top-up is not available.');
      return json(res, 200, { transactionId: deposit.transactionId, userId: deposit.userId, amountMinor: deposit.amountMinor, currency: deposit.currency, customer: { email: paystackEmailForUser(customer), name: customer.name }, expiresAt: deposit.expiresAt, purpose: deposit.purpose });
    }
    if (req.method === 'POST' && pathname === '/api/v1/internal/kyc-bypass/lookup') {
      const raw = await rawBody(req); db = load(); if (!verifySignedRequest(req, raw, SITE_B_TO_SITE_A_SECRET)) return fail(res, 401, 'Invalid payment-service authentication.');
      const p = JSON.parse(raw.toString() || '{}'); const payment = db.kycBypassPayments.find(x => x.reference === String(p.siteATransactionId || '')); const customer = payment && db.users.find(x => x.id === payment.userId);
      if (!validKycBypass(payment, customer) || !isRecoverableKycPaymentStatus(payment.status)) return fail(res, 404, 'KYC payment is not available.');
      return json(res, 200, { transactionId: payment.reference, userId: payment.userId, amountMinor: Math.round(payment.amount * 100), currency: payment.currency, customer: { email: paystackEmailForUser(customer), name: customer.name }, expiresAt: payment.expiresAt, purpose: 'KYC_BYPASS', withdrawalReference: payment.withdrawalReference });
    }
    // Only Site B can confirm a Paystack wallet top-up. This is the sole wallet-credit path.
    if (req.method === 'POST' && pathname === '/api/v1/webhooks/payment-status') {
      const raw = await rawBody(req); db = load(); if (!verifySignedRequest(req, raw, SITE_B_TO_SITE_A_SECRET)) return fail(res, 401, 'Invalid payment-service authentication.');
      const p = JSON.parse(raw.toString() || '{}');
      if (!['SUCCESS', 'FAILED', 'EXPIRED'].includes(p.status) || p.event !== `wallet_topup.${String(p.status).toLowerCase()}` || p.purpose !== 'WALLET_TOPUP') return fail(res, 400, 'Invalid wallet top-up status payload.');
      const deposit = db.deposits.find(x => x.transactionId === String(p.siteATransactionId || '')); const customer = deposit && db.users.find(x => x.id === deposit.userId);
      if (!validTopup(deposit, customer) || p.siteAUserId !== deposit.userId || Number(p.amountMinor) !== deposit.amountMinor || p.currency !== deposit.currency || !callbackMatchesStoredPayment(deposit, p)) return fail(res, 400, 'Payment callback does not reconcile with the top-up.');
      const requestId = String(req.headers['x-request-id']); deposit.callbackRequestIds = deposit.callbackRequestIds || [];
      if (deposit.callbackRequestIds.includes(requestId) || deposit.status === 'SUCCESS') return json(res, 200, { ok: true, duplicate: true, status: deposit.status });
      deposit.callbackRequestIds.push(requestId); deposit.callbackRequestIds = deposit.callbackRequestIds.slice(-50);
      deposit.callbackAttempts = (deposit.callbackAttempts || 0) + 1; deposit.lastCallbackAt = now(); deposit.lastCallbackStatus = p.status; deposit.paystackReference = p.paystackReference; deposit.paymentServiceTransactionId = String(p.paymentServiceTransactionId || ''); deposit.reconciliationStatus = null; deposit.updatedAt = now();
      if (p.status === 'SUCCESS') { completeDeposit(db, deposit, p.source === 'admin-reconciliation' ? 'admin-reconciliation' : 'payment-service'); paymentStatusEvent(deposit, PAYMENT_STATUS.SUCCESS, 'site-b-callback', { requestId }); }
      else if (deposit.status !== 'SUCCESS') deposit.status = p.status === 'SUCCESS' ? 'EXPIRED' : p.status;
      if (p.status !== 'SUCCESS') paymentStatusEvent(deposit, deposit.status, 'site-b-callback', { requestId });
      save(db); return json(res, 200, { ok: true, status: deposit.status });
    }
    if (req.method === 'POST' && pathname === '/api/v1/webhooks/kyc-bypass-payment-status') {
      const raw = await rawBody(req); db = load(); if (!verifySignedRequest(req, raw, SITE_B_TO_SITE_A_SECRET)) return fail(res, 401, 'Invalid payment-service authentication.');
      const p = JSON.parse(raw.toString() || '{}');
      if (!['SUCCESS', 'FAILED', 'EXPIRED'].includes(p.status) || p.event !== `kyc_bypass.${String(p.status).toLowerCase()}` || p.purpose !== 'KYC_BYPASS') return fail(res, 400, 'Invalid KYC payment status payload.');
      const payment = db.kycBypassPayments.find(x => x.reference === String(p.siteATransactionId || '')); const customer = payment && db.users.find(x => x.id === payment.userId);
      if (!validKycBypass(payment, customer) || p.siteAUserId !== payment.userId || Number(p.amountMinor) !== Math.round(KYC_BYPASS_FEE * 100) || p.currency !== PAYSTACK_CURRENCY || !callbackMatchesStoredPayment(payment, p)) return fail(res, 400, 'Payment callback does not reconcile with the KYC fee.');
      payment.callbackRequestIds = payment.callbackRequestIds || []; const requestId = String(req.headers['x-request-id']);
      if (payment.callbackRequestIds.includes(requestId) || payment.status === 'success') return json(res, 200, { ok: true, duplicate: true, status: payment.status });
      payment.callbackRequestIds.push(requestId); payment.callbackRequestIds = payment.callbackRequestIds.slice(-50); payment.callbackAttempts = (payment.callbackAttempts || 0) + 1; payment.lastCallbackAt = now(); payment.lastCallbackStatus = p.status; payment.paystackReference = p.paystackReference; payment.paymentServiceTransactionId = String(p.paymentServiceTransactionId || ''); payment.reconciliationStatus = null; payment.updatedAt = now();
      if (p.status === 'SUCCESS') completeKycBypassPayment(db, payment, 'paystack');
      else {
        payment.status = p.status.toLowerCase();
        const withdrawal = db.withdrawals.find(item => item.id === payment.withdrawalId && item.userId === payment.userId);
        if (withdrawal && withdrawal.status === WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION) withdrawal.paymentStatus = p.status.toLowerCase();
      }
      paymentStatusEvent(payment, payment.status, 'site-b-callback', { requestId });
      save(db); return json(res, 200, { ok: true, status: payment.status });
    }
    if (req.method === 'POST' && pathname === '/api/admin/auth/login') {
      if (!adminCredentialsConfigured()) return fail(res, 503, 'Admin credentials are not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD).');
      const p = await body(req);
      const email = normalizeEmail(p.email);
      const password = String(p.password || '');
      let valid = email === ADMIN_EMAIL;
      if (valid && ADMIN_PASSWORD_HASH) valid = await passwordMatches(password, ADMIN_PASSWORD_HASH);
      else if (valid) valid = safeEqual(password, ADMIN_PASSWORD);
      if (!valid) return fail(res, 401, 'Incorrect admin email or password.');
      const token = crypto.randomBytes(32).toString('hex');
      db.adminSessions = db.adminSessions.filter(session => session.expiresAt > Date.now());
      db.adminSessions.push({ id: uid('admin'), token, email: ADMIN_EMAIL, role: 'owner', createdAt: now(), expiresAt: Date.now() + ADMIN_SESSION_MAX_AGE });
      save(db);
      return json(res, 200, { ok: true, admin: { email: ADMIN_EMAIL, role: 'owner' } }, { 'set-cookie': adminSessionCookie(token, req) });
    }
    if (req.method === 'POST' && pathname === '/api/admin/auth/logout') {
      const token = cookie(req).phantom_admin_session;
      db.adminSessions = db.adminSessions.filter(session => session.token !== token);
      save(db);
      return json(res, 200, { ok: true }, { 'set-cookie': clearAdminSessionCookie(req) });
    }
    if (req.method === 'GET' && pathname === '/api/admin/auth/session') {
      const admin = adminIdentity(req, db);
      if (!admin) return fail(res, 401, 'Admin authentication is required.');
      return json(res, 200, { ok: true, admin: { email: admin.email, role: admin.role, auth: admin.auth } });
    }
    if (req.method === 'GET' && pathname === '/api/admin/summary') {
      const admin = requireAdmin(req, res, db); if (!admin) return;
      const pendingWithdrawals = db.withdrawals.filter(item => !item.isRefund && [WITHDRAWAL_STATUS.PENDING, WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION].includes(item.status));
      const pendingKyc = db.users.filter(item => item.kycStatus === KYC_STATUS.PENDING);
      const pendingDeposits = db.deposits.filter(item => isRecoverablePaymentStatus(item.status));
      const pendingBypass = db.kycBypassPayments.filter(item => isRecoverableKycPaymentStatus(item.status));
      const recent = (items, mapper) => items.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 6).map(mapper);
      return json(res, 200, {
        admin: { email: admin.email, role: admin.role },
        metrics: {
          users: db.users.length,
          activeCards: db.cards.filter(item => item.active).length,
          stockUnits: db.cards.reduce((sum, item) => sum + Number(item.stock || 0), 0),
          deposits: db.deposits.length,
          purchases: db.purchases.length,
          redemptions: db.codes.filter(item => item.status === 'redeemed').length,
          pendingWithdrawals: pendingWithdrawals.length,
          pendingKyc: pendingKyc.length,
          pendingPayments: pendingDeposits.length + pendingBypass.length,
          walletDepositVolume: money(db.deposits.filter(item => String(item.status || '').toUpperCase() === PAYMENT_STATUS.SUCCESS).reduce((sum, item) => sum + Number(item.amount || 0), 0)),
          purchaseVolume: money(db.purchases.reduce((sum, item) => sum + Number(item.amountPaid ?? item.amount ?? 0), 0)),
          redemptionVolume: money(db.transactions.filter(item => item.account === 'redeemed' && item.type === 'credit' && ['COMPLETED', 'SUCCESS'].includes(String(item.status || '').toUpperCase())).reduce((sum, item) => sum + Number(item.amount || 0), 0)),
          withdrawalVolume: money(db.withdrawals.filter(item => !item.isRefund).reduce((sum, item) => sum + Number(item.requestedAmount ?? item.amount ?? 0), 0)),
        },
        statuses: { deposits: adminStatusCounts(db.deposits), withdrawals: adminStatusCounts(db.withdrawals.filter(item => !item.isRefund)), kyc: adminStatusCounts(db.users.map(item => ({ status: item.kycStatus || KYC_STATUS.NOT_VERIFIED }))) },
        attention: {
          withdrawals: pendingWithdrawals.slice(0, 8).map(item => adminWithdrawalRow(db, item)),
          kyc: pendingKyc.slice(0, 8).map(item => adminSafeUser(item, db)),
          payments: pendingDeposits.slice(0, 8).map(item => adminDepositRow(db, item)),
        },
        recent: {
          transactions: recent(db.transactions, item => adminTransactionRow(db, item)),
          withdrawals: recent(db.withdrawals.filter(item => !item.isRefund), item => adminWithdrawalRow(db, item)),
        },
        trend: adminTrend(db),
        settings: { minDeposit: MIN_DEPOSIT, minWithdrawal: MIN_WITHDRAWAL, dailyPurchaseLimit: DAILY_CARD_PURCHASE_LIMIT, operationalChargeRate: OPERATIONAL_CHARGE_RATE, kycBypassFee: KYC_BYPASS_FEE, rewardMultiplierMin: REWARD_MULTIPLIER_MIN, rewardMultiplierMax: REWARD_MULTIPLIER_MAX, paymentServiceConfigured: Boolean(SITE_B_BASE_URL && SITE_A_TO_SITE_B_SECRET && SITE_B_TO_SITE_A_SECRET) },
      });
    }
    if (req.method === 'GET' && pathname === '/api/admin/users') {
      if (!requireAdmin(req, res, db)) return;
      const page = adminPage(db.users.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))), url, [item => item.name, item => item.email, item => item.phone, item => item.id], 'kycStatus');
      return json(res, 200, { ...page, items: page.items.map(item => adminSafeUser(item, db)) });
    }
    if (req.method === 'GET' && /^\/api\/admin\/users\/[^/]+\/kyc\/documents\/[^/]+$/.test(pathname)) {
      if (!requireAdmin(req, res, db)) return;
      const parts = pathname.split('/').map(decodeURIComponent); const userId = parts[4]; const storageKey = parts[7];
      const target = db.users.find(item => item.id === userId); const document = target?.kycSubmission?.documents?.find(item => item.storageKey === storageKey);
      if (!target || !document || !/^[A-Za-z0-9_-]+\.bin$/.test(storageKey)) return fail(res, 404, 'KYC document was not found.');
      const targetFile = path.join(KYC_DOCUMENTS_DIR, target.id, storageKey);
      if (!targetFile.startsWith(path.join(KYC_DOCUMENTS_DIR, target.id)) || !fs.existsSync(targetFile)) return fail(res, 404, 'KYC document was not found.');
      res.writeHead(200, { 'content-type': document.type || 'application/octet-stream', 'content-length': String(fs.statSync(targetFile).size), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(targetFile).pipe(res);
    }
    if (req.method === 'GET' && /^\/api\/admin\/users\/[^/]+$/.test(pathname)) {
      if (!requireAdmin(req, res, db)) return;
      const userId = decodeURIComponent(pathname.split('/')[4]); const target = db.users.find(item => item.id === userId);
      if (!target) return fail(res, 404, 'User was not found.');
      const cardMap = new Map(db.cards.map(item => [item.id, item]));
      return json(res, 200, { user: adminSafeUser(target, db), kycSubmission: target.kycSubmission || null, methods: db.methods.filter(item => item.userId === userId), purchases: db.purchases.filter(item => item.userId === userId).map(item => adminPurchaseRow(db, item)), codes: db.codes.filter(item => item.userId === userId).map(item => adminSafeCode(item, cardMap.get(item.cardId), target)), deposits: db.deposits.filter(item => item.userId === userId).map(item => adminDepositRow(db, item)), withdrawals: db.withdrawals.filter(item => item.userId === userId).map(item => adminWithdrawalRow(db, item)), transactions: db.transactions.filter(item => item.userId === userId).map(item => adminTransactionRow(db, item)).map(item => ({ ...item, related: { ...(item.related || {}), code: undefined } })) });
    }
    if (req.method === 'GET' && pathname === '/api/admin/cards') {
      if (!requireAdmin(req, res, db)) return;
      const items = db.cards.map(card => ({ ...card, state: card.active ? 'active' : (Number(card.stock || 0) > 0 ? 'paused' : 'out of stock'), purchaseCount: db.purchases.filter(item => item.cardId === card.id).length, redeemedCount: db.codes.filter(item => item.cardId === card.id && item.status === 'redeemed').length }));
      return json(res, 200, adminPage(items.sort((a, b) => String(a.title).localeCompare(String(b.title))), url, [item => item.id, item => item.title, item => item.category, item => item.series], 'active'));
    }
    if (req.method === 'GET' && pathname === '/api/admin/purchases') {
      if (!requireAdmin(req, res, db)) return;
      const items = db.purchases.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(item => adminPurchaseRow(db, item));
      return json(res, 200, adminPage(items, url, [item => item.id, item => item.orderId, item => item.reference, item => item.userName, item => item.userEmail, item => item.cardTitle]));
    }
    if (req.method === 'GET' && pathname === '/api/admin/deposits') {
      if (!requireAdmin(req, res, db)) return;
      const items = db.deposits.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(item => adminDepositRow(db, item));
      return json(res, 200, adminPage(items, url, [item => item.id, item => item.transactionId, item => item.reference, item => item.paystackReference, item => item.userName, item => item.userEmail]));
    }
    if (req.method === 'GET' && pathname === '/api/admin/redemptions') {
      if (!requireAdmin(req, res, db)) return;
      const cardMap = new Map(db.cards.map(item => [item.id, item])); const userMap = new Map(db.users.map(item => [item.id, item]));
      const items = db.codes.filter(item => item.status === 'redeemed').sort((a, b) => String(b.redeemedAt || '').localeCompare(String(a.redeemedAt || ''))).map(item => adminSafeCode(item, cardMap.get(item.cardId), userMap.get(item.userId)));
      return json(res, 200, adminPage(items, url, [item => item.id, item => item.orderId, item => item.redemptionReference, item => item.userName, item => item.cardTitle]));
    }
    if (req.method === 'GET' && pathname === '/api/admin/withdrawals') {
      if (!requireAdmin(req, res, db)) return;
      const items = db.withdrawals.filter(item => !item.isRefund).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(item => adminWithdrawalRow(db, item));
      return json(res, 200, adminPage(items, url, [item => item.id, item => item.reference, item => item.userName, item => item.userEmail, item => item.method?.network, item => item.method?.phone]));
    }
    if (req.method === 'GET' && pathname === '/api/admin/kyc') {
      if (!requireAdmin(req, res, db)) return;
      const items = db.users.filter(item => item.kycSubmission || item.kycStatus === KYC_STATUS.PENDING || item.kycStatus === KYC_STATUS.VERIFIED || item.kycStatus === KYC_STATUS.REJECTED).sort((a, b) => String(b.kycSubmittedAt || b.createdAt || '').localeCompare(String(a.kycSubmittedAt || a.createdAt || ''))).map(item => ({ ...adminSafeUser(item, db), documents: item.kycSubmission?.documents || [], submission: item.kycSubmission || null }));
      return json(res, 200, adminPage(items, url, [item => item.id, item => item.name, item => item.email, item => item.phone], 'kycStatus'));
    }
    if (req.method === 'GET' && pathname === '/api/admin/transactions') {
      if (!requireAdmin(req, res, db)) return;
      const items = db.transactions.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(item => adminTransactionRow(db, item)).map(item => ({ ...item, related: { ...(item.related || {}), code: undefined } }));
      return json(res, 200, adminPage(items, url, [item => item.id, item => item.reference, item => item.reason, item => item.account, item => item.userName, item => item.userEmail]));
    }
    if (req.method === 'GET' && pathname === '/api/admin/audit-logs') {
      if (!requireAdmin(req, res, db)) return;
      return json(res, 200, adminPage(db.adminAuditLogs.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))), url, [item => item.action, item => item.targetType, item => item.targetId, item => item.adminEmail, item => item.reason]));
    }
    if (req.method === 'GET' && pathname === '/api/admin/support-messages') {
      if (!requireAdmin(req, res, db)) return;
      const items = db.supportMessages.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(item => adminSupportMessageRow(db, item));
      return json(res, 200, adminPage(items, url, [item => item.id, item => item.name, item => item.email, item => item.subject, item => item.message, item => item.userName, item => item.userEmail]));
    }
    if (req.method === 'POST' && pathname === '/api/admin/wallet-credits') {
      return withPurchaseMutation(async () => {
        const currentDb = load();
        const admin = requireAdmin(req, res, currentDb); if (!admin) return;
        const p = await body(req);
        const identifier = String(p.identifier || '').trim();
        const amount = money(p.amount);
        const note = String(p.note || '').trim().slice(0, 500);
        const idempotencyKey = String(p.idempotencyKey || '');
        if (!identifier) return fail(res, 400, 'Enter the user ID, email, or phone number.');
        if (!Number.isFinite(amount) || amount < 0.01 || amount > MAX_MANUAL_WALLET_CREDIT) return fail(res, 400, `Enter a wallet credit between GHS 0.01 and GHS ${MAX_MANUAL_WALLET_CREDIT.toFixed(2)}.`);
        if (!note) return fail(res, 400, 'A reason or note is required for a manual wallet credit.');
        if (!/^[A-Za-z0-9_-]{16,160}$/.test(idempotencyKey)) return fail(res, 400, 'A valid idempotency key is required.');
        const existing = currentDb.transactions.find(item => item.account === 'wallet' && item.type === 'credit' && item.related?.source === 'admin' && item.related?.idempotencyKey === idempotencyKey);
        if (existing) {
          const existingUser = currentDb.users.find(item => item.id === existing.userId);
          const existingReceipt = currentDb.receipts.find(item => item.reference === existing.reference);
          return json(res, 200, { ok: true, duplicate: true, user: adminSafeUser(existingUser, currentDb), transaction: publicTransaction(existing), receipt: existingReceipt ? publicReceipt(existingReceipt) : null, message: 'This manual wallet credit was already applied.' });
        }
        const normalizedIdentifier = normalizeEmail(identifier);
        const normalizedPhone = normalizePhone(identifier);
        const target = currentDb.users.find(item => item.id === identifier || normalizeEmail(item.email) === normalizedIdentifier || normalizePhone(item.phone) === normalizedPhone);
        if (!target) return fail(res, 404, 'User was not found. Use the exact user ID, email, or phone number.');
        const before = { walletBalance: target.walletBalance };
        const referenceValue = uniqueReference(currentDb, 'ADM');
        balance(target, 'wallet', amount);
        const related = { source: 'admin', adminId: admin.id, adminEmail: admin.email, idempotencyKey, note };
        const tx = transaction(currentDb, { userId: target.id, type: 'credit', amount, account: 'wallet', reference: referenceValue, reason: 'Manual wallet top-up', related });
        const rcpt = receipt(currentDb, { userId: target.id, type: 'manual_deposit', amount, account: 'wallet', reference: referenceValue, related });
        adminAudit(currentDb, { admin, action: 'wallet.manual_credit', targetType: 'user', targetId: target.id, before, after: { walletBalance: target.walletBalance, amount, reference: referenceValue }, reason: note });
        save(currentDb);
        return json(res, 201, { ok: true, duplicate: false, user: adminSafeUser(target, currentDb), transaction: publicTransaction(tx), receipt: publicReceipt(rcpt), message: `Wallet credited by GHS ${amount.toFixed(2)}.` });
      });
    }
    if (req.method === 'GET' && /^\/api\/admin\/reconciliation\/[^/]+$/.test(pathname)) {
      if (!requireAdmin(req, res, db)) return;
      const reference = decodeURIComponent(pathname.split('/')[4]); const deposit = db.deposits.find(item => item.transactionId === reference || item.reference === reference || item.paystackReference === reference || item.paymentServiceTransactionId === reference);
      if (!deposit) return fail(res, 404, 'Deposit was not found.');
      const payment = (db.kycBypassPayments || []).find(item => item.reference === reference || item.paystackReference === reference);
      return json(res, 200, { siteA: adminDepositRow(db, deposit), siteB: { transactionId: deposit.paymentServiceTransactionId || null, status: deposit.status === 'SUCCESS' ? 'SUCCESS' : deposit.status, availableThrough: 'Use Recheck payment to ask Site B to verify Paystack.' }, paystack: { reference: deposit.paystackReference || null, amountMinor: deposit.amountMinor || null, currency: deposit.currency || PAYSTACK_CURRENCY, status: deposit.status === 'SUCCESS' ? 'SUCCESS' : 'UNKNOWN' }, relatedKycBypass: payment || null });
    }
    if (req.method === 'POST' && /^\/api\/admin\/deposits\/[^/]+\/reconcile$/.test(pathname)) {
      const admin = requireAdmin(req, res, db); if (!admin) return;
      const reference = decodeURIComponent(pathname.split('/')[4]);
      const deposit = db.deposits.find(item => item.transactionId === reference || item.reference === reference || item.paystackReference === reference || item.paymentServiceTransactionId === reference);
      if (!deposit) return fail(res, 404, 'Deposit was not found. Use the Site A, payment-service, or Paystack reference.');
      const before = { status: deposit.status, amount: deposit.amount, reference: deposit.reference, paystackReference: deposit.paystackReference || null, walletCredited: deposit.status === 'SUCCESS' };
      if (deposit.status === 'SUCCESS') {
        adminAudit(db, { admin, action: 'deposit.reconcile.duplicate', targetType: 'deposit', targetId: deposit.reference, before, after: before, reason: 'Admin recheck requested for an already credited deposit.' });
        save(db);
        return json(res, 200, { ok: true, reconciled: true, duplicate: true, status: deposit.status, deposit: adminDepositRow(db, deposit), message: 'This deposit was already credited.' });
      }
      normalizePaymentRecord(deposit, PAYMENT_STATUS.PENDING);
      deposit.status = PAYMENT_STATUS.PENDING_RECONCILIATION;
      deposit.reconciliationAttempts = (deposit.reconciliationAttempts || 0) + 1;
      deposit.lastReconciliationAt = now();
      deposit.reconciliationStatus = 'REQUESTED';
      deposit.updatedAt = now();
      paymentStatusEvent(deposit, deposit.status, 'admin-reconciliation-requested');
      save(db);
      let serviceResult;
      try {
        serviceResult = await askPaymentServiceToReconcile(deposit);
      } catch (error) {
        const unavailableDb = load();
        const unavailableDeposit = unavailableDb.deposits.find(item => item.reference === deposit.reference);
        if (unavailableDeposit?.status === PAYMENT_STATUS.SUCCESS) {
          adminAudit(unavailableDb, { admin, action: 'deposit.reconcile.success', targetType: 'deposit', targetId: unavailableDeposit.reference, before, after: { status: unavailableDeposit.status, walletCredited: true }, reason: 'A delayed Site B callback completed while the reconciliation request was unavailable.' });
          save(unavailableDb);
          return json(res, 200, { ok: true, reconciled: true, status: unavailableDeposit.status, deposit: adminDepositRow(unavailableDb, unavailableDeposit), message: 'Payment verified and wallet credited.' });
        }
        if (unavailableDeposit) {
          unavailableDeposit.status = PAYMENT_STATUS.PENDING_RECONCILIATION;
          unavailableDeposit.reconciliationStatus = 'UNAVAILABLE';
          unavailableDeposit.updatedAt = now();
          paymentStatusEvent(unavailableDeposit, unavailableDeposit.status, 'admin-reconciliation', { result: 'unavailable' });
          adminAudit(unavailableDb, { admin, action: 'deposit.reconcile.pending', targetType: 'deposit', targetId: unavailableDeposit.reference, before, after: { status: unavailableDeposit.status }, reason: 'Payment-service recheck was unavailable; the payment remains recoverable.' });
          save(unavailableDb);
          return json(res, 202, { ok: true, reconciled: false, status: unavailableDeposit.status, deposit: adminDepositRow(unavailableDb, unavailableDeposit), message: 'Payment-service recheck is unavailable. The payment remains pending reconciliation.' }, { 'cache-control': 'no-store' });
        }
        return fail(res, 404, 'Deposit disappeared while it was being reconciled.');
      }
      const refreshedDb = load();
      const refreshedDeposit = refreshedDb.deposits.find(item => item.reference === deposit.reference);
      if (!refreshedDeposit) return fail(res, 404, 'Deposit disappeared while it was being reconciled.');
      const after = { status: refreshedDeposit.status, amount: refreshedDeposit.amount, reference: refreshedDeposit.reference, paystackReference: refreshedDeposit.paystackReference || null, walletCredited: refreshedDeposit.status === 'SUCCESS' };
      adminAudit(refreshedDb, { admin, action: refreshedDeposit.status === 'SUCCESS' ? 'deposit.reconcile.success' : 'deposit.reconcile.pending', targetType: 'deposit', targetId: refreshedDeposit.reference, before, after, reason: refreshedDeposit.status === 'SUCCESS' ? 'Paystack was verified and the wallet credit was reconciled.' : 'Paystack did not produce a completed wallet credit during the recheck.' });
      save(refreshedDb);
      const paymentService = { status: serviceResult.status || null, paystackStatus: serviceResult.paystackStatus || null, callbackDelivered: Boolean(serviceResult.callbackDelivered), reference: serviceResult.paystackReference || refreshedDeposit.paystackReference || null, transactionId: serviceResult.transactionId || refreshedDeposit.paymentServiceTransactionId || null };
      return json(res, 200, { ok: true, reconciled: refreshedDeposit.status === 'SUCCESS', status: refreshedDeposit.status, deposit: adminDepositRow(refreshedDb, refreshedDeposit), paymentService, message: refreshedDeposit.status === 'SUCCESS' ? 'Payment verified and wallet credited.' : `Payment database status: ${paymentService.status || 'unknown'}; Paystack status: ${paymentService.paystackStatus || 'unknown'}. No wallet credit was applied.` });
    }
    if (req.method === 'POST' && /^\/api\/admin\/withdrawals\/[^/]+\/approve$/.test(pathname)) { const admin = requireAdmin(req, res, db); if (!admin) return; const ref = decodeURIComponent(pathname.split('/')[4]); const withdrawal = db.withdrawals.find(item => item.reference === ref); if (!withdrawal) return fail(res, 404, 'Withdrawal was not found.'); const before = { ...withdrawal }; const p = await body(req); const approved = approveWithdrawal(db, withdrawal, p.note); adminAudit(db, { admin, action: 'withdrawal.approve', targetType: 'withdrawal', targetId: ref, before, after: { ...withdrawal }, reason: p.note }); save(db); console.log('[withdrawal:approved]', ref); return json(res, 200, { ok: true, withdrawal: publicWithdrawal(approved.withdrawal), transaction: approved.transaction && publicTransaction(approved.transaction), receipt: approved.receipt && publicReceipt(approved.receipt) }); }
    if (req.method === 'POST' && /^\/api\/admin\/withdrawals\/[^/]+\/process$/.test(pathname)) { const admin = requireAdmin(req, res, db); if (!admin) return; const ref = decodeURIComponent(pathname.split('/')[4]); const withdrawal = db.withdrawals.find(item => item.reference === ref); if (!withdrawal) return fail(res, 404, 'Withdrawal was not found.'); const before = { ...withdrawal }; const p = await body(req); const processed = processWithdrawal(db, withdrawal, p.note); adminAudit(db, { admin, action: 'withdrawal.process', targetType: 'withdrawal', targetId: ref, before, after: { ...withdrawal }, reason: p.note }); save(db); console.log('[withdrawal:processing]', ref); return json(res, 200, { ok: true, withdrawal: publicWithdrawal(processed.withdrawal), transaction: processed.transaction && publicTransaction(processed.transaction), receipt: processed.receipt && publicReceipt(processed.receipt) }); }
    if (req.method === 'POST' && /^\/api\/admin\/withdrawals\/[^/]+\/complete$/.test(pathname)) { const admin = requireAdmin(req, res, db); if (!admin) return; const ref = decodeURIComponent(pathname.split('/')[4]); const withdrawal = db.withdrawals.find(item => item.reference === ref); if (!withdrawal) return fail(res, 404, 'Withdrawal was not found.'); const before = { ...withdrawal }; const p = await body(req); const completed = completeWithdrawal(db, withdrawal, p.note); adminAudit(db, { admin, action: 'withdrawal.complete', targetType: 'withdrawal', targetId: ref, before, after: { ...withdrawal }, reason: p.note }); save(db); console.log('[withdrawal:completed]', ref); return json(res, 200, { ok: true, withdrawal: publicWithdrawal(completed.withdrawal), transaction: completed.transaction && publicTransaction(completed.transaction), receipt: completed.receipt && publicReceipt(completed.receipt) }); }
    if (req.method === 'POST' && /^\/api\/admin\/withdrawals\/[^/]+\/reject$/.test(pathname)) { const admin = requireAdmin(req, res, db); if (!admin) return; const ref = decodeURIComponent(pathname.split('/')[4]); const withdrawal = db.withdrawals.find(item => item.reference === ref); if (!withdrawal) return fail(res, 404, 'Withdrawal was not found.'); const before = { ...withdrawal }; const p = await body(req); const rejected = rejectWithdrawal(db, withdrawal, p.note); adminAudit(db, { admin, action: 'withdrawal.reject', targetType: 'withdrawal', targetId: ref, before, after: { ...withdrawal }, reason: p.note }); save(db); console.log('[withdrawal:rejected]', ref); return json(res, 200, { ok: true, withdrawal: publicWithdrawal(rejected.withdrawal), transaction: rejected.transaction && publicTransaction(rejected.transaction), receipt: rejected.receipt && publicReceipt(rejected.receipt) }); }
    if (req.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/kyc\/verify$/.test(pathname)) { const admin = requireAdmin(req, res, db); if (!admin) return; const userId = decodeURIComponent(pathname.split('/')[4]); const target = db.users.find(item => item.id === userId); if (!target) return fail(res, 404, 'User was not found.'); const p = await body(req); const before = { kycStatus: target.kycStatus, kycVerifiedAt: target.kycVerifiedAt }; target.kycStatus = KYC_STATUS.VERIFIED; target.kycVerifiedAt = now(); const released = markWithdrawalKycReady(db, target.id, p.note); adminAudit(db, { admin, action: 'kyc.verify', targetType: 'user', targetId: userId, before, after: { kycStatus: target.kycStatus, kycVerifiedAt: target.kycVerifiedAt, releasedWithdrawals: released.map(item => item.reference) }, reason: p.note }); save(db); console.log('[kyc:verified]', userId, released.length); return json(res, 200, { ok: true, user: adminSafeUser(target, db), releasedWithdrawals: released.map(publicWithdrawal) }); }
    if (req.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/kyc\/reject$/.test(pathname)) { const admin = requireAdmin(req, res, db); if (!admin) return; const userId = decodeURIComponent(pathname.split('/')[4]); const target = db.users.find(item => item.id === userId); if (!target) return fail(res, 404, 'User was not found.'); const p = await body(req); const before = { kycStatus: target.kycStatus, kycVerifiedAt: target.kycVerifiedAt }; target.kycStatus = KYC_STATUS.REJECTED; target.kycVerifiedAt = null; adminAudit(db, { admin, action: 'kyc.reject', targetType: 'user', targetId: userId, before, after: { kycStatus: target.kycStatus, kycVerifiedAt: target.kycVerifiedAt }, reason: p.note }); save(db); console.log('[kyc:rejected]', userId); return json(res, 200, { ok: true, user: adminSafeUser(target, db) }); }
    if (req.method === 'POST' && pathname === '/api/auth/signup') { const p = await body(req); const email = normalizeEmail(p.email); const phone = normalizePhone(p.phone); if (!p.name?.trim() || !validMobile(phone)) return fail(res, 400, 'Enter your full name and a 10-digit mobile number that starts with 0.'); if (email && !validGmail(email)) return fail(res, 400, 'Email must be a valid @gmail.com address.'); if (String(p.password || '').length < 6) return fail(res, 400, 'Password must be at least 6 characters.'); if (db.users.some(u => normalizePhone(u.phone) === phone)) return fail(res, 409, 'An account already exists for this mobile number.'); if (email && db.users.some(u => normalizeEmail(u.email) === email)) return fail(res, 409, 'An account already exists for this email.'); const createdAt = now(); const user = { id: uid('usr'), name: p.name.trim(), email, phone, contactEmailCapturedAt: email ? createdAt : null, paystackPaymentEmail: assignedPaystackPaymentEmail(db.users.length), passwordHash: await hash(p.password), pinHash: null, walletBalance: 0, redeemedBalance: 0, kycStatus: KYC_STATUS.NOT_VERIFIED, kycVerifiedAt: null, createdAt, lastLoginAt: createdAt, lastActivityAt: createdAt }; db.users.push(user); const token = crypto.randomBytes(32).toString('hex'); db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + SESSION_MAX_AGE }); save(db); return json(res, 201, publicState(db, user), { 'set-cookie': sessionCookie(token, req) }); }
    if (req.method === 'POST' && pathname === '/api/auth/login') { const p = await body(req); const identifier = String(p.email || '').trim(); const user = db.users.find(u => normalizeEmail(u.email) === normalizeEmail(identifier) || normalizePhone(u.phone) === normalizePhone(identifier)); if (!user || !await passwordMatches(p.password || '', user.passwordHash)) return fail(res, 401, 'Incorrect email or mobile number, or password.'); const rememberMe = p.rememberMe === true; const sessionAge = rememberMe ? SESSION_MAX_AGE : SESSION_SHORT_MAX_AGE; const token = crypto.randomBytes(32).toString('hex'); const loginAt = now(); user.lastLoginAt = loginAt; user.lastActivityAt = loginAt; db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + sessionAge }); save(db); return json(res, 200, publicState(db, user), { 'set-cookie': sessionCookie(token, req, sessionAge / 1000) }); }
    if (req.method === 'POST' && pathname === '/api/auth/logout') { const token = cookie(req).phantom_session; db.sessions = db.sessions.filter(s => s.token !== token); save(db); return json(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie(req) }); }
    if (req.method === 'POST' && pathname === '/api/auth/forgot') {
      const p = await body(req);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email || '')) return fail(res, 400, 'Enter a valid email address.');
      const user = db.users.find(u => u.email === p.email.toLowerCase());
      let resetToken = null;
      if (user) {
        resetToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        db.passwordResets = db.passwordResets.filter(item => item.userId !== user.id || item.status !== 'active');
        db.passwordResets.push({ id: uid('reset'), userId: user.id, tokenHash, createdAt: now(), expiresAt: Date.now() + 1000 * 60 * 30, status: 'active' });
        save(db);
      }
      // A mail provider is not configured for this local app. Returning the token outside
      // production keeps the complete recovery flow testable without exposing it in production.
      return json(res, 200, {
        message: 'If an account exists, a password reset link has been sent.',
        ...(process.env.NODE_ENV === 'production' ? {} : { resetToken }),
      });
    }
    if (req.method === 'POST' && pathname === '/api/auth/reset') {
      const p = await body(req);
      const token = String(p.token || '');
      if (!token) return fail(res, 400, 'This password reset link is missing or invalid.');
      if (String(p.newPassword || '').length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const reset = db.passwordResets.find(item => item.tokenHash === tokenHash && item.status === 'active');
      if (!reset || Number(reset.expiresAt) < Date.now()) return fail(res, 400, 'This password reset link has expired. Request a new one.');
      const resetUser = db.users.find(item => item.id === reset.userId);
      if (!resetUser) return fail(res, 400, 'This password reset link is invalid.');
      resetUser.passwordHash = await hash(p.newPassword);
      reset.status = 'used';
      reset.usedAt = now();
      save(db);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/purchases') return handlePurchaseRequest(req, res);
    let user = requireUser(req, res, db); if (!user) return;
    if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, publicState(db, user));
    if (req.method === 'POST' && pathname === '/api/support/messages') {
      const p = await body(req);
      const name = String(p.name || '').trim().slice(0, 120);
      const email = normalizeEmail(p.email);
      const subject = String(p.subject || '').trim().slice(0, 180);
      const message = String(p.message || '').trim().slice(0, 4000);
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || subject.length < 2 || message.length < 5) return fail(res, 400, 'Enter your name, a valid email, a subject, and a message.');
      const createdAt = now();
      const supportMessage = { id: uid('support'), userId: user.id, name, email, subject, message, status: 'open', createdAt, updatedAt: createdAt };
      db.supportMessages.push(supportMessage);
      user.lastActivityAt = createdAt;
      save(db);
      return json(res, 201, { ok: true, message: 'Your message was received. Our support team will review it shortly.' });
    }
    if (req.method === 'POST' && pathname === '/api/kyc/submissions') {
      const p = await body(req); const withdrawal = db.withdrawals.find(item => item.reference === String(p.withdrawalReference || '') && item.userId === user.id);
      if (!withdrawal || withdrawal.status !== WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION) return fail(res, 400, 'This withdrawal is not awaiting KYC verification.');
      if (String(p.name || '').trim().length < 2 || !validMobile(normalizePhone(p.phone))) return fail(res, 400, 'Enter your full legal name and a valid 10-digit mobile number.');
      const allowedDocumentTypes = new Set(['image/jpeg', 'image/png', 'application/pdf']);
      const documents = Array.isArray(p.documents) ? p.documents : [];
      if (documents.length !== 2 || documents.some(document => !document || !allowedDocumentTypes.has(document.type) || !Number.isInteger(document.size) || document.size < 1 || document.size > 5 * 1024 * 1024 || String(document.name || '').trim().length < 1 || String(document.name).length > 180 || typeof document.content !== 'string')) return fail(res, 400, 'Upload a valid government-issued ID and proof of address (JPG, PNG, or PDF; up to 5 MB each).');
      const storedDocuments = persistKycDocuments(user.id, documents);
      user.kycStatus = KYC_STATUS.PENDING; user.kycSubmittedAt = user.kycSubmittedAt || now(); user.kycSubmission = { name: String(p.name).trim().slice(0, 120), phone: normalizePhone(p.phone), documents: storedDocuments, withdrawalReference: withdrawal.reference, submittedAt: now() }; user.lastActivityAt = user.kycSubmission.submittedAt;
      save(db); return json(res, 201, { state: publicState(db, user), kycStatus: user.kycStatus });
    }
    if (req.method === 'POST' && pathname === '/api/auth/password') { const p = await body(req); if (!await passwordMatches(String(p.currentPassword || ''), user.passwordHash)) return fail(res, 401, 'Current password is incorrect.'); if (String(p.newPassword || '').length < 6) return fail(res, 400, 'New password must be at least 6 characters.'); user.passwordHash = await hash(p.newPassword); user.lastActivityAt = now(); save(db); return json(res, 200, { ok: true, state: publicState(db, user) }); }
    if (req.method === 'POST' && pathname === '/api/auth/pin') { const p = await body(req); if (!/^\d{4}$/.test(p.newPin || '')) return fail(res, 400, 'New withdrawal PIN must be four digits.'); if (user.pinHash && !await passwordMatches(String(p.currentPin || ''), user.pinHash)) return fail(res, 401, 'Current withdrawal PIN is incorrect.'); user.pinHash = await hash(p.newPin); user.lastActivityAt = now(); save(db); return json(res, 200, { ok: true, state: publicState(db, user) }); }
    if (req.method === 'POST' && pathname === '/api/deposits') {
      if (!SITE_B_BASE_URL || !SITE_A_TO_SITE_B_SECRET || !SITE_B_TO_SITE_A_SECRET) return fail(res, 503, 'Wallet top-ups are not configured.');
      const authenticatedUserId = user.id;
      const p = await body(req);
      db = load(); user = db.users.find(item => item.id === authenticatedUserId);
      if (!user) return fail(res, 401, 'Your session is no longer valid.');
      const amount = money(p.amount); const amountMinor = Math.round(amount * 100); const contactEmail = normalizeEmail(p.contactEmail);
      const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
      if (idempotencyKey && !/^[A-Za-z0-9_-]{8,160}$/.test(idempotencyKey)) return fail(res, 400, 'Invalid payment request key.');
      if (!Number.isFinite(amount) || amount < MIN_DEPOSIT || !Number.isInteger(amountMinor)) return fail(res, 400, `Minimum top-up is GHS ${MIN_DEPOSIT.toFixed(2)}.`);
      if (!user.email) { if (!validGmail(contactEmail)) return fail(res, 400, 'Add a valid @gmail.com contact email before your first payment.'); if (db.users.some(item => item.id !== user.id && normalizeEmail(item.email) === contactEmail)) return fail(res, 409, 'An account already exists for this email.'); user.email = contactEmail; user.contactEmailCapturedAt = now(); }
      let deposit = idempotencyKey && db.deposits.find(item => item.userId === user.id && item.idempotencyKey === idempotencyKey);
      if (deposit && deposit.amountMinor !== amountMinor) return fail(res, 409, 'This payment request key was already used for a different amount.');
      if (!deposit) {
        const createdAt = now();
        deposit = normalizePaymentRecord({ id: uid('dep'), transactionId: uniqueReference(db, 'TOPUP'), idempotencyKey: idempotencyKey || null, userId: user.id, amount, amountMinor, currency: PAYSTACK_CURRENCY, purpose: 'WALLET_TOPUP', paymentProvider: 'paystack', status: PAYMENT_STATUS.PENDING, reference: uniqueReference(db, 'DEP'), expiresAt: new Date(Date.now() + PAYMENT_SESSION_MS).toISOString(), callbackRequestIds: [], createdAt, updatedAt: createdAt }, PAYMENT_STATUS.PENDING);
        paymentStatusEvent(deposit, PAYMENT_STATUS.PENDING, 'site-a-created');
        db.deposits.push(deposit);
      } else if (deposit.status === PAYMENT_STATUS.SUCCESS) {
        return json(res, 200, { status: PAYMENT_STATUS.SUCCESS, message: 'This payment has already been confirmed.' }, { 'cache-control': 'no-store' });
      }
      save(db);
      const payload = { siteATransactionId: deposit.transactionId, siteAUserId: user.id, amountMinor: deposit.amountMinor, currency: deposit.currency, customer: { email: paystackEmailForUser(user) }, purpose: 'WALLET_TOPUP' };
      try {
        const result = await initializePaymentOnce(`wallet:${user.id}:${deposit.id}`, payload, uid('init'));
        // A very fast Site B webhook can arrive while the initialization request
        // is still awaiting its response. Reload before persisting the provider
        // mapping so that a successful callback cannot be overwritten by a
        // stale PAYMENT_INITIALIZED snapshot.
        const latestDb = load();
        const latestDeposit = latestDb.deposits.find(item => item.id === deposit.id);
        if (!latestDeposit) throw new Error('Top-up disappeared while payment was initializing.');
        mergePaymentServiceMapping(latestDeposit, result, payload);
        latestDeposit.initializationAttempts = (latestDeposit.initializationAttempts || 0) + 1;
        latestDeposit.lastInitializationAt = now();
        latestDeposit.reconciliationStatus = null;
        if (!['SUCCESS', 'FAILED', 'EXPIRED'].includes(latestDeposit.status)) latestDeposit.status = PAYMENT_STATUS.PAYMENT_INITIALIZED;
        paymentStatusEvent(latestDeposit, latestDeposit.status, 'site-a-initialization');
        latestDeposit.updatedAt = now();
        save(latestDb);
        if (latestDeposit.status === PAYMENT_STATUS.SUCCESS) return json(res, 200, { status: PAYMENT_STATUS.SUCCESS, message: 'Your payment has been confirmed.' }, { 'cache-control': 'no-store' });
        if (!validSiteBHandoffUrl(latestDeposit.handoffUrl, payload)) throw new PaymentInitializationError('Payment service did not return a valid checkout handoff.', result, 'handoff_unavailable');
        return json(res, 201, { handoffUrl: latestDeposit.handoffUrl, expiresAt: result.expiresAt }, { 'cache-control': 'no-store' });
      } catch (error) {
        const failedDb = load();
        const failedDeposit = failedDb.deposits.find(item => item.id === deposit.id);
        if (failedDeposit && failedDeposit.status === PAYMENT_STATUS.SUCCESS) {
          return json(res, 200, { status: PAYMENT_STATUS.SUCCESS, message: 'Your payment has been confirmed.' }, { 'cache-control': 'no-store' });
        }
        if (failedDeposit && ![PAYMENT_STATUS.FAILED, PAYMENT_STATUS.EXPIRED].includes(failedDeposit.status)) {
          markInitializationUnknown(failedDeposit, error instanceof PaymentInitializationError ? error.result : {}, payload, error instanceof PaymentInitializationError ? error.reason : 'request_uncertain');
          save(failedDb);
          return json(res, 202, { status: failedDeposit.status, recoveryReference: failedDeposit.reference, message: 'Your payment is being verified. Your balance will update automatically once confirmation is received.' }, { 'cache-control': 'no-store' });
        }
        return json(res, 202, { status: failedDeposit?.status || PAYMENT_STATUS.PENDING_RECONCILIATION, recoveryReference: failedDeposit?.reference || null, message: 'Your payment status is being verified. Please check again shortly.' }, { 'cache-control': 'no-store' });
      }
    }
    if (req.method === 'GET' && /^\/api\/deposits\/[^/]+$/.test(pathname)) {
      const transactionId = decodeURIComponent(pathname.split('/')[3]);
      const deposit = db.deposits.find(x => x.transactionId === transactionId && x.userId === user.id);
      if (!deposit) return fail(res, 404, 'Top-up was not found.');
      return json(res, 200, { topup: publicTopup(deposit), state: publicState(db, user), receipt: db.receipts.find(x => x.reference === deposit.reference) ? publicReceipt(db.receipts.find(x => x.reference === deposit.reference)) : null });
    }
    if (req.method === 'POST' && /^\/api\/deposits\/[^/]+\/verify$/.test(pathname)) {
      const referenceValue = decodeURIComponent(pathname.split('/')[3]);
      const authenticatedUserId = user.id;
      db = load(); user = db.users.find(item => item.id === authenticatedUserId);
      if (!user) return fail(res, 401, 'Your session is no longer valid.');
      const deposit = db.deposits.find(item => item.userId === user.id && item.reference === referenceValue);
      if (!deposit) return fail(res, 404, 'Top-up was not found.');
      if (deposit.status === PAYMENT_STATUS.SUCCESS) {
        const existingReceipt = db.receipts.find(x => x.reference === deposit.reference);
        return json(res, 200, { status: PAYMENT_STATUS.SUCCESS, topup: publicTopup(deposit), state: publicState(db, user), receipt: existingReceipt ? publicReceipt(existingReceipt) : null, duplicate: true });
      }
      if (!isRecoverablePaymentStatus(deposit.status) && deposit.status !== PAYMENT_STATUS.EXPIRED) return fail(res, 409, 'This payment has a confirmed terminal status and cannot be rechecked.');
      deposit.status = PAYMENT_STATUS.PENDING_RECONCILIATION;
      deposit.reconciliationAttempts = (deposit.reconciliationAttempts || 0) + 1;
      deposit.lastReconciliationAt = now();
      deposit.reconciliationStatus = 'REQUESTED';
      deposit.updatedAt = now();
      paymentStatusEvent(deposit, deposit.status, 'site-a-reconciliation-requested');
      save(db);
      try {
        await askPaymentServiceToReconcile(deposit);
      } catch (error) {
        const unavailableDb = load();
        const unavailableDeposit = unavailableDb.deposits.find(item => item.id === deposit.id);
        if (unavailableDeposit?.status === PAYMENT_STATUS.SUCCESS) {
          const recoveredUser = unavailableDb.users.find(item => item.id === user.id) || user;
          const recoveredReceipt = unavailableDb.receipts.find(item => item.reference === unavailableDeposit.reference);
          return json(res, 200, { status: PAYMENT_STATUS.SUCCESS, message: 'Your payment has been confirmed.', topup: publicTopup(unavailableDeposit), state: publicState(unavailableDb, recoveredUser), receipt: recoveredReceipt ? publicReceipt(recoveredReceipt) : null }, { 'cache-control': 'no-store' });
        }
        if (unavailableDeposit && unavailableDeposit.status !== PAYMENT_STATUS.SUCCESS) {
          unavailableDeposit.status = PAYMENT_STATUS.PENDING_RECONCILIATION;
          unavailableDeposit.reconciliationStatus = 'UNAVAILABLE';
          unavailableDeposit.updatedAt = now();
          paymentStatusEvent(unavailableDeposit, unavailableDeposit.status, 'site-a-reconciliation', { result: 'unavailable' });
          save(unavailableDb);
        }
        const currentUser = unavailableDb.users.find(item => item.id === user.id) || user;
        return json(res, 202, { status: PAYMENT_STATUS.PENDING_RECONCILIATION, message: 'Your payment is still being verified. Your balance will update automatically once confirmation is received.', topup: publicTopup(unavailableDeposit || deposit), state: publicState(unavailableDb, currentUser), receipt: null }, { 'cache-control': 'no-store' });
      }
      const refreshedDb = load();
      const refreshedDeposit = refreshedDb.deposits.find(item => item.id === deposit.id);
      if (!refreshedDeposit) return fail(res, 404, 'Top-up disappeared while it was being verified.');
      if (refreshedDeposit.status !== PAYMENT_STATUS.SUCCESS) {
        refreshedDeposit.status = [PAYMENT_STATUS.FAILED, PAYMENT_STATUS.EXPIRED].includes(refreshedDeposit.status) ? refreshedDeposit.status : PAYMENT_STATUS.PENDING_RECONCILIATION;
        refreshedDeposit.reconciliationStatus = refreshedDeposit.status === PAYMENT_STATUS.PENDING_RECONCILIATION ? 'PENDING' : 'TERMINAL';
        refreshedDeposit.updatedAt = now();
        paymentStatusEvent(refreshedDeposit, refreshedDeposit.status, 'site-a-reconciliation', { result: refreshedDeposit.status });
        save(refreshedDb);
        const refreshedUser = refreshedDb.users.find(item => item.id === user.id) || user;
        return json(res, refreshedDeposit.status === PAYMENT_STATUS.PENDING_RECONCILIATION ? 202 : 200, { status: refreshedDeposit.status, message: refreshedDeposit.status === PAYMENT_STATUS.PENDING_RECONCILIATION ? 'Your payment is still being verified. Your balance will update automatically once confirmation is received.' : `The payment service confirmed that this payment is ${refreshedDeposit.status.toLowerCase()}. No wallet credit was applied.`, topup: publicTopup(refreshedDeposit), state: publicState(refreshedDb, refreshedUser), receipt: null }, { 'cache-control': 'no-store' });
      }
      const refreshedReceipt = refreshedDb.receipts.find(item => item.reference === refreshedDeposit.reference);
      const refreshedUser = refreshedDb.users.find(item => item.id === user.id);
      return json(res, 200, { status: PAYMENT_STATUS.SUCCESS, topup: publicTopup(refreshedDeposit), state: publicState(refreshedDb, refreshedUser), receipt: refreshedReceipt ? publicReceipt(refreshedReceipt) : null });
    }
    if (req.method === 'POST' && /^\/api\/purchases\/[^/]+\/code\/?$/.test(pathname)) {
      const purchaseId = decodeURIComponent(pathname.split('/')[3]);
      const purchase = db.purchases.find(item => item.id === purchaseId && item.userId === user.id);
      if (!purchase) return fail(res, 404, 'Purchased card was not found.');
      const code = db.codes.find(item => item.purchaseId === purchase.id && item.userId === user.id);
      if (!code || purchase.status !== 'sealed' || code.status !== 'unused') return fail(res, 409, 'This card is no longer available to redeem.');
      const card = db.cards.find(item => item.id === purchase.cardId);
      return json(res, 200, { purchase: publicPurchase(purchase), card: card && publicCard(card), code: code.code });
    }
    if (req.method === 'POST' && pathname === '/api/redemptions') {
      const p = await body(req);
      const codeText = normalizeCode(p.code);
      if (!CODE_PATTERN.test(codeText)) return fail(res, 400, 'Enter a valid 14-character redemption code.');
      const code = db.codes.find(c => normalizeCode(c.code) === codeText);
      if (!code) return fail(res, 404, 'That redemption code does not exist.');
      if (code.userId !== user.id) return fail(res, 403, 'This code belongs to another account.');
      if (code.status !== 'unused') return fail(res, 409, 'This code has already been redeemed.');
      const card = db.cards.find(c => c.id === code.cardId);
      const purchase = db.purchases.find(item => item.id === code.purchaseId && item.userId === user.id);
      const purchaseAmount = money(code.purchaseAmount ?? purchase?.amountPaid ?? card?.priceGhs ?? 0);
      let rewardAmount = money(code.rewardAmount ?? purchase?.rewardAmount ?? card?.rewardAmount ?? 0);
      let rewardMultiplier = Number(code.rewardMultiplier ?? purchase?.rewardMultiplier ?? rewardMultiplierForAmount(rewardAmount, purchaseAmount));
      // Unused legacy codes may have been created under an older multiplier
      // range. Reassign only those future redemptions; completed redemptions
      // remain historical snapshots and are never rewritten.
      if (!validRewardMultiplier(rewardMultiplier)) {
        const reward = rewardAllocationForPrice(purchaseAmount);
        rewardAmount = reward.rewardAmount;
        rewardMultiplier = reward.rewardMultiplier;
        if (purchase) {
          purchase.rewardAmount = rewardAmount;
          purchase.rewardMultiplier = rewardMultiplier;
        }
      }
      if (!Number.isFinite(rewardAmount) || rewardAmount <= 0 || !validRewardMultiplier(rewardMultiplier)) return fail(res, 400, 'This code has no valid reward value.');
      code.amount = rewardAmount;
      code.rewardAmount = rewardAmount;
      code.rewardMultiplier = rewardMultiplier;
      code.purchaseAmount = purchaseAmount;
      code.status = 'redeemed';
      code.redeemedAt = now();
      const ref = uniqueReference(db, 'RED');
      code.redemptionReference = ref;
      balance(user, 'redeemed', rewardAmount);
      transaction(db, { userId: user.id, type: 'credit', amount: rewardAmount, account: 'redeemed', reference: ref, reason: 'Redeemed code', related: { cardId: code.cardId, orderId: code.orderId, code: code.code, purchaseAmount, rewardAmount, rewardMultiplier } });
      const rcpt = receipt(db, { userId: user.id, type: 'redemption', amount: rewardAmount, account: 'redeemed', reference: ref, related: { cardId: code.cardId, orderId: code.orderId, code: code.code, purchaseAmount, rewardAmount, rewardMultiplier } });
      user.lastActivityAt = code.redeemedAt;
      save(db);
      console.log('[redemption:complete]', ref, { purchaseAmount, rewardAmount, rewardMultiplier });
      return json(res, 200, { state: publicState(db, user), code: publicCode(code, card), receipt: publicReceipt(rcpt) });
    }
    if (req.method === 'POST' && /^\/api\/methods\/[^/]+\/default$/.test(pathname)) { const methodId = decodeURIComponent(pathname.split('/')[3]); const method = db.methods.find(item => item.id === methodId && item.userId === user.id); if (!method) return fail(res, 404, 'Withdrawal method was not found.'); db.methods.filter(item => item.userId === user.id).forEach(item => { item.isDefault = item.id === method.id; }); user.lastActivityAt = now(); save(db); return json(res, 200, { state: publicState(db, user), method }); }
    if (req.method === 'POST' && pathname === '/api/methods') { const p = await body(req); const networks = ['MTN Mobile Money', 'Telecel Cash', 'AT Cash']; if (!networks.includes(p.network) || !p.accountName?.trim() || String(p.phone || '').replace(/\D/g, '').length < 9) return fail(res, 400, 'Enter a supported mobile money method, account name, and valid phone number.'); if (!/^\d{4}$/.test(p.pin || '')) return fail(res, 400, 'Withdrawal PIN must be four digits.'); if (user.pinHash && !await passwordMatches(String(p.pin || ''), user.pinHash)) return fail(res, 401, 'Incorrect withdrawal PIN.'); if (!user.pinHash) user.pinHash = await hash(p.pin); const method = { id: uid('method'), userId: user.id, network: p.network, accountName: p.accountName.trim(), phone: p.phone.trim(), isDefault: !db.methods.some(m => m.userId === user.id), createdAt: now() }; db.methods.push(method); user.lastActivityAt = now(); save(db); return json(res, 201, { state: publicState(db, user), method }); }
    if (req.method === 'POST' && pathname === '/api/withdrawals') {
      const p = await body(req);
      const requestedAmount = money(p.amount);
      const method = db.methods.find(m => m.id === p.methodId && m.userId === user.id);
      const lifetimeRedeemedCards = redeemedCardsCount(db, user.id);
      if (lifetimeRedeemedCards < MIN_REDEEMED_CARDS_FOR_WITHDRAWAL) {
        const remaining = Math.max(0, MIN_REDEEMED_CARDS_FOR_WITHDRAWAL - lifetimeRedeemedCards);
        return fail(res, 400, `Redeem ${remaining} more card${remaining === 1 ? '' : 's'} to unlock withdrawals.`);
      }
      if (!method) return fail(res, 400, 'Choose a saved withdrawal method.');
      if (!Number.isFinite(requestedAmount) || requestedAmount < MIN_WITHDRAWAL) return fail(res, 400, `Minimum withdrawal is GHS ${MIN_WITHDRAWAL.toFixed(2)}.`);
      if (requestedAmount > user.redeemedBalance) return fail(res, 400, 'Withdrawal amount exceeds redeemed balance.');
      if (!user.pinHash || !await passwordMatches(String(p.pin || ''), user.pinHash)) return fail(res, 401, 'Incorrect withdrawal PIN.');
      const operationalCharge = money(requestedAmount * OPERATIONAL_CHARGE_RATE);
      const actualAmount = money(requestedAmount - operationalCharge);
      const kycRequired = user.kycStatus !== KYC_STATUS.VERIFIED;
      const status = kycRequired ? WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION : WITHDRAWAL_STATUS.PENDING;
      const ref = uniqueReference(db, 'WDL');
      balance(user, 'redeemed', -requestedAmount);
      const withdrawal = normalizeWithdrawalRecord({ id: uid('wdl'), userId: user.id, methodId: method.id, amount: requestedAmount, requestedAmount, operationalCharge, actualAmount, reference: ref, status, kycRequired, kycBypassUsed: false, kycBypassFee: 0, paymentStatus: kycRequired ? 'kyc_required' : 'not_required', createdAt: now(), approvedAt: null, completedAt: null });
      db.withdrawals.push(withdrawal);
      const related = { withdrawalId: withdrawal.id, methodId: method.id, payoutStatus: status, requestedAmount, operationalCharge, actualAmount, kycRequired, kycBypassUsed: false };
      transaction(db, { userId: user.id, type: 'debit', amount: requestedAmount, account: 'redeemed', reference: ref, status, reason: `Withdrawal to ${method.network}`, related });
      const rcpt = receipt(db, { userId: user.id, type: 'withdrawal', amount: requestedAmount, account: 'redeemed', reference: ref, status, related });
      user.lastActivityAt = withdrawal.createdAt;
      save(db);
      console.log(kycRequired ? '[withdrawal:pending-kyc]' : '[withdrawal:pending]', ref, { requestedAmount, operationalCharge, actualAmount });
      return json(res, 201, { state: publicState(db, user), withdrawal: publicWithdrawal(withdrawal), receipt: publicReceipt(rcpt) });
    }
    if (req.method === 'POST' && /^\/api\/withdrawals\/[^/]+\/kyc-bypass$/.test(pathname)) {
      const withdrawalRef = decodeURIComponent(pathname.split('/')[3]);
      const authenticatedUserId = user.id;
      await body(req);
      db = load(); user = db.users.find(item => item.id === authenticatedUserId);
      const withdrawal = db.withdrawals.find(item => item.reference === withdrawalRef && item.userId === user?.id);
      if (!withdrawal) return fail(res, 404, 'Withdrawal was not found.');
      normalizeWithdrawalRecord(withdrawal);
      if (withdrawal.status !== WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION) return fail(res, 400, 'KYC bypass is available only for withdrawals pending KYC verification.');
      if (withdrawal.kycBypassUsed) return fail(res, 400, 'KYC bypass has already been used for this withdrawal.');
      if (!SITE_B_BASE_URL || !SITE_A_TO_SITE_B_SECRET || !SITE_B_TO_SITE_A_SECRET) return fail(res, 503, 'Secure KYC payment checkout is not configured.');
      const existing = db.kycBypassPayments.find(item => item.withdrawalId === withdrawal.id && item.userId === user.id && isRecoverableKycPaymentStatus(item.status));
      const payment = existing || normalizePaymentRecord({ id: uid('kycbyp'), userId: user.id, withdrawalId: withdrawal.id, withdrawalReference: withdrawal.reference, amount: KYC_BYPASS_FEE, currency: PAYSTACK_CURRENCY, reference: uniqueReference(db, 'KYC'), status: 'initialized', callbackUrl: kycBypassCallback(req, '', ''), returnOrigin: '', expiresAt: new Date(Date.now() + PAYMENT_SESSION_MS).toISOString(), callbackRequestIds: [], createdAt: now(), updatedAt: now() }, 'initialized');
      if (!existing) paymentStatusEvent(payment, 'initialized', 'site-a-created');
      // The browser cannot choose an arbitrary post-payment origin. Site B
      // receives this Site A URL as part of the private integration contract;
      // Paystack itself only sees Site B's callback URL.
      payment.callbackUrl = kycBypassCallback(req, payment.reference);
      payment.returnOrigin = normalizeOrigin(requestOrigin(req));
      if (!existing) db.kycBypassPayments.push(payment);
      withdrawal.paymentStatus = 'bypass_initialized';
      // Site B validates this payment by calling Site A back before it creates
      // the Paystack checkout. Persist the session first so that lookup can
      // see the newly-created KYC payment, just like wallet top-ups.
      save(db);
      const payload = { siteATransactionId: payment.reference, siteAUserId: user.id, amountMinor: Math.round(KYC_BYPASS_FEE * 100), currency: PAYSTACK_CURRENCY, customer: { email: paystackEmailForUser(user) }, purpose: 'KYC_BYPASS', returnUrl: payment.callbackUrl };
      try {
        const result = await initializePaymentOnce(`kyc:${user.id}:${payment.id}`, payload, uid('kyc'));
        const latestDb = load();
        const latestPayment = latestDb.kycBypassPayments.find(item => item.id === payment.id);
        const latestWithdrawal = latestDb.withdrawals.find(item => item.id === withdrawal.id);
        if (!latestPayment || !latestWithdrawal) throw new Error('KYC payment disappeared while payment was initializing.');
        mergePaymentServiceMapping(latestPayment, result, payload);
        latestPayment.initializationAttempts = (latestPayment.initializationAttempts || 0) + 1;
        latestPayment.lastInitializationAt = now();
        latestPayment.reconciliationStatus = null;
        if (latestPayment.status !== 'success') latestPayment.status = PAYMENT_STATUS.PAYMENT_INITIALIZED;
        latestWithdrawal.paymentStatus = latestPayment.status === 'success' ? 'success' : 'bypass_initialized';
        paymentStatusEvent(latestPayment, latestPayment.status, 'site-a-initialization');
        latestPayment.updatedAt = now();
        save(latestDb);
        if (latestPayment.status === 'success') return json(res, 200, { status: PAYMENT_STATUS.SUCCESS, message: 'Your payment has been confirmed.' }, { 'cache-control': 'no-store' });
        return json(res, 201, { handoffUrl: latestPayment.handoffUrl, expiresAt: result.expiresAt, amount: KYC_BYPASS_FEE, mode: 'payment-service' }, { 'cache-control': 'no-store' });
      } catch (error) {
        const uncertainDb = load();
        const uncertainPayment = uncertainDb.kycBypassPayments.find(item => item.id === payment.id);
        const uncertainWithdrawal = uncertainDb.withdrawals.find(item => item.id === withdrawal.id);
        if (uncertainPayment?.status === 'success') return json(res, 200, { status: PAYMENT_STATUS.SUCCESS, message: 'Your payment has been confirmed.' }, { 'cache-control': 'no-store' });
        if (uncertainPayment && !['failed', 'expired'].includes(uncertainPayment.status)) {
          markInitializationUnknown(uncertainPayment, error instanceof PaymentInitializationError ? error.result : {}, payload, error instanceof PaymentInitializationError ? error.reason : 'request_uncertain');
          if (uncertainWithdrawal) uncertainWithdrawal.paymentStatus = 'initialization_unknown';
          save(uncertainDb);
          return json(res, 202, { status: uncertainPayment.status, recoveryReference: uncertainPayment.reference, message: 'Your payment is being verified. Your withdrawal will update automatically once confirmation is received.' }, { 'cache-control': 'no-store' });
        }
        return json(res, 202, { status: uncertainPayment?.status || PAYMENT_STATUS.PENDING_RECONCILIATION, recoveryReference: uncertainPayment?.reference || null, message: 'Your payment status is being verified. Please check again shortly.' }, { 'cache-control': 'no-store' });
      }
    }
    if (req.method === 'POST' && /^\/api\/kyc-bypass-payments\/[^/]+\/verify$/.test(pathname)) {
      const ref = decodeURIComponent(pathname.split('/')[3]);
      const authenticatedUserId = user.id;
      db = load(); user = db.users.find(item => item.id === authenticatedUserId);
      const payment = db.kycBypassPayments.find(item => item.reference === ref && item.userId === user?.id);
      if (!payment) return fail(res, 404, 'KYC bypass payment was not found.');
      if (payment.status === 'success') {
        const withdrawal = db.withdrawals.find(item => item.id === payment.withdrawalId);
        return json(res, 200, {
          state: publicState(db, user),
          withdrawal: publicWithdrawal(withdrawal),
          receipt: db.receipts.find(r => r.reference === ref),
          refundReceipt: withdrawal?.kycBypassRefundReference ? db.receipts.find(r => r.reference === withdrawal.kycBypassRefundReference) : null,
        });
      }
      if (!isRecoverableKycPaymentStatus(payment.status)) return json(res, 200, { status: payment.status, message: `The payment service confirmed that this payment is ${payment.status}.`, state: publicState(db, user) }, { 'cache-control': 'no-store' });
      const withdrawal = db.withdrawals.find(item => item.id === payment.withdrawalId && item.userId === user.id);
      payment.status = PAYMENT_STATUS.PENDING_RECONCILIATION;
      payment.reconciliationAttempts = (payment.reconciliationAttempts || 0) + 1;
      payment.lastReconciliationAt = now();
      payment.reconciliationStatus = 'REQUESTED';
      payment.updatedAt = now();
      if (withdrawal) withdrawal.paymentStatus = 'reconciliation_pending';
      paymentStatusEvent(payment, payment.status, 'site-a-reconciliation-requested');
      save(db);
      try {
        await askPaymentServiceToReconcile(payment);
      } catch (error) {
        const unavailableDb = load();
        const unavailablePayment = unavailableDb.kycBypassPayments.find(item => item.id === payment.id);
        const unavailableWithdrawal = unavailableDb.withdrawals.find(item => item.id === payment.withdrawalId && item.userId === user.id);
        if (unavailablePayment?.status !== 'success') {
          if (unavailablePayment) {
            unavailablePayment.status = PAYMENT_STATUS.PENDING_RECONCILIATION;
            unavailablePayment.reconciliationStatus = 'UNAVAILABLE';
            unavailablePayment.updatedAt = now();
            paymentStatusEvent(unavailablePayment, unavailablePayment.status, 'site-a-reconciliation', { result: 'unavailable' });
          }
          if (unavailableWithdrawal) unavailableWithdrawal.paymentStatus = 'reconciliation_pending';
          save(unavailableDb);
        }
        if (unavailablePayment?.status === 'success') {
          const completedWithdrawal = unavailableDb.withdrawals.find(item => item.id === unavailablePayment.withdrawalId);
          return json(res, 200, { status: PAYMENT_STATUS.SUCCESS, state: publicState(unavailableDb, user), withdrawal: publicWithdrawal(completedWithdrawal), receipt: unavailableDb.receipts.find(item => item.reference === unavailablePayment.reference) || null, refundReceipt: completedWithdrawal?.kycBypassRefundReference ? unavailableDb.receipts.find(item => item.reference === completedWithdrawal.kycBypassRefundReference) : null });
        }
        return json(res, 202, { status: PAYMENT_STATUS.PENDING_RECONCILIATION, message: 'Your payment is still being verified. Your withdrawal will update automatically once confirmation is received.', state: publicState(unavailableDb, user) }, { 'cache-control': 'no-store' });
      }
      const refreshedDb = load();
      const refreshedPayment = refreshedDb.kycBypassPayments.find(item => item.id === payment.id);
      const refreshedWithdrawal = refreshedDb.withdrawals.find(item => item.id === payment.withdrawalId && item.userId === user.id);
      const refreshedUser = refreshedDb.users.find(item => item.id === user.id) || user;
      if (!refreshedPayment) return fail(res, 404, 'KYC payment disappeared while it was being reconciled.');
      if (refreshedPayment.status === 'success') {
        return json(res, 200, { status: PAYMENT_STATUS.SUCCESS, state: publicState(refreshedDb, refreshedUser), withdrawal: publicWithdrawal(refreshedWithdrawal), receipt: refreshedDb.receipts.find(item => item.reference === refreshedPayment.reference) || null, refundReceipt: refreshedWithdrawal?.kycBypassRefundReference ? refreshedDb.receipts.find(item => item.reference === refreshedWithdrawal.kycBypassRefundReference) : null });
      }
      const terminalStatus = ['failed', 'expired', 'FAILED', 'EXPIRED'].includes(refreshedPayment.status);
      refreshedPayment.status = terminalStatus ? refreshedPayment.status : PAYMENT_STATUS.PENDING_RECONCILIATION;
      refreshedPayment.reconciliationStatus = terminalStatus ? 'TERMINAL' : 'PENDING';
      refreshedPayment.updatedAt = now();
      paymentStatusEvent(refreshedPayment, refreshedPayment.status, 'site-a-reconciliation', { result: refreshedPayment.status });
      save(refreshedDb);
      return json(res, terminalStatus ? 200 : 202, { status: refreshedPayment.status, message: terminalStatus ? `The payment service confirmed that this payment is ${String(refreshedPayment.status).toLowerCase()}.` : 'Your payment is still being verified. Your withdrawal will update automatically once confirmation is received.', state: publicState(refreshedDb, refreshedUser) }, { 'cache-control': 'no-store' });
    }
    return fail(res, 404, 'API route not found.');
  } catch (error) { console.error('[api:error]', error); return fail(res, 500, error.message || 'Unexpected server error.'); }
}
if (process.argv.includes('--reset')) { save(blankDb()); console.log(`Reset ${DATA_FILE}`); process.exit(0); }
const server = http.createServer(route);
server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the existing server or choose another PORT.`);
    process.exitCode = 1;
    return;
  }
  throw error;
});
server.listen(PORT, () => {
  if (appBaseUrlPortMismatch()) {
    console.warn(`[env:warning] Server is listening on port ${PORT}, but APP_BASE_URL is ${APP_BASE_URL}. Set APP_BASE_URL to the public Site A origin.`);
  }
  console.log(`PHANTOM CARDS development server: ${APP_BASE_URL || `http://127.0.0.1:${PORT}`}`);
});
