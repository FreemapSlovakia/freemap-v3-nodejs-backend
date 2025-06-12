export function getEnv(variable: string): string;
export function getEnv(variable: string, dflt: string): string | string;
export function getEnv(variable: string, dflt?: string): string | undefined {
  if (variable in process.env) {
    return process.env[variable];
  }

  if (typeof dflt === 'string') {
    return dflt;
  }

  throw new Error(`no such env variable defined: ${variable}`);
}

export function getEnvBoolean(variable: string): boolean;
export function getEnvBoolean(variable: string, dflt: boolean): boolean;
export function getEnvBoolean(
  variable: string,
  dflt?: boolean,
): boolean | undefined {
  if (variable in process.env) {
    const value = process.env[variable];

    return value === '1' || value === 'true' || value === 'yes';
  }

  if (typeof dflt === 'boolean') {
    return dflt;
  }

  throw new Error(`no such env variable defined: ${variable}`);
}

export function getEnvInteger(variable: string): number;
export function getEnvInteger(variable: string, dflt: number): number;
export function getEnvInteger(
  variable: string,
  dflt?: number,
): number | undefined {
  if (variable in process.env) {
    const value = parseInt(process.env[variable] ?? '', 10);

    if (isNaN(value)) {
      throw new Error(`env variable ${variable} is not a valid integer`);
    }

    return value;
  }

  if (typeof dflt === 'number') {
    return dflt;
  }

  throw new Error(`no such env variable defined: ${variable}`);
}
