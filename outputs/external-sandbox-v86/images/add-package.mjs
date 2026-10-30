#!/usr/bin/env node
// Trusted build-time tool. The runtime server never imports this file.
// Adds one package pinned in sources.lock.json to the bundled initramfs without
// rebuilding the kernel or changing any other installed package.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [lockPath] = process.argv.slice(2);
if (!lockPath?.startsWith('apks/')) throw new Error('Usage: node images/add-package.mjs apks/NAME-VERSION.apk');
const images = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(images);
const cache = path.join(images, 'cache');
const output = path.join(images, 'linux');
const lockBytes = await fs.readFile(path.join(images, 'sources.lock.json'));
const lock = JSON.parse(lockBytes.toString('utf8'));
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

async function cached(entryPath) {
  const entry = lock.inputs.find(input => input.path === entryPath);
  if (!entry) throw new Error(`${entryPath} is not pinned in sources.lock.json`);
  const destination = path.join(cache, entry.path);
  let bytes = await fs.readFile(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!bytes) {
    const response = await fetch(entry.url);
    if (!response.ok) throw new Error(`Download failed ${response.status}: ${entry.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);
  }
  if (sha256(bytes) !== entry.sha256) throw new Error(`Checksum mismatch for ${entry.path}`);
}
const base = 'alpine-minirootfs-3.21.0-x86.tar.gz';
const cpio = 'apks/cpio-2.15-r0.apk';
for (const entry of [base, cpio, lockPath]) await cached(entry);

const recipe = `set -eu
set -o pipefail
umask 022
apk add --no-network --no-scripts /cache/${cpio}
mkdir /rootfs
cd /rootfs
gzip -dc /out/initrd.img | cpio -idm --quiet
apk --root /rootfs --no-network --no-scripts --no-cache add /cache/${lockPath}
sed -i 's/><[^[:space:]]*$//' /rootfs/etc/apk/world
apk --root /rootfs info -v | LC_ALL=C sort > /out/packages.txt
rm -rf /rootfs/var/cache/apk
find . -exec touch -h -t 202412050000.00 {} +
find . -print0 | LC_ALL=C sort -z | cpio --null -o --format=newc --reproducible 2>/dev/null | gzip -9n > /out/initrd.img
`;
function docker(args) {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker failed with status ${result.status}`);
}
const tag = 'v86-shell-build-base:3.21.0';
docker(['import', '--platform', 'linux/386', path.join(cache, base), tag]);
docker(['run', '--rm', '--platform', 'linux/386', '--network', 'none',
  '-v', `${cache}:/cache:ro`, '-v', `${output}:/out`, tag, 'sh', '-c', recipe]);

const manifestPath = path.join(output, 'image.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
manifest.build.sourcesLockSha256 = sha256(lockBytes);
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
// Reapplies init, modules and the world file, then refreshes every asset hash.
const prepared = spawnSync(process.execPath, [path.join(repo, 'scripts/prepare-image.mjs')], { stdio: 'inherit' });
if (prepared.status !== 0) throw new Error('prepare-image failed');
