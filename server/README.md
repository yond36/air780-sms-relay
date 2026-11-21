# Server: Cloudflare Worker, D1, and admin UI

This directory contains the Worker, browser admin console, SQL migrations, and local tests for the SMS relay.

## Requirements

- Node.js 22 or newer.
- A Cloudflare account and a D1 database for remote deployment.

## Local development

Create local-only configuration files from the examples. Fill the account/D1/rate-limit placeholders in `wrangler.toml`, and use only a local test password and random application secret in `.dev.vars`.

```sh
npm ci
cp .dev.vars.example .dev.vars
cp wrangler.example.toml wrangler.toml
npx wrangler d1 migrations apply air780-sms-relay-data --local
npm run dev
```

Open `http://127.0.0.1:8787/`; the health endpoint is `/api/v1/health`. Never use a production credential or a real SIM for local testing.

Run the full server suite with `npm test`. The focused migration test is `node --test test/migration-sql.test.js`; tests use in-memory SQLite/Miniflare and synthetic credentials.

The isolated browser harness `node scripts/verify-ws-gui.mjs` starts a local-only Miniflare environment with simulated WSS devices and blocks external channel delivery.

## Deploy your own service

Create a D1 database in your own Cloudflare account, update the local `wrangler.toml` placeholders, then configure secrets through Wrangler (never commit secret values):

```sh
npx wrangler d1 migrations apply air780-sms-relay-data --remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put APP_SECRET
npm run deploy
```

Keep the same D1 database and `APP_SECRET` across updates; changing the app secret prevents decryption of existing channel configuration. Review pending D1 migrations before applying them. Do not run destructive cleanup as part of a normal deployment.

## Retention contract

The admin UI accepts SMS retention days `0–90`; `0` means permanent history. Events remain `1–90` days. The API returns `0` for permanent SMS retention and continues accepting legacy `null`; D1 stores permanent policy and expiry as SQL `NULL`. Saving a policy never runs manual cleanup. Expired cleanup waits for records to reach the current policy revision; explicit, previewed `before`/`all` cleanup can still remove permanent history. In-flight commands stay protected and their execution TTL is independent of history retention.

The device status badge reflects WSS session liveness, separate from cellular registration and last business-event time. An alarm checks auto-answered WSS heartbeat freshness every minute; expired sessions are marked offline without changing credentials, command-session authority, event history, or SMS state. Alarm dispatch timing is platform-scheduled rather than a hard real-time SLA.
