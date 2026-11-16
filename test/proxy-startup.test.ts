import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApiServer } from '../src/http.js';
import { startManagedProxy } from '../src/network/managed-proxy.js';
import { startupProxyPolicy } from '../src/network/proxy-config.js';

const ORIGIN = 'https://api.example.com';

async function listen(t: TestContext, server: http.Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return (server.address() as AddressInfo).port;
}

function send(port: number, target: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: target, method: options.method ?? 'GET', agent: false,
      headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, text }));
    });
    request.on('error', reject);
    request.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

test('startup policy is absent by default, deny-all for --proxy, and read from a configuration file', async t => {
  assert.equal(await startupProxyPolicy({}), undefined);
  assert.equal(await startupProxyPolicy({ proxy: false }), undefined);

  const denyAll = await startupProxyPolicy({ proxy: true }, {});
  assert.deepEqual(denyAll!.configuration!(), { allow: [] });
  assert.deepEqual(denyAll!.guestEnv, {});
  assert.throws(() => denyAll!.authorize(new URL(`${ORIGIN}/`), 'GET', {}), /denied/);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'v86-proxy-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'policy.json');
  await writeFile(file, JSON.stringify({ allow: [{ origin: ORIGIN, methods: ['GET'] }] }));
  for (const proxy of [true, false]) {
    const configured = await startupProxyPolicy({ proxy, proxyConfig: file }, {});
    assert.equal(configured!.authorize(new URL(`${ORIGIN}/`), 'GET', {}).rule.origin, ORIGIN);
  }
  await assert.rejects(startupProxyPolicy({ proxy: true, proxyConfig: path.join(directory, 'missing.json') }));
});

test('a --proxy server denies every request until a rule is added on /proxy', async t => {
  const executor = { execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }), info: () => ({}) };
  const offline = await listen(t, createApiServer(executor));
  assert.equal((await send(offline, '/proxy')).status, 404);

  const upstream = await listen(t, http.createServer((_request, response) => { response.end('reached upstream'); }));
  const origin = `http://127.0.0.1:${upstream}`;
  const proxy = await startManagedProxy((await startupProxyPolicy({ proxy: true }, {}))!);
  t.after(() => proxy.close());
  const api = await listen(t, createApiServer(executor, { proxyManagement: proxy }));
  const viaProxy = () => send(proxy.port, `${origin}/hello`, { headers: { host: new URL(origin).host } });

  const page = await send(api, '/proxy');
  assert.equal(page.status, 200);
  const headers = { 'x-proxy-token': /<meta name="proxy-token" content="([^"]+)"/.exec(page.text)![1] };
  assert.deepEqual(JSON.parse((await send(api, '/proxy/api', { headers })).text).policy, { allow: [] });
  assert.equal((await viaProxy()).status, 403);

  const update = await send(api, '/proxy/api', { method: 'PUT', headers, body: { allow: [{ origin, allowCidrs: ['127.0.0.1/32'] }] } });
  assert.equal(update.status, 200, update.text);
  const allowed = await viaProxy();
  assert.equal(allowed.status, 200, allowed.text);
  assert.equal(allowed.text, 'reached upstream');
});
