import assert from 'node:assert/strict';
import test from 'node:test';
import { compileProxyPolicy, ProxyPolicyError } from '../src/network/proxy-policy.js';

const origin = 'https://api.openai.com';
const placeholder = 'Bearer 932c633d-1ba4-456c-a69c-a6605dac49ec';
const secret = 'secret-for-policy-tests-only';
const credential = { header: 'authorization', placeholder, secretEnv: 'TEST_API_KEY', prefix: 'Bearer ' };
const requestUrl = new URL(`${origin}/v1/responses`);
const config = { allow: [{ origin, methods: ['POST'], paths: ['/v1/responses'], credential }], guestEnv: { OPENAI_API_KEY: placeholder.slice(7) } };
const secrets = { TEST_API_KEY: secret };

test('injects a host-only credential only for the exact allowed request and placeholder', () => {
  const policy = compileProxyPolicy(config, secrets);
  const incoming = { authorization: placeholder, 'content-type': 'application/json' };
  const permitted = policy.authorize(requestUrl, 'POST', incoming);
  assert.equal(permitted.headers.authorization, `Bearer ${secret}`);
  assert.equal(incoming.authorization, placeholder);
  assert.equal(permitted.rule.origin, origin);
  assert.deepEqual(policy.origins, [origin]);
  assert.deepEqual(policy.guestEnv, config.guestEnv);
  assert.deepEqual(policy.secretValues(), [secret]);
  assert.ok(!JSON.stringify(policy).includes(secret));
  assert.ok(!JSON.stringify(permitted.rule).includes(secret));
});

test('rejects other origins, methods, paths, and credential values without leaking secrets', () => {
  const policy = compileProxyPolicy(config, secrets);
  for (const [url, method, headers] of [
    ['https://api.openai.com.evil.example/v1/responses', 'POST', { authorization: placeholder }],
    ['http://api.openai.com/v1/responses', 'POST', { authorization: placeholder }],
    ['https://api.openai.com:8443/v1/responses', 'POST', { authorization: placeholder }],
    [`${origin}/v1/responses`, 'GET', { authorization: placeholder }],
    [`${origin}/v1/responses/extra`, 'POST', { authorization: placeholder }],
    [`${origin}/v1/responses`, 'POST', {}],
    [`${origin}/v1/responses`, 'POST', { authorization: `Bearer ${secret}` }],
    [`${origin}/v1/responses`, 'POST', { authorization: [placeholder, placeholder] }],
    [`https://username:password@api.openai.com/v1/responses`, 'POST', { authorization: placeholder }],
  ] as const) {
    assert.throws(() => policy.authorize(new URL(url), method, headers as any), error =>
      error instanceof ProxyPolicyError && !error.message.includes(secret));
  }
});

test('permits ordinary HTTP without credentials and preserves noncredential request headers', () => {
  const policy = compileProxyPolicy({ allow: [{ origin: 'http://example.com:8080' }] });
  const result = policy.authorize(new URL('http://example.com:8080/path?x=1'), 'GET', { 'x-example': 'yes' });
  assert.equal(result.headers['x-example'], 'yes');
});

test('rejects malformed and ambiguous configuration with generic errors', () => {
  const invalid = [null, [], {}, { allow: 'any' }, { allow: [], extra: true },
    { allow: [{ origin, unknown: true }] },
    ...['*', 'https://*.example.com', 'https://api.openai.com/', 'https://api.openai.com?x=1',
      'https://u:p@api.openai.com', 'https://api.openai.com.', 'https://a..com',
      'https://bad_host.example', 'https://api.openai.com\r\n', 'ftp://example.com',
      'https://127.1', 'https://0x7f000001', 'https://example.com:0'].map(value => ({ allow: [{ origin: value }] })),
    { allow: [{ origin }, { origin }] },
    { allow: [{ origin, methods: [] }] }, { allow: [{ origin, methods: ['get'] }] },
    { allow: [{ origin, methods: ['GET\r\n'] }] }, { allow: [{ origin, paths: ['relative'] }] },
    { allow: [{ origin, paths: ['/x?query'] }] }, { allow: [{ origin, paths: ['/x\n'] }] },
    { allow: [{ origin, allowCidrs: [] }] }, { allow: [{ origin, allowCidrs: ['127.0.0.1'] }] },
    { allow: [{ origin, allowCidrs: ['10.0.0.0/33'] }] },
    { allow: [{ origin: 'http://example.com', credential }] },
    { allow: [{ origin, credential: { ...credential, header: 'bad header' } }] },
    { allow: [{ origin, credential: { ...credential, header: 'host' } }] },
    { allow: [{ origin, credential: { ...credential, placeholder: 'bad\nvalue' } }] },
    { allow: [{ origin, credential: { ...credential, prefix: 'bad\rvalue' } }] },
    { allow: [{ origin, credential: { ...credential, secretEnv: 'BAD-NAME' } }] },
    { allow: [{ origin, credential: { ...credential, extra: true } }] },
    { allow: [], guestEnv: { 'BAD-NAME': 'value' } },
    { allow: [], guestEnv: { TOKEN: 'value\n' } },
    { allow: [], guestEnv: { TOKEN: 5 } },
  ];
  for (const value of invalid) assert.throws(() => compileProxyPolicy(value, secrets), Error);
  for (const value of [undefined, '', 'bad\r\nvalue']) {
    assert.throws(() => compileProxyPolicy(config, { TEST_API_KEY: value }), error =>
      error instanceof Error && error.message === 'Invalid proxy configuration');
  }
});

test('freezes copied policy configuration against caller mutation', () => {
  const source = { allow: [{ origin, methods: ['POST'], credential: { ...credential } }], guestEnv: { TOKEN: 'guest-token' } };
  const policy = compileProxyPolicy(source, secrets);
  source.allow[0].origin = 'https://evil.example';
  source.allow[0].methods.push('DELETE');
  source.allow[0].credential.placeholder = 'new-value';
  source.guestEnv.TOKEN = secret;
  assert.equal(policy.authorize(requestUrl, 'POST', { authorization: placeholder }).headers.authorization, `Bearer ${secret}`);
  assert.throws(() => policy.authorize(requestUrl, 'DELETE', { authorization: placeholder }));
  assert.equal(policy.guestEnv.TOKEN, 'guest-token');
});

test('rejects actual secret values accidentally exposed in placeholders or guest environments', () => {
  for (const exposed of [
    { ...config, allow: [{ origin, credential: { ...credential, placeholder: `Bearer ${secret}` } }] },
    { ...config, guestEnv: { OPENAI_API_KEY: secret } },
    { ...config, guestEnv: { DEBUG: `configured ${secret} here` } },
    { allow: [
      { origin, credential },
      { origin: 'https://another.example', credential: { ...credential, placeholder: secret, secretEnv: 'SECOND_KEY' } },
    ] },
  ]) {
    assert.throws(() => compileProxyPolicy(exposed, { ...secrets, SECOND_KEY: 'other-test-secret' }),
      error => error instanceof Error && error.message === 'Invalid proxy configuration');
  }
});

test('bounds origin, environment, and credential configuration size', () => {
  const origins = (count: number) => Array.from({ length: count }, (_, i) => ({ origin: `https://host${i}.example` }));
  assert.equal(compileProxyPolicy({ allow: origins(64) }).origins.length, 64);
  assert.throws(() => compileProxyPolicy({ allow: origins(65) }));
  const guestEnv = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`VALUE_${i}`, 'x']));
  assert.throws(() => compileProxyPolicy({ allow: [], guestEnv }));
  assert.throws(() => compileProxyPolicy({ allow: [], guestEnv: { TOKEN: 'x'.repeat(16385) } }));
  assert.throws(() => compileProxyPolicy({ allow: [], guestEnv: { TOKEN: 'é'.repeat(8193) } }));
  assert.throws(() => compileProxyPolicy(config, { TEST_API_KEY: 'x'.repeat(16385) }));
  assert.throws(() => compileProxyPolicy({ allow: [{ origin, credential: { ...credential, placeholder: 'x'.repeat(16385) } }] }, secrets));
});

async function resolveAddress(address: string, allowCidrs?: string[]) {
  const policy = compileProxyPolicy({ allow: [{ origin, ...(allowCidrs ? { allowCidrs } : {}) }] }, {}, {
    lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
  });
  return policy.resolve(requestUrl, policy.authorize(requestUrl, 'GET', {}).rule);
}

test('default address policy permits public IPv4 and IPv6 and blocks special-purpose addresses', async () => {
  assert.deepEqual(await resolveAddress('8.8.8.8'), { address: '8.8.8.8', family: 4 });
  assert.deepEqual(await resolveAddress('2606:4700:4700::1111'), { address: '2606:4700:4700::1111', family: 6 });
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.0.0.8', '192.0.2.1', '192.168.0.1', '198.18.0.1', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1',
    'ff02::1', '2001:db8::1', '2001::1', '2002:7f00:1::', '3fff::1', '64:ff9b::7f00:1',
    '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    await assert.rejects(resolveAddress(address), ProxyPolicyError, address);
  }
});

test('explicit CIDRs permit only listed ranges, including private networks and mapped IPv4', async () => {
  assert.deepEqual(await resolveAddress('10.4.3.2', ['10.0.0.0/8']), { address: '10.4.3.2', family: 4 });
  assert.deepEqual(await resolveAddress('::ffff:10.4.3.2', ['10.0.0.0/8']), { address: '10.4.3.2', family: 4 });
  assert.deepEqual(await resolveAddress('::ffff:a04:302', ['::ffff:10.0.0.0/104']), { address: '10.4.3.2', family: 4 });
  await assert.rejects(resolveAddress('8.8.8.8', ['10.0.0.0/8']), ProxyPolicyError);
  await assert.rejects(resolveAddress('10.4.3.2', ['2000::/3']), ProxyPolicyError);
});

test('looks up all DNS answers once and only returns a permitted pinned address', async () => {
  let lookups = 0;
  const policy = compileProxyPolicy({ allow: [{ origin }] }, {}, {
    lookup: async hostname => {
      lookups++;
      assert.equal(hostname, 'api.openai.com');
      return [{ address: '127.0.0.1', family: 4 }, { address: '8.8.4.4', family: 4 }];
    },
  });
  const { rule } = policy.authorize(requestUrl, 'GET', {});
  assert.deepEqual(await policy.resolve(requestUrl, rule), { address: '8.8.4.4', family: 4 });
  assert.equal(lookups, 1);
  await assert.rejects(policy.resolve(new URL('https://evil.example/'), rule), ProxyPolicyError);
  await assert.rejects(policy.resolve(requestUrl, { origin }), ProxyPolicyError);
});

test('IP literal origins bypass DNS and still enforce destination policy', async () => {
  const policy = compileProxyPolicy({ allow: [{ origin: 'https://[::1]:8443', allowCidrs: ['::1/128'] }] }, {}, {
    lookup: async () => { throw new Error('DNS must not be used'); },
  });
  const url = new URL('https://[::1]:8443/path');
  assert.deepEqual(await policy.resolve(url, policy.authorize(url, 'GET', {}).rule), { address: '::1', family: 6 });
});
