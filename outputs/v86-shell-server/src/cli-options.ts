import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VMMount } from './vm.js';

function aliasAllowed(target: string) {
  const protectedPaths = ['/bin', '/sbin', '/etc', '/usr', '/lib', '/lib64', '/dev', '/proc', '/sys', '/run', '/mnt', '/workspace', '/home/agent'];
  return target !== '/' && target !== '/tmp' && protectedPaths.every(p => target !== p && !target.startsWith(p + '/') && !p.startsWith(target + '/'));
}

export async function parseServerOptions(args: string[]) {
  let port = 8686, memoryMiB = 512, preserve = false, verbose = false;
  let image = fileURLToPath(new URL('../images/linux', import.meta.url));
  let proxyConfig: string | undefined;
  const specs: { value: string; mode: 'ro' | 'rw' }[] = [];
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { help = true; break; }
    if (arg === '--preserve-paths') { preserve = true; continue; }
    if (arg === '--verbose') { verbose = true; continue; }
    if (arg === '--') { specs.push(...args.slice(i + 1).map(value => ({ value, mode: 'rw' as const }))); break; }
    if (['--mount', '--mount-ro', '--mount-rw', '--port', '--memory', '--image', '--proxy-config'].includes(arg)) {
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (['--mount', '--mount-ro', '--mount-rw'].includes(arg)) specs.push({ value, mode: arg === '--mount-ro' ? 'ro' : 'rw' });
      if (arg === '--port') port = Number(value);
      if (arg === '--memory') memoryMiB = Number(value);
      if (arg === '--image') image = path.resolve(value);
      if (arg === '--proxy-config') proxyConfig = path.resolve(value);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else specs.push({ value: arg, mode: 'rw' });
  }
  if (help) return { help, port, memoryMiB, image, proxyConfig, verbose, mounts: [] as VMMount[] };
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535');
  const mounts: VMMount[] = [];
  for (const { value: spec, mode } of specs) {
    const split = spec.indexOf('=');
    const input = split >= 0 ? spec.slice(split + 1) : spec;
    if (!input) throw new Error('Mount path must not be empty');
    const requestedPath = path.resolve(input);
    const hostPath = await realpath(requestedPath);
    const name = split >= 0 ? spec.slice(0, split) : path.basename(requestedPath);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`Invalid mount name: ${name}. Use NAME=/path with a simple name.`);
    if (mounts.some(m => m.name === name)) throw new Error(`Duplicate mount name: ${name}. Give each directory a unique NAME.`);
    if (!(await stat(hostPath)).isDirectory()) throw new Error(`Mount is not a directory: ${hostPath}`);
    let preservedPaths: string[] | undefined;
    if (preserve) {
      preservedPaths = [...new Set([hostPath, requestedPath])];
      for (const target of preservedPaths) if (!aliasAllowed(target)) throw new Error(`Cannot preserve guest system path ${target}; omit --preserve-paths to use /mnt/${name}`);
    }
    mounts.push({ name, hostPath, mode, ...(preservedPaths ? { preservedPaths } : {}) });
  }
  return { help, port, memoryMiB, image, proxyConfig, verbose, mounts };
}
