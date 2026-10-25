#!/usr/bin/env node
// Build-time only: patch the bundled newc initramfs without extracting it on the host.
// Preserving original archive records keeps ownership, device nodes, and hardlinks.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageDir = path.join(root, 'images/linux');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const align = n => (n + 3) & ~3;
const manifest = JSON.parse(await fs.readFile(path.join(imageDir, 'image.json'), 'utf8'));
const agentHash = sha256(await fs.readFile(path.join(root, 'guest/agent/agent.c')));
if (manifest.build.agentSourceSha256 !== agentHash) {
  throw new Error('The agent source changed; run node images/build.mjs to compile it before patching the image');
}
const archive = gunzipSync(await fs.readFile(path.join(imageDir, 'initrd.img')));
const entries = [];
let maxInode = 0;
for (let offset = 0; offset + 110 <= archive.length;) {
  if (archive.toString('ascii', offset, offset + 6) !== '070701') throw new Error('Expected newc initramfs');
  const fields = Array.from({ length: 13 }, (_, i) => parseInt(archive.toString('ascii', offset + 6 + 8*i, offset + 14 + 8*i), 16));
  if (fields.some(value => !Number.isSafeInteger(value))) throw new Error('Invalid newc header');
  const nameEnd = offset + 110 + fields[11];
  const name = archive.toString('utf8', offset + 110, nameEnd - 1);
  const dataStart = align(nameEnd);
  const end = align(dataStart + fields[6]);
  if (end > archive.length) throw new Error('Truncated newc archive');
  if (name === 'TRAILER!!!') break;
  maxInode = Math.max(maxInode, fields[0]);
  entries.push({ name: name.replace(/^\.\//, ''), fields, raw: archive.subarray(offset, end), data: archive.subarray(dataStart, dataStart + fields[6]) });
  offset = end;
}
const replacements = new Map();
replacements.set('init', { mode: 0o100755, data: await fs.readFile(path.join(root, 'images/init')) });
// Installing from local files records each world entry with a checksum pin.
// Plain names let runtime package installs upgrade these packages from the
// repository when a newer package depends on a newer build.
const world = entries.find(entry => entry.name === 'etc/apk/world');
if (!world) throw new Error('The initramfs has no /etc/apk/world');
replacements.set('etc/apk/world', { mode: world.fields[1], data: Buffer.from(world.data.toString('utf8').replace(/><\S*$/gm, '')) });
const moduleDir = 'usr/local/lib/v86-modules';
const existingNames = new Set(entries.map(entry => entry.name));
for (const name of ['usr/local/lib', moduleDir]) {
  if (!existingNames.has(name)) replacements.set(name, { mode: 0o40755, data: Buffer.alloc(0) });
}
const moduleHashes = {};
for (const module of ['netfs', '9pnet', '9pnet_virtio', '9p', 'failover', 'net_failover', 'virtio_net']) {
  const compressed = await fs.readFile(path.join(root, `images/modules/${module}.ko.gz`));
  moduleHashes[`${module}.ko.gz`] = sha256(compressed);
  replacements.set(`${moduleDir}/${module}.ko`, { mode: 0o100644, data: gunzipSync(compressed) });
}
function record(name, item, prior) {
  const encodedName = Buffer.from(`./${name}\0`);
  const fields = prior ? [...prior] : [++maxInode, item.mode, 0, 0, (item.mode & 0o170000) === 0o40000 ? 2 : 1, 1733356800, 0, 0, 0, 0, 0, 0, 0];
  fields[1] = item.mode;
  fields[6] = item.data.length;
  fields[11] = encodedName.length;
  const header = Buffer.from('070701' + fields.map(n => n.toString(16).padStart(8, '0')).join(''));
  return Buffer.concat([header, encodedName, Buffer.alloc(align(110 + encodedName.length) - 110 - encodedName.length), item.data, Buffer.alloc(align(item.data.length) - item.data.length)]);
}
const parts = entries.map(entry => {
  const replacement = replacements.get(entry.name);
  if (!replacement) return entry.raw;
  replacements.delete(entry.name);
  return record(entry.name, replacement, entry.fields);
});
for (const [name, item] of replacements) parts.push(record(name, item));
// The trailer name must be literal, without the normal './' prefix.
const trailerName = Buffer.from('TRAILER!!!\0');
const trailerFields = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, trailerName.length, 0];
parts.push(Buffer.concat([Buffer.from('070701' + trailerFields.map(n => n.toString(16).padStart(8, '0')).join('')), trailerName, Buffer.alloc(align(110 + trailerName.length) - 110 - trailerName.length)]));
const packed = Buffer.concat(parts);
const initrd = gzipSync(Buffer.concat([packed, Buffer.alloc((512 - packed.length % 512) % 512)]), { level: 9 });
await fs.writeFile(path.join(imageDir, 'initrd.img'), initrd);
manifest.v86Version = '0.5.458';
manifest.memoryMiB = 512;
manifest.capabilities = { ...manifest.capabilities, startupPackages: true };
for (const asset of Object.values(manifest.assets)) {
  const bytes = await fs.readFile(path.join(imageDir, asset.path));
  asset.sha256 = sha256(bytes);
  asset.size = bytes.length;
}
manifest.build.initSourceSha256 = sha256(await fs.readFile(path.join(root, 'images/init')));
manifest.build.hostFilesystem = 'virtio-9p/9p2000.L at /mnt';
manifest.build.modules = moduleHashes;
await fs.writeFile(path.join(imageDir, 'image.json'), JSON.stringify(manifest, null, 2) + '\n');
console.error(`Prepared ${path.join(imageDir, 'image.json')} (${initrd.length} initrd bytes)`);
