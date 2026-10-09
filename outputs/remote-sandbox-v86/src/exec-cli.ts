#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/remote_sandbox_exec.py', import.meta.url));
// Keep the complete command as one argument. No host shell parses its contents.
const child = spawn('uv', ['run', '--quiet', '--script', script, ...process.argv.slice(2)], {
  stdio: 'inherit', shell: false,
});
let finished = false;
let interrupted: NodeJS.Signals | undefined;
const forwards = new Map<NodeJS.Signals, () => void>();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  const forward = () => {
    if (finished) return;
    interrupted ??= signal;
    // uv forwards signals to its Python child. Wait for it to finish so the
    // streaming client has time to send cancellation to the guest process.
    child.kill(signal);
  };
  forwards.set(signal, forward);
  process.on(signal, forward);
}

function cleanup() {
  finished = true;
  for (const [signal, handler] of forwards) process.removeListener(signal, handler);
  process.removeListener('exit', onExit);
}

function onExit() {
  if (!finished) child.kill('SIGTERM');
}
process.once('exit', onExit);

child.once('error', (error: NodeJS.ErrnoException) => {
  cleanup();
  process.stderr.write(error.code === 'ENOENT'
    ? 'remote-sandbox-v86-exec: uv was not found. Install uv: https://docs.astral.sh/uv/getting-started/installation/\n'
    : 'remote-sandbox-v86-exec: unable to start uv. Check that uv is installed and executable.\n');
  process.exitCode = 125;
});

child.once('close', (code, signal) => {
  if (finished) return;
  cleanup();
  const termination = interrupted ?? signal;
  process.exitCode = termination ? 128 + constants.signals[termination] : code ?? 125;
});
