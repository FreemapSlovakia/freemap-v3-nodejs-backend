// Development: `.env`, if there is one, over the shell's environment. Node's
// --env-file and process.loadEnvFile let the shell win.

import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

try {
  Object.assign(process.env, parseEnv(readFileSync('.env', 'utf8')));
} catch (err) {
  if (err.code !== 'ENOENT') {
    throw err;
  }
}
