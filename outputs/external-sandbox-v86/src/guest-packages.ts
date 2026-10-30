import { gzipSync } from 'node:zlib';
import { GUEST_PROXY_URL } from './network/wisp-relay.js';

/** Plain Alpine names only: no options, URLs, paths, repositories, or selectors. */
export function normalizePackages(values: string[]): string[] {
  if (!Array.isArray(values)) throw new Error('Startup packages must be a list of Alpine package names');
  const packages = new Set<string>();
  for (const name of values) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9+_.-]{0,127}$/.test(name)) {
      throw new Error('Invalid startup package name; use plain Alpine package names only');
    }
    packages.add(name);
    if (packages.size > 64) throw new Error('At most 64 startup packages may be requested');
  }
  return [...packages];
}

const align = (size: number) => (size + 3) & ~3;

function record(name: string, data: Buffer, mode: number, inode: number): Buffer {
  const encoded = Buffer.from(name + '\0');
  const fields = [inode, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, encoded.length, 0];
  const header = Buffer.from('070701' + fields.map(value => value.toString(16).padStart(8, '0')).join(''));
  return Buffer.concat([header, encoded, Buffer.alloc(align(header.length + encoded.length) - header.length - encoded.length),
    data, Buffer.alloc(align(data.length) - data.length)]);
}

/** Linux unpacks concatenated gzip/newc archives. Never mutate the verified base image. */
export function appendGuestBootstrap(initrd: ArrayBuffer, options: { packages: string[]; caCertificate: string }): ArrayBuffer {
  if (typeof options.caCertificate !== 'string' || !options.caCertificate || Buffer.byteLength(options.caCertificate) > 128 * 1024) {
    throw new Error('Invalid managed proxy public certificate');
  }
  const config = Buffer.from(JSON.stringify({ version: 1, packages: normalizePackages(options.packages),
    caCertificate: options.caCertificate, proxyUrl: GUEST_PROXY_URL }));
  const archive = Buffer.concat([
    record('etc/v86-bootstrap.json', config, 0o100600, 1),
    record('TRAILER!!!', Buffer.alloc(0), 0, 0),
  ]);
  const compressed = gzipSync(Buffer.concat([archive, Buffer.alloc((512 - archive.length % 512) % 512)]));
  const combined = Buffer.concat([Buffer.from(initrd), compressed]);
  return combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength) as ArrayBuffer;
}
