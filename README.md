# Freemap 3 API

Backend API server for the [Freemap](https://www.freemap.sk) web map application. It is a [Koa](https://koajs.com/)-based HTTP (and WebSocket) server backed by MariaDB that powers the features of the [frontend SPA](https://github.com/FreemapSlovakia/freemap-v3-react): user accounts and OAuth login, the photo gallery, GPS live tracking, saved (personal) maps, the elevation/profile service, offline map (`.mbtiles`) downloads, and premium/credit purchases.

## Requirements

- Node 22+
- pnpm
- MariaDB Database Server
- exiftran (for lossless rotation of uploaded JPEGs)
- ImageMagick with HEIF support (for converting uploaded HEIF/HEIC photos to JPEG)

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

A `country` table (`alpha2` plus a `geom` polygon, populated externally from
OSM administrative boundaries) is required — it is not created by
`initDatabase()`. The `picture` triggers look up each photo's country code in
it, and `POST /geotools/covered-countries` queries it directly; without the
table both fail with `Table 'country' doesn't exist`.

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
- `ELEVATION_SOURCES` — optional, premium-only high-precision elevation rasters
  tried before the global fallback, in priority order (first match wins).
  Semicolon-separated list of `name:path:minLon,minLat,maxLon,maxLat`, e.g.
  `sk:/data/dmr5.tif:16.8,47.7,22.6,49.7`. Paths must not contain colons, and
  the bbox is WGS84 lon/lat regardless of the raster's own CRS.

  `name` is reported by `/geotools/elevation?sources=1` and the frontend
  resolves it to a data attribution, so it is an API contract, not a label:
  use the lowercase ISO 3166-1 alpha-2 code of the country the model covers
  (`sk`, `at`, …), or the model's own id for one that isn't country-scoped
  (`gedtm30`). Several entries may share a name — the reported list is
  deduplicated. An unrecognised name is still credited, but only under the
  bare token, so keep names stable across file renames or re-projections. See
  `elevationSourcesFromTokens` in the frontend for the resolution rules.

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
one-time custom-amount top-ups (1 credit = €0.01, minimum 500).

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

Endpoints: `POST /auth/polar/checkout` (auth required) returns a hosted
`checkoutUrl` to redirect the user to; `POST /auth/polar/webhook` provisions
`premiumExpiration` (from subscription events) and `credits` (from
`order.paid`). The webhook needs the raw request body, which is why `koa-body`
is configured with `includeUnparsed`.

A user who already has a subscription gets `409` instead of a second one — an
extra subscription would be silent, because it starts as a trial as long as the
premium they already have (see below). A card that stopped working is fixed in
the Polar customer portal; once a subscription really ends, `subscription.revoked`
clears the stored ID and a new one can be bought.

#### Price increase

The yearly premium price rises from €8 to €15 for new customers on 1 September
2026. The switch is manual: point `POLAR_PREMIUM_RECURRING_PRODUCT_ID` and
`POLAR_PREMIUM_ONETIME_PRODUCT_ID` at the €15 products on that day (and drop
the announcement in the frontend). A running subscription keeps the price it was
created with — Polar grandfathers it — so nothing has to be migrated.

Someone holding a one-time year has no such protection, so until that day the
app offers them the switch to a subscription at the current price. A yearly
subscription starts as a trial as long as the premium the user already has, so
the periods don't overlap and nobody pays for the same days twice; Polar takes a
trial as an interval and a count, not as an absolute end date. The trial is
capped at two years, so someone who stacked more one-time years than that does
overlap for the excess — it is logged when it happens.

### Tracking

- `TRACKING_SOCKET_PORT` — TCP port for the raw GPS tracker socket; set to `0`
  or leave unset to disable.

# Rovas callback tunneling

```sh
ssh -N -R 0.0.0.0:17744:localhost:3001 fm3
```
