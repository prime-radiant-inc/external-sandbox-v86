import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

const launcher = fileURLToPath(new URL('../src/exec-cli.ts', import.meta.url));
const script = fileURLToPath(new URL('../scripts/v86_exec.py', import.meta.url));
const loader = createRequire(import.meta.url).resolve('tsx');

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v86-exec-cli-'));
  const bin = path.join(root, 'bin'); await mkdir(bin);
  const uv = path.join(bin, 'uv');
  await writeFile(uv, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
if (process.env.FAKE_UV_WAIT) {
  const signal = name => {
    fs.writeFileSync(process.env.FAKE_UV_SIGNAL_FILE, name);
    process.exit(128 + require('node:os').constants.signals[name]);
  };
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, () => signal(name));
  process.stdout.write(JSON.stringify({ ready: process.pid }) + '\n');
  setInterval(() => {}, 1000);
} else {
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ args: process.argv.slice(2), stdin: Buffer.concat(chunks).toString() }) + '\n');
    process.stderr.write('fake client stderr\n');
    process.exit(Number(process.env.FAKE_UV_EXIT || 0));
  });
}
`, { mode: 0o755 });
  const linked = path.join(root, 'v86-exec'); await symlink(launcher, linked);
  t.after(() => rm(root, { recursive: true, force: true }));
  function start(args: string[], env: Record<string, string> = {}) {
    const child = spawn(process.execPath, ['--no-warnings', '--import', loader, linked, ...args], {
      cwd: root, env: { ...process.env, PATH: bin, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    return child;
  }
  async function run(args: string[], env: Record<string, string> = {}, stdin = '') {
    const child = start(args, env); let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin.end(stdin);
    const [code, signal] = await once(child, 'close');
    return { code, signal, stdout, stderr };
  }
  return { root, start, run };
}

test('npm-style symlink passes the complete shell command and stdin literally to uv', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const command = 'printf "$HOME `whoami` $(uname)"\n' + 'echo \'quoted; && | > * ?\'\n';
  const result = await f.run(['--no-stdin', command], {}, 'streamed input\nsecond line\0');
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ['run', '--quiet', '--script', script, '--no-stdin', command], stdin: 'streamed input\nsecond line\0',
  });
  assert.equal(result.stderr, 'fake client stderr\n');
});

test('propagates the uv client exit status', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const result = await f.run(['exit 7'], { FAKE_UV_EXIT: '7' });
  assert.equal(result.code, 7); assert.equal(result.signal, null);
});

test('missing uv reports an actionable error with status 125', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const empty = path.join(f.root, 'empty'); await mkdir(empty);
  const result = await f.run(['true'], { PATH: empty });
  assert.equal(result.code, 125); assert.match(result.stderr, /uv.*(?:not found|install)/i);
  assert.match(result.stderr, /https:\/\/docs\.astral\.sh\/uv/);
});

test('signals sent only to the launcher reach the client and wait for its cancellation', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const receipt = path.join(f.root, `${signal}.txt`);
    const child = f.start(['sleep 60'], { FAKE_UV_WAIT: '1', FAKE_UV_SIGNAL_FILE: receipt });
    child.stdin.end();
    const closed = once(child, 'close');
    const [ready] = await once(child.stdout, 'data');
    const pid = JSON.parse(ready.toString()).ready;
    child.kill(signal);
    const [code, exitSignal] = await closed;
    assert.equal(code, 128 + os.constants.signals[signal]); assert.equal(exitSignal, null);
    assert.equal(await readFile(receipt, 'utf8'), signal);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});
