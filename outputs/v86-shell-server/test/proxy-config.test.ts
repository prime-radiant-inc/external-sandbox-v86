import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadProxyPolicy } from '../src/network/proxy-config.js';

test('proxy configuration loads host secrets without exporting them to guest settings', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v86-proxy-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'policy.json');
  const token = 'c911750a-76e3-481b-81c0-cddc95630d9d';
  await writeFile(file, JSON.stringify({
    allow: [{ origin: 'https://api.example.com', credential: {
      header: 'authorization', placeholder: `Bearer ${token}`, secretEnv: 'EXAMPLE_API_KEY', prefix: 'Bearer ',
    } }],
    guestEnv: { EXAMPLE_API_KEY: token },
  }));
  const policy = await loadProxyPolicy(file, { EXAMPLE_API_KEY: 'host-secret-sentinel' });
  assert.deepEqual(policy.guestEnv, { EXAMPLE_API_KEY: token });
  const request = policy.authorize(new URL('https://api.example.com/v1/test'), 'POST', { authorization: `Bearer ${token}` });
  assert.equal(request.headers.authorization, 'Bearer host-secret-sentinel');
  assert.equal(JSON.stringify(policy.guestEnv).includes('host-secret-sentinel'), false);
  await assert.rejects(loadProxyPolicy(file, {}), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes('host-secret-sentinel'), false);
    return true;
  });
});

test('configuration parse failures do not echo file contents and reject oversized files', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v86-proxy-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'policy.json');
  await writeFile(file, '{"accidental-secret":"never-print-this"');
  await assert.rejects(loadProxyPolicy(file), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Invalid proxy configuration JSON/);
    assert.equal(error.message.includes('never-print-this'), false);
    return true;
  });
  await writeFile(file, ' '.repeat(256 * 1024 + 1));
  await assert.rejects(loadProxyPolicy(file), /256 KiB/);
});
