import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestError } from '../http.js';
import { checkUiAccess, rawHeaderValues, safeEqual, uiHeaders } from './browser-access.js';

/** The engine owns atomic validation and sanitized, bounded snapshots. */
export interface ProxyManagement {
  snapshot(): unknown;
  updatePolicy(config: unknown): void;
}

const MAX_POLICY_BYTES = 256 * 1024;

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { ...uiHeaders(), 'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readPolicy(req: IncomingMessage): Promise<Buffer> {
  if (Number(req.headers['content-length']) > MAX_POLICY_BYTES) {
    req.resume();
    return Promise.reject(new RequestError(413, `Policy exceeds ${MAX_POLICY_BYTES} bytes.`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData); req.off('end', onEnd);
      req.off('error', onError); req.off('aborted', onAborted);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_POLICY_BYTES) {
        cleanup(); chunks.length = 0; req.resume();
        reject(new RequestError(413, `Policy exceeds ${MAX_POLICY_BYTES} bytes.`));
      } else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    const onError = () => { cleanup(); reject(new RequestError(400, 'Request body was interrupted.')); };
    const onAborted = () => onError();
    req.on('data', onData); req.once('end', onEnd);
    req.once('error', onError); req.once('aborted', onAborted);
  });
}

/** Serve exactly /proxy and /proxy/api; create one management token per server. */
export function createProxyManagementUi(proxy: ProxyManagement):
  (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean> {
  const token = randomBytes(32).toString('base64url');
  const page = readFileSync(new URL('./shared/assets/proxy.html', import.meta.url), 'utf8');
  return async (req, res, path) => {
    if (path !== '/proxy' && path !== '/proxy/api') return false;
    try {
      const allowed = path === '/proxy' ? ['GET'] : ['GET', 'PUT'];
      if (!allowed.includes(req.method ?? '')) {
        res.setHeader('allow', allowed.join(', '));
        throw new RequestError(405, `Use ${allowed.join(' or ')} for ${path}.`);
      }
      checkUiAccess(req);
      if (path === '/proxy') {
        const nonce = randomBytes(24).toString('base64url');
        const values: Record<string, string> = { __NONCE__: nonce, __TOKEN__: token };
        const body = page.replace(/__NONCE__|__TOKEN__/g, marker => values[marker]);
        res.writeHead(200, { ...uiHeaders(), 'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(body), 'cross-origin-opener-policy': 'same-origin',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
        res.end(body);
        return true;
      }
      const supplied = rawHeaderValues(req, 'x-proxy-token');
      if (supplied.length !== 1 || !safeEqual(supplied[0], token)) {
        throw new RequestError(403, 'The proxy management token is required.');
      }
      if (req.method === 'PUT') {
        if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          throw new RequestError(415, 'Content-Type must be application/json.');
        }
        if (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') {
          throw new RequestError(415, 'Compressed request bodies are not supported.');
        }
        const body = await readPolicy(req);
        let config: unknown;
        try {
          config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body), (_key, value: unknown) => {
            if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nonfinite JSON');
            return value;
          });
          if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('Not an object');
        } catch {
          throw new RequestError(400, 'The policy must be a valid UTF-8 JSON object.');
        }
        try {
          // Synchronous engine validation preserves the previous policy on error.
          proxy.updatePolicy(config);
        } catch {
          // Validation errors may contain host secrets or attacker-supplied text.
          throw new RequestError(400, 'Policy rejected; the current policy is unchanged. Check policy fields, allowed origins, and host secret environment variable names. Changing guestEnv requires a restart.');
        }
      }
      json(res, 200, proxy.snapshot());
    } catch (error) {
      json(res, error instanceof RequestError ? error.statusCode : 500,
        { error: error instanceof RequestError ? error.message : 'Proxy management request failed.' });
    } finally {
      if (!req.complete && !req.destroyed) req.resume();
    }
    return true;
  };
}
