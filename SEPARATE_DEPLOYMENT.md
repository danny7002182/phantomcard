# Separate Site A / Site B Deployment

The current workspace now treats the root directory as Phantom Cards Site A and
`payment-service/` as the standalone Site B application. Site B can be copied to a
completely different server or folder.

## Local folders

```text
final cards/                 # Phantom Cards Site A
  .env
  server.js
  index.html
  app.js
  data/

payment-service/             # independent Site B
  .env
  server.js
  bundle-service.js
  payment-config.js
  public/
  data/
```

## Site A `.env`

Start from the root `.env.example`:

```env
PORT=3000
APP_BASE_URL=http://127.0.0.1:3000
SITE_B_BASE_URL=http://127.0.0.1:4000
PAYSTACK_CURRENCY=GHS
SITE_A_TO_SITE_B_SECRET=the_same_site_a_to_site_b_secret_used_by_site_b
SITE_B_TO_SITE_A_SECRET=the_same_site_b_to_site_a_secret_used_by_site_b
PAYMENT_SESSION_MINUTES=15
PHANTOM_DATA_FILE=./data/phantom-cards.json
```

Keep the existing Site A admin settings in this file too. Site A must not contain
`PAYSTACK_SECRET_KEY` or `PAYSTACK_API_BASE_URL`.

## Site B `.env`

Copy `payment-service/.env.example` to `payment-service/.env`:

```env
PORT=4000
SITE_B_BASE_URL=http://127.0.0.1:4000
SITE_A_BASE_URL=http://127.0.0.1:3000
SITE_A_TO_SITE_B_SECRET=the_exact_same_value_as_site_a
SITE_B_TO_SITE_A_SECRET=the_exact_same_value_as_site_a
PAYSTACK_SECRET_KEY=your_paystack_test_or_live_secret
PAYSTACK_API_BASE_URL=https://api.paystack.co
PAYSTACK_CURRENCY=GHS
PAYMENT_DATA_FILE=./data/payment-service.json
DATA_BUNDLE_DATA_FILE=./data/data-bundles.json
DATA_BUNDLE_PAYMENT_EMAIL=your_paystack_approved_receipt_email
DATA_BUNDLE_ADMIN_TOKEN=your_private_manual_fulfillment_token
```

Only Site B receives the Paystack secret and Paystack API base URL. Keep `.env` files
private and do not commit them.

## Run locally

Terminal 1, from the Phantom Cards root:

```bash
npm run dev
```

Terminal 2, from the independent Site B directory:

```bash
cd payment-service
npm run dev
```

The two services communicate over:

```text
Site A → POST /api/v1/payments/initialize → Site B
Browser → Site B GET /payment/handoff?token=<opaque-token> → Paystack
Site B → POST /api/v1/webhooks/payment-status → Site A
Paystack → POST /api/v1/webhooks/paystack → Site B
```

Site B's initialization response for Site A payments must contain:

```json
{
  "transactionId": "<site-b-transaction-id>",
  "handoffUrl": "https://data.example.com/payment/handoff?token=<opaque-token>",
  "expiresAt": "<iso-expiration>"
}
```

Site A requires an absolute handoff URL with the exact configured Site B origin,
the `/payment/handoff` path, one opaque `token` query parameter, and HTTPS in
production. Site A fails closed when `handoffUrl` is missing or invalid and does
not fall back to a legacy `authorizationUrl` field.

## Production URLs

Replace the local URLs in both `.env` files with the deployed HTTPS origins:

```env
# Site A
APP_BASE_URL=https://cards.example.com
SITE_B_BASE_URL=https://data.example.com

# Site B
SITE_A_BASE_URL=https://cards.example.com
SITE_B_BASE_URL=https://data.example.com
```

Configure Paystack's webhook URL as:

```text
https://data.example.com/api/v1/webhooks/paystack
```

Paystack's callback URL is generated from Site B's `SITE_B_BASE_URL`. Site B's
handoff endpoint must look up the opaque token privately, reject unknown,
expired, completed, or invalid tokens, and redirect only to the stored Paystack
authorization URL. It must not accept a browser-supplied destination or expose
Site A identifiers in the handoff URL. The endpoint should send `Cache-Control:
no-store` and a restrictive `Referrer-Policy`; both origins must be publicly
reachable over HTTPS in production.
