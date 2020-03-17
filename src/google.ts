import { OAuth2Client } from 'google-auth-library';
import { getEnv } from './env';

const clientId = getEnv('GOOGLE_CLIENT_ID');

const clientSecret = getEnv('GOOGLE_CLIENT_SECRET');

export const googleClient = new OAuth2Client(clientId, clientSecret, '');
