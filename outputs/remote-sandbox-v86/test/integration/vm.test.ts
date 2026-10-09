import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ShellVM } from '../../src/vm.js';
import { createApiServer, type ExecRequest, type ExecResult } from '../../src/http.js';
import { externalClientPath } from './external-client.js';

const sharedPrefix = externalClientPath('REMOTE_SANDBOX_PREFIX');
const root = fileURLToPath(new URL('../../', import.meta.url));
const quote = (text: string) => `'${text.replaceAll("'", "'\"'\"'")}'`;

test('real v86 HTTP API, live mounts and optional shared prefix', { timeout: 240_000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'v86-shell-test-'));
  const host = await fs.realpath(temp);
  const project = path.join(host, 'project with spaces');
  const data = path.join(host, 'data');
  await fs.mkdir(project); await fs.mkdir(data);
  await fs.writeFile(path.join(project, 'host.txt'), 'host version one\n');
  await fs.writeFile(path.join(data, 'other.txt'), 'second directory\n');
  const vm = await ShellVM.boot({ image: path.join(root, 'images/linux'), mounts: [
    { name: 'project', hostPath: project, preservedPaths: [project] },
    { name: 'data', hostPath: data, preservedPaths: [data] },
  ] });
  const server = createApiServer(vm);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await vm.destroy(); await fs.rm(temp, { recursive: true, force: true });
  });
  async function exec(command: string, extra: Partial<ExecRequest> = {}): Promise<ExecResult> {
    const response = await fetch(base + '/exec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, ...extra }) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result as ExecResult;
  }

  await t.test('Linux guest preserves shell syntax, stdout, stderr, and nonzero exit', async () => {
    const result = await exec('uname -m; for x in a b; do printf "%s\\n" "$x"; done | tr a-z A-Z; printf err >&2; exit 23');
    assert.equal(result.stdout, 'i686\nA\nB\n'); assert.equal(result.stderr, 'err'); assert.equal(result.exitCode, 23);
    assert.equal(result.signal, null); assert.equal(result.timedOut, false);
  });
  await t.test('two live mounts and changes from the host are immediately visible', async () => {
    assert.equal((await exec('cat host.txt /mnt/data/other.txt')).stdout, 'host version one\nsecond directory\n');
    await fs.writeFile(path.join(project, 'host.txt'), 'changed after boot, longer!\n');
    await fs.writeFile(path.join(project, 'new-host.txt'), 'new file');
    const result = await exec('cat host.txt new-host.txt; printf "from guest\\n" > /mnt/data/guest.txt');
    assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'changed after boot, longer!\nnew file');
    assert.equal(await fs.readFile(path.join(data, 'guest.txt'), 'utf8'), 'from guest\n');
  });
  await t.test('mkdir, append, truncate, rename, chmod, unlink and symlinks', async () => {
    const result = await exec('set -e; mkdir edits; printf abc > edits/a; printf d >> edits/a; mv edits/a edits/b; chmod 755 edits/b; ln -s b edits/link; cat edits/link; truncate -s 2 edits/b; cat edits/b; rm edits/link');
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.stdout, 'abcdab');
    assert.equal(await fs.readFile(path.join(project, 'edits/b'), 'utf8'), 'ab');
    assert.equal((await fs.stat(path.join(project, 'edits/b'))).mode & 0o777, 0o755);
    const binary = await exec('python3 -c "open(\'bytes.bin\',\'wb\').write(bytes(range(256)))"');
    assert.equal(binary.exitCode, 0, binary.stderr);
    assert.deepEqual(await fs.readFile(path.join(project, 'bytes.bin')), Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  });
  await t.test('guest filesystem operations cannot follow a host symlink to an unmounted file', async () => {
    const secret = path.join(host, 'outside.txt');
    await fs.writeFile(secret, 'outside sentinel');
    await fs.symlink(secret, path.join(project, 'outside-link'));
    const result = await exec('cat outside-link');
    assert.notEqual(result.exitCode, 0); assert.equal(result.stdout, '');
    assert.equal(await fs.readFile(secret, 'utf8'), 'outside sentinel');
  });
  await t.test('stdin, env, and original host path aliases', async () => {
    const result = await exec('printf "%s\\n" "$MY_VALUE"; pwd -P; cat', { cwd: project, env: { MY_VALUE: 'spaces and $literal' }, stdin: 'hello stdin\n' });
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.stdout, `spaces and $literal\n${project}\nhello stdin\n`);
    const short = await exec('printf short', { stdin: 'not consumed' });
    assert.equal(short.stdout, 'short'); assert.equal(short.exitCode, 0);
  });
  await t.test('concurrent calls do not mix streams', async () => {
    const [a, b] = await Promise.all([exec('sleep 0.1; printf one; printf err-one >&2'), exec('printf two; printf err-two >&2')]);
    assert.equal(a.stdout, 'one'); assert.equal(a.stderr, 'err-one'); assert.equal(b.stdout, 'two'); assert.equal(b.stderr, 'err-two');
  });
  await t.test('timeout and output limit terminate guest processes, server remains usable', async () => {
    const timeout = await exec('printf started; sleep 30', { timeoutMs: 100 });
    assert.equal(timeout.timedOut, true); assert.equal(timeout.signal, 9);
    const capped = await exec('yes output', { maxOutputBytes: 128 });
    assert.equal(capped.outputLimitExceeded, true);
    assert.ok(Buffer.byteLength(capped.stdout) + Buffer.byteLength(capped.stderr) <= 128);
    assert.equal((await exec('printf healthy')).stdout, 'healthy');
  });
  await t.test('HTTP disconnect cancels the running command', async () => {
    const controller = new AbortController();
    const request = fetch(base + '/exec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'printf ready > cancel-start; sleep 30; printf bad > cancel-end' }), signal: controller.signal });
    void request.catch(() => {});
    for (let i = 0; i < 100; i++) {
      // Opening a redirected file creates it before printf writes its marker.
      // Wait for the completed marker rather than racing that empty-file window.
      try { if (await fs.readFile(path.join(project, 'cancel-start'), 'utf8') === 'ready') break; } catch {}
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(await fs.readFile(path.join(project, 'cancel-start'), 'utf8'), 'ready');
    controller.abort(); await assert.rejects(request);
    for (let i = 0; i < 100 && vm.info().activeCommands; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(vm.info().activeCommands, 0);
    await assert.rejects(fs.stat(path.join(project, 'cancel-end')), { code: 'ENOENT' });
  });
  await t.test('Claude prefix runs full quoted prologue and writes a host-readable cwd file', {
    skip: sharedPrefix === undefined && 'Set REMOTE_SANDBOX_PREFIX to run the shared-prefix integration check',
  }, async () => {
    const cwdFile = path.join(data, 'claude-test-cwd');
    const inner = 'printf \'%s\\n\' \'literal $HOME "quotes"\'; printf prefix-error >&2';
    const command = `source /does/not/exist 2>/dev/null || true; eval ${quote(inner)}; pwd -P >| ${quote(cwdFile)}`;
    const run = (script: string) => new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(sharedPrefix!, [script], { cwd: project, env: { ...process.env, REMOTE_SANDBOX_API_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject); child.on('close', code => resolve({ stdout, stderr, code }));
    });
    const result = await run(command);
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, 'literal $HOME "quotes"\n'); assert.equal(result.stderr, 'prefix-error');
    assert.equal(await fs.readFile(cwdFile, 'utf8'), project + '\n');
    const failure = await run('printf failed >&2; exit 37');
    assert.equal(failure.code, 37); assert.equal(failure.stderr, 'failed');
  });
});
