import assert from 'node:assert/strict';
import test from 'node:test';
import { parseServerOptions } from '../src/cli-options.js';

test('startup package flags support comma lists, equals syntax, repetition and deduplication', async () => {
  const result = await parseServerOptions(['--proxy-config', 'policy.json', '--packages', 'uv,jq', '--packages=ripgrep,uv']);
  assert.deepEqual(result.packages, ['uv', 'jq', 'ripgrep']);
  assert.deepEqual((await parseServerOptions([])).packages, []);
});

test('startup package flags reject unsafe names and require an explicit managed proxy', async () => {
  await assert.rejects(parseServerOptions(['--packages', 'uv']), /proxy-config/);
  for (const value of ['', 'uv,', ',uv', '--allow-untrusted', 'uv;id', '../uv', 'https://example.com/uv.apk', 'uv jq', 'uv=1']) {
    await assert.rejects(parseServerOptions(['--proxy-config', 'policy.json', '--packages', value]), /package/i);
  }
  await assert.rejects(parseServerOptions(['--packages']), /needs a value/);
  assert.equal((await parseServerOptions(['--packages', 'uv', '--help'])).help, true);
});
