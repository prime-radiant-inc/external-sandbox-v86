import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import WebSocket from 'ws';
import { createApiServer } from '../src/http.js';
import { attachWebSocketApi } from '../src/websocket.js';

async function upgradeStatus(url: string, headers: Record<string, string>, protocols: string[] = []): Promise<number> {
  const ws = new WebSocket(url, protocols, { headers });
  return new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode!);
      ws.terminate();
    });
    ws.once('open', () => { resolve(101); ws.terminate(); });
    ws.on('error', reject);
  });
}

async function fixture(t: TestContext) {
  const server = createApiServer({ info: () => ({ defaultCwd: '/workspace' }),
    execute: async () => { throw new Error('Not used'); },
    start: async () => { throw new Error('Not used'); },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const token = /name="terminal-token" content="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(token);
  return { origin, url: origin.replace('http:', 'ws:') + '/exec/ws', token };
}

test('terminal token authorizes only same-origin command sockets and is never negotiated', async t => {
  const f = await fixture(t);
  const ws = new WebSocket(f.url, ['sandbox-terminal', `sandbox-token.${f.token}`], {
    origin: f.origin, headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'websocket' },
  });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  assert.equal(ws.protocol, 'sandbox-terminal');
  ws.close();
  await once(ws, 'close');
  const legacy = new WebSocket(f.url);
  t.after(() => legacy.terminate());
  await once(legacy, 'open');
  assert.equal(legacy.protocol, '');
  legacy.close();
  await once(legacy, 'close');
});

test('browser socket rejects absent/wrong tokens, origins, cross-site metadata, and other server tokens', async t => {
  const f = await fixture(t), other = await fixture(t);
  for (const [protocols, origin, headers] of [
    [[], f.origin, {}],
    [['sandbox-terminal', 'sandbox-token.wrong'], f.origin, {}],
    [['sandbox-terminal', `sandbox-token.${other.token}`], f.origin, {}],
    [['sandbox-terminal', `sandbox-token.${f.token}`], 'null', {}],
    [['sandbox-terminal', `sandbox-token.${f.token}`], other.origin, {}],
    [['sandbox-terminal', `sandbox-token.${f.token}`], f.origin, { 'Sec-Fetch-Site': 'cross-site' }],
    [['sandbox-terminal', `sandbox-token.${f.token}`, 'extra'], f.origin, {}],
  ] as [string[], string, Record<string, string>][]) {
    const ws = new WebSocket(f.url, protocols, { origin, headers });
    t.after(() => ws.terminate());
    const status = await new Promise<number>((resolve, reject) => {
      ws.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); ws.terminate(); });
      ws.once('open', () => reject(new Error('Unauthorized socket opened')));
      ws.on('error', () => {});
    });
    assert.equal(status, 403);
  }
  const buffered = await fetch(f.origin + '/exec', { method: 'POST',
    headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: '{"command":"true"}' });
  assert.equal(buffered.status, 403);
});

test('Fetch Metadata cannot use the originless CLI WebSocket path', async t => {
  const f = await fixture(t);
  const headers: Record<string, string>[] = [
    { 'Sec-Fetch-Site': 'same-origin' },
    { 'Sec-Fetch-Site': 'none' },
    { 'Sec-Fetch-Mode': 'websocket' },
    { 'Sec-Fetch-Dest': '' },
    { 'Sec-Fetch-User': '?1' },
    { 'sEc-FeTcH-sItE': 'same-origin' },
    { 'Sec-Fetch-Future': '' },
  ];
  for (const metadata of headers) {
    await t.test(JSON.stringify(metadata), async () => {
      assert.equal(await upgradeStatus(f.url, metadata), 403);
    });
  }
  // A valid token does not replace the mandatory same-origin Origin header.
  assert.equal(await upgradeStatus(f.url, { 'Sec-Fetch-Site': 'same-origin' },
    ['sandbox-terminal', `sandbox-token.${f.token}`]), 403);
});

test('Fetch Metadata is rejected when no terminal authorization adapter is installed', async t => {
  const server = createServer();
  let starts = 0;
  attachWebSocketApi(server, { start: async () => { starts++; throw new Error('Not used'); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/exec/ws`;
  assert.equal(await upgradeStatus(url, { 'Sec-Fetch-Mode': 'websocket' }), 403);
  assert.equal(await upgradeStatus(url, {}), 101);
  assert.equal(starts, 0);
});
