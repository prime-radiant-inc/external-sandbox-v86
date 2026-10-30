import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createApiServer, type ExecRequest, type ExecResult, type Executor } from '../src/http.js';

const result: ExecResult = {
  stdout: 'first\nsecond\n', stderr: 'warning\n', exitCode: 17, signal: null,
  timedOut: false, outputLimitExceeded: false, durationMs: 12,
};

async function fixture(t: TestContext, execute?: Executor['execute'], maxBodyBytes?: number) {
  const calls: ExecRequest[] = [];
  const mounts = [{ hostPath: '/host/project', guestPath: '/mnt/project' }];
  const server = createApiServer({
    info: () => ({ mounts, vm: 'test-vm' }),
    execute: execute ?? (async input => { calls.push(input); return result; }),
  }, { maxBodyBytes });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const port = (server.address() as AddressInfo).port;
  async function send(path: string, {
    method = 'POST', body, raw, headers = {},
  }: { method?: string; body?: unknown; raw?: string | Buffer; headers?: Record<string, string> } = {}) {
    const bytes = raw ?? (body === undefined ? '' : JSON.stringify(body));
    return await new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: any }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, agent: false,
        headers: { 'content-type': 'application/json', ...headers },
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({
          status: res.statusCode!, headers: res.headers,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        }));
      });
      req.on('error', reject);
      req.end(bytes);
    });
  }
  return { server, port, calls, mounts, send };
}

test('exec preserves exact stdout, stderr, and a nonzero guest exit code', async t => {
  const f = await fixture(t);
  const command = "printf 'first\\nsecond\\n'; printf 'warning\\n' >&2; exit 17";
  const response = await f.send('/exec', { body: {
    command, cwd: '/mnt/project', env: { GREETING: 'hello $world' }, stdin: 'a\0b\n',
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, result);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, command);
  assert.equal(f.calls[0].cwd, '/mnt/project');
  assert.equal(f.calls[0].env?.GREETING, 'hello $world');
  assert.equal(f.calls[0].stdin, 'a\0b\n');
  assert.equal(f.calls[0].timeoutMs, 30_000);
  assert.equal(f.calls[0].maxOutputBytes, 4 * 1024 * 1024);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('health and mounts report VM information', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.send('/health', { method: 'GET' })).body,
    { status: 'ready', mounts: f.mounts, vm: 'test-vm' });
  assert.deepEqual((await f.send('/mounts', { method: 'GET' })).body, { mounts: f.mounts });
  assert.equal(f.calls.length, 0);
});

test('legacy routes reject cross-site Fetch Metadata without an Origin', async t => {
  const f = await fixture(t);
  for (const value of ['cross-site', 'same-site', 'cross-site, none']) {
    const headers = { 'sec-fetch-site': value };
    assert.equal((await f.send('/exec', { body: { command: 'true' }, headers })).status, 403);
    assert.equal((await f.send('/health', { method: 'GET', headers })).status, 403);
    assert.equal((await f.send('/mounts', { method: 'GET', headers })).status, 403);
  }
  assert.equal(f.calls.length, 0);
});

test('legacy routes keep same-origin Fetch Metadata and clients that send none', async t => {
  const f = await fixture(t);
  for (const value of ['none', 'same-origin']) {
    assert.equal((await f.send('/health', { method: 'GET', headers: { 'sec-fetch-site': value } })).status, 200);
  }
  assert.equal((await f.send('/health', { method: 'GET' })).status, 200);
});

test('rejects web origins and DNS rebinding hosts before executing', async t => {
  const f = await fixture(t);
  for (const origin of ['https://example.com', 'http://localhost', 'null']) {
    assert.equal((await f.send('/exec', { body: { command: 'true' }, headers: { Origin: origin } })).status, 403);
  }
  for (const host of ['example.com', 'localhost.example.com', '127.0.0.1.example.com', 'localhost:65536', 'localhost:0']) {
    assert.equal((await f.send('/exec', { body: { command: 'true' }, headers: { Host: host } })).status, 403);
  }
  assert.equal(f.calls.length, 0);
  for (const host of ['localhost', 'localhost:1234', '127.0.0.1:1234', '[::1]:1234', 'LOCALHOST']) {
    assert.equal((await f.send('/health', { method: 'GET', headers: { Host: host } })).status, 200);
  }
});

test('invalid commands, paths, environments, and resource limits never execute', async t => {
  const f = await fixture(t);
  const invalid: unknown[] = [null, [], {}, { command: '' }, { command: '  ' }, { command: 1 },
    { command: 'x\0y' }, { command: 'a'.repeat(64 * 1024 + 1) },
    { command: 'true', cwd: 'relative' }, { command: 'true', cwd: '/a\0' },
    { command: 'true', env: [] }, { command: 'true', env: { A: 2 } },
    { command: 'true', env: { 'INVALID-NAME': 'x' } },
    { command: 'true', env: { A: 'a\0b' } },
    { command: 'true', env: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`K${i}`, 'v'])) },
    { command: 'true', env: { A: 'x'.repeat(32 * 1024) } },
    { command: 'true', stdin: 'é'.repeat(16 * 1024 + 1) },
    { command: 'true', timeoutMs: 0 }, { command: 'true', timeoutMs: 300_001 },
    { command: 'true', timeoutMs: 1.5 }, { command: 'true', timeoutMs: '1000' },
    { command: 'true', maxOutputBytes: 0 }, { command: 'true', maxOutputBytes: 16 * 1024 * 1024 + 1 },
    { command: 'true', typo: true },
  ];
  for (const body of invalid) {
    const response = await f.send('/exec', { body });
    assert.equal(response.status, 400, `Accepted invalid request: ${JSON.stringify(body).slice(0, 200)}`);
    assert.equal(typeof response.body.error, 'string');
  }
  assert.equal(f.calls.length, 0);
});

test('reports JSON, body size, content type, method, and routing errors', async t => {
  const f = await fixture(t, undefined, 1024);
  assert.equal((await f.send('/exec', { raw: '{' })).status, 400);
  assert.equal((await f.send('/exec', { raw: Buffer.from([0xff]) })).status, 400);
  assert.equal((await f.send('/exec', { raw: 'x'.repeat(1025) })).status, 413);
  assert.equal((await f.send('/exec', { raw: 'x'.repeat(1025), headers: { 'content-length': '1025' } })).status, 413);
  assert.equal((await f.send('/exec', { body: { command: 'true' }, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.send('/exec', { body: { command: 'true' }, headers: { 'content-encoding': 'gzip' } })).status, 415);
  const wrongMethod = await f.send('/exec', { method: 'GET' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
  assert.equal((await f.send('/missing', { method: 'GET' })).status, 404);
  assert.equal(f.calls.length, 0);
});

test('passes explicit bounds and returns timeout and signal details unchanged', async t => {
  const timedOut: ExecResult = { ...result, exitCode: null, signal: 15, timedOut: true };
  const f = await fixture(t, async input => {
    assert.equal(input.timeoutMs, 300_000);
    assert.equal(input.maxOutputBytes, 16 * 1024 * 1024);
    return timedOut;
  });
  const response = await f.send('/exec', { body: { command: 'sleep 600', timeoutMs: 300_000, maxOutputBytes: 16 * 1024 * 1024 } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, timedOut);
});

test('executor failures become JSON server errors', async t => {
  const f = await fixture(t, async () => { throw new Error('VM disconnected'); });
  const response = await f.send('/exec', { body: { command: 'true' } });
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'VM disconnected' });
});

test('disconnecting an execution request aborts its executor signal', { timeout: 5000 }, async t => {
  let markStarted!: () => void;
  let markAborted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const aborted = new Promise<void>(resolve => { markAborted = resolve; });
  const f = await fixture(t, async (_input, signal) => {
    assert.ok(signal);
    markStarted();
    await new Promise<void>(resolve => {
      signal.addEventListener('abort', () => { markAborted(); resolve(); }, { once: true });
    });
    return result;
  });
  const req = httpRequest({ host: '127.0.0.1', port: f.port, path: '/exec', method: 'POST',
    agent: false, headers: { 'content-type': 'application/json' },
  });
  req.on('error', () => {});
  req.end(JSON.stringify({ command: 'sleep 60' }));
  await started;
  req.destroy();
  await aborted;
});
