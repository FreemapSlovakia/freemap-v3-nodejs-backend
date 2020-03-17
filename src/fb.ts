import { Facebook } from 'fb';
import { getEnv } from './env';

export const fb = new Facebook({ appSecret: getEnv('FACEBOOK_APP_SECRET') });
