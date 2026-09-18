import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { RequestError } from '../http.js';

export function rawHeaderValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === name.toLowerCase()) values.push(req.rawHeaders[index + 1]);
  }
  return values;
}

/** Narrow browser exception for the UI; legacy execution endpoints stay Origin-free. */
export function checkUiAccess(req: IncomingMessage): void {
  const hosts = rawHeaderValues(req, 'host');
  const match = hosts.length === 1
    ? /^(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(hosts[0]) : null;
  if (!match || (match[1] !== undefined && (+match[1] < 1 || +match[1] > 65535))) {
    throw new RequestError(403, 'A loopback Host is required.');
  }
  if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
    throw new RequestError(400, 'An absolute-path request target is required.');
  }
  const origins = rawHeaderValues(req, 'origin');
  const scheme = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  if (origins.length && (origins.length !== 1 || origins[0] !== `${scheme}://${hosts[0]}`)) {
    throw new RequestError(403, "Only this page's origin is allowed.");
  }
  const sites = rawHeaderValues(req, 'sec-fetch-site');
  if (sites.length > 1 || (sites.length && !['none', 'same-origin'].includes(sites[0]))) {
    throw new RequestError(403, 'Cross-origin browser access is not allowed.');
  }
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function uiHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    'cross-origin-resource-policy': 'same-origin',
  };
}
