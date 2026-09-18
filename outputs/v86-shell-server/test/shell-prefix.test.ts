import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

const wrapper = fileURLToPath(new URL('../scripts/claude-shell-prefix-http.sh', import.meta.url));
const ok = { stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false, durationMs: 1 };

async function fixture(t: TestContext, response = ok) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'v86-shell-prefix-')));
  const cwd = path.join(root, 'nested', 'child');
  await mkdir(cwd, { recursive: true });
  const calls: any[] = [];
  const mounts: { name: string; hostPath: string; guestPath: string; preservedPaths?: string[] }[] = [
    { name: 'root', hostPath: root, guestPath: '/mnt/root' },
    { name: 'nested', hostPath: path.join(root, 'nested'), guestPath: '/mnt/nested' },
  ];
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/mounts') { res.end(JSON.stringify({ mounts })); return; }
    if (req.url !== '/exec') { res.writeHead(404); res.end('{}'); return; }
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { calls.push(JSON.parse(Buffer.concat(chunks).toString())); res.end(JSON.stringify(response)); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  });
  const port = (server.address() as AddressInfo).port;
  async function run(command: string, env: Record<string, string> = {}, stdin?: string) {
    return await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(wrapper, [command], { cwd, env: {
        ...process.env, V86_CWD: undefined, V86_FORWARD_STDIN: undefined,
        V86_TIMEOUT_MS: undefined, V86_MAX_OUTPUT_BYTES: undefined,
        V86_API_URL: `http://127.0.0.1:${port}`, ...env,
      }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', exitCode => resolve({ exitCode, stdout, stderr }));
      // With no opt-in the wrapper must finish even when its stdin pipe stays open.
      if (stdin !== undefined) child.stdin.end(stdin);
    });
  }
  return { calls, mounts, root, cwd, run, server, port };
}

test('prefix sends its one complete quoted multiline command without host evaluation', { timeout: 5000 }, async t => {
  const expected = { ...ok, stdout: 'hello\nexact\n', stderr: 'problem\n', exitCode: 23 };
  const f = await fixture(t, expected);
  const command = 'source /missing/claude-snapshot.sh\n' +
    'eval "printf \'$HOME `whoami` $(uname)\\n\'"\n' +
    'pwd -P >| /tmp/claude-a-cwd';
  const actual = await f.run(command);
  assert.deepEqual(actual, { exitCode: 23, stdout: expected.stdout, stderr: expected.stderr });
  assert.deepEqual(f.calls, [{ command, cwd: '/mnt/nested/child', timeoutMs: 120_000 }]);
});

test('preserved paths retain the host cwd path inside the VM', async t => {
  const f = await fixture(t);
  f.mounts[0].preservedPaths = [f.root];
  assert.equal((await f.run('pwd')).exitCode, 0);
  assert.equal(f.calls[0].cwd, f.cwd);
});

test('explicit guest cwd, stdin opt-in, and execution limits pass through', async t => {
  const f = await fixture(t);
  const actual = await f.run('cat', {
    V86_CWD: '/root', V86_FORWARD_STDIN: '1', V86_TIMEOUT_MS: '4567', V86_MAX_OUTPUT_BYTES: '1024',
  }, 'quoted " data\nand another line\0');
  assert.equal(actual.exitCode, 0);
  assert.deepEqual(f.calls[0], { command: 'cat', cwd: '/root', timeoutMs: 4567,
    maxOutputBytes: 1024, stdin: 'quoted " data\nand another line\0' });
});

test('missing cwd mapping and nonlocal URLs fail without command execution', async t => {
  const f = await fixture(t);
  f.mounts.length = 0;
  const missing = await f.run('true');
  assert.equal(missing.exitCode, 125);
  assert.match(missing.stderr, /not in a mounted directory/);
  for (const url of ['https://localhost:8686', 'http://example.com', 'http://localhost/a', 'http://user:secret@localhost']) {
    const response = await f.run('true', { V86_API_URL: url });
    assert.equal(response.exitCode, 125);
    assert.match(response.stderr, /V86_API_URL/);
  }
  assert.equal(f.calls.length, 0);
});

test('prefix uses shell exit conventions for VM signals, timeouts, and output caps', async t => {
  for (const [override, expected] of [
    [{ signal: 9, exitCode: null }, 137],
    [{ timedOut: true, exitCode: null, signal: 15 }, 124],
    [{ outputLimitExceeded: true, exitCode: null, signal: 9 }, 125],
  ] as const) {
    const f = await fixture(t, { ...ok, ...override });
    assert.equal((await f.run('true')).exitCode, expected);
  }
});

test('oversized forwarded stdin is rejected before execution', async t => {
  const f = await fixture(t);
  const response = await f.run('cat', { V86_FORWARD_STDIN: '1' }, 'x'.repeat(32769));
  assert.equal(response.exitCode, 125);
  assert.match(response.stderr, /stdin exceeds 32768/);
  assert.equal(f.calls.length, 0);
});

test('prefix rejects redirects instead of sending commands to another endpoint', async t => {
  const f = await fixture(t);
  f.server.removeAllListeners('request');
  f.server.on('request', (_req, res) => {
    res.writeHead(307, { location: 'http://example.com/exec' });
    res.end();
  });
  const result = await f.run('true', { V86_CWD: '/' });
  assert.equal(result.exitCode, 125);
  assert.match(result.stderr, /v86-shell-prefix:/);
});

test('SIGTERM aborts the API request and exits with shell status 143', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let markStarted!: () => void;
  let markDisconnected!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const disconnected = new Promise<void>(resolve => { markDisconnected = resolve; });
  f.server.removeAllListeners('request');
  f.server.on('request', (req, res) => {
    req.resume();
    req.on('end', markStarted);
    res.once('close', markDisconnected);
  });
  const child = spawn(wrapper, ['sleep 60'], { cwd: f.cwd, env: {
    ...process.env, V86_API_URL: `http://127.0.0.1:${f.port}`, V86_CWD: '/', V86_FORWARD_STDIN: undefined,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const closed = once(child, 'close');
  await started;
  child.kill('SIGTERM');
  const [code, signal] = await closed;
  assert.equal(code, 143);
  assert.equal(signal, null);
  await disconnected;
});
