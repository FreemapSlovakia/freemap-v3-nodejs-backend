import { Facebook } from 'fb';
import config from 'config';

export default new Facebook({ appSecret: config.get('facebook.appSecret') });
