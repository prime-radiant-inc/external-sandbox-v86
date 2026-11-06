#!/usr/bin/env node
// Trusted build-time tool. The runtime server never imports this file.
//
// Writes images/THIRD-PARTY-NOTICES.md from the bundled image: Alpine package
// licenses come from the APK database inside linux/initrd.img. Fails if any
// license identifier lacks a text in images/licenses/. With --check, compares
// instead of writing and exits non-zero when the notices are out of date.
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const images = path.dirname(fileURLToPath(import.meta.url));
const linux = path.join(images, 'linux');
const output = path.join(images, 'THIRD-PARTY-NOTICES.md');
const licenseDir = path.join(images, 'licenses');
const check = process.argv.includes('--check');

function readInitrdFile(archive, wanted) {
  const align = n => (n + 3) & ~3;
  for (let offset = 0; offset + 110 <= archive.length;) {
    if (archive.toString('ascii', offset, offset + 6) !== '070701') throw new Error('Expected newc initramfs');
    const field = i => parseInt(archive.toString('ascii', offset + 6 + 8*i, offset + 14 + 8*i), 16);
    const size = field(6);
    const nameEnd = offset + 110 + field(11);
    const name = archive.toString('utf8', offset + 110, nameEnd - 1).replace(/^\.\//, '');
    const dataStart = align(nameEnd);
    if (name === 'TRAILER!!!') break;
    if (name === wanted) return archive.toString('utf8', dataStart, dataStart + size);
    offset = align(dataStart + size);
  }
  throw new Error(`${wanted} not found in initramfs`);
}

function parsePackages(database) {
  return database.split('\n\n').map(block => {
    const fields = {};
    for (const line of block.split('\n')) {
      const match = /^([A-Za-z]):(.*)$/.exec(line);
      if (match && !(match[1] in fields)) fields[match[1]] = match[2];
    }
    return fields;
  }).filter(fields => fields.P).map(fields => ({
    name: fields.P, version: fields.V, license: fields.L, url: fields.U, origin: fields.o, commit: fields.c,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

// The aports directory holding the APKBUILD (upstream source URLs, checksums,
// and Alpine patches) at the commit that built the package. Packages pinned
// from Alpine's community repository are in community/; everything else,
// including the minirootfs base, is in main/.
function aportsSource(item, communityApks) {
  if (!item.origin || !/^[0-9a-f]{40}$/.test(item.commit ?? '')) {
    throw new Error(`${item.name} has no origin or aports commit in the APK database`);
  }
  const repository = communityApks.has(`${item.name}-${item.version}.apk`) ? 'community' : 'main';
  const url = `https://gitlab.alpinelinux.org/alpine/aports/-/tree/${item.commit}/${repository}/${item.origin}`;
  return `[aports ${repository}/${item.origin}@${item.commit.slice(0, 7)}](${url})`;
}

// SPDX expression to identifiers. Public-Domain is Alpine's marker for public
// domain code and has no license text.
const identifiers = expression => expression
  .replace(/[()]/g, ' ').split(/\s+(?:AND|OR|WITH)\s+|\s+/)
  .filter(id => id && id !== 'Public-Domain');

const licenseLinks = expression => expression.replace(/[A-Za-z0-9.+-]+/g, token =>
  ['AND', 'OR', 'WITH', 'Public-Domain'].includes(token) ? token : `[${token}](licenses/${token}.txt)`);

const manifest = JSON.parse(await fs.readFile(path.join(linux, 'image.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(images, 'sources.lock.json'), 'utf8'));
const seabios = (await fs.readFile(path.join(linux, 'seabios.bin'))).toString('latin1');
const seabiosVersion = /rel-(\d+\.\d+\.\d+)/.exec(seabios)?.[1];
if (!seabiosVersion) throw new Error('Could not find the SeaBIOS release in linux/seabios.bin');

const packages = parsePackages(readInitrdFile(gunzipSync(await fs.readFile(path.join(linux, 'initrd.img'))), 'lib/apk/db/installed'));
const kernel = packages.find(item => item.name === 'linux-virt');
if (!kernel) throw new Error('linux-virt is not installed in the initramfs');

const firmware = { name: 'SeaBIOS and SeaVGABIOS', license: 'LGPL-3.0-only' };
const used = new Set([...packages.flatMap(item => identifiers(item.license)), ...identifiers(firmware.license)]);
const available = new Set((await fs.readdir(licenseDir)).filter(name => name.endsWith('.txt')).map(name => name.slice(0, -4)));
const missing = [...used].filter(id => !available.has(id)).sort();
if (missing.length) throw new Error(`Add license texts to images/licenses/ for: ${missing.join(', ')}`);
const unused = [...available].filter(id => !used.has(id)).sort();
if (unused.length) throw new Error(`Remove unused license texts from images/licenses/: ${unused.join(', ')}`);

const communityApks = new Set(lock.inputs
  .filter(input => input.url.includes('/community/'))
  .map(input => path.basename(input.path)));
const rows = packages.map(item =>
  `| ${item.name} | ${item.version} | ${licenseLinks(item.license)} | ${aportsSource(item, communityApks)} | ${item.url ? `<${item.url}>` : ''} |`);

const notices = `# Third-party notices

<!-- Generated by images/notices.mjs from the bundled image. Do not edit. -->

The external-sandbox-v86 source code, including the guest agent and init
script, is licensed under Apache 2.0 (see \`LICENSE\` at the package root).
The bundled guest image contains third-party software that keeps its own
licenses, listed below. Each license text is in [\`licenses/\`](licenses),
named by its [SPDX identifier](https://spdx.org/licenses/). Package licenses
are as declared in Alpine Linux package metadata. See
[\`../PROVENANCE.md\`](../PROVENANCE.md) for where each component came from.

## Source code

Alpine Linux built every package from a directory in its
[aports](https://gitlab.alpinelinux.org/alpine/aports) repository. The Source
links below point to that directory at the exact commit recorded in the
package's metadata. Its \`APKBUILD\` lists the upstream source archive URLs with
their SHA-512 checksums and applies the Alpine patches kept alongside it.

## Firmware

| Component | Version | License | Source | Files |
| --- | --- | --- | --- | --- |
| ${firmware.name} | ${seabiosVersion} | ${licenseLinks(firmware.license)} | [seabios-${seabiosVersion}.tar.gz](https://www.seabios.org/downloads/seabios-${seabiosVersion}.tar.gz) ([git tag](https://github.com/coreboot/seabios/tree/rel-${seabiosVersion})), configured and built by v86's [build script and configs](https://github.com/copy/v86/tree/${lock.v86Revision}/bios) | \`linux/seabios.bin\`, \`linux/vgabios.bin\` |

## Linux kernel

| Component | Version | License | Source | Files |
| --- | --- | --- | --- | --- |
| Linux (Alpine \`${kernel.name}\`) | ${kernel.version} | ${licenseLinks(kernel.license)} | ${aportsSource(kernel, new Set())} | \`linux/bzimage\`, \`modules/*.ko.gz\` |

## Alpine Linux ${manifest.build.alpine} packages in \`linux/initrd.img\`

| Package | Version | License | Source | Upstream |
| --- | --- | --- | --- | --- |
${rows.join('\n')}
`;

if (check) {
  const current = await fs.readFile(output, 'utf8').catch(() => '');
  if (current !== notices) {
    console.error('images/THIRD-PARTY-NOTICES.md is out of date; run node images/notices.mjs');
    process.exit(1);
  }
  console.log(`Third-party notices match the image (${packages.length} packages, ${used.size} licenses)`);
} else {
  await fs.writeFile(output, notices);
  console.log(`Wrote images/THIRD-PARTY-NOTICES.md (${packages.length} packages, ${used.size} licenses)`);
}
