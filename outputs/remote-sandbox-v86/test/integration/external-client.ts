import path from 'node:path';

/** Explicit opt-in keeps backend tests independent of another checkout. */
export function externalClientPath(name: 'REMOTE_SANDBOX_CLIENT' | 'REMOTE_SANDBOX_PREFIX'): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path to the shared client script.`);
  return value;
}
