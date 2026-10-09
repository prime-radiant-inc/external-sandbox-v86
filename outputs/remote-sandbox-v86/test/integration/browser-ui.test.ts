import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createApiServer } from '../../src/http.js';
import { createCertificateAuthority } from '../../src/network/certificates.js';
import { startManagedProxy } from '../../src/network/managed-proxy.js';
import { compileProxyPolicy, type ProxyConfig } from '../../src/network/proxy-policy.js';
import { ShellVM } from '../../src/vm.js';

const image = fileURLToPath(new URL('../../images/linux', import.meta.url));
type Message = { type: string; data?: string; id?: number; [key: string]: unknown };

async function until(predicate: () => boolean, description: string, timeout = 15_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Real browser authorization headers, then the unchanged /exec/ws protocol. */
class BrowserSession {
  readonly messages: Message[] = [];
  private failure?: Error;
  constructor(readonly socket: WebSocket) {
    socket.on('message', data => {
      try { this.messages.push(JSON.parse(data.toString()) as Message); }
      catch (error) { this.failure = error as Error; }
    });
    socket.on('error', error => { this.failure = error; });
  }
  static async open(base: string, token: string, t: TestContext): Promise<BrowserSession> {
    const session = new BrowserSession(new WebSocket(base.replace('http:', 'ws:') + '/exec/ws',
      ['sandbox-terminal', `sandbox-token.${token}`], { origin: base }));
    t.after(() => session.socket.terminate());
    await session.wait(() => session.socket.readyState === WebSocket.OPEN, 'browser WebSocket authorization');
    assert.equal(session.socket.protocol, 'sandbox-terminal', 'token must never be echoed as the selected protocol');
    return session;
  }
  send(message: object): void { this.socket.send(JSON.stringify(message)); }
  output(stream: 'stdout' | 'stderr'): string {
    return Buffer.concat(this.messages.filter(message => message.type === stream)
      .map(message => Buffer.from(message.data!, 'base64'))).toString();
  }
  async wait(predicate: () => boolean, description: string): Promise<void> {
    await until(() => {
      if (this.failure) throw this.failure;
      assert.equal(this.messages.find(message => message.type === 'error'), undefined,
        `Unexpected protocol failure: ${JSON.stringify(this.messages)}`);
      if (predicate()) return true;
      assert.notEqual(this.socket.readyState, WebSocket.CLOSED, `WebSocket closed before ${description}`);
      return false;
    }, description);
  }
  async write(id: number, text: string): Promise<void> {
    this.send({ type: 'stdin', id, data: Buffer.from(text).toString('base64') });
    await this.wait(() => this.messages.some(message => message.type === 'stdin_ack' && message.id === id), `stdin acknowledgement ${id}`);
  }
  async exit(): Promise<Message> {
    await this.wait(() => this.messages.some(message => message.type === 'exit'), 'guest exit');
    return this.messages.find(message => message.type === 'exit')!;
  }
}

test('browser terminal and live proxy management work against real v86 Linux', { timeout: 120_000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'v86-browser-ui-'));
  const root = await fs.realpath(temp);
  const rw = path.join(root, 'writable'), ro = path.join(root, 'reference');
  await fs.mkdir(rw); await fs.mkdir(ro);
  await fs.writeFile(path.join(ro, 'reference.txt'), 'protected host reference\n');
  const secret = 'sk-offline-browser-ui-secret-value';
  const placeholder = '8bfa96bc-3f70-4a41-b22e-17fc5be7da7d';
  const upstreamCa = createCertificateAuthority();
  const certificate = upstreamCa.issue('ui-upstream.test');
  const authorizations: string[] = [];
  const upstream = createHttpsServer({ key: certificate.privateKey, cert: certificate.certificate }, (req, res) => {
    authorizations.push(String(req.headers.authorization));
    res.writeHead(200, { 'content-type': 'text/plain' });
    if (req.url === '/stall') res.write('upstream-connected\n');
    else res.end(`upstream received ${req.headers.authorization}\n`);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const origin = `https://ui-upstream.test:${(upstream.address() as { port: number }).port}`;
  const config: ProxyConfig = {
    allow: [{ origin, methods: ['GET'], paths: ['/ok', '/stall'], allowCidrs: ['127.0.0.1/32'],
      credential: { header: 'authorization', placeholder: `Bearer ${placeholder}`, secretEnv: 'FIXTURE_SECRET', prefix: 'Bearer ' } }],
    guestEnv: { GUEST_API_TOKEN: placeholder },
  };
  const policy = compileProxyPolicy(config, { FIXTURE_SECRET: secret }, {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  const proxy = await startManagedProxy(policy, { upstreamCa: upstreamCa.certificate });
  let vm: ShellVM | undefined;
  let api: ReturnType<typeof createApiServer> | undefined;
  t.after(async () => {
    if (api) await new Promise<void>(resolve => { api!.closeAllConnections(); api!.close(() => resolve()); });
    await vm?.destroy();
    await proxy.close();
    await new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); });
    await fs.rm(temp, { recursive: true, force: true });
  });
  vm = await ShellVM.boot({ image, mounts: [
    { name: 'rw', hostPath: rw, mode: 'rw' }, { name: 'ro', hostPath: ro, mode: 'ro' },
  ], managedNetwork: { proxyPort: proxy.port, caCertificate: proxy.caCertificate, env: policy.guestEnv } });
  api = createApiServer(vm, { proxyManagement: proxy });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const page = await (await fetch(base)).text();
  const terminalToken = page.match(/name="terminal-token" content="([^"]+)"/)![1];
  const proxyPage = await (await fetch(base + '/proxy')).text();
  const proxyToken = proxyPage.match(/name="proxy-token" content="([^"]+)"/)![1];
  assert.notEqual(terminalToken, proxyToken);
  const management = (config?: unknown) => fetch(base + '/proxy/api', {
    method: config === undefined ? 'GET' : 'PUT',
    headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'X-Proxy-Token': proxyToken, 'Content-Type': 'application/json' },
    ...(config === undefined ? {} : { body: JSON.stringify(config) }),
  });
  const run = async (t: TestContext, command: string) => {
    const session = await BrowserSession.open(base, terminalToken, t);
    session.send({ type: 'start', command, cwd: '/mnt/rw', stdin: false, timeoutMs: 15_000 });
    const result = await session.exit();
    return { ...result, stdout: session.output('stdout'), stderr: session.output('stderr') };
  };
  const request = (route = '/ok?do-not-log=browser-query-marker') => `python3 -u - <<'PY'
import os, urllib.request, urllib.error
assert os.environ['GUEST_API_TOKEN'] == '${placeholder}'
assert 'FIXTURE_SECRET' not in os.environ
request = urllib.request.Request('${origin}${route}', headers={'Authorization': 'Bearer ' + os.environ['GUEST_API_TOKEN']})
try:
    with urllib.request.urlopen(request, timeout=5) as response:
        print(response.read().decode(), end='', flush=True)
except urllib.error.URLError:
    print('request denied', flush=True)
PY`;

  await t.test('page assets expose terminal and copy UI while legacy execution stays Origin-free', async () => {
    assert.match(page, /href="\/proxy"/);
    assert.match(page, /value="\/mnt\/rw"/);
    assert.match(page, /Managed proxy/);
    const script = await fetch(base + '/terminal.js', { headers: { Origin: base } });
    assert.equal(script.status, 200);
    assert.match(await script.text(), /Copy session/);
    assert.equal((await fetch(base + '/exec', { method: 'POST', headers: { Origin: base,
      'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'printf should-not-run' }) })).status, 403);
    assert.equal((await fetch(base + '/proxy/api', { headers: { 'X-Proxy-Token': terminalToken } })).status, 403);
  });

  await t.test('browser session streams stdout and stderr before stdin and preserves EOF/nonzero exit', async t => {
    const session = await BrowserSession.open(base, terminalToken, t);
    session.send({ type: 'start', command: 'printf "ready\\n"; printf "error-ready\\n" >&2; read -r name; printf "hello:%s\\n" "$name"; cat; exit 23',
      cwd: '/mnt/rw', stdin: true, timeoutMs: 15_000 });
    await session.wait(() => session.output('stdout') === 'ready\n' && session.output('stderr') === 'error-ready\n', 'streamed output before stdin');
    assert.equal(session.messages.some(message => message.type === 'exit'), false);
    await session.write(0, 'browser visitor\n');
    await session.wait(() => session.output('stdout').includes('hello:browser visitor\n'), 'output before subsequent stdin');
    await session.write(1, 'tail bytes\n');
    session.send({ type: 'stdin_eof' });
    const result = await session.exit();
    assert.equal(result.exitCode, 23); assert.equal(result.signal, null);
    assert.equal(session.output('stdout'), 'ready\nhello:browser visitor\ntail bytes\n');
    assert.equal(session.output('stderr'), 'error-ready\n');
    assert.ok(session.messages.some(message => message.type === 'stdin_closed'));
    assert.equal(session.messages[0].type, 'started');
  });

  await t.test('browser commands write through the RW mount and cannot modify the RO host mount', async t => {
    const result = await run(t, 'cat /mnt/ro/reference.txt; printf "saved through browser\\n" > result.txt; printf bad > /mnt/ro/reference.txt');
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.stdout, 'protected host reference\n');
    assert.match(result.stderr, /Read-only file system/);
    assert.equal(await fs.readFile(path.join(rw, 'result.txt'), 'utf8'), 'saved through browser\n');
    assert.equal(await fs.readFile(path.join(ro, 'reference.txt'), 'utf8'), 'protected host reference\n');
  });

  await t.test('cancel from the browser protocol kills the running guest command', async t => {
    const session = await BrowserSession.open(base, terminalToken, t);
    session.send({ type: 'start', command: 'printf cancel-ready; sleep 30; printf bad > /mnt/rw/after-cancel', timeoutMs: 60_000 });
    await session.wait(() => session.output('stdout') === 'cancel-ready', 'cancel target');
    session.send({ type: 'cancel' });
    const result = await session.exit();
    assert.equal(result.signal, 9); assert.equal(result.timedOut, false);
    await until(() => vm!.info().activeCommands === 0, 'canceled guest process cleanup');
    await assert.rejects(fs.stat(path.join(rw, 'after-cancel')), { code: 'ENOENT' });
  });

  await t.test('managed HTTPS replaces placeholder credentials and redacts output and activity', async t => {
    const snapshot = await management();
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json()).enabled, true);
    const result = await run(t, request());
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /upstream received Bearer/);
    assert.ok(!result.stdout.includes(secret));
    assert.deepEqual(authorizations, [`Bearer ${secret}`]);
    const state = await (await management()).json();
    const event = state.events.find((event: { path: string }) => event.path === '/ok');
    assert.equal(event.decision, 'allowed'); assert.equal(event.credentialInjected, true);
    const serialized = JSON.stringify(state);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes('browser-query-marker'));
  });

  await t.test('invalid policy updates preserve live access and guestEnv changes require restart', async t => {
    const before = (await (await management()).json()).policy;
    for (const invalid of [{ allow: [{ origin: 'not-an-origin' }] }, { ...config, guestEnv: { GUEST_API_TOKEN: 'different' } }]) {
      const rejected = await management(invalid);
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).error, /unchanged/);
      assert.deepEqual((await (await management()).json()).policy, before);
    }
    const result = await run(t, request());
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /upstream received/);
    assert.equal(authorizations.length, 2);
  });

  await t.test('applying a new policy revokes an existing tunnel and blocks subsequent guest requests', async t => {
    const session = await BrowserSession.open(base, terminalToken, t);
    session.send({ type: 'start', stdin: false, timeoutMs: 15_000, command: `python3 -u - <<'PY'
import os, urllib.request
request = urllib.request.Request('${origin}/stall', headers={'Authorization':'Bearer ' + os.environ['GUEST_API_TOKEN']})
try:
    with urllib.request.urlopen(request, timeout=8) as response:
        print(response.readline().decode(), end='', flush=True)
        response.read()
except Exception:
    print('existing request revoked', flush=True)
PY` });
    await session.wait(() => session.output('stdout').includes('upstream-connected'), 'open upstream tunnel');
    assert.equal(authorizations.length, 3);
    const updated = await management({ allow: [], guestEnv: config.guestEnv });
    assert.equal(updated.status, 200);
    assert.deepEqual((await updated.json()).policy.allow, []);
    const result = await session.exit();
    assert.equal(result.exitCode, 0);
    assert.match(session.output('stdout'), /existing request revoked/);
    const denied = await run(t, request());
    assert.equal(denied.exitCode, 0, denied.stderr);
    assert.equal(denied.stdout, 'request denied\n');
    assert.equal(authorizations.length, 3, 'denied requests must never reach the upstream');
    const state = await (await management()).json();
    assert.ok(state.events.some((event: { decision: string }) => event.decision === 'denied'));
    assert.ok(state.events.some((event: { reason: string }) => event.reason === 'proxy_closed_or_policy_updated'));
    assert.ok(!JSON.stringify(state).includes(secret));
    assert.equal((await management(config)).status, 200);
    const restored = await run(t, request());
    assert.equal(restored.exitCode, 0, restored.stderr);
    assert.match(restored.stdout, /upstream received/);
    assert.equal(authorizations.length, 4);
  });
});
