import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyUiAssets, verifyUiBundle } from '../scripts/copy-ui-assets.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'v86-ui-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const destination = join(root, 'dist');
  await cp(new URL('../src/ui/shared/', import.meta.url), source, { recursive: true });
  return { source, destination };
}

test('the build verifies the full bundle and ships only runtime assets with provenance', async t => {
  const { source, destination } = await fixture(t);
  const manifest = await copyUiAssets(source, destination);
  assert.ok(Object.keys(manifest.files).some(name => name.startsWith('test/')));
  assert.deepEqual((await readdir(destination)).sort(), ['assets', 'manifest.json', 'package.json']);
  assert.deepEqual((await readdir(join(destination, 'assets'))).sort(), ['proxy.html', 'terminal.html', 'terminal.js']);
  assert.equal(await readFile(join(destination, 'manifest.json'), 'utf8'), await readFile(join(source, 'manifest.json'), 'utf8'));
  for (const name of ['proxy.html', 'terminal.html', 'terminal.js']) {
    assert.deepEqual(await readFile(join(destination, 'assets', name)), await readFile(join(source, 'assets', name)));
  }
});

test('changed shared assets fail verification before replacing an existing build', async t => {
  const { source, destination } = await fixture(t);
  await mkdir(destination);
  await writeFile(join(destination, 'previous-build'), 'preserve until verified');
  await writeFile(join(source, 'assets', 'terminal.js'), 'changed local copy');
  await assert.rejects(copyUiAssets(source, destination), /digest mismatch: assets\/terminal.js/);
  assert.equal(await readFile(join(destination, 'previous-build'), 'utf8'), 'preserve until verified');
});

test('missing tests and unrecorded files fail source bundle verification', async t => {
  const { source } = await fixture(t);
  await writeFile(join(source, 'extra.js'), 'unrecorded');
  await assert.rejects(verifyUiBundle(source), /manifest file list/);
  await rm(join(source, 'extra.js'));
  await rm(join(source, 'test'), { recursive: true });
  await assert.rejects(verifyUiBundle(source), /manifest file list/);
});
