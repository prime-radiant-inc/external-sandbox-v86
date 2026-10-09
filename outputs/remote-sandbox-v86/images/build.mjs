#!/usr/bin/env node
// Trusted build-time tool. The runtime server never imports this file.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const images = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(images);
const cache = path.join(images, 'cache');
let outputPath;
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--output' && process.argv[index + 1]) outputPath = process.argv[++index];
  else throw new Error(`Unknown or incomplete build option: ${process.argv[index]}`);
}
const output = outputPath ? path.resolve(outputPath) : path.join(images, 'linux');
const lock = JSON.parse(await fs.readFile(path.join(images, 'sources.lock.json'), 'utf8'));
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
await fs.mkdir(cache, { recursive: true });
await fs.mkdir(output, { recursive: true });
const agentSource = 'guest/agent/agent.c';
const agentBytes = await fs.readFile(path.join(repo, agentSource));
const stagedAgent = 'images/cache/production-agent.c';
await fs.writeFile(path.join(repo, stagedAgent), agentBytes);
const buildRecipe = await fs.readFile(path.join(images, 'build-in-container.sh'), 'utf8');
const stagedInit = 'images/cache/production-init';
await fs.writeFile(path.join(repo, stagedInit), await fs.readFile(path.join(images, 'init')));
async function download(entry) {
  const destination = path.join(cache, entry.path);
  let bytes;
  try { bytes = await fs.readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes && sha256(bytes) === entry.sha256) return;
  if (bytes) throw new Error(`Checksum mismatch for cached input ${entry.path}; remove that cache file to fetch again`);
  console.error(`Downloading ${entry.path}`);
  const response = await fetch(entry.url);
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${entry.url}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== entry.sha256) throw new Error(`Checksum mismatch for ${entry.url}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
}
for (let index=0; index<lock.inputs.length; index+=4) await Promise.all(lock.inputs.slice(index,index+4).map(download));
function docker(args) {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker failed with status ${result.status}`);
}
const tag = 'v86-shell-build-base:3.21.0';
docker(['import', '--platform', 'linux/386', path.join(cache, 'alpine-minirootfs-3.21.0-x86.tar.gz'), tag]);
docker(['run', '--rm', '--platform', 'linux/386', '--network', 'none',
  '-e', `AGENT_SOURCE=${stagedAgent}`, '-e', `INIT_SOURCE=${stagedInit}`,
  '-v', `${repo}:/src:ro`, '-v', `${cache}:/cache:ro`, '-v', `${output}:/out`,
  tag, 'sh', '-c', buildRecipe]);
const assets = {};
for (const [key, filename] of Object.entries({ bios:'seabios.bin', vgaBios:'vgabios.bin', bzimage:'bzimage', initrd:'initrd.img' })) {
  const bytes = await fs.readFile(path.join(output, filename));
  assets[key] = { path: filename, sha256: sha256(bytes), size: bytes.length };
}
const manifest = {
  formatVersion: 1, v86Version: '0.5.458', memoryMiB: 512,
  capabilities: { startupPackages: true },
  cmdline: 'console=ttyS0,115200 quiet loglevel=3 rdinit=/init panic=-1 acpi=off pci=nomsi',
  assets,
  build: { alpine: '3.21.0', kernel: '6.12.109-r0', agentSource,
    agentSourceSha256: sha256(agentBytes),
    initSourceSha256: sha256(await fs.readFile(path.join(images, 'init'))),
    hostFilesystem: 'virtio-9p/9p2000.L at /mnt',
    sourcesLockSha256: sha256(await fs.readFile(path.join(images, 'sources.lock.json'))) },
};
await fs.writeFile(path.join(output, 'image.json'), JSON.stringify(manifest, null, 2)+'\n');
console.error(`Built ${path.join(output, 'image.json')}`);
