import path from 'node:path';

const CHUNK_BYTES = 49152;
const FILE_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_HANDLES = 64;
const MAX_ENTRIES = 10000;
const METHODS = new Set(['fs/readFile', 'fs/open', 'fs/readBlock', 'fs/close', 'fs/writeFile',
  'fs/createDirectory', 'fs/getMetadata', 'fs/canonicalize', 'fs/readDirectory', 'fs/walk', 'fs/remove', 'fs/copy']);

export type GuestFilesystemRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export interface CodexFilesystem {
  handle(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): void;
}
interface Metadata { kind: string; size: number; mode: number; mtimeMs: number }
interface Entry { name: string; kind: string }

function fail(code: string, message = code): never { throw Object.assign(new Error(message), { code }); }
function object(value: unknown, code = 'EINVAL'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}
function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') fail('EINVAL');
  return value;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER, code = 'EINVAL'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) fail(code);
  return value;
}
function guestPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value)
    || Buffer.byteLength(value) > 4096) fail('EINVAL', 'Expected an absolute guest path');
  return path.posix.normalize(value);
}

/** URI conversion is lexical only. It never resolves a path on the host. */
export function guestPathFromUri(value: unknown): string {
  if (typeof value !== 'string' || !/^file:\/\/(?:localhost)?\//.test(value)
    || /[\x00-\x1f\x7f\\]/.test(value)) fail('EINVAL', 'Expected a local file:// guest URI');
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.hostname || url.username || url.password || url.port || url.search || url.hash
      || /%2f/i.test(url.pathname)) fail('EINVAL');
    return guestPath(decodeURIComponent(url.pathname));
  } catch { return fail('EINVAL', 'Invalid guest file URI'); }
}

export function guestPathToUri(value: unknown): string {
  try { return 'file://' + guestPath(value).split('/').map(encodeURIComponent).join('/'); }
  catch { return fail('EINVAL', 'Invalid guest path'); }
}

function decode(value: unknown, maximum: number, code = 'EINVAL'): Buffer {
  if (typeof value !== 'string') fail(code);
  if (value.length > Math.ceil(maximum / 3) * 4) fail(code === 'EINVAL' ? 'EFBIG' : code);
  // Avoid nested repeated groups: V8's regexp stack can overflow on an 8 MiB
  // input. Canonical round-trip validation below also checks padding bits.
  if (value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(code);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maximum) fail(code === 'EINVAL' ? 'EFBIG' : code);
  if (bytes.toString('base64') !== value) fail(code);
  return bytes;
}
function handleId(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 32 || value.includes('\0')) fail('EINVAL');
  return value;
}

/**
 * Codex exec-server filesystem schemas are mapped only to private guest RPCs.
 * Callers must authorize and strip any sandbox context before using this adapter;
 * a non-null context is rejected here rather than silently ignored.
 * Open handles are immutable byte snapshots, not persistent guest descriptors.
 * Reading the snapshot itself is not atomic against concurrent guest writes.
 */
export function createCodexFilesystem(request: GuestFilesystemRequest): CodexFilesystem {
  const snapshots = new Map<string, Buffer>();
  let snapshotBytes = 0, closed = false;
  let pending = Promise.resolve();
  function check(signal?: AbortSignal) { if (closed || signal?.aborted) fail('ECANCELED'); }
  async function call(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
    check(signal); const result = await request(method, params); check(signal); return object(result, 'EIO');
  }
  async function metadata(file: string, follow: boolean, signal?: AbortSignal): Promise<Metadata> {
    const result = await call('fs.getMetadata', { path: file, follow }, signal);
    if (!['file', 'directory', 'symlink', 'other'].includes(String(result.kind))
      || !Number.isSafeInteger(result.mtimeMs)) fail('EIO');
    return { kind: result.kind as string, size: integer(result.size, Number.MAX_SAFE_INTEGER, 'EIO'),
      mode: integer(result.mode, 0o777, 'EIO'), mtimeMs: result.mtimeMs as number };
  }
  async function read(file: string, follow: boolean, signal?: AbortSignal): Promise<Buffer> {
    const info = await metadata(file, follow, signal);
    if (info.kind === 'symlink') fail('ELOOP');
    if (info.kind !== 'file') fail('EISDIR');
    if (info.size > FILE_BYTES) fail('EFBIG');
    const chunks: Buffer[] = []; let offset = 0;
    for (;;) {
      check(signal);
      if (offset === FILE_BYTES) fail('EFBIG');
      const length = Math.min(CHUNK_BYTES, FILE_BYTES - offset);
      const result = await call('fs.readFile', { path: file, offset, length, follow }, signal);
      if (typeof result.eof !== 'boolean') fail('EIO');
      const bytes = decode(result.data, length, 'EIO');
      chunks.push(bytes); offset += bytes.length;
      if (result.eof) return Buffer.concat(chunks, offset);
      if (!bytes.length) fail('EIO', 'Guest read made no progress');
    }
  }
  async function write(file: string, bytes: Buffer, follow: boolean, signal?: AbortSignal, mode = 0o644) {
    for (let offset = 0; offset < bytes.length || offset === 0; offset += CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
      const result = await call('fs.writeFile', { path: file, data: chunk.toString('base64'), offset,
        truncate: offset === 0, follow, mode }, signal);
      if (result.written !== chunk.length) fail('EIO', 'Guest write was incomplete');
    }
  }
  async function entries(directory: string, signal?: AbortSignal, follow = true): Promise<Entry[]> {
    const result = await call('fs.readDirectory', { path: directory, follow }, signal);
    if (!Array.isArray(result.entries) || result.entries.length > MAX_ENTRIES) fail('EFBIG');
    const names = new Set<string>();
    return result.entries.map(value => {
      const entry = object(value, 'EIO');
      if (typeof entry.name !== 'string' || !entry.name || ['.', '..'].includes(entry.name)
        || entry.name.includes('/') || /[\x00-\x1f\x7f]/.test(entry.name) || names.has(entry.name)
        || !['file', 'directory', 'symlink', 'other'].includes(String(entry.kind))) fail('EIO');
      names.add(entry.name);
      return { name: entry.name, kind: entry.kind as string };
    });
  }
  async function canonical(file: string, signal?: AbortSignal) {
    const result = await call('fs.canonicalize', { path: file }, signal);
    try { return guestPath(result.path); } catch { return fail('EIO'); }
  }

  async function walk(root: string, value: unknown, signal?: AbortSignal) {
    const options = object(value);
    const maxDepth = Math.min(integer(options.maxDepth), 64);
    const maxDirectories = Math.min(integer(options.maxDirectories), 4096);
    const maxEntries = Math.min(integer(options.maxEntries), MAX_ENTRIES);
    const follow = bool(options.followDirectorySymlinks, false), prune = bool(options.pruneHiddenDirectories, false);
    const outcome: { entries: Array<{ path: string; kind: 'file' | 'directory' }>; errors: Array<{ path: string; message: string }>; truncated: boolean } = {
      entries: [], errors: [], truncated: false,
    };
    const visited = new Set<string>(); let directories = 0, examined = 0;
    async function visit(directory: string, depth: number): Promise<void> {
      check(signal);
      const resolved = await canonical(directory, signal);
      if (visited.has(resolved)) return;
      if (directories >= maxDirectories) { outcome.truncated = true; return; }
      visited.add(resolved); directories++;
      const listing = await entries(directory, signal);
      for (const entry of listing) {
        check(signal);
        if (examined >= maxEntries) { outcome.truncated = true; return; }
        examined++;
        const child = path.posix.join(directory, entry.name);
        try {
          let kind = entry.kind;
          if (kind === 'symlink') {
            if (!follow) continue;
            kind = (await metadata(child, true, signal)).kind;
          }
          if (kind !== 'file' && kind !== 'directory') continue;
          outcome.entries.push({ path: guestPathToUri(child), kind });
          if (kind === 'directory' && !(prune && entry.name.startsWith('.'))) {
            if (depth >= maxDepth) outcome.truncated = true;
            else await visit(child, depth + 1);
          }
        } catch (error) {
          check(signal);
          outcome.errors.push({ path: guestPathToUri(child), message: error instanceof Error ? error.message : 'Unable to inspect guest path' });
        }
      }
    }
    if ((await metadata(root, true, signal)).kind !== 'directory') fail('ENOTDIR');
    await visit(root, 0); return outcome;
  }

  async function copy(source: string, destination: string, recursive: boolean, signal?: AbortSignal) {
    if (source === destination || destination.startsWith(source.endsWith('/') ? source : source + '/')) fail('EINVAL', 'Cannot copy a path into itself');
    let copied = 0, count = 0;
    async function visit(from: string, to: string, depth: number): Promise<void> {
      check(signal);
      if (depth > 64 || ++count > MAX_ENTRIES) fail('EFBIG');
      const info = await metadata(from, false, signal);
      if (info.kind === 'symlink' || info.kind === 'other') fail('ENOTSUP', 'Copying symlinks and special files is unsupported');
      if (info.kind === 'file') {
        const bytes = await read(from, false, signal);
        copied += bytes.length;
        if (copied > 64 * 1024 * 1024) fail('EFBIG');
        // Guest writes reopen the file per chunk. Keep newly created files
        // writable until all chunks land, then restore the source permissions.
        await write(to, bytes, false, signal, info.mode | 0o200);
        await call('fs.chmod', { path: to, mode: info.mode }, signal); return;
      }
      if (!recursive) fail('EISDIR');
      // Snapshot names before creating the destination. Do not follow guest
      // symlinks during recursive copy, including in destination parents.
      const children = await entries(from, signal, false);
      await call('fs.createDirectory', { path: to, recursive: true, follow: false, mode: info.mode | 0o700 }, signal);
      for (const child of children) await visit(path.posix.join(from, child.name), path.posix.join(to, child.name), depth + 1);
      await call('fs.chmod', { path: to, mode: info.mode }, signal);
    }
    await visit(source, destination, 0);
  }

  async function execute(method: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
    check(signal);
    if (!METHODS.has(method)) fail('ENOSYS');
    const params = object(value);
    if (params.sandbox !== undefined && params.sandbox !== null) fail('ENOTSUP', 'Authorize the sandbox context before calling the filesystem adapter');
    if (method === 'fs/readBlock') {
      const bytes = snapshots.get(handleId(params.handleId)); if (!bytes) fail('EBADF');
      const offset = integer(params.offset), length = integer(params.len, FILE_BYTES);
      const end = Math.min(bytes.length, offset + length);
      return { chunk: bytes.subarray(Math.min(offset, bytes.length), end).toString('base64'), eof: end >= bytes.length };
    }
    if (method === 'fs/close') {
      const id = handleId(params.handleId), old = snapshots.get(id);
      if (old) { snapshotBytes -= old.length; snapshots.delete(id); }
      return {};
    }
    if (method === 'fs/copy') {
      if (typeof params.recursive !== 'boolean') fail('EINVAL');
      await copy(guestPathFromUri(params.sourcePath), guestPathFromUri(params.destinationPath), params.recursive, signal); return {};
    }
    const file = guestPathFromUri(params.path), follow = bool(params.followSymlinks, true);
    switch (method) {
      case 'fs/readFile': return { dataBase64: (await read(file, follow, signal)).toString('base64') };
      case 'fs/writeFile': await write(file, decode(params.dataBase64, FILE_BYTES), follow, signal); return {};
      case 'fs/open': {
        const id = handleId(params.handleId);
        if (snapshots.has(id)) fail('EEXIST');
        if (snapshots.size >= MAX_HANDLES) fail('EMFILE');
        const bytes = await read(file, true, signal);
        if (snapshotBytes + bytes.length > SNAPSHOT_BYTES) fail('ENOMEM');
        snapshots.set(id, bytes); snapshotBytes += bytes.length; return { handleId: id };
      }
      case 'fs/getMetadata': {
        const info = await metadata(file, follow, signal);
        return { isDirectory: info.kind === 'directory', isFile: info.kind === 'file', isSymlink: info.kind === 'symlink',
          size: info.size, createdAtMs: 0, modifiedAtMs: info.mtimeMs }; // Guest protocol has no birth time.
      }
      case 'fs/canonicalize': return { path: guestPathToUri(await canonical(file, signal)) };
      case 'fs/readDirectory': return { entries: (await entries(file, signal)).map(entry => ({ fileName: entry.name,
        isDirectory: entry.kind === 'directory', isFile: entry.kind === 'file' })) };
      case 'fs/createDirectory': await call('fs.createDirectory', { path: file, recursive: bool(params.recursive, true), follow }, signal); return {};
      case 'fs/remove': {
        const force = bool(params.force, true);
        try { await call('fs.remove', { path: file, recursive: bool(params.recursive, true), follow }, signal); }
        catch (error) { if (!force || (error as { code?: string }).code !== 'ENOENT') throw error; }
        return {};
      }
      case 'fs/walk': return walk(file, params.options, signal);
      default: return fail('ENOSYS');
    }
  }
  return {
    handle(method, params, signal) {
      // Serialize multi-chunk operations and handle accounting; pending calls
      // cannot reserve unbounded simultaneous 8 MiB read buffers.
      const result = pending.then(() => execute(method, params, signal));
      pending = result.then(() => {}, () => {}); return result;
    },
    close() { closed = true; snapshots.clear(); snapshotBytes = 0; },
  };
}
