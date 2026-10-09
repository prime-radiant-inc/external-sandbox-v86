import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = new URL('../src/ui/shared/', import.meta.url);
const destination = new URL('../dist/ui/shared/', import.meta.url);
const runtimeAssets = ['assets/proxy.html', 'assets/terminal.html', 'assets/terminal.js'];

async function filesIn(directory, prefix = '') {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) names.push(...await filesIn(join(directory, entry.name), name + '/'));
    else if (entry.isFile()) names.push(name);
    else throw new Error(`Shared UI bundle contains a nonregular file: ${name}`);
  }
  return names.sort();
}

/** Verify the complete source bundle, including the shared frontend tests. */
export async function verifyUiBundle(directory = source) {
  const root = directory instanceof URL ? fileURLToPath(directory) : resolve(directory);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.name !== 'remote-sandbox-ui'
      || typeof manifest.version !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.sourceCommit)
      || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('Invalid shared UI manifest');
  }
  const expected = Object.keys(manifest.files).sort();
  const actual = (await filesIn(root)).filter(name => name !== 'manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Shared UI manifest file list differs from the bundle; run the shared UI updater');
  }
  for (const required of [...runtimeAssets, 'package.json']) {
    if (!Object.hasOwn(manifest.files, required)) throw new Error(`Shared UI manifest is missing ${required}`);
  }
  for (const name of expected) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')
        || !/^[0-9a-f]{64}$/.test(manifest.files[name])) {
      throw new Error(`Invalid shared UI manifest entry: ${name}`);
    }
    const digest = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
    if (digest !== manifest.files[name]) throw new Error(`Shared UI digest mismatch: ${name}; run the shared UI updater`);
  }
  return manifest;
}

/** Runtime bundles retain provenance but omit shared development tests. */
export async function copyUiAssets(from = source, to = destination) {
  const manifest = await verifyUiBundle(from);
  const fromPath = from instanceof URL ? fileURLToPath(from) : resolve(from);
  const toPath = to instanceof URL ? fileURLToPath(to) : resolve(to);
  await rm(toPath, { recursive: true, force: true });
  const assets = Object.keys(manifest.files).filter(name => name.startsWith('assets/'));
  for (const name of [...assets, 'manifest.json', 'package.json']) {
    await mkdir(dirname(join(toPath, name)), { recursive: true });
    await cp(join(fromPath, name), join(toPath, name));
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) {
    throw new Error('Usage: node scripts/copy-ui-assets.mjs [--check]');
  }
  if (process.argv[2] === '--check') await verifyUiBundle();
  else {
    await copyUiAssets();
    // Remove assets left by builds made before the shared bundle was introduced.
    await rm(new URL('../dist/ui/assets/', import.meta.url), { recursive: true, force: true });
  }
}
