#!/usr/bin/env node
import { ShellVM } from './vm.js';
import { parseServerOptions } from './cli-options.js';
import { createApiServer } from './http.js';
import { loadProxyPolicy } from './network/proxy-config.js';
import { startManagedProxy } from './network/managed-proxy.js';

const HELP = `remote-sandbox-v86 — a local JSON shell API inside a Linux VM

Usage: remote-sandbox-v86 [options] [directory ...]

  --mount [NAME=]PATH   Mount read-write at /mnt/NAME (repeatable).
  --mount-rw [NAME=]PATH Explicit read-write mount.
  --mount-ro [NAME=]PATH Read-only mount, enforced on the host.
                       NAME defaults to the directory basename.
  --preserve-paths     Also bind mounts at their original absolute host paths
                       inside the VM, for Claude Code and absolute file paths.
  --port PORT         Local HTTP port (default: 8686; 0 selects a free port).
  --memory MIB        Guest RAM, 128–2048 MiB (default: 512).
  --image PATH        Guest image directory (default: bundled images/linux).
  --proxy-config FILE Enable managed HTTP(S) egress with host-side policy and
                       credential substitution from a JSON configuration.
  --packages LIST     Install comma-separated Alpine packages at boot (repeatable).
                       Requires --proxy-config permitting Alpine's package CDN.
  --verbose           Print guest boot diagnostics on stderr.
  --help              Show this help.

POST http://127.0.0.1:8686/exec
  {"command":"printf hello; printf error >&2; exit 7","cwd":"/mnt/project"}

GET /health and GET /mounts provide readiness and mounted paths.
Open / for the browser terminal, and /proxy for live managed proxy controls.
WebSocket /codex implements the Codex 0.164.0 exec-server protocol.
Mount modes appear in /mounts. Networking is off by default.
`;

async function main() {
  const { help, port, memoryMiB, image, mounts, proxyConfig, verbose, packages } = await parseServerOptions(process.argv.slice(2));
  if (help) { process.stdout.write(HELP); return; }
  const policy = proxyConfig ? await loadProxyPolicy(proxyConfig) : undefined;
  const proxy = policy ? await startManagedProxy(policy) : undefined;
  let vm: ShellVM;
  try {
    console.error('Booting Linux in v86…');
    if (packages.length) console.error(`Installing Alpine packages before commands start: ${packages.join(', ')}`);
    vm = await ShellVM.boot({ image, mounts, memoryMiB, packages,
      managedNetwork: proxy ? { proxyPort: proxy.port, caCertificate: proxy.caCertificate, env: policy!.guestEnv } : undefined,
      onBootLog: verbose ? text => { process.stderr.write(text); } : undefined });
  } catch (error) { await proxy?.close(); throw error; }
  const server = createApiServer(vm, { proxyManagement: proxy });
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
    console.error(`Browser terminal: http://127.0.0.1:${actualPort}/`);
    console.error(`Codex exec-server: ws://127.0.0.1:${actualPort}/codex`);
    if (proxy) {
      console.error(`Proxy controls: http://127.0.0.1:${actualPort}/proxy`);
      console.error('Managed HTTP(S) egress enabled; direct guest connections are blocked.');
    }
    for (const mount of mounts) console.error(`  ${mount.hostPath} -> /mnt/${mount.name} (${mount.mode ?? 'rw'})${mount.preservedPaths ? ' (original paths also available)' : ''}`);
  } catch (error) { await stop(); throw error; }
}

main().catch(error => { console.error(`remote-sandbox-v86: ${error.message}`); process.exitCode = 1; });
