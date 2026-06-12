# Freemap 3 API

Backend API server for the [Freemap](https://www.freemap.sk) web map application. It is a [Koa](https://koajs.com/)-based HTTP (and WebSocket) server backed by MariaDB that powers the features of the [frontend SPA](https://github.com/FreemapSlovakia/freemap-v3-react): user accounts and OAuth login, the photo gallery, GPS live tracking, saved (personal) maps, the elevation/profile service, offline map (`.mbtiles`) downloads, and premium/credit purchases.

## Requirements

- Node 22+
- pnpm
- MariaDB Database Server
- exiftran (for uploaded images processing)

## Database setup

The application stores user accounts, photos metadata, tracking data, user maps,
purchases and auth tokens in MariaDB. All tables (and migrations) are created
automatically on startup by `initDatabase()` in [src/database.ts](src/database.ts);
you only need to provide an empty database and a user with privileges to create
and alter tables.

```sql
CREATE DATABASE freemap CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'freemap'@'localhost' IDENTIFIED BY 'freemap';
GRANT ALL PRIVILEGES ON freemap.* TO 'freemap'@'localhost';
FLUSH PRIVILEGES;
```

The `picture` table has triggers that look up a country code from a `country`
table (populated externally from OSM administrative boundaries). The triggers
silently set `country = NULL` if the table is missing, so it is optional for
local development.

Connection settings are read from the `MARIADB_*` environment variables (see
below).

## Running in development mode

Provide settings in environment variables or put them to `.env` file in project
root directory.

```sh
pnpm install
pnpm run dev
```

This rebuilds on file changes via `tsc-watch` and restarts the server through
`dotenvx`, piping logs through `pino-pretty`.

## Running in production mode

Provide settings in environment variables. Then:

```sh
pnpm install
pnpm run build
pnpm start | pnpm exec pino-pretty
```

## Environment variables

### HTTP server

- `HTTP_HOSTNAME` — bind address for plain HTTP (default `127.0.0.1`).
- `HTTP_PORT` — plain HTTP port; set to `0` or leave unset to disable.
- `HTTPS_HOSTNAME` — bind address for HTTPS (default `127.0.0.1`).
- `HTTPS_PORT` — HTTPS port; set to `0` or leave unset to disable.
- `HTTP_SSL_CERT` — path to the TLS certificate file (required if HTTPS is enabled).
- `HTTP_SSL_KEY` — path to the TLS private key file (required if HTTPS is enabled).
- `WEB_BASE_URL` — comma-separated list of allowed web frontend origins; the
  first entry is used when generating absolute links (e.g. in emails).

### MariaDB

- `MARIADB_HOST` — database host.
- `MARIADB_PORT` — database port (default `3306`).
- `MARIADB_DATABASE` — database name.
- `MARIADB_USER` — database user.
- `MARIADB_PASSWORD` — database password.
- `MARIADB_CONNECTION_LIMIT` — connection pool size (default `10`).

### File storage

- `PICTURES_DIRECTORY` — directory where uploaded gallery pictures are stored.
- `TRACKLOGS_DIRECTORY` — directory where uploaded GPX track logs are stored.
- `ELEVATION_DATA_DIRECTORY` — directory containing HGT elevation tiles used by
  the elevation/profile endpoints.

### Map tiles

- `MBTILES_DIR` — directory containing pre-generated `.mbtiles` files served as
  downloadable offline maps.
- `MBTILES_URL_PREFIX` — public URL prefix under which `.mbtiles` files are
  exposed for download.

### Authentication

- `OSM_OAUTH2_CLIENT_ID` — OAuth 2.0 client ID registered with OpenStreetMap.
- `OSM_OAUTH2_CLIENT_SECRET` — OAuth 2.0 client secret for OpenStreetMap.
- `GARMIN_OAUTH_CONSUMER_KEY` — OAuth 1.0a consumer key for Garmin Connect.
- `GARMIN_OAUTH_CONSUMER_SECRET` — OAuth 1.0a consumer secret for Garmin Connect.

### Mailgun (transactional email)

- `MAILGUN_ENABLE` — `true` to actually send emails; otherwise emails are skipped.
- `MAILGUN_API_KEY` — Mailgun API key.
- `MAILGUN_DOMAIN` — Mailgun sending domain.
- `MAILGUN_EU` — `true` to use the EU Mailgun region (`api.eu.mailgun.net`),
  otherwise the US region is used.

### Purchases (Rovas)

- `PURCHASE_URL_PREFIX` — base URL of the Rovas payment page; the user is
  redirected here to complete a purchase.
- `PURCHASE_SECRET` — HMAC-SHA256 shared secret used to sign purchase tokens
  and verify Rovas webhook signatures.
- `PURCHASE_WEBHOOK_MAX_AGE_SEC` — reject webhooks older than this many seconds
  (default `1209600`, i.e. 14 days; set to `0` to disable the staleness check).
- `PURCHASE_WEBHOOK_MAX_FUTURE_SKEW_SEC` — reject webhooks whose `occurred_at`
  is more than this many seconds in the future (default `600`).
- `PREMIUM_PHOTO_SECRET` — HMAC secret used to sign access URLs for premium
  (paid) photos.

### Purchases (Polar)

Polar ([polar.sh](https://polar.sh)) runs in parallel with the legacy Rovas
flow during migration. Premium is pay-what-you-want (minimum €8) and the user
chooses a one-time year or an auto-renewing yearly subscription; credits are
one-time custom-amount top-ups (1 credit = €0.01, minimum 500). The new flow is
limited to an allowlist of users until the migration is complete.

- `POLAR_ACCESS_TOKEN` — Polar Organization Access Token (`polar_oat_…`).
- `POLAR_SERVER` — `sandbox` or `production` (default `sandbox`).
- `POLAR_PREMIUM_RECURRING_PRODUCT_ID` — product ID of the auto-renewing yearly
  premium subscription (custom amount, min €8).
- `POLAR_PREMIUM_ONETIME_PRODUCT_ID` — product ID of the one-time one-year
  premium (custom amount, min €8).
- `POLAR_CREDITS_PRODUCT_ID` — Polar product ID of the custom-amount credits
  product.
- `POLAR_WEBHOOK_SECRET` — secret of the Polar webhook endpoint (Standard
  Webhooks signature). Set on the endpoint that points at `/auth/polar/webhook`.
- `POLAR_ENABLED_USER_IDS` — comma-separated list of user IDs allowed to use the
  Polar flow. Others get `403` from `/auth/polar/checkout` and keep using Rovas.

Endpoints: `POST /auth/polar/checkout` (auth required, allowlisted) returns a
hosted `checkoutUrl` to redirect the user to; `POST /auth/polar/webhook`
provisions `premiumExpiration` (from subscription events) and `credits` (from
`order.paid`). The webhook needs the raw request body, which is why `koa-body`
is configured with `includeUnparsed`.

### Tracking

- `TRACKING_SOCKET_PORT` — TCP port for the raw GPS tracker socket; set to `0`
  or leave unset to disable.

# Rovas callback tunneling

```sh
ssh -N -R 0.0.0.0:17744:localhost:3001 fm3
```
