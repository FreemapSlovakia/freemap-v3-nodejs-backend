# Freemap 3 API

API server for next freemap webapp.

## Requirements

* Node 8
* MySQL Database Server
* exiftran

## Running in development mode

Please create `config/development.json` configuration. It will inherint from `config/default.json`.

```bash
npm i
npm run watch | ./node_modules/.bin/bunyan
```

## Running in production mode

Please create `config/production.json` configuration. It will inherint from `config/default.json`.

```bash
npm i
NODE_ENV=production npm start | ./node_modules/.bin/bunyan
```

We strongly recommend to use `forever` command (installed with `npm i -g forever`).

## Running tests

```bash
npm i
./node_modules/.bin/mocha test/
```

Running single test:

```bash
./node_modules/.bin/mochamocha test -g "POST /tracklogs should return uid"
```
