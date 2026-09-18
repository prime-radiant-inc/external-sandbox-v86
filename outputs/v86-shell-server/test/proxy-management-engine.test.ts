import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { compileProxyPolicy } from '../src/network/proxy-policy.js';
import { startManagedProxy } from '../src/network/managed-proxy.js';
import { createCertificateAuthority } from '../src/network/certificates.js';

const secret = 'host-only-management-secret';
const laterSecret = 'host-only-newly-loaded-secret';
const credential = { header: 'Authorization', placeholder: 'Bearer fake-uuid', secretEnv: 'TOKEN', prefix: 'Bearer ' };
const credentialRule = { origin: 'https://credential.test', credential };

async function fixture(t: test.TestContext, options: { lookup?: () => Promise<{address: string; family: 4}[]> } = {}) {
  const requested: string[] = [];
  const streams: http.ServerResponse[] = [];
  const upstream = http.createServer((req, res) => {
    requested.push(req.url!);
    if (req.url === '/stream') { streams.push(res); res.write('first\n'); }
    else res.end('ok');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const origin = `http://fixture.test:${(upstream.address() as net.AddressInfo).port}`;
  const rule = { origin, allowCidrs: ['127.0.0.1/32'] };
  const config = { allow: [rule, credentialRule], guestEnv: { TOKEN: 'fake-uuid' } };
  const policy = compileProxyPolicy(config, { TOKEN: secret, NEW_TOKEN: laterSecret }, {
    lookup: options.lookup ?? (async () => [{address: '127.0.0.1', family: 4}]),
  });
  const proxy = await startManagedProxy(policy);
  t.after(async () => {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  return { proxy, policy, config, rule, origin, requested, streams };
}

function request(port: number, url: string): Promise<{status: number; body: string}> {
  return new Promise((resolve, reject) => {
    const req = http.get({hostname: '127.0.0.1', port, path: url, agent: false, headers: {host: new URL(url).host}}, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({status: res.statusCode!, body}));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

test('compiled policy exposes copied normalized configuration and retains private host compilation inputs', async () => {
  const hostSecrets = { TOKEN: secret, NEW_TOKEN: laterSecret };
  let lookups = 0;
  const policy = compileProxyPolicy({allow: [credentialRule], guestEnv: { TOKEN: 'fake-uuid' }}, hostSecrets, {
    lookup: async () => { lookups++; return [{address: '8.8.8.8', family: 4}]; },
  });
  const snapshot = policy.configuration();
  assert.equal(snapshot.allow[0].credential?.header, 'authorization');
  snapshot.guestEnv!.TOKEN = 'changed';
  assert.equal(policy.configuration().guestEnv!.TOKEN, 'fake-uuid');
  hostSecrets.NEW_TOKEN = 'changed-after-start';
  const replacement = policy.replacement({allow: [{...credentialRule, credential: {...credential, secretEnv: 'NEW_TOKEN'}}]});
  const url = new URL('https://credential.test/');
  const authorized = replacement.authorize(url, 'GET', {authorization: credential.placeholder});
  assert.equal(authorized.headers.authorization, `Bearer ${laterSecret}`);
  await replacement.resolve(url, authorized.rule);
  assert.equal(lookups, 1);
  assert.equal(JSON.stringify(policy).includes(secret), false);
});

test('management configuration redacts accidental secret appearances without exposing internal key values', () => {
  const policy = compileProxyPolicy({allow: [{...credentialRule, paths: [`/${secret}`]}]}, {TOKEN: secret});
  assert.deepEqual(policy.configuration().allow[0].paths, ['/[REDACTED]']);
  assert.equal(JSON.stringify(policy.configuration()).includes(secret), false);
  assert.equal(JSON.stringify(policy).includes(secret), false);
});

test('ephemeral leaf certificate cache can be cleared without changing its trusted CA', () => {
  const ca = createCertificateAuthority();
  const originalCertificate = ca.certificate;
  const first = ca.issue('upstream.test');
  assert.equal(ca.issue('upstream.test'), first);
  ca.clearCache();
  const replacement = ca.issue('upstream.test');
  assert.notEqual(replacement.certificate, first.certificate);
  assert.equal(ca.certificate, originalCertificate);
});

test('live policy updates validate atomically, preserve guestEnv, and apply without restarting the listener', async t => {
  const f = await fixture(t);
  assert.equal((await request(f.proxy.port, f.origin + '/before')).status, 200);
  for (const config of [{allow: 'bad'}, {allow: [], guestEnv: {TOKEN: 'changed'}}]) {
    assert.throws(() => f.proxy.updatePolicy(config));
    assert.equal((await request(f.proxy.port, f.origin + '/unchanged')).status, 200);
  }
  f.proxy.updatePolicy({allow: [], guestEnv: f.config.guestEnv});
  assert.equal((await request(f.proxy.port, f.origin + '/denied')).status, 403);
  f.proxy.updatePolicy(f.config);
  assert.equal((await request(f.proxy.port, f.origin + '/restored')).status, 200);
  assert.deepEqual(f.requested, ['/before', '/unchanged', '/unchanged', '/restored']);
});

test('activity omits queries and bodies, records decisions, and redacts current and newly configured secrets', async t => {
  const f = await fixture(t);
  await request(f.proxy.port, `${f.origin}/${secret}/${laterSecret}?private=query-value`);
  await request(f.proxy.port, 'http://denied.test/private?token=query-secret');
  let snapshot = f.proxy.snapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.events.length, 2);
  assert.deepEqual(snapshot.events.map(event => [event.decision, event.status, event.reason]),
    [['allowed', 200, 'completed'], ['denied', 403, 'policy_denied']]);
  assert.equal(snapshot.events[0].credentialInjected, false);
  assert.ok(snapshot.events[0].durationMs >= 0);
  assert.ok(Date.parse(snapshot.events[0].timestamp));
  assert.equal(snapshot.events[0].path, `/[REDACTED]/${laterSecret}`);
  assert.equal(JSON.stringify(snapshot).includes('query-value'), false);
  assert.equal(JSON.stringify(snapshot).includes('query-secret'), false);
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  f.proxy.updatePolicy({ ...f.config, allow: [f.rule, {...credentialRule, credential: {...credential, secretEnv: 'NEW_TOKEN'}}] });
  snapshot = f.proxy.snapshot();
  assert.equal(snapshot.events[0].path, '/[REDACTED]/[REDACTED]');
  snapshot.events[0].path = 'mutated';
  assert.equal(f.proxy.snapshot().events[0].path, '/[REDACTED]/[REDACTED]');
  f.proxy.updatePolicy({allow: [], guestEnv: f.config.guestEnv});
  assert.equal(f.proxy.snapshot().events[0].path, '/[REDACTED]/[REDACTED]', 'removing a credential must not uncover a historical secret');
});

test('activity is bounded to 500 events, and redaction happens before display truncation', async t => {
  const longSecret = 's'.repeat(3000);
  const policy = compileProxyPolicy({allow: [credentialRule]}, {TOKEN: longSecret});
  const proxy = await startManagedProxy(policy);
  t.after(() => proxy.close());
  for (let i = 0; i < 502; i++) await request(proxy.port, `http://denied.test/${i}/${longSecret}`);
  const events = proxy.snapshot().events;
  assert.equal(events.length, 500);
  assert.equal(events[0].path, '/2/[REDACTED]');
  assert.equal(events[499].path, '/501/[REDACTED]');
});

test('applying a policy closes in-flight upstream responses and idle proxy sockets', {timeout: 5000}, async t => {
  const f = await fixture(t);
  const idle = net.connect(f.proxy.port, '127.0.0.1');
  await once(idle, 'connect');
  const idleClosed = once(idle, 'close');
  const req = http.get({hostname: '127.0.0.1', port: f.proxy.port, path: f.origin + '/stream', headers: {host: new URL(f.origin).host}});
  req.on('error', () => {});
  const [res] = await once(req, 'response');
  res.on('error', () => {});
  await once(res, 'data');
  const clientClosed = new Promise<void>(resolve => res.once('close', resolve));
  const upstreamClosed = new Promise<void>(resolve => f.streams[0].once('close', resolve));
  f.proxy.updatePolicy({allow: [], guestEnv: f.config.guestEnv});
  await Promise.all([idleClosed, clientClosed, upstreamClosed]);
  assert.equal(f.proxy.snapshot().events.at(-1)?.reason, 'proxy_closed_or_policy_updated');
});

test('a DNS lookup already in flight cannot connect upstream after its policy is revoked', {timeout: 5000}, async t => {
  const started = Promise.withResolvers<void>();
  const resolved = Promise.withResolvers<{address: string; family: 4}[]>();
  const f = await fixture(t, {lookup: () => { started.resolve(); return resolved.promise; }});
  const pending = request(f.proxy.port, f.origin + '/race').catch(() => null);
  await started.promise;
  f.proxy.updatePolicy({allow: [], guestEnv: f.config.guestEnv});
  resolved.resolve([{address: '127.0.0.1', family: 4}]);
  await pending;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.requested, []);
  assert.equal(f.proxy.snapshot().events.at(-1)?.reason, 'proxy_closed_or_policy_updated');
});

test('updates revoke TLS streams and tunnels, retain upstream trust, and use replacement credentials', {timeout: 5000}, async t => {
  const ca = createCertificateAuthority();
  const leaf = ca.issue('upstream.test');
  const requests: string[] = [];
  let stream!: http.ServerResponse;
  const upstream = https.createServer({key: leaf.privateKey, cert: leaf.certificate}, (req, res) => {
    requests.push(req.headers.authorization!);
    if (req.url === '/stream') { stream = res; res.write('first\n'); }
    else res.end('ok');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const origin = `https://upstream.test:${(upstream.address() as net.AddressInfo).port}`;
  const rule = {origin, allowCidrs: ['127.0.0.1/32'], credential};
  const proxy = await startManagedProxy(compileProxyPolicy({allow: [rule]}, {TOKEN: secret, NEW_TOKEN: laterSecret},
    {lookup: async () => [{address: '127.0.0.1', family: 4}]}), {upstreamCa: ca.certificate});
  t.after(async () => { await proxy.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  async function tunnel() {
    const raw = net.connect(proxy.port, '127.0.0.1');
    await once(raw, 'connect');
    raw.write(`CONNECT ${new URL(origin).host} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\n\r\n`);
    assert.match(String((await once(raw, 'data'))[0]), /200 Connection Established/);
    const secure = tls.connect({socket: raw, servername: 'upstream.test', ca: proxy.caCertificate});
    await once(secure, 'secureConnect');
    return secure;
  }
  const idle = await tunnel();
  const active = await tunnel();
  active.write(`GET /stream HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nAuthorization: ${credential.placeholder}\r\n\r\n`);
  assert.match(String((await once(active, 'data'))[0]), /first/);
  const allClosed = Promise.all([once(idle, 'close'), once(active, 'close'), once(stream, 'close')]);
  proxy.updatePolicy({allow: [{...rule, credential: {...credential, secretEnv: 'NEW_TOKEN'}}]});
  await allClosed;
  assert.equal(proxy.snapshot().events[0].credentialInjected, true);
  assert.equal(proxy.snapshot().events[0].reason, 'proxy_closed_or_policy_updated');
  const updated = await tunnel();
  updated.write(`GET / HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nAuthorization: ${credential.placeholder}\r\nConnection: close\r\n\r\n`);
  let response = '';
  updated.on('data', chunk => { response += chunk; });
  await once(updated, 'end');
  assert.match(response, /^HTTP\/1.1 200/);
  assert.match(response, /ok/);
  assert.deepEqual(requests, [`Bearer ${secret}`, `Bearer ${laterSecret}`]);
  assert.equal(proxy.snapshot().events.at(-1)?.credentialInjected, true);
  assert.equal(proxy.snapshot().events.at(-1)?.decision, 'allowed');
});
