import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ShellVM } from '../../src/vm.js';
import { createApiServer } from '../../src/http.js';
import { createCertificateAuthority } from '../../src/network/certificates.js';
import { compileProxyPolicy } from '../../src/network/proxy-policy.js';
import { startManagedProxy } from '../../src/network/managed-proxy.js';
const image = fileURLToPath(new URL('../../images/linux', import.meta.url));

test('real VM reaches only its managed proxy and receives proxy environment', { timeout: 90_000 }, async t => {
  const originalFetch = globalThis.fetch; let unexpectedFetch = 0;
  globalThis.fetch = (() => { unexpectedFetch++; return Promise.reject(new Error('Unexpected host fetch outside managed proxy')); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests: string[] = [];
  const proxy = createServer((request, response) => { requests.push(request.url!); response.end('through managed proxy'); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
  const vm = await ShellVM.boot({ image, mounts: [], managedNetwork: {
    proxyPort: (proxy.address() as { port: number }).port, caCertificate: 'public certificate test fixture', env: { PLACEHOLDER_TOKEN: 'placeholder-only' },
  } });
  t.after(() => vm.destroy());
  assert.equal(vm.info().network, 'managed-http');
  const response = await vm.execute({ command: `python3 - <<'PY'
import os, urllib.request
assert os.environ['http_proxy'] == 'http://192.168.86.1:8080'
assert os.environ['https_proxy'] == os.environ['http_proxy']
assert os.environ['no_proxy'] == ''
assert os.environ['PLACEHOLDER_TOKEN'] == 'placeholder-only'
print(urllib.request.urlopen('http://allowed.example/hello', timeout=5).read().decode())
PY` });
  assert.equal(response.exitCode, 0, response.stderr); assert.equal(response.stdout, 'through managed proxy\n');
  assert.deepEqual(requests, ['http://allowed.example/hello']);
  const denied = await vm.execute({ command: `python3 - <<'PY'
import socket, struct
for host, port in [('203.0.113.1',443), ('192.168.86.1',443), ('127.0.0.1',${(proxy.address() as { port: number }).port})]:
    try:
        with socket.create_connection((host,port),timeout=1) as connection:
            connection.sendall(b'GET / HTTP/1.0\\r\\n\\r\\n')
            assert not connection.recv(1024), 'unexpected raw network response'
    except OSError:
        pass
print('direct network blocked')
query = struct.pack('!HHHHHH', 1234, 0x0100, 1, 0, 0, 0) + b'\\x04leak\\x07example\\x00' + struct.pack('!HH', 1, 1)
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as dns:
    dns.settimeout(2)
    dns.sendto(query, ('8.8.8.8', 53))
    reply, _ = dns.recvfrom(4096)
    assert reply.endswith(bytes([192,168,87,1]))
print('DNS stayed internal')
PY` });
  assert.equal(denied.exitCode, 0, denied.stderr); assert.equal(denied.stdout, 'direct network blocked\nDNS stayed internal\n');
  assert.equal(requests.length, 1);
  assert.equal(unexpectedFetch, 0, 'v86 must never use its host DoH fetch path');
});

test('uv client streams real guest HTTPS requests with scoped UUID substitution', { timeout: 120_000 }, async t => {
  const upstreamCa = createCertificateAuthority();
  const certificate = upstreamCa.issue('upstream.test');
  const secret = 'sk-local-fixture-' + randomUUID(), placeholder = randomUUID();
  const authorizations: string[] = [];
  let upstreamFinished = false, firstOutputBeforeFinish = false;
  const upstream = createHttpsServer({ key: certificate.privateKey, cert: certificate.certificate }, (request, response) => {
    authorizations.push(String(request.headers.authorization));
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('first HTTPS chunk\n');
    setTimeout(() => { upstreamFinished = true; response.end('second HTTPS chunk\n'); }, 600);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const origin = `https://upstream.test:${upstreamPort}`;
  const policy = compileProxyPolicy({ allow: [{ origin, methods: ['GET'], paths: ['/stream'], allowCidrs: ['127.0.0.1/32'], credential: {
    header: 'authorization', placeholder: `Bearer ${placeholder}`, secretEnv: 'FIXTURE_SECRET', prefix: 'Bearer ',
  } }], guestEnv: { OPENAI_API_KEY: placeholder } }, { FIXTURE_SECRET: secret }, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  const proxy = await startManagedProxy(policy, { upstreamCa: upstreamCa.certificate });
  t.after(() => proxy.close());
  const vm = await ShellVM.boot({ image, mounts: [], managedNetwork: { proxyPort: proxy.port, caCertificate: proxy.caCertificate, env: policy.guestEnv } });
  t.after(() => vm.destroy());
  const api = createApiServer(vm); api.listen(0, '127.0.0.1'); await once(api, 'listening');
  t.after(() => new Promise<void>(resolve => { api.closeAllConnections(); api.close(() => resolve()); }));
  const command = `python3 - <<'PY'
import os, sys, urllib.request
print('guest stderr is streamed', file=sys.stderr, flush=True)
request = urllib.request.Request('${origin}/stream', headers={'Authorization':'Bearer ' + os.environ['OPENAI_API_KEY']})
with urllib.request.urlopen(request, timeout=10) as response:
    for line in response:
        print(line.decode().rstrip(), flush=True)
PY`;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('uv', ['run', '--quiet', '--offline', fileURLToPath(new URL('../../scripts/remote_sandbox_exec.py', import.meta.url)), '--no-stdin', command], {
      env: { ...process.env, REMOTE_SANDBOX_API_URL: `http://127.0.0.1:${(api.address() as { port: number }).port}`, REMOTE_SANDBOX_CWD: '/workspace' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; if (stdout.includes('first HTTPS chunk') && !upstreamFinished) firstOutputBeforeFinish = true; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'first HTTPS chunk\nsecond HTTPS chunk\n');
  assert.equal(result.stderr, 'guest stderr is streamed\n');
  assert.equal(firstOutputBeforeFinish, true, 'first chunk must arrive before upstream completes');
  assert.deepEqual(authorizations, [`Bearer ${secret}`]);
  assert.ok(!JSON.stringify(result).includes(secret));
  const blocked = await vm.execute({ command: `python3 - <<'PY'
import urllib.request, urllib.error
try:
    urllib.request.urlopen('https://denied.test/', timeout=5)
    raise AssertionError('denied origin was reached')
except urllib.error.URLError:
    print('denied origin blocked')
PY` });
  assert.equal(blocked.exitCode, 0, blocked.stderr); assert.equal(blocked.stdout, 'denied origin blocked\n');
  assert.equal(authorizations.length, 1);
});

test('large downloads stream while stalled readers leave v86 buffers bounded', { timeout: 90_000 }, async t => {
  const proxy = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(Buffer.alloc(8 * 1024 * 1024, 65));
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
  const vm = await ShellVM.boot({ image, mounts: [], managedNetwork: {
    proxyPort: (proxy.address() as { port: number }).port, caCertificate: 'public certificate test fixture',
  } });
  t.after(() => vm.destroy());
  let ready!: () => void;
  const connected = new Promise<void>(resolve => { ready = resolve; });
  const stalled = await vm.start({ command: `python3 - <<'PY'
import socket, time
connection = socket.create_connection(('192.168.86.1',8080),timeout=5)
connection.sendall(b'GET http://allowed.example/large HTTP/1.1\\r\\nHost: allowed.example\\r\\n\\r\\n')
print('connected', flush=True)
time.sleep(30)
PY`, timeoutMs: 35_000, stdin: false }, (_stream, data) => { if (Buffer.from(data).toString().includes('connected')) ready(); });
  await connected;
  await new Promise(resolve => setTimeout(resolve, 500));
  // The guard deliberately depends on this pinned internal v86 layout. Check
  // the real implementation, including buffers that WebSocket limits cannot see.
  const adapter = (vm as unknown as { emulator: { network_adapter: { tcp_conn: Record<string, { send_buffer: { length: number; buffer: Uint8Array } }> } } }).emulator.network_adapter;
  const queues = Object.values(adapter.tcp_conn).map(connection => connection.send_buffer);
  assert.ok(queues.length > 0);
  assert.ok(queues.every(queue => queue.length <= 128 * 1024));
  assert.equal(vm.info().status, 'ready');
  stalled.cancel(); await stalled.completion;
  const result = await vm.execute({ command: `python3 - <<'PY'
import urllib.request
with urllib.request.urlopen('http://allowed.example/large',timeout=20) as response:
    data = response.read()
assert len(data) == 8 * 1024 * 1024
assert data == b'A' * len(data)
print('downloaded 8388608 bytes')
PY`, timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, 'downloaded 8388608 bytes\n');
  assert.equal(vm.info().status, 'ready');
});
