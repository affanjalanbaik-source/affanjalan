# AFFANJALANBAIK storefront deployment and media notes

## Run the application

This project requires the Node/Express server; GitHub Pages serves only static files and cannot provide its API, admin sessions, uploads, PayPal verification, SQLite persistence, or private download delivery. Use Node.js 22.13 or newer, run `npm install`, configure `.env` from `.env.example`, then use `npm start`.

## Preview audio versus masters

- Upload only a short, watermarked/approved preview clip (MP3, WAV, OGG, M4A, AAC, or FLAC up to the configured upload limit) through Admin → Products → Add/Edit beat → Audio preview.
- Preview files are stored under `PREVIEW_DIR` (default `./previews`) and catalog URLs are stored on the beat row. The preload gateway serves catalog-listed preview clips with byte-range support, which is needed for seeking and mobile browser playback. It does not expose a download control.
- Keep full-quality masters and stems under `PRIVATE_BEAT_DIR` (default `./private-beats`), outside the public web root. They are never used as preview sources. For production, use durable private storage with backups and restrict filesystem access to the application account.
- No preview is generated automatically. Until an actual clip is uploaded, the storefront explicitly reports preview unavailable.

## First preview upload

1. Configure `ADMIN_USERNAME` and a strong `ADMIN_PASSWORD` in the server environment, then restart the Node server.
2. Open `https://<your-app-host>/admin` (or `http://localhost:3000/admin` locally) and sign in.
3. Choose **Add beat**, enter the title, genre, BPM, key, and license prices, then select an actual preview audio clip in **Audio preview**. Choose a preview—not the full-quality master.
4. Save the beat. The upload is stored by the server, its `/previews/...` URL is saved to the beat record, and the storefront catalog provides the source to the custom player.
5. Visit the storefront and tap **Play preview**. Verify load, play/pause, seek, duration, and unavailable/error messages. Real playback cannot be asserted until you upload and test an actual file.

## Production configuration still required

- Deploy the Node server on HTTPS with writable durable storage for SQLite, `PREVIEW_DIR`, and `PRIVATE_BEAT_DIR`; do not deploy the marketplace only on GitHub Pages.
- Set a strong `SESSION_SECRET`, owner-only admin credentials, exact `PUBLIC_ORIGIN`, and secure cookie configuration at the HTTPS host/reverse proxy.
- Add PayPal Sandbox Client ID and Secret in the host secret manager and conduct end-to-end Sandbox verification. Never put the secret in frontend code.
- Register the PayPal webhook and set `PAYPAL_WEBHOOK_ID` after the webhook endpoint is implemented/configured for your deployment.
- Add real beat preview files and private purchased delivery assets; no sample audio or download asset is bundled.
- Confirm seller account eligibility, license terms, tax/privacy obligations, retention/backups, and support/refund processes before production.
