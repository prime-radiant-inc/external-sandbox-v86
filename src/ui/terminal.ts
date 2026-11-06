import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestError } from '../http.js';
import { checkUiAccess, rawHeaderValues, safeEqual, uiHeaders } from './browser-access.js';

const pageTemplate = readFileSync(new URL('./shared/assets/terminal.html', import.meta.url), 'utf8');
const javascript = readFileSync(new URL('./shared/assets/terminal.js', import.meta.url));
const protocol = 'sandbox-terminal';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[character]!);
}

/** Browser terminal for the existing streaming shell protocol. Tokens stay local to this server. */
export function createTerminalUi(info: () => object, options: { proxyEnabled?: boolean } = {}) {
  const token = randomBytes(32).toString('base64url');
  return {
    protocol,
    handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
      if (path !== '/' && path !== '/terminal.js') return false;
      checkUiAccess(req);
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET');
        throw new RequestError(405, `Use GET for ${path}.`);
      }
      const headers = uiHeaders();
      if (path === '/terminal.js') {
        res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8', 'content-length': javascript.length });
        res.end(javascript);
        return true;
      }
      const details = info() as { defaultCwd?: unknown; proxyEnabled?: boolean };
      const nonce = randomBytes(24).toString('base64url');
      const proxyEnabled = options.proxyEnabled ?? details.proxyEnabled ?? false;
      const values: Record<string, string> = {
        __NONCE__: nonce, __TOKEN__: token,
        __TITLE__: escapeHtml('external-sandbox-v86 terminal'), __BRAND__: escapeHtml('external-sandbox-v86'),
        __CWD__: escapeHtml(String(details.defaultCwd ?? '/workspace')),
        __NETWORK__: proxyEnabled ? 'Managed proxy' : 'Network disabled',
        __PROXY_LINK__: proxyEnabled ? '<a id="proxy-link" href="/proxy" target="_blank" rel="noopener">Network policy ↗</a>' : '',
      };
      // Replace original template markers only: a mount path can contain marker text.
      const page = pageTemplate.replace(/__NONCE__|__TOKEN__|__TITLE__|__BRAND__|__CWD__|__NETWORK__|__PROXY_LINK__/g, marker => values[marker]);
      const scheme = (req.socket as { encrypted?: boolean }).encrypted ? 'wss' : 'ws';
      headers['content-security-policy'] = `default-src 'none'; script-src 'self'; style-src 'nonce-${nonce}'; connect-src 'self' ${scheme}://${req.headers.host}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
      headers['cross-origin-opener-policy'] = 'same-origin';
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(page) });
      res.end(page);
      return true;
    },
    authorizeWebSocket(req: IncomingMessage): void {
      checkUiAccess(req);
      if (rawHeaderValues(req, 'origin').length !== 1) {
        throw new RequestError(403, 'Browser WebSockets require a same-origin Origin.');
      }
      const headers = rawHeaderValues(req, 'sec-websocket-protocol');
      const protocols = headers.length === 1 ? headers[0].split(',').map(value => value.trim()) : [];
      const tokens = protocols.filter(value => value.startsWith('sandbox-token.')).map(value => value.slice('sandbox-token.'.length));
      if (protocols.length !== 2 || protocols.filter(value => value === protocol).length !== 1 || tokens.length !== 1 || !safeEqual(tokens[0], token)) {
        throw new RequestError(403, 'The terminal session token is required.');
      }
    },
  };
}
