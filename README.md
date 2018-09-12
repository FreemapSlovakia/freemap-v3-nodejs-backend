# Freemap 3 API

API server for next freemap webapp.

## Requirements

* Node 8
* MySQL Database Server
* exiftran (for uploaded images processing)
* gdal_translate (for geotiff to HGT conversion)

## Running in development mode

Please create `config/development.json` configuration. It will inherint from `config/default.json`.

```bash
npm i
npm run watch | npx bunyan
```

## Running in production mode

Please create `config/production.json` configuration. It will inherint from `config/default.json`.

```bash
npm i
NODE_ENV=production npm start | npx bunyan
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
