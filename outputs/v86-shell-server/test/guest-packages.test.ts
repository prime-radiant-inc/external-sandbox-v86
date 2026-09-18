import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';
import { appendGuestBootstrap, normalizePackages } from '../src/guest-packages.js';
import { ShellVM } from '../src/vm.js';

test('startup package names are validated, ordered, deduplicated, and bounded', () => {
  assert.deepEqual(normalizePackages(['uv', 'jq', 'uv', 'py3-pip', 'g++', 'libstdc++', 'p7zip']),
    ['uv', 'jq', 'py3-pip', 'g++', 'libstdc++', 'p7zip']);
  assert.deepEqual(normalizePackages([]), []);
  for (const name of ['', '-u', '--allow-untrusted', 'uv,jq', 'uv jq', '/tmp/file.apk', './foo',
    'https://example.test/file.apk', 'uv=0.5.31', 'uv@edge', 'cmd:uv', 'uv;id', 'uv\n', 'uv\0', '.hidden', 'é', 'a'.repeat(129)]) {
    assert.throws(() => normalizePackages([name]), /package/i, name);
  }
  assert.throws(() => normalizePackages([42 as unknown as string]), /package/i);
  assert.throws(() => normalizePackages(Array.from({ length: 65 }, (_, i) => `package${i}`)), /64/);
  assert.equal(normalizePackages(Array(65).fill('uv')).length, 1);
});

test('bootstrap is a separate gzip newc archive with a root-only JSON file and fixed proxy', () => {
  const original = gzipSync(Buffer.from('existing initramfs bytes'));
  const input = original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength) as ArrayBuffer;
  const output = Buffer.from(appendGuestBootstrap(input, { packages: ['uv', 'jq', 'uv'], caCertificate: 'public-test-ca' }));
  assert.deepEqual(output.subarray(0, original.length), original);
  const archive = gunzipSync(output.subarray(original.length));
  assert.equal(archive.subarray(0, 6).toString(), '070701');
  const fields = Array.from({ length: 13 }, (_, i) => parseInt(archive.toString('ascii', 6 + i * 8, 14 + i * 8), 16));
  assert.equal(fields[1], 0o100600);
  assert.equal(fields[2], 0); assert.equal(fields[3], 0);
  const name = archive.toString('utf8', 110, 110 + fields[11] - 1);
  assert.equal(name, 'etc/v86-bootstrap.json');
  const start = (110 + fields[11] + 3) & ~3;
  assert.deepEqual(JSON.parse(archive.toString('utf8', start, start + fields[6])), {
    version: 1, packages: ['uv', 'jq'], caCertificate: 'public-test-ca', proxyUrl: 'http://192.168.86.1:8080',
  });
  assert.ok(archive.includes(Buffer.from('TRAILER!!!\0')));
  assert.equal(archive.length % 512, 0);
  assert.deepEqual(Buffer.from(input), original, 'base image is never modified');
  assert.throws(() => appendGuestBootstrap(input, { packages: ['uv'], caCertificate: 'a'.repeat(128 * 1024 + 1) }), /certificate/i);
});

test('packages require managed networking and capable images before emulator allocation', async t => {
  await assert.rejects(ShellVM.boot({ image: '/not-read', mounts: [], packages: ['jq'] }), /managed/i);
  await assert.rejects(ShellVM.boot({ image: '/not-read', mounts: [], packages: ['--allow-untrusted'] }), /package/i);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'v86-package-manifest-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(fileURLToPath(new URL('../images/linux/image.json', import.meta.url)), 'utf8'));
  delete manifest.capabilities;
  await writeFile(path.join(temp, 'image.json'), JSON.stringify(manifest));
  await assert.rejects(ShellVM.boot({ image: temp, mounts: [], packages: ['jq'], managedNetwork: {
    proxyPort: 1234, caCertificate: 'public-ca',
  } }), /image.*startup packages/i);
});
