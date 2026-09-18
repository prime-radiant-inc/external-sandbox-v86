#!/usr/bin/env node
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShellVM, type VMMount } from './vm.js';
import { createApiServer } from './http.js';
import { loadProxyPolicy } from './network/proxy-config.js';
import { startManagedProxy } from './network/managed-proxy.js';

const HELP = `v86-shell-server — a local JSON shell API inside a Linux VM

Usage: node dist/cli.js [options] [directory ...]

  --mount [NAME=]PATH   Mount a host directory at /mnt/NAME (repeatable).
                       NAME defaults to the directory basename.
  --preserve-paths     Also bind mounts at their original absolute host paths
                       inside the VM, for Claude Code and absolute file paths.
  --port PORT         Local HTTP port (default: 8686; 0 selects a free port).
  --memory MIB        Guest RAM, 128–2048 MiB (default: 512).
  --image PATH        Guest image directory (default: bundled images/linux).
  --proxy-config FILE Enable managed HTTP(S) egress with host-side policy and
                       credential substitution from a JSON configuration.
  --verbose           Print guest boot diagnostics on stderr.
  --help              Show this help.

POST http://127.0.0.1:8686/exec
  {"command":"printf hello; printf error >&2; exit 7","cwd":"/mnt/project"}

GET /health and GET /mounts provide readiness and mounted paths.
Selected directories are live read/write mounts. Networking is off by default.
`;

function aliasAllowed(target: string) {
  const protectedPaths = ['/bin', '/sbin', '/etc', '/usr', '/lib', '/lib64', '/dev', '/proc', '/sys', '/run', '/mnt', '/workspace', '/home/agent'];
  return target !== '/' && target !== '/tmp' && protectedPaths.every(p => target !== p && !target.startsWith(p + '/') && !p.startsWith(target + '/'));
}

async function main() {
  let port = 8686, memoryMiB = 512, preserve = false, verbose = false;
  let image = fileURLToPath(new URL('../images/linux', import.meta.url));
  let proxyConfig: string | undefined;
  const specs: string[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { process.stdout.write(HELP); return; }
    if (arg === '--preserve-paths') { preserve = true; continue; }
    if (arg === '--verbose') { verbose = true; continue; }
    if (arg === '--') { specs.push(...args.slice(i + 1)); break; }
    if (['--mount', '--port', '--memory', '--image', '--proxy-config'].includes(arg)) {
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === '--mount') specs.push(value);
      if (arg === '--port') port = Number(value);
      if (arg === '--memory') memoryMiB = Number(value);
      if (arg === '--image') image = path.resolve(value);
      if (arg === '--proxy-config') proxyConfig = path.resolve(value);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else specs.push(arg);
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535');
  const mounts: VMMount[] = [];
  for (const spec of specs) {
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
    mounts.push({ name, hostPath, ...(preservedPaths ? { preservedPaths } : {}) });
  }
  const policy = proxyConfig ? await loadProxyPolicy(proxyConfig) : undefined;
  const proxy = policy ? await startManagedProxy(policy) : undefined;
  let vm: ShellVM;
  try {
    console.error('Booting Linux in v86…');
    vm = await ShellVM.boot({ image, mounts, memoryMiB,
      managedNetwork: proxy ? { proxyPort: proxy.port, caCertificate: proxy.caCertificate, env: policy!.guestEnv } : undefined,
      onBootLog: verbose ? text => { process.stderr.write(text); } : undefined });
  } catch (error) { await proxy?.close(); throw error; }
  const server = createApiServer(vm);
  let shuttingDown = false;
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(); server.closeAllConnections();
    try { await vm.destroy(); } finally { await proxy?.close(); }
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.error(`Listening on http://127.0.0.1:${actualPort}`);
    if (proxy) console.error('Managed HTTP(S) egress enabled; direct guest connections are blocked.');
    for (const mount of mounts) console.error(`  ${mount.hostPath} -> /mnt/${mount.name}${mount.preservedPaths ? ' (original paths also available)' : ''}`);
  } catch (error) { await stop(); throw error; }
}

main().catch(error => { console.error(`v86-shell-server: ${error.message}`); process.exitCode = 1; });
