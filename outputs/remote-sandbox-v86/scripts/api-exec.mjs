#!/usr/bin/env node
import path from 'node:path';

const MAX_STDIN_BYTES = 32 * 1024;
// A JSON string can expand each output byte to a six-byte Unicode escape.
const MAX_RESPONSE_BYTES = 6 * 16 * 1024 * 1024 + 64 * 1024;
const aborter = new AbortController();
let interruptedExit;
for (const [name, number] of [['SIGHUP', 1], ['SIGINT', 2], ['SIGTERM', 15]]) {
  process.on(name, () => {
    interruptedExit = 128 + number;
    aborter.abort();
    // Also release an explicitly requested stdin read that has not reached EOF.
    if (environmentSetting('REMOTE_SANDBOX_FORWARD_STDIN') === '1') process.stdin.destroy();
  });
}

function environmentSetting(name, fallback) {
  return process.env[name] ?? process.env[name.replace('REMOTE_SANDBOX_', 'V86_')] ?? fallback;
}

function integerSetting(name, fallback, maximum) {
  const raw = environmentSetting(name);
  if (raw === undefined) return fallback;
  const number = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return number;
}

function apiBase() {
  const url = new URL(environmentSetting('REMOTE_SANDBOX_API_URL') ?? 'http://127.0.0.1:8686');
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('REMOTE_SANDBOX_API_URL must be an http:// localhost, 127.0.0.1, or [::1] origin without credentials or a path.');
  }
  return url;
}

async function apiJson(base, route, options = {}, timeout = 10_000) {
  const response = await fetch(new URL(route, base), {
    ...options, redirect: 'error',
    signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(timeout)]),
  });
  const chunks = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('API response exceeds the response-size limit.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error(`API returned invalid JSON (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${body?.error ?? response.statusText}`);
  return body;
}

function relativeWithin(parent, child) {
  if (typeof parent !== 'string' || !path.isAbsolute(parent)) return undefined;
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    ? relative : undefined;
}

async function guestCwd(base) {
  const explicit = environmentSetting('REMOTE_SANDBOX_CWD');
  if (explicit !== undefined) {
    if (!path.posix.isAbsolute(explicit) || explicit.includes('\0')) throw new Error('REMOTE_SANDBOX_CWD must be an absolute guest path.');
    return explicit;
  }
  const cwd = process.cwd();
  const body = await apiJson(base, '/mounts');
  if (!Array.isArray(body?.mounts)) throw new Error('API /mounts returned an invalid mount list.');
  // Preserved absolute paths let Claude use its complete command, including its cwd file.
  for (const mount of body.mounts) {
    if (Array.isArray(mount?.preservedPaths)
      && mount.preservedPaths.some(alias => relativeWithin(alias, cwd) !== undefined)) return cwd;
  }
  const candidates = body.mounts.flatMap(mount => {
    const relative = relativeWithin(mount?.hostPath, cwd);
    if (relative === undefined || typeof mount?.guestPath !== 'string' || !path.posix.isAbsolute(mount.guestPath)) return [];
    return [{ hostPath: mount.hostPath, guestPath: path.posix.join(mount.guestPath, ...relative.split(path.sep)) }];
  }).sort((left, right) => right.hostPath.length - left.hostPath.length);
  if (!candidates[0]) throw new Error(`Host cwd ${cwd} is not in a mounted directory. Set REMOTE_SANDBOX_CWD to an absolute guest path or mount this directory.`);
  return candidates[0].guestPath;
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error(`stdin exceeds ${MAX_STDIN_BYTES} bytes.`);
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

function write(stream, value) {
  return new Promise((resolve, reject) => stream.write(value, error => error ? reject(error) : resolve()));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('Expected exactly one argument containing the complete shell command.');
  const base = apiBase();
  const timeoutMs = integerSetting('REMOTE_SANDBOX_TIMEOUT_MS', 120_000, 300_000);
  const maxOutputBytes = integerSetting('REMOTE_SANDBOX_MAX_OUTPUT_BYTES', undefined, 16 * 1024 * 1024);
  const request = { command: args[0], cwd: await guestCwd(base), timeoutMs };
  if (maxOutputBytes !== undefined) request.maxOutputBytes = maxOutputBytes;
  if (environmentSetting('REMOTE_SANDBOX_FORWARD_STDIN') === '1') request.stdin = await readStdin();
  const result = await apiJson(base, '/exec', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
  }, timeoutMs + 60_000);
  if (typeof result?.stdout !== 'string' || typeof result?.stderr !== 'string'
    || typeof result.timedOut !== 'boolean' || typeof result.outputLimitExceeded !== 'boolean'
    || !(result.exitCode === null || (Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255))
    || !(result.signal === null || (Number.isInteger(result.signal) && result.signal >= 1 && result.signal <= 127))) {
    throw new Error('API /exec returned an invalid execution result.');
  }
  await Promise.all([write(process.stdout, result.stdout), write(process.stderr, result.stderr)]);
  if (result.timedOut) return 124;
  if (result.outputLimitExceeded) return 125;
  if (result.signal !== null) return 128 + result.signal;
  if (result.exitCode === null) throw new Error('API returned neither an exit code nor a signal.');
  return result.exitCode;
}

try {
  const result = await main();
  process.exitCode = interruptedExit ?? result;
} catch (error) {
  if (interruptedExit !== undefined) {
    process.exitCode = interruptedExit;
  } else {
    process.stderr.write(`remote-sandbox-shell-prefix: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 125;
  }
}
