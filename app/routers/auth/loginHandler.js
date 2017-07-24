
const request = require('request');
const qs = require('querystring');

request.post(
  {
    url: 'http://www.openstreetmap.org/oauth/request_token',
    oauth: {
      callback: 'http://mysite.com/callback/',
      consumer_key: 'XsCiIfvjfhS6iBNR30H29ymmgRYAb3j98kjOyCUu',
      consumer_secret: 'eASOhF36wPcsRXPMS7baat26KCX2TsL2UHK7qAWV',
    },
  },
  (e, r, body) => {
    const reqData = qs.parse(body);

    console.log(reqData);
    console.log(`http://www.openstreetmap.org/oauth/authorize?${qs.stringify({ oauth_token: reqData.oauth_token })}`);
  },
);

request.post(
  {
    url: 'http://www.openstreetmap.org/oauth/access_token',
    oauth: {
      consumer_key: 'XsCiIfvjfhS6iBNR30H29ymmgRYAb3j98kjOyCUu',
      consumer_secret: 'eASOhF36wPcsRXPMS7baat26KCX2TsL2UHK7qAWV',
      token: 'wQLq4546d8Bl6agAxEI5YKGaRNloP6HEfEIy9iiT',
      token_secret: 'SGcgegjLLnHbQiRqyNfGUFTOcNnkLzIK2zLUAcDH',
      verifier: 'uq3mEBCxwRxwYb9WjmT6',
    },
  },
  (e, r, body) => {
    const permData = qs.parse(body);
    console.log(permData);
  }
);

request.get(
  {
    url: 'http://api.openstreetmap.org/api/0.6/user/details',
    oauth: {
      consumer_key: 'XsCiIfvjfhS6iBNR30H29ymmgRYAb3j98kjOyCUu',
      consumer_secret: 'eASOhF36wPcsRXPMS7baat26KCX2TsL2UHK7qAWV',
      token: 'LPS1OTaMpmTucbsX6IxPPevQN1GZd3WSDHpgm121',
      token_secret: 'H7DwhDJCJVZLkHiuQtTwfEPvzKeGNOdR6GpHdgSy',
    },
  },
  (e, r, body) => {
   console.log('bbbbbbbbbbbbbb', body);
  },
);
