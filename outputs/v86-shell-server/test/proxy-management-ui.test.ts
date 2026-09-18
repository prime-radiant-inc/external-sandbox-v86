import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createProxyManagementUi, type ProxyManagement } from '../src/ui/proxy-management.js';

const POLICY = { allow: [{ origin: 'https://api.example.test', methods: ['GET'], credential: {
  header: 'Authorization', placeholder: 'Bearer demo-token', prefix: 'Bearer ', secretEnv: 'EXAMPLE_API_KEY',
} }], guestEnv: { EXAMPLE_API_KEY: 'demo-token' } };

class FakeProxy implements ProxyManagement {
  policy: unknown = structuredClone(POLICY);
  events: unknown[] = [];
  updates: unknown[] = [];
  secret = 'host-secret-never-in-the-management-ui';
  snapshot() { return { enabled: true, policy: structuredClone(this.policy), events: structuredClone(this.events) }; }
  updatePolicy(config: any) {
    this.updates.push(config);
    if (!Array.isArray(config.allow) || Object.keys(config).some(key => !['allow', 'guestEnv'].includes(key))) throw new Error(this.secret);
    this.policy = structuredClone(config);
  }
}

async function fixture(t: TestContext) {
  const proxy = new FakeProxy();
  const handler = createProxyManagementUi(proxy);
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url!, 'http://localhost').pathname).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  async function send(path: string, options: { method?: string; body?: unknown; raw?: string | Buffer;
    headers?: Record<string, string | string[]>; chunks?: Buffer[] } = {}) {
    return await new Promise<{ status: number; headers: IncomingHttpHeaders; text: string; json(): any }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', agent: false,
        headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode!, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      });
      req.on('error', reject);
      for (const chunk of options.chunks ?? []) req.write(chunk);
      req.end(options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)));
    });
  }
  const page = await send('/proxy');
  assert.equal(page.status, 200);
  const token = /<meta name="proxy-token" content="([^"]+)"/.exec(page.text)![1];
  const headers = { 'X-Proxy-Token': token };
  return { send, proxy, page, token, headers, origin };
}

test('proxy management serves the cloned page and a token-protected safe snapshot', async t => {
  const f = await fixture(t);
  const page = await f.send('/proxy');
  assert.ok(page.text.includes(`content="${f.token}"`));
  for (const text of ['Runtime only', 'secretEnv', 'element.textContent = text', 'setInterval(refresh, 3000)']) assert.ok(page.text.includes(text));
  for (const text of ['innerHTML', 'insertAdjacentHTML', 'https://', 'http://', 'api.example.test', f.proxy.secret]) assert.ok(!page.text.includes(text));
  const nonce = /<script nonce="([^"]+)"/.exec(page.text)![1];
  assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.ok(page.headers['content-security-policy']?.includes(`script-src 'nonce-${nonce}'`));
  assert.notEqual(nonce, /<script nonce="([^"]+)"/.exec(f.page.text)![1]);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');
  const response = await f.send('/proxy/api', { headers: f.headers });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), f.proxy.snapshot());
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('API requires exactly one correct management token unique to this server', async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  assert.notEqual(f.token, other.token);
  for (const method of ['GET', 'PUT']) {
    for (const headers of [{}, { 'X-Proxy-Token': 'wrong' }, other.headers, { 'X-Proxy-Token': [f.token, f.token] }]) {
      assert.equal((await f.send('/proxy/api', { method, headers, body: { allow: [] } })).status, 403);
    }
  }
  assert.deepEqual(f.proxy.updates, []);
});

test('same-origin, loopback Host, and fetch metadata checks protect both proxy routes', async t => {
  const f = await fixture(t);
  for (const path of ['/proxy', '/proxy/api']) {
    for (const headers of [
      { Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: 'http://localhost' },
      { Origin: [f.origin, f.origin] }, { Host: 'rebinding.evil.test' }, { Host: '127.0.0.1:0' },
      { Host: '127.0.0.1:65536' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
    ]) {
      const response = await f.send(path, { headers: { ...f.headers, ...headers } });
      assert.equal(response.status, 403, JSON.stringify({ path, headers }));
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
    assert.equal((await f.send(path, { headers: { ...f.headers, Origin: f.origin, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  }
  assert.equal((await f.send(`${f.origin}/proxy`, { headers: f.headers })).status, 400);
});

test('valid policy updates are atomic and validation exceptions never leak secrets', async t => {
  const f = await fixture(t);
  const headers = { ...f.headers, Origin: f.origin, 'Sec-Fetch-Site': 'same-origin' };
  const changed = { allow: [{ origin: 'https://packages.example.test', methods: ['GET'] }] };
  const response = await f.send('/proxy/api', { method: 'PUT', headers, body: changed });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json().policy, changed);
  const rejected = await f.send('/proxy/api', { method: 'PUT', headers, body: { allow: 'invalid' } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.json().error, /unchanged/);
  assert.ok(!rejected.text.includes(f.proxy.secret));
  assert.deepEqual(f.proxy.policy, changed);
  assert.deepEqual((await f.send('/proxy/api', { headers })).json().policy, changed);
});

test('cross-origin mutation and unsupported methods never update policy', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('/proxy/api', { method: 'PUT', headers: { ...f.headers, Origin: 'https://evil.example' }, body: { allow: [] } })).status, 403);
  for (const [path, method, allowed] of [['/proxy/api', 'OPTIONS', 'GET, PUT'], ['/proxy/api', 'POST', 'GET, PUT'], ['/proxy', 'HEAD', 'GET']]) {
    const response = await f.send(path, { method, headers: f.headers });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, allowed);
  }
  for (const path of ['/proxy/', '/proxy/api/extra', '/other']) assert.equal((await f.send(path, { headers: f.headers })).status, 404);
  assert.deepEqual(f.proxy.updates, []);
});

test('invalid UTF-8 and nonobject or nonfinite JSON never reach the proxy', async t => {
  const f = await fixture(t);
  for (const raw of ['not JSON', '[]', 'null', '"string"', '{"allow":NaN}', '{"x":1e400}', Buffer.from([255])]) {
    const response = await f.send('/proxy/api', { method: 'PUT', headers: { ...f.headers, 'content-type': 'application/json' }, raw });
    assert.equal(response.status, 400);
    assert.match(response.json().error, /valid UTF-8 JSON object/);
  }
  assert.deepEqual(f.proxy.updates, []);
});

test('policy request encoding and byte caps are checked for declared and streamed bodies', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('/proxy/api', { method: 'PUT', headers: f.headers, raw: '{}' })).status, 415);
  const headers = { ...f.headers, 'content-type': 'application/json' };
  assert.equal((await f.send('/proxy/api', { method: 'PUT', headers: { ...headers, 'content-encoding': 'br' }, raw: '{}' })).status, 415);
  assert.equal((await f.send('/proxy/api', { method: 'PUT', headers: { ...headers, 'content-length': '262145' }, raw: ' '.repeat(262145) })).status, 413);
  assert.equal((await f.send('/proxy/api', { method: 'PUT', headers,
    chunks: [Buffer.from(' '.repeat(131072)), Buffer.from('é'.repeat(65536) + ' ')] })).status, 413);
  assert.deepEqual(f.proxy.updates, []);
});

test('activity is JSON data, never interpolated into HTML; snapshot errors stay generic', async t => {
  const f = await fixture(t);
  const payload = '</script><img src=x onerror="alert(document.domain)">';
  f.proxy.events = [{ origin: payload, reason: payload }];
  const response = await f.send('/proxy/api', { headers: f.headers });
  assert.deepEqual(response.json().events, f.proxy.events);
  assert.match(String(response.headers['content-type']), /^application\/json/);
  assert.ok(!(await f.send('/proxy')).text.includes(payload));
  f.proxy.snapshot = () => { throw new Error(f.proxy.secret); };
  const failed = await f.send('/proxy/api', { headers: f.headers });
  assert.equal(failed.status, 500);
  assert.ok(!failed.text.includes(f.proxy.secret));
});

function browser(html: string) {
  class Element {
    textContent = ''; className = ''; value = ''; disabled = false; hidden = false;
    children: Element[] = []; listeners = new Map<string, (...args: any[]) => unknown>();
    append(...items: Element[]) { this.children.push(...items); }
    replaceChildren(...items: Element[]) { this.children = items; }
    addEventListener(event: string, listener: (...args: any[]) => unknown) { this.listeners.set(event, listener); }
    fire(event: string) { return this.listeners.get(event)?.(); }
  }
  const elements = new Map<string, Element>();
  const byId = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const pending: { resolve(value: unknown): void; method: string; headers: Record<string, string>; body?: string }[] = [];
  let refresh!: () => Promise<void>;
  runInNewContext(/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1], {
    document: { getElementById: byId, querySelector: () => ({ content: 'test-token' }), createElement: () => new Element() },
    fetch: (_url: string, options: any) => new Promise(resolve => pending.push({ ...options,
      resolve: (value: unknown) => resolve({ ok: true, json: async () => value }) })),
    setInterval: (fn: () => Promise<void>, ms: number) => { assert.equal(ms, 3000); refresh = fn; },
  });
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  return { byId, pending, refresh, settle };
}

test('cloned browser client preserves dirty edits during polling and discards to latest policy', async t => {
  const f = await fixture(t);
  const ui = browser(f.page.text);
  assert.equal(ui.pending[0].headers['X-Proxy-Token'], 'test-token');
  ui.pending.shift()!.resolve(f.proxy.snapshot()); await ui.settle();
  const editor = ui.byId('policy');
  editor.value = '{"allow":[]}'; editor.fire('input');
  assert.equal(ui.byId('save').disabled, false);
  const refresh = ui.refresh();
  const changed = { allow: [{ origin: 'https://new.example.test' }] };
  ui.pending.shift()!.resolve({ enabled: true, policy: changed, events: [] }); await refresh;
  assert.equal(editor.value, '{"allow":[]}');
  assert.equal(ui.byId('edit-state').textContent, 'Unsaved edits');
  ui.byId('reset').fire('click');
  assert.deepEqual(JSON.parse(editor.value), changed);
  assert.equal(ui.byId('save').disabled, true);
});

test('cloned browser client ignores stale polls after Apply and renders hostile strings safely', async t => {
  const f = await fixture(t);
  const ui = browser(f.page.text);
  ui.pending.shift()!.resolve(f.proxy.snapshot()); await ui.settle();
  const oldRefresh = ui.refresh();
  const stale = ui.pending.shift()!;
  ui.byId('policy').value = 'invalid JSON'; ui.byId('policy').fire('input');
  await ui.byId('save').fire('click');
  assert.equal(ui.pending.length, 0);
  assert.match(ui.byId('message').textContent, /valid JSON/);
  ui.byId('policy').value = '{"allow":[]}'; ui.byId('policy').fire('input');
  const applied = ui.byId('save').fire('click');
  assert.equal(ui.byId('policy').disabled, true);
  assert.equal(ui.pending[0].method, 'PUT');
  assert.deepEqual(JSON.parse(ui.pending[0].body!), { allow: [] });
  const hostile = '<img src=x onerror=alert(1)>';
  ui.pending.shift()!.resolve({ enabled: true, policy: { allow: [] }, events: [{ reason: hostile }] });
  await applied;
  stale.resolve(f.proxy.snapshot()); await oldRefresh;
  assert.deepEqual(JSON.parse(ui.byId('policy').value), { allow: [] });
  assert.equal(ui.byId('events').children[0].children[3].textContent, hostile);
  assert.equal(ui.byId('policy').disabled, false);
});
