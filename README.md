# Freemap 3 API

API server for next freemap webapp.

## Requirements

- Node 22+
- MariaDB Database Server
- exiftran (for uploaded images processing)
- gdal_translate (for geotiff to HGT conversion)

## Running in development mode

Please provide settings in environment variables or put them to `.env` file in project root directory.

```sh
npm i
npm run watch
```

## Running in production mode

Please provide settings in environment variables. Then:

```sh
npm i
npm run build
npm start | npx pino-pretty
```

We strongly recommend to use `forever` command (installed with `npm i -g forever`).

## Running tests

```sh
npm i
npx mocha test/
```

Running single test:

```sh
./node_modules/.bin/mochamocha test -g "POST /tracklogs should return uid"
```

## Environment variables

- `ELEVATION_DATA_DIRECTORY` - TODO
- `FACEBOOK_APP_SECRET` - TODO
- `GARMIN_OAUTH_CONSUMER_KEY` - TODO
- `GARMIN_OAUTH_CONSUMER_SECRET` - TODO
- `GOOGLE_CLIENT_ID` - TODO
- `GOOGLE_CLIENT_SECRET` - TODO
- `HTTPS_PORT` - TODO
- `HTTP_PORT` - TODO
- `HTTP_SSL_CERT` - TODO
- `HTTP_SSL_KEY` - TODO
- `MAILGIN_API_KEY` - TODO
- `MAILGIN_DOMAIN` - TODO
- `MAILGIN_ENABLE` - TODO
- `MARIADB_DATABASE` - TODO
- `MARIADB_HOST` - TODO
- `MARIADB_PASSWORD` - TODO
- `MARIADB_PORT` - TODO
- `MARIADB_USER` - TODO
- `OAUTH_CONSUMER_KEY` - TODO
- `OAUTH_CONSUMER_SECRET` - TODO
- `OSM_OAUTH2_CLIENT_ID` - TODO
- `OSM_OAUTH2_CLIENT_SECRET` - TODO
- `PICTURES_DIRECTORY` - TODO
- `PURCHASE_SECRET` - TODO
- `PURCHASE_URL_PREFIX` - TODO
- `TRACKING_SOCKET_PORT` - TODO
- `TRACKLOGS_DIRECTORY` - TODO
- `URS_EARTHDATA_NASA_PASSWORD` - TODO
- `URS_EARTHDATA_NASA_USERNAME` - TODO
- `WEB_BASE_URL` - TODO

# Rovas callback tunneling

```sh
ssh -N -R 0.0.0.0:17744:localhost:3001 fm4
```
