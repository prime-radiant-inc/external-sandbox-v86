import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createTerminalUi } from '../src/ui/terminal.js';

async function fixture(t: TestContext, info: object = {}, proxyEnabled?: boolean) {
  const terminal = createTerminalUi(() => info, { proxyEnabled });
  const server = createServer((req, res) => {
    try {
      if (!terminal.handle(req, res, new URL(req.url!, 'http://localhost').pathname)) {
        res.writeHead(404); res.end();
      }
    } catch (error) {
      res.writeHead((error as { statusCode?: number }).statusCode ?? 500);
      res.end((error as Error).message);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  async function send(path = '/', headers: Record<string, string> = {}, method = 'GET') {
    return await new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.end();
    });
  }
  const authorize = (headers: Record<string, string>, extraRaw: string[] = []) => terminal.authorizeWebSocket({
    url: '/exec/ws', socket: {},
    headers: { host: `127.0.0.1:${port}`, ...headers },
    rawHeaders: ['Host', `127.0.0.1:${port}`, ...Object.entries(headers).flat(), ...extraRaw],
  } as IncomingMessage);
  return { terminal, send, origin, authorize };
}

test('terminal page escapes guest paths once and includes only the enabled proxy link', async t => {
  const f = await fixture(t, { defaultCwd: '/mnt/<x>"__TOKEN____TITLE____BRAND__&', proxyEnabled: true });
  const page = await f.send();
  assert.equal(page.status, 200);
  assert.match(page.body, /value="\/mnt\/&lt;x&gt;&quot;__TOKEN____TITLE____BRAND__&amp;"/);
  assert.match(page.body, /href="\/proxy"/);
  assert.match(page.body, /terminal-token/);
  assert.match(page.body, /<title>external-sandbox-v86 terminal<\/title>/);
  assert.match(page.body, /class="eyebrow">external-sandbox-v86<\/div>/);
  assert.match(page.body, /src="\/terminal.js"/);
  assert.match(page.body, /Each run starts a new shell/);
  const offline = await fixture(t);
  assert.doesNotMatch((await offline.send()).body, /id="proxy-link"/);
  assert.match((await offline.send()).body, /Network disabled/);
  const enabled = await fixture(t, {}, true);
  assert.match((await enabled.send()).body, /id="proxy-link"/);
});

test('terminal assets carry restrictive headers and fresh style nonces', async t => {
  const f = await fixture(t);
  const page = await f.send('/', { Origin: f.origin, 'Sec-Fetch-Site': 'same-origin' });
  const next = await f.send();
  const script = await f.send('/terminal.js');
  for (const response of [page, script]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
  }
  const nonce = page.body.match(/<style nonce="([^"]+)"/)![1];
  assert.notEqual(next.body.match(/<style nonce="([^"]+)"/)![1], nonce);
  assert.match(String(page.headers['content-security-policy']), new RegExp(`style-src 'nonce-${nonce}'`));
  assert.ok(String(page.headers['content-security-policy']).includes(`connect-src 'self' ${f.origin.replace('http:', 'ws:')}`));
  assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');
  assert.match(String(script.headers['content-type']), /javascript/);
  assert.match(script.body, /Copy session/);
  assert.match(script.body, /clipboard\.writeText/);
});

test('terminal routes reject wrong methods, origins, fetch sites and nonlocal hosts', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/terminal.js']) {
    for (const method of ['POST', 'HEAD', 'OPTIONS']) {
      const response = await f.send(path, {}, method);
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, 'GET');
    }
    for (const headers of [
      { Origin: 'http://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' },
      { Host: 'evil.example' }, { Host: 'localhost:65536' }, { Host: 'localhost:0' },
    ]) assert.equal((await f.send(path, headers)).status, 403);
  }
  assert.equal((await f.send('/missing')).status, 404);
});

test('terminal WebSockets require exact origin and the per-server token in exactly two protocols', async t => {
  const f = await fixture(t);
  const page = await f.send();
  const token = page.body.match(/name="terminal-token" content="([^"]+)"/)![1];
  const headers = { Origin: f.origin, 'Sec-WebSocket-Protocol': `sandbox-terminal, sandbox-token.${token}` };
  assert.equal(f.terminal.protocol, 'sandbox-terminal');
  assert.doesNotThrow(() => f.authorize(headers));
  for (const protocol of ['', 'sandbox-terminal', `sandbox-token.${token}`, `sandbox-terminal, sandbox-token.wrong`,
    `sandbox-terminal, sandbox-token.${token}, extra`, `sandbox-terminal, sandbox-terminal`,
    `sandbox-terminal, sandbox-token.${token}, sandbox-token.${token}`]) {
    assert.throws(() => f.authorize({ ...headers, 'Sec-WebSocket-Protocol': protocol }), /token/i);
  }
  assert.throws(() => f.authorize({ 'Sec-WebSocket-Protocol': headers['Sec-WebSocket-Protocol'] }), /Origin/);
  assert.throws(() => f.authorize({ ...headers, Origin: 'http://localhost:9999' }), /origin/i);
  assert.throws(() => f.authorize(headers, ['Origin', f.origin]), /origin/i);
  assert.throws(() => f.authorize(headers, ['Sec-WebSocket-Protocol', headers['Sec-WebSocket-Protocol']]), /token/i);
  assert.throws(() => f.authorize(headers, ['Host', '127.0.0.1']), /Host/);
  const other = await fixture(t);
  assert.throws(() => other.authorize({ ...headers, Origin: other.origin }), /token/i);
});
