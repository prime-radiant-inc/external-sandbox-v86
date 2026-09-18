import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ShellVM } from '../../src/vm.js';
import { compileProxyPolicy } from '../../src/network/proxy-policy.js';
import { startManagedProxy } from '../../src/network/managed-proxy.js';

const image = fileURLToPath(new URL('../../images/linux', import.meta.url));

test('startup package fetch failures stop boot before unprivileged execution becomes available', { timeout: 60_000 }, async t => {
  const proxy = await startManagedProxy(compileProxyPolicy({ allow: [] }));
  t.after(() => proxy.close());
  const started = performance.now();
  await assert.rejects(ShellVM.boot({ image, mounts: [], packages: ['jq'], bootTimeoutMs: 50_000,
    managedNetwork: { proxyPort: proxy.port, caCertificate: proxy.caCertificate },
  }), /Startup package installation failed/);
  assert.ok(performance.now() - started < 45_000, 'serial fatal marker must fail before boot timeout');
  assert.ok(proxy.snapshot().events.some(event => event.decision === 'denied'));
});

test('startup packages install uv and jq via HTTPS proxy before normal commands run as UID 1000', {
  timeout: 360_000, skip: process.env.V86_TEST_PACKAGE_NETWORK !== '1' && 'Set V86_TEST_PACKAGE_NETWORK=1 for public Alpine repository verification',
}, async t => {
  const proxy = await startManagedProxy(compileProxyPolicy({ allow: [{ origin: 'https://dl-cdn.alpinelinux.org', methods: ['GET', 'HEAD'] }] }));
  t.after(() => proxy.close());
  let bootLog = '';
  const vm = await ShellVM.boot({ image, mounts: [], packages: ['uv', 'jq', 'uv'],
    managedNetwork: { proxyPort: proxy.port, caCertificate: proxy.caCertificate },
    onBootLog: text => { bootLog += text; },
  });
  t.after(() => vm.destroy());
  const result = await vm.execute({ command: `set -e
id -u
uv --version
jq --version
printf '{"answer":42}' | jq -r .answer
uv run --no-project --offline python -c 'print("guest uv executed Python")'
test ! -e /etc/v86-bootstrap.json
test ! -w /etc/apk/repositories
test ! -w /usr/bin/uv
test -r "$SSL_CERT_FILE"
printf 'bootstrap removed; package files protected\\n'
`, timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0, result.stderr + '\n' + bootLog);
  assert.match(result.stdout, /^1000\nuv /);
  assert.match(result.stdout, /jq-\d/);
  assert.match(result.stdout, /\n42\n/);
  assert.match(result.stdout, /guest uv executed Python/);
  assert.match(result.stdout, /bootstrap removed; package files protected/);
  assert.deepEqual(vm.info().packages, ['uv', 'jq']);
  const events = proxy.snapshot().events;
  assert.ok(events.some(event => event.path.includes('/uv-') && event.status === 200));
  assert.ok(events.some(event => event.path.includes('/jq-') && event.status === 200));
  assert.ok(events.every(event => event.origin === 'https://dl-cdn.alpinelinux.org'));
  assert.ok(events.filter(event => event.method !== 'CONNECT').every(event => event.decision === 'allowed'));
  t.diagnostic(result.stdout.trim());
  t.diagnostic(`${events.length} package requests traversed the managed HTTPS proxy`);
});
