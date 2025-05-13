import crypto from 'node:crypto';
import OAuth from 'oauth-1.0a';
import { getEnv } from './env.js';

export const garminOauth = new OAuth({
  consumer: {
    key: getEnv('GARMIN_OAUTH_CONSUMER_KEY')!,
    secret: getEnv('GARMIN_OAUTH_CONSUMER_SECRET')!,
  },
  signature_method: 'HMAC-SHA1',
  hash_function(base_string, key) {
    return crypto.createHmac('sha1', key).update(base_string).digest('base64');
  },
});
