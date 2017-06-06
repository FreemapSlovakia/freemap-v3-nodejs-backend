# Freemap 3 API

Part of backend for Freemap v3 written in node.js

## Requirements

* Node 8

## Running in development mode

```
sudo npm i -g bunyan
npm i
npm run watch | bunyan
```

## Running in production mode

```
sudo npm i -g bunyan
npm i
NODE_ENV=production npm start | bunyan
```

## Running tests

```
sudo npm install -g mocha
npm i
mocha test/
```

running single test:

```
mocha test -g "POST /tracklogs should return uid"
```