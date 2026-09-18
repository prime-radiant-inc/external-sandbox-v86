import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ShellVM } from '../../src/vm.js';

const image = fileURLToPath(new URL('../../images/linux', import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const metadata = (value: Awaited<ReturnType<typeof fs.stat>>) => ({
  mode: value.mode, uid: value.uid, gid: value.gid,
  mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, size: value.size, nlink: value.nlink,
});

test('real VM enforces read-only mounts while preserving live reads and writable mounts', { timeout: 120_000 }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'v86-mount-modes-'));
  const host = await fs.realpath(temporary);
  const ro = path.join(host, 'read only'), rw = path.join(host, 'read write'), defaultRw = path.join(host, 'default writable');
  let vm: ShellVM | undefined;
  t.after(async () => { await vm?.destroy(); await fs.rm(temporary, { recursive: true, force: true }); });
  for (const directory of [ro, rw, defaultRw]) await fs.mkdir(directory, { mode: 0o777 });
  await fs.chmod(ro, 0o777);
  const files = ['content', 'append', 'truncate', 'rename', 'unlink', 'link-source', 'chmod', 'touch', 'atime', 'alias', 'hardlinked'];
  for (const file of files) {
    await fs.writeFile(path.join(ro, file), `original ${file}\n`, { mode: 0o777 });
    await fs.chmod(path.join(ro, file), 0o777);
  }
  await fs.mkdir(path.join(ro, 'empty-dir'), { mode: 0o777 });
  await fs.writeFile(path.join(rw, 'incoming'), 'writable source\n');
  await fs.symlink('/mnt/ro/content', path.join(rw, 'readonly-link'));
  await fs.link(path.join(ro, 'hardlinked'), path.join(rw, 'readonly-hardlink'));
  vm = await ShellVM.boot({ image, mounts: [
    { name: 'ro', hostPath: ro, mode: 'ro', preservedPaths: [ro] },
    { name: 'rw', hostPath: rw, mode: 'rw', preservedPaths: [rw] },
    { name: 'default', hostPath: defaultRw },
  ] });
  const exec = (command: string) => vm!.execute({ command, cwd: '/workspace' });

  await t.test('read-only mount and preserved alias show live host changes', async () => {
    const first = await exec(`cat /mnt/ro/content ${quote(path.join(ro, 'content'))}`);
    assert.equal(first.exitCode, 0, first.stderr);
    assert.equal(first.stdout, 'original content\noriginal content\n');
    await fs.writeFile(path.join(ro, 'content'), 'host changed this live\n');
    await fs.writeFile(path.join(ro, 'new-from-host'), 'new host file\n');
    const updated = await exec(`cat /mnt/ro/content ${quote(path.join(ro, 'new-from-host'))}`);
    assert.equal(updated.exitCode, 0, updated.stderr);
    assert.equal(updated.stdout, 'host changed this live\nnew host file\n');
  });

  const before = new Map<string, ReturnType<typeof metadata>>();
  for (const name of ['', ...files, 'empty-dir', 'new-from-host']) before.set(name, metadata(await fs.stat(path.join(ro, name))));
  const beforeAtime = (await fs.stat(path.join(ro, 'atime'))).atimeMs;
  const denied: [string, string][] = [
    ['overwrite', "printf bad > /mnt/ro/content"],
    ['append', "printf bad >> /mnt/ro/append"],
    ['truncate', 'truncate -s 0 /mnt/ro/truncate'],
    ['create', "printf bad > /mnt/ro/created"],
    ['mkdir', 'mkdir /mnt/ro/created-dir'],
    ['rename', 'mv /mnt/ro/rename /mnt/ro/renamed'],
    ['unlink', 'rm /mnt/ro/unlink'],
    ['rmdir', 'rmdir /mnt/ro/empty-dir'],
    ['hard link', 'ln /mnt/ro/link-source /mnt/ro/hardlink'],
    ['symlink', 'ln -s content /mnt/ro/symlink'],
    ['chmod file', 'chmod 600 /mnt/ro/chmod'],
    ['touch modification time', 'touch -m -t 200001020304.05 /mnt/ro/touch'],
    ['touch access time', 'touch -a -t 200001020304.05 /mnt/ro/atime'],
    ['chmod root', 'chmod 700 /mnt/ro'],
    ['touch root', 'touch -m -t 200001020304.05 /mnt/ro'],
    ['move into read-only directory', 'mv /mnt/rw/incoming /mnt/ro/incoming'],
    ['write via preserved path', `printf bad > ${quote(path.join(ro, 'alias'))}`],
    ['create via preserved path', `mkdir ${quote(path.join(ro, 'alias-created'))}`],
    ['change root via preserved path', `chmod 700 ${quote(ro)}`],
    ['write via writable-mount symlink', 'printf bad > /mnt/rw/readonly-link'],
    ['write via pre-existing writable-mount hard link', 'printf bad > /mnt/rw/readonly-hardlink'],
    ['chmod via pre-existing writable-mount hard link', 'chmod 600 /mnt/rw/readonly-hardlink'],
    ['unlink pre-existing writable-mount hard link', 'rm /mnt/rw/readonly-hardlink'],
    ['rename pre-existing writable-mount hard link', 'mv /mnt/rw/readonly-hardlink /mnt/rw/renamed-hardlink'],
    ['overwrite pre-existing writable-mount hard link', 'mv /mnt/rw/incoming /mnt/rw/readonly-hardlink'],
  ];
  for (const [operation, command] of denied) {
    await t.test(`read-only mount rejects ${operation}`, async () => {
      const result = await exec(command);
      assert.notEqual(result.exitCode, 0, `${operation} unexpectedly succeeded`);
      assert.equal(result.timedOut, false);
    });
  }

  await t.test('denied operations leave host contents and metadata unchanged', async () => {
    assert.deepEqual((await fs.readdir(ro)).sort(), [...files, 'empty-dir', 'new-from-host'].sort());
    for (const [name, expected] of before) assert.deepEqual(metadata(await fs.stat(path.join(ro, name))), expected, name || 'mount root');
    assert.equal((await fs.stat(path.join(ro, 'atime'))).atimeMs, beforeAtime);
    for (const file of files) assert.equal(await fs.readFile(path.join(ro, file), 'utf8'), file === 'content' ? 'host changed this live\n' : `original ${file}\n`);
    assert.equal(await fs.readFile(path.join(rw, 'incoming'), 'utf8'), 'writable source\n');
    assert.equal(await fs.readFile(path.join(rw, 'readonly-hardlink'), 'utf8'), 'original hardlinked\n');
  });

  await t.test('explicit and default writable mounts still permit ordinary file operations', async () => {
    const result = await exec(`set -e
mkdir /mnt/rw/subdir
printf abc > /mnt/rw/subdir/file
printf d >> /mnt/rw/subdir/file
mv /mnt/rw/subdir/file /mnt/rw/subdir/renamed
chmod 600 /mnt/rw/subdir/renamed
truncate -s 2 /mnt/rw/subdir/renamed
ln -s renamed /mnt/rw/subdir/symlink
cat /mnt/rw/subdir/symlink
rm /mnt/rw/subdir/symlink
printf alias-write > ${quote(path.join(rw, 'through-alias'))}
printf default-write > /mnt/default/new-file`);
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.stdout, 'ab');
    assert.equal(await fs.readFile(path.join(rw, 'subdir/renamed'), 'utf8'), 'ab');
    assert.equal((await fs.stat(path.join(rw, 'subdir/renamed'))).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(path.join(rw, 'through-alias'), 'utf8'), 'alias-write');
    assert.equal(await fs.readFile(path.join(defaultRw, 'new-file'), 'utf8'), 'default-write');
  });

  await t.test('mixed modes reject new hard links without freezing the writable source', async () => {
    const source = path.join(rw, 'subdir/renamed');
    const before = metadata(await fs.stat(source));
    const link = await exec('ln /mnt/rw/subdir/renamed /mnt/rw/subdir/hardlink');
    assert.notEqual(link.exitCode, 0, 'Hard link creation must not produce an immutable writable file');
    assert.match(link.stderr, /read-only file system/i);
    assert.deepEqual(metadata(await fs.stat(source)), before);
    assert.equal((await fs.stat(source)).nlink, 1);
    await assert.rejects(fs.stat(path.join(rw, 'subdir/hardlink')), { code: 'ENOENT' });
    const rewrite = await exec('printf still-writable > /mnt/rw/subdir/renamed');
    assert.equal(rewrite.exitCode, 0, rewrite.stderr);
    assert.equal(await fs.readFile(source, 'utf8'), 'still-writable');
  });
});
