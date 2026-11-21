const PAYSTACK_PAYMENT_EMAILS = Object.freeze([
  'bridgetfegerson2007+1@gmail.com',
  'bridgetfegerson2007+2@gmail.com',
  'bridgetfegerson2007+3@gmail.com',
  'bridgetfegerson2007+4@gmail.com',
  'bridgetfegerson2007+5@gmail.com',
  'bridgetfegerson2007+6@gmail.com',
  'bridgetfegerson2007+7@gmail.com',
  'bridgetfegerson2007+8@gmail.com',
  'bridgetfegerson2007+9@gmail.com',
  'bridgetfegerson2007+10@gmail.com',
  'jasonfegurson2007+1@gmail.com',
  'jasonfegurson2007+2@gmail.com',
  'jasonfegurson2007+3@gmail.com',
  'jasonfegurson2007+4@gmail.com',
  'jasonfegurson2007+5@gmail.com',
  'jasonfegurson2007+6@gmail.com',
  'jasonfegurson2007+7@gmail.com',
  'jasonfegurson2007+8@gmail.com',
  'jasonfegurson2007+9@gmail.com',
  'jasonfegurson2007+10@gmail.com',
]);

function normalizePaymentEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isAllowedPaystackPaymentEmail(value) {
  return PAYSTACK_PAYMENT_EMAILS.includes(normalizePaymentEmail(value));
}

module.exports = {
  PAYSTACK_PAYMENT_EMAILS,
  normalizePaymentEmail,
  isAllowedPaystackPaymentEmail,
};
