const PAYSTACK_PAYMENT_EMAIL_POOL_VERSION = 'plus-11-to-21-v1';
const PAYSTACK_PAYMENT_EMAILS = Object.freeze([
  'bridgetfegerson2007+11@gmail.com',
  'bridgetfegerson2007+12@gmail.com',
  'bridgetfegerson2007+13@gmail.com',
  'bridgetfegerson2007+14@gmail.com',
  'bridgetfegerson2007+15@gmail.com',
  'bridgetfegerson2007+16@gmail.com',
  'bridgetfegerson2007+17@gmail.com',
  'bridgetfegerson2007+18@gmail.com',
  'bridgetfegerson2007+19@gmail.com',
  'bridgetfegerson2007+20@gmail.com',
  'bridgetfegerson2007+21@gmail.com',
  'jasonfegurson2007+11@gmail.com',
  'jasonfegurson2007+12@gmail.com',
  'jasonfegurson2007+13@gmail.com',
  'jasonfegurson2007+14@gmail.com',
  'jasonfegurson2007+15@gmail.com',
  'jasonfegurson2007+16@gmail.com',
  'jasonfegurson2007+17@gmail.com',
  'jasonfegurson2007+18@gmail.com',
  'jasonfegurson2007+19@gmail.com',
  'jasonfegurson2007+20@gmail.com',
  'jasonfegurson2007+21@gmail.com',
]);

function normalizePaymentEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isAllowedPaystackPaymentEmail(value) {
  return PAYSTACK_PAYMENT_EMAILS.includes(normalizePaymentEmail(value));
}

module.exports = {
  PAYSTACK_PAYMENT_EMAIL_POOL_VERSION,
  PAYSTACK_PAYMENT_EMAILS,
  normalizePaymentEmail,
  isAllowedPaystackPaymentEmail,
};
