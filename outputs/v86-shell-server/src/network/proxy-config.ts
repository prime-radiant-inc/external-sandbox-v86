import { open } from 'node:fs/promises';
import { compileProxyPolicy, type ProxyPolicy } from './proxy-policy.js';

/** Read host configuration without reflecting its contents in startup errors. */
export async function loadProxyPolicy(
  file: string, secrets: Record<string, string | undefined> = process.env,
): Promise<ProxyPolicy> {
  const handle = await open(file, 'r');
  let value: unknown;
  try {
    const buffer = Buffer.alloc(256 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 256 * 1024) throw new Error('Proxy configuration must not exceed 256 KiB');
    try { value = JSON.parse(buffer.subarray(0, length).toString('utf8')); }
    catch { throw new Error('Invalid proxy configuration JSON'); }
  } finally { await handle.close(); }
  return compileProxyPolicy(value, secrets);
}
