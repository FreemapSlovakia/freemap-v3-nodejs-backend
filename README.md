# Freemap 3 API

API server for next freemap webapp.

## Requirements

- Node 10+
- MariaDB Database Server
- exiftran (for uploaded images processing)
- gdal_translate (for geotiff to HGT conversion)

## Running in development mode

Please provide settings in environment variables or put them to `.env` file in project root directory.

```bash
npm i
npm run watch | npx bunyan
```

## Running in production mode

Please provide settings in environment variables. Then:

```bash
npm i
npm run build
npm start | npx bunyan
```

We strongly recommend to use `forever` command (installed with `npm i -g forever`).

## Running tests

```bash
npm i
npx mocha test/
```

Running single test:

```bash
./node_modules/.bin/mochamocha test -g "POST /tracklogs should return uid"
```

## Environment variables

- `EARTHEXPLORER_PASSWORD` - TODO
- `EARTHEXPLORER_USERNAME` - TODO
- `ELEVATION_DATA_DIRECTORY` - TODO
- `FACEBOOK_APP_SECRET` - TODO
- `GOOGLE_CLIENT_ID` - TODO
- `GOOGLE_CLIENT_SECRET` - TODO
- `HTTP_PORT` - TODO
- `HTTP_SSL_CERT` - TODO
- `HTTP_SSL_ENABLE` - TODO
- `HTTP_SSL_KEY` - TODO
- `MAILGIN_API_KEY` - TODO
- `MAILGIN_DOMAIN` - TODO
- `MAILGIN_ENABLE` - TODO
- `MARIADB_DATABASE` - TODO
- `MARIADB_HOST` - TODO
- `MARIADB_PASSWORD` - TODO
- `MARIADB_PORT` - TODO
- `MARIADB_USER` - TODO
- `NODE_ENV` - TODO
- `OSM_OAUTH2_CLIENT_ID` - TODO
- `OSM_OAUTH2_CLIENT_SECRET` - TODO
- `OSM_OAUTH2_REDIRECT_URI` - TODO
- `PICTURES_DIRECTORY` - TODO
- `TRACKING_SOCKET_PORT` - TODO
- `TRACKLOGS_DIRECTORY` - TODO
- `WEB_BASE_URL` - TODO
