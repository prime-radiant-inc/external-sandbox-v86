import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseServerOptions } from '../src/cli-options.js';

test('CLI preserves per-directory modes, including explicit/default read-write', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v86-mount-options-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirs = ['reference', 'project', 'legacy', 'positional', 'after-dash'];
  for (const name of dirs) await mkdir(path.join(root, name));
  const result = await parseServerOptions([
    '--mount-ro', `reference=${root}/reference`, '--mount-rw', `project=${root}/project`,
    '--mount', `legacy=${root}/legacy`, `${root}/positional`, '--preserve-paths', '--', `${root}/after-dash`,
  ]);
  assert.deepEqual(result.mounts.map(m => [m.name, m.mode]), [
    ['reference', 'ro'], ['project', 'rw'], ['legacy', 'rw'], ['positional', 'rw'], ['after-dash', 'rw'],
  ]);
  for (const mount of result.mounts) {
    assert.equal(mount.hostPath, await realpath(path.join(root, mount.name)));
    assert.ok(mount.preservedPaths?.includes(mount.hostPath));
  }
});

test('mount mode options reject missing values and duplicate names', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v86-mount-options-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(parseServerOptions(['--mount-ro']), /needs a value/);
  await assert.rejects(parseServerOptions(['--mount-rw']), /needs a value/);
  await assert.rejects(parseServerOptions(['--mount-ro', `x=${root}`, '--mount-rw', `x=${root}`]), /Duplicate mount name/);
});
