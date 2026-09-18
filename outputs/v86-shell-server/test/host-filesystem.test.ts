import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHostFilesystem } from '../src/host-filesystem.js';

const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s: string) => Buffer.concat([u16(Buffer.byteLength(s)), Buffer.from(s)]);

async function fixture(t: test.TestContext, modes: { left?: 'ro' | 'rw'; right?: 'ro' | 'rw' } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'v86-9p-test-'));
  const left = path.join(base, 'left'), right = path.join(base, 'right');
  await fs.mkdir(left); await fs.mkdir(right);
  const bridge = await createHostFilesystem([{ name: 'left', hostPath: left, mode: modes.left }, { name: 'right', hostPath: right, mode: modes.right }]);
  t.after(async () => { await bridge.close(); await fs.rm(base, { recursive: true, force: true }); });
  let tag = 0;
  async function raw(type: number, ...body: Buffer[]) {
    const data = Buffer.concat(body), request = Buffer.concat([u32(data.length + 7), u8(type), u16(++tag), data]);
    const response = Buffer.from(await new Promise<Uint8Array>(resolve => bridge.handle9p(request, resolve)));
    assert.equal(response.readUInt32LE(0), response.length);
    assert.equal(response.readUInt16LE(5), tag);
    return response;
  }
  async function call(type: number, ...body: Buffer[]) {
    const response = await raw(type, ...body);
    assert.equal(response[4], type + 1, `9P type ${type} failed with errno ${response.length >= 11 ? response.readUInt32LE(7) : '?'}`);
    return response.subarray(7);
  }
  async function error(errno: number, type: number, ...body: Buffer[]) {
    const response = await raw(type, ...body);
    assert.equal(response[4], 7); assert.equal(response.readUInt32LE(7), errno);
  }
  const walk = (from: number, to: number, ...names: string[]) => call(110, u32(from), u32(to), u16(names.length), ...names.map(str));
  const read = async (id: number, offset = 0, count = 100000) => {
    const data = await call(116, u32(id), u64(offset), u32(count));
    assert.equal(data.readUInt32LE(0), data.length - 4); return data.subarray(4);
  };
  const write = (id: number, data: Buffer, offset = 0) => call(118, u32(id), u64(offset), u32(data.length), data);
  const list = async (id: number) => {
    const data = await call(40, u32(id), u64(0), u32(65500));
    const names = []; let i = 4;
    while (i < data.length) { const len = data.readUInt16LE(i + 22); names.push(data.toString('utf8', i + 24, i + 24 + len)); i += 24 + len; }
    return names;
  };
  const attr = (id: number) => call(24, u32(id), u64(0x7ff));
  const setattr = (id: number, valid: number, mode = 0, size = 0) => call(26, u32(id), u32(valid), u32(mode), u32(1000), u32(1000), u64(size), u64(0), u64(0), u64(0), u64(0));
  await call(100, u32(65536), str('9P2000.L'));
  await call(104, u32(0), u32(0xffffffff), str('agent'), str(''), u32(1000));
  await walk(0, 1, 'left'); await walk(0, 2, 'right');
  return { base, left, right, bridge, raw, call, error, walk, read, write, list, attr, setattr };
}

test('host files are live in both directions, including binary writes and truncation', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.left, 'input'), Buffer.from([0, 255, 1, 2]));
  await f.walk(1, 3, 'input'); await f.call(12, u32(3), u32(2));
  assert.deepEqual(await f.read(3), Buffer.from([0, 255, 1, 2]));
  await f.write(3, Buffer.from([9, 8]), 1);
  assert.deepEqual(await fs.readFile(path.join(f.left, 'input')), Buffer.from([0, 9, 8, 2]));
  await fs.writeFile(path.join(f.left, 'input'), 'changed by host');
  assert.equal((await f.read(3)).toString(), 'changed by host');
  await f.setattr(3, 8, 0, 4);
  assert.equal((await fs.readFile(path.join(f.left, 'input'))).toString(), 'chan');
  await f.setattr(3, 1, 0o100640);
  assert.equal((await fs.stat(path.join(f.left, 'input'))).mode & 0o777, 0o640);
  const attr = await f.attr(3);
  assert.equal(attr.length, 153);
  assert.equal(attr.readUInt32LE(25), 1000);
  assert.equal(attr.readBigUInt64LE(49), 4n);
  await f.call(50, u32(3), u32(0));
});

test('create, append, mkdir, rename, hardlink and directory listing reach the host', async t => {
  const f = await fixture(t);
  await f.call(72, u32(1), str('subdir'), u32(0o755), u32(1000));
  await f.walk(1, 3, 'subdir'); await f.walk(3, 4);
  await f.call(14, u32(4), str('new'), u32(2 | 0x80), u32(0o644), u32(1000));
  await f.write(4, Buffer.from('first'));
  await f.call(120, u32(4));
  await f.walk(3, 4, 'new'); await f.call(12, u32(4), u32(1 | 0x400));
  await f.write(4, Buffer.from(' second'));
  assert.equal(await fs.readFile(path.join(f.left, 'subdir/new'), 'utf8'), 'first second');
  await f.call(74, u32(3), str('new'), u32(1), str('renamed'));
  await f.call(70, u32(1), u32(4), str('hardlink'));
  assert.equal((await fs.stat(path.join(f.left, 'renamed'))).ino, (await fs.stat(path.join(f.left, 'hardlink'))).ino);
  await fs.writeFile(path.join(f.left, 'new-on-host'), 'live');
  assert.deepEqual(await f.list(1), ['.', '..', 'hardlink', 'new-on-host', 'renamed', 'subdir']);
  await f.call(12, u32(3), u32(0x10000)); // Linux O_DIRECTORY must translate on macOS too.
  await f.call(76, u32(1), str('subdir'), u32(0x200));
  assert.deepEqual(await f.list(0), ['.', '..', 'left', 'right']);
});

test('symlinks are returned to the guest but never followed by host I/O', async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'secret'); await fs.writeFile(outside, 'outside export');
  await fs.symlink(outside, path.join(f.left, 'escape'));
  await fs.symlink(f.base, path.join(f.left, 'escape-dir'));
  await f.walk(1, 3, 'escape');
  const link = await f.call(22, u32(3)); assert.equal(link.subarray(2).toString(), outside);
  await f.error(40, 12, u32(3), u32(2));
  await f.walk(1, 4);
  await f.error(40, 14, u32(4), str('escape'), u32(1 | 0x200), u32(0o600), u32(1000));
  await f.walk(1, 5, 'escape-dir');
  await f.error(20, 110, u32(5), u32(6), u16(1), str('secret'));
  await f.error(20, 72, u32(5), str('new'), u32(0o755), u32(1000));
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside export');
  await f.call(16, u32(1), str('relative'), str('inside'), u32(1000));
  assert.equal(await fs.readlink(path.join(f.left, 'relative')), 'inside');
  await f.call(76, u32(1), str('escape'), u32(0));
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside export');
});

test('an existing fid cannot be redirected through a parent replaced with a symlink', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.left, 'parent'));
  await fs.writeFile(path.join(f.left, 'parent/file'), 'old');
  await f.walk(1, 3, 'parent', 'file');
  await fs.rename(path.join(f.left, 'parent'), path.join(f.left, 'old-parent'));
  await fs.mkdir(path.join(f.base, 'outside')); await fs.writeFile(path.join(f.base, 'outside/file'), 'secret');
  await fs.symlink(path.join(f.base, 'outside'), path.join(f.left, 'parent'));
  await f.error(40, 12, u32(3), u32(2));
  await f.error(40, 24, u32(3), u64(0x7ff));
});

test('open files remain readable after unlink and directory rename updates fids', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.left, 'dir')); await fs.writeFile(path.join(f.left, 'dir/file'), 'data');
  await f.walk(1, 3, 'dir'); await f.walk(3, 4, 'file'); await f.call(12, u32(4), u32(2));
  await f.call(74, u32(1), str('dir'), u32(1), str('moved'));
  await f.write(4, Buffer.from('new!'));
  assert.equal(await fs.readFile(path.join(f.left, 'moved/file'), 'utf8'), 'new!');
  await f.call(76, u32(3), str('file'), u32(0));
  assert.equal((await f.read(4)).toString(), 'new!');
  assert.equal((await f.attr(4)).readBigUInt64LE(49), 4n);
  await f.call(120, u32(4));
});

test('mount boundaries, malformed names, special nodes and Linux errno are enforced', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.left, 'dir')); await fs.writeFile(path.join(f.left, 'dir/file'), 'data');
  await f.error(18, 74, u32(1), str('dir'), u32(2), str('moved'));
  await f.error(16, 76, u32(0), str('left'), u32(0x200));
  await f.error(39, 76, u32(1), str('dir'), u32(0x200)); // Darwin uses errno 66.
  await f.error(22, 72, u32(1), str('../escape'), u32(0o755), u32(1000));
  await f.error(22, 72, u32(1), str('x\0y'), u32(0o755), u32(1000));
  await f.error(1, 18);
  await f.error(95, 30);
  await f.error(22, 118, u32(1), u64(0), u32(100), Buffer.from('short'));
  await f.walk(1, 3, '..'); assert.deepEqual(await f.list(3), ['.', '..', 'left', 'right']);
  assert.equal((await f.call(8, u32(1))).length, 60);
});

test('read-only mounts remain live for reads while refusing every writable open flag and direct write', async t => {
  const f = await fixture(t, { left: 'ro', right: 'rw' });
  const file = path.join(f.left, 'file'); await fs.writeFile(file, 'initial'); await fs.chmod(file, 0o666);
  await f.walk(1, 3, 'file');
  for (const flags of [1, 2, 0x40, 0x200, 0x400]) await f.error(30, 12, u32(3), u32(flags));
  await f.call(12, u32(3), u32(0));
  assert.equal((await f.read(3)).toString(), 'initial');
  await fs.writeFile(file, 'changed by host');
  assert.equal((await f.read(3)).toString(), 'changed by host');
  await f.error(30, 118, u32(3), u64(0), u32(4), Buffer.from('evil'));
  assert.equal(await fs.readFile(file, 'utf8'), 'changed by host');
  assert.deepEqual(await f.list(1), ['.', '..', 'file']);
  await f.walk(2, 4);
  await f.call(14, u32(4), str('writable'), u32(2), u32(0o644), u32(1000));
  await f.write(4, Buffer.from('allowed'));
  assert.equal(await fs.readFile(path.join(f.right, 'writable'), 'utf8'), 'allowed');
});

test('read-only 9P mutations cannot alter content, metadata, or directory entries', async t => {
  const f = await fixture(t, { left: 'ro' });
  const file = path.join(f.left, 'file'); await fs.writeFile(file, 'original');
  await fs.mkdir(path.join(f.left, 'directory'));
  await f.walk(1, 3, 'file'); await f.walk(1, 4, 'directory');
  const before = await fs.stat(file), rootBefore = await fs.stat(f.left);
  for (const [valid, mode, size] of [[1, 0o600, 0], [8, 0, 0], [16 | 32, 0, 0], [2 | 4, 0, 0]]) {
    await f.error(30, 26, u32(3), u32(valid), u32(mode), u32(1000), u32(1000), u64(size), u64(0), u64(0), u64(0), u64(0));
  }
  await f.error(30, 26, u32(1), u32(1), u32(0o700), u32(1000), u32(1000), u64(0), u64(0), u64(0), u64(0), u64(0));
  await f.error(30, 14, u32(1), str('new'), u32(2), u32(0o644), u32(1000));
  await f.error(30, 72, u32(1), str('newdir'), u32(0o755), u32(1000));
  await f.error(30, 16, u32(1), str('symlink'), str('file'), u32(1000));
  await f.error(30, 70, u32(1), u32(3), str('hardlink'));
  await f.error(30, 70, u32(2), u32(3), str('exported-hardlink'));
  await f.error(30, 20, u32(3), u32(1), str('renamed'));
  await f.error(30, 74, u32(1), str('file'), u32(1), str('renamed'));
  await f.error(30, 76, u32(1), str('file'), u32(0));
  await f.error(30, 76, u32(1), str('directory'), u32(0x200));
  await f.error(30, 122, u32(3));
  await f.error(30, 122, u32(4));
  const after = await fs.stat(file), rootAfter = await fs.stat(f.left);
  for (const key of ['mode', 'size', 'mtimeMs', 'ctimeMs', 'nlink'] as const) assert.equal(after[key], before[key], key);
  for (const key of ['mode', 'mtimeMs', 'ctimeMs', 'nlink'] as const) assert.equal(rootAfter[key], rootBefore[key], `root ${key}`);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(f.left), ['directory', 'file']);
  assert.deepEqual(await fs.readdir(f.right), []);
});

test('rejects mixed-mode canonical aliases and overlapping parents in either input order', async t => {
  const f = await fixture(t);
  const nested = path.join(f.left, 'nested'); await fs.mkdir(nested);
  const alias = path.join(f.base, 'alias'); await fs.symlink(f.left, alias);
  for (const mounts of [
    [{ name: 'ro', hostPath: f.left, mode: 'ro' }, { name: 'rw', hostPath: f.left, mode: 'rw' }],
    [{ name: 'ro', hostPath: f.left, mode: 'ro' }, { name: 'rw', hostPath: alias }],
    [{ name: 'ro', hostPath: nested, mode: 'ro' }, { name: 'rw', hostPath: f.left }],
    [{ name: 'ro', hostPath: f.left, mode: 'ro' }, { name: 'rw', hostPath: nested }],
  ] as const) {
    await assert.rejects(createHostFilesystem([...mounts]), /overlap|read.only/i);
    await assert.rejects(createHostFilesystem([...mounts].reverse()), /overlap|read.only/i);
  }
  const sameMode = await createHostFilesystem([{ name: 'a', hostPath: f.left, mode: 'ro' }, { name: 'b', hostPath: nested, mode: 'ro' }]);
  await sameMode.close();
  await assert.rejects(createHostFilesystem([{ name: 'invalid', hostPath: f.left, mode: 'invalid' as any }]), /mode/i);
});

test('pre-existing hardlinks in writable mounts cannot change read-only files through inode aliases', async t => {
  const f = await fixture(t, { left: 'ro', right: 'rw' });
  const original = path.join(f.left, 'protected'), alias = path.join(f.right, 'alias');
  await fs.writeFile(original, 'protected contents'); await fs.link(original, alias);
  await fs.writeFile(path.join(f.right, 'replacement'), 'replacement');
  await f.walk(2, 3, 'alias'); await f.walk(2, 4, 'replacement');
  const before = await fs.stat(original);
  await f.error(30, 12, u32(3), u32(2));
  await f.error(30, 12, u32(3), u32(0x200));
  for (const valid of [1, 8, 16 | 32]) await f.error(30, 26, u32(3), u32(valid), u32(0o600), u32(1000), u32(1000), u64(0), u64(0), u64(0), u64(0), u64(0));
  await f.error(30, 70, u32(2), u32(3), str('another-alias'));
  await f.error(30, 20, u32(3), u32(2), str('moved'));
  await f.error(30, 20, u32(4), u32(2), str('alias'));
  await f.error(30, 76, u32(2), str('alias'), u32(0));
  await f.error(30, 122, u32(3));
  await f.call(12, u32(3), u32(0));
  await f.error(30, 118, u32(3), u64(0), u32(4), Buffer.from('evil'));
  const after = await fs.stat(original);
  for (const key of ['mode', 'size', 'mtimeMs', 'ctimeMs', 'nlink'] as const) assert.equal(after[key], before[key], key);
  assert.equal((await f.read(3)).toString(), 'protected contents');
});

test('a writable fid is rechecked when the host later adds a read-only hardlink alias', async t => {
  const f = await fixture(t, { left: 'ro', right: 'rw' });
  const writable = path.join(f.right, 'file'), protectedPath = path.join(f.left, 'protected');
  await fs.writeFile(writable, 'before alias');
  await f.walk(2, 3, 'file'); await f.call(12, u32(3), u32(2));
  await f.write(3, Buffer.from('allowed data'));
  await fs.link(writable, protectedPath);
  const before = await fs.stat(protectedPath);
  await f.error(30, 118, u32(3), u64(0), u32(4), Buffer.from('evil'));
  await f.error(30, 26, u32(3), u32(1 | 8), u32(0o600), u32(1000), u32(1000), u64(0), u64(0), u64(0), u64(0), u64(0));
  const after = await fs.stat(protectedPath);
  for (const key of ['mode', 'size', 'mtimeMs', 'ctimeMs', 'nlink'] as const) assert.equal(after[key], before[key], key);
  assert.equal(await fs.readFile(protectedPath, 'utf8'), 'allowed data');
});

test('hardlink creation is refused with any read-only mount without freezing the writable source', async t => {
  const f = await fixture(t, { left: 'ro', right: 'rw' });
  const source = path.join(f.right, 'source'); await fs.writeFile(source, 'original');
  await f.walk(2, 3, 'source');
  await f.error(30, 70, u32(2), u32(3), str('new-link'));
  assert.equal((await fs.stat(source)).nlink, 1);
  await assert.rejects(fs.stat(path.join(f.right, 'new-link')), { code: 'ENOENT' });
  await f.call(12, u32(3), u32(2)); await f.write(3, Buffer.from('updated!'));
  assert.equal(await fs.readFile(source, 'utf8'), 'updated!');
});
