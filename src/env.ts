export function getEnv(variable: string, dflt?: string) {
  if (variable in process.env) {
    return process.env[variable];
  }

  if (arguments.length >= 2) {
    return dflt;
  }

  throw new Error(`no such env variable defined: ${variable}`);
}
