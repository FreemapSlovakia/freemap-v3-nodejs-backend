import { Facebook } from 'fb';
import config from 'config';

export const fb = new Facebook({ appSecret: config.get('facebook.appSecret') });
