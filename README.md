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
- `ELEVATION_DIR` — optional, root of the premium-only high-precision elevation
  rasters tried before the global fallback. One subdirectory per source,
  consulted in the order the directory names sort, so a numeric prefix sets
  priority the way `rc.d` does:

  ```
  elevation-sources/010-sk/source.json
                    250-sonny-de/source.json
                    330-gedtm30/source.json
  ```

  A subdirectory counts as a source only if it holds a `source.json`; anything
  else is ignored, so a half-finished download cannot silently change what the
  API serves. A malformed one is skipped with a warning rather than failing
  startup.

  ```json
  {
    "name": "sonny",
    "file": "/fm/storage1/dtm/sonny/de/de.tif",
    "attributions": [
      { "name": "Sonny's LiDAR DTM (CC BY 4.0)", "url": "https://sonny.4lima.de/" }
    ]
  }
  ```

  - `name` (required) is reported by `/geotools/elevation?sources=1`, so it is
    an API contract, not a label: use the lowercase ISO 3166-1 alpha-2 code of
    the country the model covers (`sk`, `at`, …), or the model's own id for one
    that isn't country-scoped (`gedtm30`, `sonny`). Several sources may share a
    name — the reported list is deduplicated, and their credits are merged.
    Keep names stable across file renames or re-projections.
  - `file` (optional) is the raster, absolute or relative to the directory, so a
    source can point at one that stays where it is. Without it the directory
    must hold `data.vrt` or `data.tif`. `.vrt` and `.tif` are both fine.
  - `attributions` (optional) is how the source wants crediting, served straight
    to clients so a new dataset needs no web or mobile release. A country
    stitched from two licensed datasets carries two entries.
  - `bbox` (optional) pins the WGS84 footprint as `[minLon, minLat, maxLon,
    maxLat]`. Normally omit it: it is derived from the raster on first use, by
    sampling the footprint on a grid and reprojecting — hand-written bboxes fail
    silently in both directions, too small and the source is never consulted,
    too large and every miss costs a pointless read. Pin it only to skip the
    derivation on a source where even that first open is too costly.

  Deriving the bbox is deferred to a source's first use rather than done at
  startup, so boot doesn't wait on every raster. Since the bbox is what the open
  produces, the first request for a point no local source covers walks the whole
  list — once per process.

  Replaces `ELEVATION_SOURCES`, which is no longer read. If that variable is
  still set while `ELEVATION_DIR` is not, startup warns: otherwise every premium
  read would quietly degrade to SRTM.

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
flow during migration. Premium is pay-what-you-want (minimum €15) and the user
chooses a one-time year or an auto-renewing yearly subscription; credits are
one-time custom-amount top-ups (1 credit = €0.01, minimum 500).

- `POLAR_ACCESS_TOKEN` — Polar Organization Access Token (`polar_oat_…`).
- `POLAR_SERVER` — `sandbox` or `production` (default `sandbox`).
- `POLAR_PREMIUM_RECURRING_PRODUCT_ID` — product ID of the auto-renewing yearly
  premium subscription (custom amount, min €15).
- `POLAR_PREMIUM_ONETIME_PRODUCT_ID` — product ID of the one-time one-year
  premium (custom amount, min €15).
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

#### Changing the price

Raise the amount (minimum and preset) on the two existing Polar products; the
env vars stay as they are. Polar grandfathers a running subscription onto the
amount it was created at, so a change only affects new purchases and nothing has
to be migrated: subscriptions bought before 1 September 2026 still renew at €8.
Those renewals must keep provisioning, which is why the `subscription.*` events
don't filter by product and a renewal order is recognized by carrying a
`subscriptionId` rather than by its product ID.

Creating new products and repointing the env vars instead also works — it splits
the two eras in Polar's reporting — but then the old products' orders no longer
match `isPremiumProduct`, leaving only that `subscriptionId` fallback. A
product's pricing type and billing interval are locked after creation, so those
do require a new product.

#### Subscription trial

A yearly subscription starts as a trial as long as the premium the user already
has, so the periods don't overlap and nobody pays for the same days twice; that
is what lets a one-time year be moved to a subscription at any moment. Polar
takes a trial as an interval and a count, not as an absolute end date, and
validates it at 1000 days — so someone who stacked more one-time years than that
does overlap for the excess. It is logged when it happens.

### Tracking

- `TRACKING_SOCKET_PORT` — TCP port for the raw GPS tracker socket; set to `0`
  or leave unset to disable.

### Wikimedia Commons import

- `WIKIMEDIA_GEO_TAGS_DUMP_URL`, `WIKIMEDIA_PAGE_DUMP_URL`,
  `WIKIMEDIA_IMAGE_DUMP_URL`, `WIKIMEDIA_MEDIAINFO_DUMP_URL` — the four Commons
  dumps the import streams. Default to `dumps.wikimedia.org`; point them at a
  mirror to spare it the ~90 GB.
- `WIKIMEDIA_IMPORT_NOTIFY_EMAIL` — comma-separated admins who get the report
  mail after every run. Unset (the default) means no report is sent, so a
  developer checkout never mails anyone; the addresses live in
  `/etc/freemap.conf` on the server rather than in this repository. Also needs
  `MAILGUN_ENABLE=true` and the rest of the Mailgun settings above.
- `WIKIMEDIA_IMPORT_UNIT` — systemd unit named in the report mails' "check the
  log" line. Defaults to `freemap-wikimedia-import.service`.
- `WIKIMEDIA_IMPORT_STREAM_STALL_MS` — socket idle timeout for a dump download,
  after which the pass truncates and retries. Defaults to 30 minutes. Keep it
  generous: the timer also ages while the importer is backpressured on its own
  database inserts, so a tight value makes a busy database re-download tens of
  gigabytes.
- `WIKIMEDIA_IMPORT_RETRY_BUDGET_MS` — how far into a run a failed pass may
  still start a fresh retry, since a retry re-downloads its dump from the
  beginning. Defaults to 7 hours, and is set alongside the matching
  `TimeoutStartSec` in `systemd/freemap-wikimedia-import.service` — the two are
  one invariant and must move together.
- `WIKIMEDIA_IMPORT_BATCH_SIZE`, `WIKIMEDIA_IMPORT_COMMIT_ROWS`,
  `WIKIMEDIA_IMPORT_PAGEID_BATCH` — load-tuning knobs; see the comments on the
  constants in `src/wikimedia/importWikimedia.ts` before changing them.

# Scheduled jobs (systemd)

The Wikimedia Commons photo import runs monthly, off the units in `systemd/`.
They are the reference copies; install and enable them on the API server with:

```sh
sudo cp systemd/freemap-wikimedia-import* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now freemap-wikimedia-import.timer
```

Three units:

- `freemap-wikimedia-import.service` — the import itself, a `oneshot` running
  the built `importWikimedia.js` as `freemap`. Several hours; niced and on idle
  I/O so it does not starve the live API.
- `freemap-wikimedia-import.timer` — fires it on the 8th of each month, a slot
  safely after the monthly Commons dumps finish.
- `freemap-wikimedia-import-abort.service` — `OnFailure=` backstop that mails
  the admins when the import dies without reporting for itself (OOM kill and
  friends). Never started by hand.

The import mails `WIKIMEDIA_IMPORT_NOTIFY_EMAIL` after every run — the live
photo count and how far it moved on success, the error on failure. A failed run
leaves the gallery untouched: the freshly built table is only swapped in at the
very last step.

`enable --now` does **not** import anything — it only starts the timer, and the
first import happens on the next 8th. `Persistent=true` catches up a run missed
while the machine was off, but it has nothing to catch up on the first enable:
systemd creates the timestamp file it compares against at that moment, so the
timer counts as having just fired. (Verified on fm6 — the stamp appears with the
enable and `list-timers` shows `LAST` empty.)

To import now rather than waiting for the 8th, start the service by hand — the
timer is unaffected and carries on from its own schedule:

`--no-block` because the unit is `Type=oneshot`: without it `systemctl` sits
waiting for the whole multi-hour run to finish. (Ctrl-C only stops the waiting;
the unit keeps running under systemd either way.)

```sh
sudo systemctl start --no-block freemap-wikimedia-import.service
journalctl -u freemap-wikimedia-import -f
```

# Rovas callback tunneling

```sh
ssh -N -R 0.0.0.0:17744:localhost:3001 fm3
```
