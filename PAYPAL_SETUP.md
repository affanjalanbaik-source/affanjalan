# PayPal Checkout setup (sandbox-first)

The repository is a static HTML prototype. PayPal requires a trusted server to keep the Client Secret private, validate current catalog prices, capture orders, and authorize digital delivery. This setup adds a Node.js/SQLite backend and injects a small checkout client into the existing `index.html` without changing the visual design.

## Important account eligibility

The owner must independently confirm that their Indonesian PayPal account can receive commercial payments for digital goods and can use the required Checkout / Orders API features. PayPal feature availability depends on account country, account status, product, and underwriting. Complete PayPal identity/business verification and follow PayPal's applicable Indonesian requirements. Do not represent an unverified Personal account as eligible or bypass verification. No account is created or paid service purchased by this project. Check current PayPal documentation and the PayPal account dashboard before production; there is no guarantee of eligibility.

## Local sandbox setup

1. Install Node.js 22.13+ and run `npm install`.
2. Copy `.env.example` to `.env` and set sandbox `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from the PayPal Developer Dashboard. Keep `.env` private.
3. Set `PUBLIC_ORIGIN` to the origin you use, e.g. `http://localhost:3000`.
4. Add approved private delivery files beneath `private-beats/` and map them in `server.js` `DELIVERY_FILES`. Files remain outside the public static directory.
5. Run `npm start` and open `http://localhost:3000`.

The browser receives only the public Client ID and USD SDK configuration. The backend creates an order from allow-listed beat/license IDs and server-held prices, validates USD and exact amounts, captures through PayPal Orders v2, and marks the local order paid only after checking the returned capture status, currency, amount, and PayPal order ID. The capture operation is idempotent for a locally paid order. A download token is issued only after verified payment and only for configured private files.

## Catalog and licensing

The backend has its own server-side catalog in `server.js`; never take prices or license rights from the browser. Confirm the sample USD prices and actual license terms with the owner before production. Exclusive licenses are inquiry-only and cannot be purchased through this demo. Currently the demo has no real beat delivery assets; until the owner maps real approved files in `DELIVERY_FILES`, a paid order will not expose any file. Do not add files to a public folder.

## Webhooks

Configure a PayPal webhook to the public HTTPS endpoint `/api/paypal/webhook`, then set the webhook ID in `PAYPAL_WEBHOOK_ID`. The server asks PayPal to verify the signature before accepting relevant events. Webhook delivery is additional reconciliation; it does not authorize file access on its own. Test with sandbox events before production.

## Production checklist

- Use an eligible, verified Indonesian PayPal merchant account and production credentials only after sandbox tests pass.
- Deploy this Node server on a trusted HTTPS host; GitHub Pages alone cannot run these backend routes. Configure environment variables in the host's secret manager.
- Set `PUBLIC_ORIGIN` to the exact HTTPS origin. Use durable, backed-up storage for SQLite or replace it with a managed database before scaling horizontally.
- Set up a registered webhook and verify its signature.
- Confirm seller account, currency settlement/conversion, prohibited/restricted business rules, refund process, applicable tax/data/privacy obligations, license terms, and digital goods availability with PayPal and local advisers.
- Test order creation, approval, capture, declined/cancelled flows, duplicated capture calls, webhook verification, restart persistence, and successful private delivery in Sandbox.
- Keep `PAYPAL_ENV=sandbox` until the owner explicitly approves live activation after successful testing. No live credentials are configured here.

This prototype collects the customer's name and email for PayPal order context but does not store them locally. Add a privacy notice and retention policy before production if persistence is introduced.
