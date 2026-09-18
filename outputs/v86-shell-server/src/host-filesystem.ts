import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

export interface Mount { name: string; hostPath: string; }
interface Location { mount?: Mount; parts: string[]; }
interface Fid extends Location { file?: FileHandle; flags?: number; }
interface Metadata {
  mode: number; size: number; nlink: number; dev: number; ino: number;
  atimeMs: number; mtimeMs: number; ctimeMs: number; blocks: number;
  isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean;
}

// Protocol numbers and layouts: Linux include/net/9p/9p.h and
// https://github.com/chaos/diod/blob/master/protocol.md (9P2000.L).
const ERRNO: Record<string, number> = {
  EPERM: 1, ENOENT: 2, EIO: 5, EBADF: 9, EAGAIN: 11, EACCES: 13, EBUSY: 16,
  EEXIST: 17, EXDEV: 18, ENODEV: 19, ENOTDIR: 20, EISDIR: 21, EINVAL: 22,
  EMFILE: 24, EFBIG: 27, ENOSPC: 28, EROFS: 30, EPIPE: 32, ERANGE: 34,
  ENAMETOOLONG: 36, ENOSYS: 38, ENOTEMPTY: 39, ELOOP: 40, ENODATA: 61,
  EOVERFLOW: 75, ENOTSUP: 95, EOPNOTSUPP: 95, ESTALE: 116,
};
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function component(name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) fail('EINVAL');
  if (Buffer.byteLength(name) > 255) fail('ENAMETOOLONG');
  return name;
}
function integer(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('EOVERFLOW');
  return Number(value);
}
class Reader {
  offset = 7;
  constructor(readonly bytes: Buffer) {}
  raw(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) fail('EINVAL');
    const data = this.bytes.subarray(this.offset, this.offset + length); this.offset += length; return data;
  }
  u8(): number { return this.raw(1).readUInt8(); }
  u16(): number { return this.raw(2).readUInt16LE(); }
  u32(): number { return this.raw(4).readUInt32LE(); }
  u64(): bigint { return this.raw(8).readBigUInt64LE(); }
  string(): string {
    const b = this.raw(this.u16());
    const s = b.toString('utf8');
    if (!Buffer.from(s).equals(b) || s.includes('\0')) fail('EINVAL');
    return s;
  }
}
class Writer {
  chunks: Buffer[] = [];
  raw(data: Uint8Array): this { this.chunks.push(Buffer.from(data)); return this; }
  u8(n: number): this { const b = Buffer.alloc(1); b.writeUInt8(n); return this.raw(b); }
  u16(n: number): this { const b = Buffer.alloc(2); b.writeUInt16LE(n); return this.raw(b); }
  u32(n: number): this { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return this.raw(b); }
  u64(n: number | bigint): this {
    const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, typeof n === 'bigint' ? n : BigInt(Math.trunc(n)))); return this.raw(b);
  }
  string(s: string): this { const b = Buffer.from(s); return this.u16(b.length).raw(b); }
  bytes(): Buffer { return Buffer.concat(this.chunks); }
}
function packet(type: number, tag: number, body: Writer): Buffer {
  const data = body.bytes(); return new Writer().u32(7 + data.length).u8(type).u16(tag).raw(data).bytes();
}
const rootMetadata: Metadata = {
  mode: 0o40755, size: 0, nlink: 2, dev: -1, ino: 1, atimeMs: 0, mtimeMs: 0, ctimeMs: 0, blocks: 0,
  isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false,
};

/** A live 9P2000.L host filesystem for v86's public filesystem.handle9p hook.
 * Host symlinks are returned as symlinks, never followed by host I/O. The guest
 * resolves their targets within its own namespace. Parent components are checked
 * before every operation; ordinary file opens additionally use O_NOFOLLOW.
 * Pure Node does not expose openat/openat2: a trusted host process must not swap
 * parent directories concurrently with these checks. Existing host hardlinks
 * retain their normal shared-inode semantics. This is not an adversarial-host
 * filesystem sandbox. Guest 9P mutations are serialized to avoid such races.
 */
export async function createHostFilesystem(input: Mount[]): Promise<{
  handle9p(req: Uint8Array, reply: (response: Uint8Array) => void): void;
  close(): Promise<void>;
}> {
  const mounts = new Map<string, Mount>();
  for (const item of input) {
    const name = component(item.name);
    if (mounts.has(name)) throw new Error(`Duplicate mount name: ${name}`);
    const hostPath = await fs.realpath(item.hostPath);
    if (!(await fs.stat(hostPath)).isDirectory()) throw new Error(`Mount is not a directory: ${item.hostPath}`);
    mounts.set(name, { name, hostPath });
  }
  const fids = new Map<number, Fid>();
  const qids = new Map<string, bigint>();
  let nextQid = 1n, msize = 65536, closed = false;
  let pending = Promise.resolve();
  const root: Location = { parts: [] };
  function fid(id: number): Fid { const f = fids.get(id); if (!f) fail('EBADF'); return f; }
  function copy(loc: Location): Fid { return { mount: loc.mount, parts: [...loc.parts] }; }
  async function host(loc: Location, allowMissing = false): Promise<string> {
    if (!loc.mount) fail('EPERM');
    let current = loc.mount.hostPath;
    // The mount root itself must remain a real directory as well.
    let st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink()) fail('ELOOP');
    for (let i = 0; i < loc.parts.length; i++) {
      current = path.join(current, component(loc.parts[i]!));
      const last = i === loc.parts.length - 1;
      if (last && allowMissing) break;
      st = await fs.lstat(current);
      if (!last && !st.isDirectory()) fail(st.isSymbolicLink() ? 'ELOOP' : 'ENOTDIR');
    }
    return current;
  }
  async function metadata(loc: Location | Fid): Promise<Metadata> {
    if (!loc.mount) return rootMetadata;
    if ('file' in loc && loc.file) return loc.file.stat();
    return fs.lstat(await host(loc));
  }
  async function qid(loc: Location | Fid, st?: Metadata): Promise<Buffer> {
    st ??= await metadata(loc);
    const key = `${st.dev}:${st.ino}`;
    let number = qids.get(key); if (!number) { number = nextQid++; qids.set(key, number); }
    return new Writer().u8(st.isDirectory() ? 0x80 : st.isSymbolicLink() ? 0x02 : 0)
      .u32(Math.trunc(st.mtimeMs) >>> 0).u64(number).bytes();
  }
  async function child(loc: Location, name: string): Promise<Location> {
    const st = await metadata(loc);
    if (!st.isDirectory()) fail('ENOTDIR');
    if (name === '.') return copy(loc);
    if (name === '..') return !loc.mount || !loc.parts.length ? root : { mount: loc.mount, parts: loc.parts.slice(0, -1) };
    component(name);
    if (!loc.mount) {
      const mount = mounts.get(name); if (!mount) fail('ENOENT'); return { mount, parts: [] };
    }
    const result = { mount: loc.mount, parts: [...loc.parts, name] };
    await metadata(result); return result;
  }
  async function newChild(loc: Location, name: string): Promise<Location> {
    if (!loc.mount) fail('EROFS');
    if (!(await metadata(loc)).isDirectory()) fail('ENOTDIR');
    return { mount: loc.mount, parts: [...loc.parts, component(name)] };
  }
  function requireMutable(loc: Location): void { if (!loc.mount || !loc.parts.length) fail('EBUSY'); }
  async function clearFid(id: number): Promise<void> {
    const f = fids.get(id); fids.delete(id); if (f?.file) await f.file.close();
  }
  async function clearAll(): Promise<void> { await Promise.all([...fids.keys()].map(clearFid)); }
  function openFlags(flags: number): number {
    // Linux protocol flags differ from host constants (notably on macOS).
    const access = flags & 3;
    if (access === 3 || flags & 0x600000) fail('ENOTSUP'); // O_PATH/O_TMPFILE
    let result = access === 0 ? constants.O_RDONLY : access === 1 ? constants.O_WRONLY : constants.O_RDWR;
    if (flags & 0x40) result |= constants.O_CREAT;
    if (flags & 0x80) result |= constants.O_EXCL;
    if (flags & 0x200) result |= constants.O_TRUNC;
    if (flags & 0x400) result |= constants.O_APPEND;
    if (flags & 0x800) result |= constants.O_NONBLOCK;
    if (flags & 0x101000) result |= constants.O_SYNC;
    return result | constants.O_NOFOLLOW;
  }
  async function openFile(f: Fid, flags: number, mode = 0o666, creating = false): Promise<void> {
    if (f.file) fail('EBUSY');
    if (creating) {
      // Creating an existing regular file is allowed; special files must never
      // block the server or provide access to devices/socket endpoints.
      try {
        const st = await metadata(f);
        if (!st.isFile()) fail(st.isSymbolicLink() ? 'ELOOP' : st.isDirectory() ? 'EISDIR' : 'ENOTSUP');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } else {
      const st = await metadata(f);
      if (st.isSymbolicLink()) fail('ELOOP');
      if (st.isDirectory()) { if ((flags & 3) || (flags & 0x200)) fail('EISDIR'); f.flags = flags; return; }
      if (flags & 0x10000) fail('ENOTDIR');
      if (!st.isFile()) fail('ENOTSUP');
    }
    f.file = await fs.open(await host(f, creating), openFlags(flags), mode & 0o777);
    const st = await f.file.stat();
    if (!st.isFile()) { await f.file.close(); f.file = undefined; fail('ENOTSUP'); }
    f.flags = flags;
  }
  async function rename(from: Location, to: Location): Promise<void> {
    requireMutable(from); requireMutable(to);
    if (from.mount !== to.mount) fail('EXDEV');
    const source = await host(from), destination = await host(to, true);
    await fs.rename(source, destination);
    for (const f of fids.values()) {
      if (f.mount === from.mount && from.parts.every((p, i) => p === f.parts[i])) {
        f.parts = [...to.parts, ...f.parts.slice(from.parts.length)];
      }
    }
  }
  async function process(req: Buffer): Promise<Buffer> {
    const tag = req.length >= 7 ? req.readUInt16LE(5) : 0xffff;
    try {
      if (closed) fail('EIO');
      if (req.length < 7 || req.length > msize || req.readUInt32LE(0) !== req.length) fail('EINVAL');
      const type = req.readUInt8(4), r = new Reader(req), w = new Writer();
      switch (type) {
        case 100: { // Tversion
          const requested = r.u32(), version = r.string();
          if (requested < 256) fail('EINVAL');
          await clearAll(); msize = Math.min(requested, 65536);
          w.u32(msize).string(version === '9P2000.L' ? version : 'unknown'); break;
        }
        case 102: fail('EOPNOTSUPP'); // no authentication exchange
        case 104: { // Tattach: the whole export is a synthetic directory
          const id = r.u32(); r.u32(); r.string(); const aname = r.string(); r.u32();
          if (aname !== '' && aname !== '/') fail('EACCES');
          if (fids.has(id)) fail('EBUSY');
          fids.set(id, copy(root)); w.raw(await qid(root)); break;
        }
        case 108: r.u16(); break; // serialized requests have already completed
        case 110: { // Twalk, including cloning a fid with zero names
          const old = r.u32(), id = r.u32(), count = r.u16();
          if (count > 256) fail('EINVAL');
          const original = fid(old);
          if (original.file) fail('EBUSY');
          if (id !== old && fids.has(id)) fail('EBUSY');
          let loc: Location = copy(original);
          const walked: Buffer[] = [];
          const names = Array.from({ length: count }, () => r.string());
          for (const name of names) {
            try { loc = await child(loc, name); walked.push(await qid(loc)); }
            catch (error) { if (!walked.length) throw error; break; }
          }
          // Partial walks return qids but do not establish newfid (9P spec).
          if (walked.length === count) fids.set(id, copy(loc));
          w.u16(walked.length); for (const q of walked) w.raw(q); break;
        }
        case 12: { const f = fid(r.u32()); await openFile(f, r.u32()); w.raw(await qid(f)).u32(msize - 24); break; }
        case 14: { // Tlcreate changes the directory fid to an opened file fid
          const id = r.u32(), dir = fid(id), name = r.string(), flags = r.u32(), mode = r.u32(); r.u32();
          if (dir.file) fail('EBUSY');
          const f = copy(await newChild(dir, name));
          await openFile(f, flags | 0x40, mode, true); fids.set(id, f);
          w.raw(await qid(f)).u32(msize - 24); break;
        }
        case 116: {
          const f = fid(r.u32()), offset = integer(r.u64()), count = Math.min(r.u32(), msize - 11);
          if (!f.file) fail('EBADF');
          const data = Buffer.alloc(count), { bytesRead } = await f.file.read(data, 0, count, offset);
          w.u32(bytesRead).raw(data.subarray(0, bytesRead)); break;
        }
        case 118: {
          const f = fid(r.u32()), offset = integer(r.u64()), count = r.u32(), data = r.raw(count);
          if (!f.file) fail('EBADF');
          const { bytesWritten } = await f.file.write(data, 0, data.length, (f.flags! & 0x400) ? null : offset);
          w.u32(bytesWritten); break;
        }
        case 120: { const id = r.u32(); fid(id); await clearFid(id); break; }
        case 8: {
          const f = fid(r.u32());
          if (f.mount) {
            const p = await host(f), inode = await fs.lstat(p);
            // statfs follows final symlinks; use their verified parent instead.
            const st = await fs.statfs(inode.isSymbolicLink() ? path.dirname(p) : p);
            w.u32(0x01021997).u32(st.bsize).u64(st.blocks).u64(st.bfree).u64(st.bavail)
              .u64(st.files).u64(st.ffree).u64(0).u32(255);
          } else w.u32(0x01021997).u32(4096).u64(0).u64(0).u64(0).u64(mounts.size + 1).u64(0).u64(0).u32(255);
          break;
        }
        case 24: { // Rgetattr fixed layout is 153 bytes
          const f = fid(r.u32()); r.u64(); const st = await metadata(f);
          w.u64(0x7ff).raw(await qid(f, st)).u32(st.mode).u32(f.mount ? 1000 : 0).u32(f.mount ? 1000 : 0)
            .u64(st.nlink).u64(0).u64(st.size).u64(4096).u64(st.blocks);
          for (const ms of [st.atimeMs, st.mtimeMs, st.ctimeMs]) {
            w.u64(Math.floor(ms / 1000)).u64(Math.floor((ms % 1000) * 1e6));
          }
          w.u64(0).u64(0).u64(0).u64(0); break;
        }
        case 26: {
          const f = fid(r.u32()), valid = r.u32(), mode = r.u32(), uid = r.u32(), gid = r.u32();
          const size = integer(r.u64()), atime = Number(r.u64()) + Number(r.u64()) / 1e9,
            mtime = Number(r.u64()) + Number(r.u64()) / 1e9;
          if (!f.mount) fail('EROFS');
          if ((valid & 2 && uid !== 1000) || (valid & 4 && gid !== 1000)) fail('EPERM');
          // Open the inode without following symlinks, then mutate via its fd.
          const p = await host(f), st = await metadata(f);
          if (st.isSymbolicLink()) fail('ENOTSUP');
          if (!st.isFile() && !st.isDirectory()) fail('ENOTSUP');
          let temporary: FileHandle | undefined;
          const file = f.file ?? (temporary = await fs.open(p, (valid & 8 ? constants.O_WRONLY : constants.O_RDONLY) | constants.O_NOFOLLOW));
          try {
            if (valid & 1) await file.chmod(mode & 0o777);
            if (valid & 8) await file.truncate(size);
            if (valid & (16 | 32)) await file.utimes(valid & 16 ? (valid & 128 ? atime : Date.now() / 1000) : st.atimeMs / 1000,
              valid & 32 ? (valid & 256 ? mtime : Date.now() / 1000) : st.mtimeMs / 1000);
          } finally { await temporary?.close(); }
          break;
        }
        case 40: { // Treaddir; cookie is a stable index within this request's snapshot
          const f = fid(r.u32()), offset = integer(r.u64()), count = Math.min(r.u32(), msize - 11);
          if (!(await metadata(f)).isDirectory()) fail('ENOTDIR');
          const names = ['.', '..', ...(f.mount ? await fs.readdir(await host(f)) : [...mounts.keys()])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
          const entries: Buffer[] = []; let length = 0;
          for (let i = offset; i < names.length; i++) {
            const name = names[i]!;
            let loc: Location, st: Metadata;
            try { loc = await child(f, name); st = await metadata(loc); }
            catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
            const entry = new Writer().raw(await qid(loc, st)).u64(i + 1)
              .u8(st.isDirectory() ? 4 : st.isSymbolicLink() ? 10 : st.isFile() ? 8 : 0).string(name).bytes();
            if (length + entry.length > count) break;
            entries.push(entry); length += entry.length;
          }
          w.u32(length); for (const e of entries) w.raw(e); break;
        }
        case 50: { const f = fid(r.u32()); r.u32(); if (f.file) await f.file.sync(); break; }
        case 72: {
          const dir = fid(r.u32()), name = r.string(), mode = r.u32(); r.u32();
          const loc = await newChild(dir, name); await fs.mkdir(await host(loc, true), { mode: mode & 0o777 });
          w.raw(await qid(loc)); break;
        }
        case 16: {
          const dir = fid(r.u32()), name = r.string(), target = r.string(); r.u32();
          const loc = await newChild(dir, name); await fs.symlink(target, await host(loc, true)); w.raw(await qid(loc)); break;
        }
        case 22: { const f = fid(r.u32()); if (!f.mount) fail('EINVAL'); w.string(await fs.readlink(await host(f))); break; }
        case 70: {
          const dir = fid(r.u32()), old = fid(r.u32()), loc = await newChild(dir, r.string());
          if (old.mount !== loc.mount) fail('EXDEV');
          if (!(await metadata(old)).isFile()) fail('EPERM');
          await fs.link(await host(old), await host(loc, true)); break;
        }
        case 20: { const source = fid(r.u32()), dir = fid(r.u32()); await rename(copy(source), await newChild(dir, r.string())); break; }
        case 74: {
          const dir = fid(r.u32()), name = r.string(), newdir = fid(r.u32()), newname = r.string();
          await rename(await child(dir, name), await newChild(newdir, newname)); break;
        }
        case 76: {
          const dir = fid(r.u32()), name = r.string(), flags = r.u32(), loc = await child(dir, name);
          if (flags & ~0x200) fail('EINVAL'); requireMutable(loc);
          const p = await host(loc);
          if (flags & 0x200) await fs.rmdir(p); else await fs.unlink(p); break;
        }
        case 122: {
          const id = r.u32(), f = fid(id); requireMutable(f);
          try { const p = await host(f), st = await metadata(f); if (st.isDirectory()) await fs.rmdir(p); else await fs.unlink(p); }
          finally { await clearFid(id); }
          break;
        }
        case 30: case 32: fail('ENOTSUP'); // extended attributes
        case 18: fail('EPERM'); // no device nodes/FIFOs on the host
        case 52: case 54: fail('ENOTSUP'); // locks cannot truthfully cover host processes
        default: fail('ENOTSUP');
      }
      return packet(type + 1, tag, w);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'EIO';
      return packet(7, tag, new Writer().u32(ERRNO[code] ?? 5));
    }
  }
  return {
    handle9p(req, reply) {
      const data = Buffer.from(req);
      pending = pending.then(async () => { const response = await process(data); reply(response); }).catch(() => {});
    },
    async close() { closed = true; await pending; await clearAll(); },
  };
}
