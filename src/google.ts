import config from 'config';
import { OAuth2Client } from 'google-auth-library';

const clientId = config.get('google.clientId') as string;
const clientSecret = config.get('google.clientSecret') as string;

export default new OAuth2Client(clientId, clientSecret, '');
