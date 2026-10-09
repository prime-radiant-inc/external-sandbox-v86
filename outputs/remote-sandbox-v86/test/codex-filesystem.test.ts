import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createCodexFilesystem, guestPathFromUri, guestPathToUri } from '../src/codex/filesystem.js';

const CHUNK = 49152;
const MAX_FILE = 8 * 1024 * 1024;
const error = (code: string) => Object.assign(new Error(code), { code });

function fixture() {
  const files = new Map<string, Buffer>([['/work/file', Buffer.from([0, 255, 1, 2])]]);
  const directories = new Set(['/', '/work']);
  const links = new Map<string, string>();
  const modes = new Map<string, number>();
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  async function request(method: string, params: Record<string, any>): Promise<any> {
    calls.push({ method, params: { ...params } });
    const original = params.path as string;
    const filePath = params.follow === false ? original : links.get(original) ?? original;
    const kind = links.has(filePath) ? 'symlink' : files.has(filePath) ? 'file' : directories.has(filePath) ? 'directory' : undefined;
    if (method === 'fs.getMetadata') {
      if (!kind) throw error('ENOENT');
      return { kind, size: files.get(filePath)?.length ?? 0, mode: modes.get(filePath) ?? 0o644, mtimeMs: 123000 };
    }
    if (method === 'fs.canonicalize') {
      if (!kind) throw error('ENOENT');
      return { path: links.get(original) ?? original };
    }
    if (method === 'fs.readFile') {
      if (kind === 'symlink') throw error('ELOOP');
      const contents = files.get(filePath); if (!contents) throw error('ENOENT');
      const chunk = contents.subarray(params.offset, params.offset + params.length);
      return { data: chunk.toString('base64'), eof: params.offset + chunk.length >= contents.length };
    }
    if (method === 'fs.writeFile') {
      if (kind === 'symlink') throw error('ELOOP');
      if (files.has(filePath) && !((modes.get(filePath) ?? 0o644) & 0o200)) throw error('EACCES');
      if (modes.has(path.posix.dirname(filePath)) && !(modes.get(path.posix.dirname(filePath))! & 0o200)) throw error('EACCES');
      if (!files.has(filePath)) modes.set(filePath, params.mode ?? 0o644);
      const data = Buffer.from(params.data, 'base64');
      const old = params.truncate ? Buffer.alloc(0) : files.get(filePath) ?? Buffer.alloc(0);
      const result = Buffer.alloc(Math.max(old.length, params.offset + data.length));
      old.copy(result); data.copy(result, params.offset); files.set(filePath, result);
      return { written: data.length };
    }
    if (method === 'fs.readDirectory') {
      if (!directories.has(filePath)) throw error('ENOTDIR');
      const children = [...directories, ...files.keys(), ...links.keys()]
        .filter(entry => entry !== filePath && path.posix.dirname(entry) === filePath);
      return { entries: [...new Set(children)].map(entry => ({ name: path.posix.basename(entry),
        kind: directories.has(entry) ? 'directory' : links.has(entry) ? 'symlink' : 'file' })) };
    }
    if (method === 'fs.createDirectory') {
      if (modes.has(path.posix.dirname(filePath)) && !(modes.get(path.posix.dirname(filePath))! & 0o200)) throw error('EACCES');
      if (!directories.has(filePath)) modes.set(filePath, params.mode ?? 0o755);
      directories.add(filePath); return {};
    }
    if (method === 'fs.chmod') { modes.set(filePath, params.mode); return {}; }
    if (method === 'fs.remove') {
      if (!kind) throw error('ENOENT');
      files.delete(filePath); directories.delete(filePath); links.delete(filePath); return {};
    }
    throw error('ENOSYS');
  }
  return { files, directories, links, modes, calls, request, fs: createCodexFilesystem(request) };
}

test('guest file URIs remain local, absolute, and encoded without touching host paths', () => {
  assert.equal(guestPathFromUri('file:///work/a%20b%23%25.txt'), '/work/a b#%.txt');
  assert.equal(guestPathFromUri('file://localhost/work/file'), '/work/file');
  assert.equal(guestPathToUri('/work/a b#%.txt'), 'file:///work/a%20b%23%25.txt');
  for (const uri of ['relative', '/work/file', 'file:/work/file', 'http://localhost/file',
    'file://remote/work/file', 'file://user@localhost/work/file', 'file:///work/file?x=1',
    'file:///work/file#fragment', 'file:///work/%00', 'file:///work/%2fetc', 'file:///work/%zz']) {
    assert.throws(() => guestPathFromUri(uri), { code: 'EINVAL' });
  }
});

test('readFile and writeFile preserve binary bytes with bounded guest chunks', async () => {
  const f = fixture(); const bytes = Buffer.alloc(CHUNK * 2 + 123);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  await f.fs.handle('fs/writeFile', { path: 'file:///work/output', dataBase64: bytes.toString('base64'), followSymlinks: false });
  assert.deepEqual(f.files.get('/work/output'), bytes);
  const writes = f.calls.filter(call => call.method === 'fs.writeFile');
  assert.deepEqual(writes.map(call => call.params.offset), [0, CHUNK, CHUNK * 2]);
  assert.deepEqual(writes.map(call => call.params.truncate), [true, false, false]);
  assert.ok(writes.every(call => Buffer.from(call.params.data, 'base64').length <= CHUNK && call.params.follow === false));
  assert.deepEqual(await f.fs.handle('fs/readFile', { path: 'file:///work/output' }), { dataBase64: bytes.toString('base64') });
  assert.ok(f.calls.filter(call => call.method === 'fs.readFile').every(call => call.params.length <= CHUNK));
  await f.fs.handle('fs/writeFile', { path: 'file:///work/output', dataBase64: '' });
  assert.equal(f.files.get('/work/output')!.length, 0);
});

test('file handles retain a bounded read snapshot until closed', async () => {
  const f = fixture();
  assert.deepEqual(await f.fs.handle('fs/open', { handleId: 'one', path: 'file:///work/file' }), { handleId: 'one' });
  f.files.set('/work/file', Buffer.from('changed'));
  assert.deepEqual(await f.fs.handle('fs/readBlock', { handleId: 'one', offset: 1, len: 2 }), { chunk: Buffer.from([255, 1]).toString('base64'), eof: false });
  assert.deepEqual(await f.fs.handle('fs/readBlock', { handleId: 'one', offset: 3, len: 999 }), { chunk: Buffer.from([2]).toString('base64'), eof: true });
  await assert.rejects(f.fs.handle('fs/open', { handleId: 'one', path: 'file:///work/file' }), { code: 'EEXIST' });
  await f.fs.handle('fs/close', { handleId: 'one' }); await f.fs.handle('fs/close', { handleId: 'one' });
  await assert.rejects(f.fs.handle('fs/readBlock', { handleId: 'one', offset: 0, len: 1 }), { code: 'EBADF' });
});

test('metadata, directory, canonicalize, create and remove preserve Codex field names and defaults', async () => {
  const f = fixture(); f.links.set('/work/link', '/work/file');
  assert.deepEqual(await f.fs.handle('fs/getMetadata', { path: 'file:///work/link' }), {
    isDirectory: false, isFile: true, isSymlink: false, size: 4, createdAtMs: 0, modifiedAtMs: 123000,
  });
  assert.equal((await f.fs.handle('fs/getMetadata', { path: 'file:///work/link', followSymlinks: false }) as any).isSymlink, true);
  assert.deepEqual(await f.fs.handle('fs/canonicalize', { path: 'file:///work/link' }), { path: 'file:///work/file' });
  assert.deepEqual(await f.fs.handle('fs/readDirectory', { path: 'file:///work' }), { entries: [
    { fileName: 'file', isDirectory: false, isFile: true }, { fileName: 'link', isDirectory: false, isFile: false },
  ] });
  await f.fs.handle('fs/createDirectory', { path: 'file:///work/new' });
  assert.equal(f.calls.at(-1)?.params.recursive, true);
  await f.fs.handle('fs/remove', { path: 'file:///missing' });
  assert.equal(f.calls.at(-1)?.params.recursive, true);
  await assert.rejects(f.fs.handle('fs/remove', { path: 'file:///missing', force: false }), { code: 'ENOENT' });
});

test('invalid or oversized data and unvalidated sandbox policies fail before guest writes', async () => {
  const f = fixture();
  for (const dataBase64 of ['%%%not-base64', 'YQ', Buffer.alloc(MAX_FILE + 1).toString('base64')]) {
    await assert.rejects(f.fs.handle('fs/writeFile', { path: 'file:///work/file', dataBase64 }));
  }
  await assert.rejects(f.fs.handle('fs/readFile', { path: 'file:///work/file', sandbox: { arbitrary: true } }), { code: 'ENOTSUP' });
  assert.equal(f.calls.length, 0);
  f.files.set('/work/huge', Buffer.alloc(MAX_FILE + 1));
  await assert.rejects(f.fs.handle('fs/readFile', { path: 'file:///work/huge' }), { code: 'EFBIG' });
  await assert.rejects(f.fs.handle('fs/unknown', {}), { code: 'ENOSYS' });
});

test('cancellation between read chunks stops further guest requests and close invalidates handles', async () => {
  const f = fixture(); f.files.set('/work/large', Buffer.alloc(CHUNK * 2));
  const abort = new AbortController();
  const adapter = createCodexFilesystem(async (method, params) => {
    const response = await f.request(method, params);
    if (method === 'fs.readFile') abort.abort();
    return response;
  });
  await assert.rejects(adapter.handle('fs/readFile', { path: 'file:///work/large' }, abort.signal), { code: 'ECANCELED' });
  assert.equal(f.calls.filter(call => call.method === 'fs.readFile').length, 1);
  await f.fs.handle('fs/open', { handleId: 'one', path: 'file:///work/file' }); f.fs.close();
  await assert.rejects(f.fs.handle('fs/readBlock', { handleId: 'one', offset: 0, len: 1 }), { code: 'ECANCELED' });
});

test('copy performs bounded guest reads and writes and refuses recursive self-copy or symlinks', async () => {
  const f = fixture(); f.directories.add('/work/tree'); f.files.set('/work/tree/child', Buffer.from('data'));
  await f.fs.handle('fs/copy', { sourcePath: 'file:///work/tree', destinationPath: 'file:///copy', recursive: true });
  assert.equal(f.files.get('/copy/child')?.toString(), 'data');
  await assert.rejects(f.fs.handle('fs/copy', { sourcePath: 'file:///work/tree', destinationPath: 'file:///work/tree/descendant', recursive: true }), { code: 'EINVAL' });
  f.links.set('/work/link', '/work/file');
  await assert.rejects(f.fs.handle('fs/copy', { sourcePath: 'file:///work/link', destinationPath: 'file:///copy-link', recursive: false }), { code: 'ENOTSUP' });
});

test('walk uses the verified schema, honors bounds and hidden pruning, and avoids symlink cycles', async () => {
  const f = fixture(); f.directories.add('/work/.hidden'); f.directories.add('/work/sub');
  f.files.set('/work/.hidden/secret', Buffer.from('x')); f.files.set('/work/sub/child', Buffer.from('x'));
  f.links.set('/work/sub/back', '/work');
  const options = { maxDepth: 10, maxDirectories: 10, maxEntries: 100, followDirectorySymlinks: true, pruneHiddenDirectories: true };
  const result = await f.fs.handle('fs/walk', { path: 'file:///work', options }) as any;
  assert.equal(result.truncated, false); assert.deepEqual(result.errors, []);
  assert.ok(result.entries.some((entry: any) => entry.path === 'file:///work/sub/child' && entry.kind === 'file'));
  assert.ok(result.entries.some((entry: any) => entry.path === 'file:///work/.hidden' && entry.kind === 'directory'));
  assert.ok(!result.entries.some((entry: any) => entry.path.includes('/secret')));
  const limited = await f.fs.handle('fs/walk', { path: 'file:///work', options: { ...options, maxEntries: 1 } }) as any;
  assert.equal(limited.entries.length, 1); assert.equal(limited.truncated, true);
});

test('malformed guest data cannot produce endless reads or oversized allocations', async () => {
  const adapter = createCodexFilesystem(async method => method === 'fs.getMetadata'
    ? { kind: 'file', size: 5, mode: 0o644, mtimeMs: 0 } : { data: '', eof: false });
  await assert.rejects(adapter.handle('fs/readFile', { path: 'file:///work/file' }), { code: 'EIO' });
});

test('the full 8 MiB file limit is supported without oversized guest frames', async () => {
  const bytes = Buffer.alloc(MAX_FILE, 0xab); let written = 0;
  const adapter = createCodexFilesystem(async (method, params) => {
    if (method === 'fs.getMetadata') return { kind: 'file', size: bytes.length, mode: 0o644, mtimeMs: 0 };
    if (method === 'fs.readFile') {
      const chunk = bytes.subarray(Number(params.offset), Number(params.offset) + Number(params.length));
      return { data: chunk.toString('base64'), eof: Number(params.offset) + chunk.length >= bytes.length };
    }
    if (method === 'fs.writeFile') {
      const size = Buffer.from(String(params.data), 'base64').length;
      assert.ok(size <= CHUNK); written += size; return { written: size };
    }
    throw error('ENOSYS');
  });
  await adapter.handle('fs/writeFile', { path: 'file:///work/large', dataBase64: bytes.toString('base64') });
  assert.equal(written, MAX_FILE);
  assert.equal((await adapter.handle('fs/readFile', { path: 'file:///work/large' }) as any).dataBase64, bytes.toString('base64'));
});

test('read-handle counts and identifier byte lengths are bounded', async () => {
  const f = fixture(); f.files.set('/work/empty', Buffer.alloc(0));
  await assert.rejects(f.fs.handle('fs/open', { path: 'file:///work/empty', handleId: 'x'.repeat(33) }), { code: 'EINVAL' });
  for (let i = 0; i < 64; i++) await f.fs.handle('fs/open', { path: 'file:///work/empty', handleId: `h${i}` });
  await assert.rejects(f.fs.handle('fs/open', { path: 'file:///work/empty', handleId: 'overflow' }), { code: 'EMFILE' });
});

test('copy writes all chunks and children before restoring source file and directory permissions', async () => {
  const f = fixture();
  f.directories.add('/work/restricted'); f.modes.set('/work/restricted', 0o500);
  const bytes = Buffer.alloc(CHUNK + 17, 0xef);
  f.files.set('/work/restricted/file', bytes); f.modes.set('/work/restricted/file', 0o400);
  await f.fs.handle('fs/copy', { sourcePath: 'file:///work/restricted', destinationPath: 'file:///copied', recursive: true });
  assert.deepEqual(f.files.get('/copied/file'), bytes);
  assert.equal(f.modes.get('/copied/file'), 0o400); assert.equal(f.modes.get('/copied'), 0o500);
  assert.equal(f.calls.filter(call => call.method === 'fs.writeFile').length, 2);
  assert.deepEqual(f.calls.filter(call => call.method === 'fs.chmod').map(call => call.params.path), ['/copied/file', '/copied']);
  f.links.set('/work/destination-link', '/work/file');
  const before = f.calls.length;
  await assert.rejects(f.fs.handle('fs/copy', { sourcePath: 'file:///work/file', destinationPath: 'file:///work/destination-link', recursive: false }), { code: 'ELOOP' });
  assert.ok(!f.calls.slice(before).some(call => call.method === 'fs.chmod'));
});
