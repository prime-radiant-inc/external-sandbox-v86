import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ShellVM } from '../../src/vm.js';
import { createApiServer } from '../../src/http.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
type Message = { type: string; data?: string; id?: number; [key: string]: unknown };

/** Deadlines on each observation make failures report the blocked protocol step. */
async function until(predicate: () => boolean, description: string, timeout = 15_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

class Session {
  readonly messages: Message[] = [];
  private error: Error | undefined;
  private constructor(readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      try { this.messages.push(JSON.parse(String(event.data)) as Message); }
      catch (error) { this.error = error as Error; }
    });
    socket.addEventListener('error', () => { this.error = new Error('WebSocket connection failed'); });
  }
  static async open(url: string, t: TestContext): Promise<Session> {
    const session = new Session(new WebSocket(url));
    t.after(() => session.socket.close());
    await session.wait(() => session.socket.readyState === WebSocket.OPEN, 'WebSocket upgrade');
    return session;
  }
  send(value: object): void { this.socket.send(JSON.stringify(value)); }
  async wait(predicate: () => boolean, description: string, timeout = 15_000): Promise<void> {
    await until(() => {
      if (this.error) throw this.error;
      const failure = this.messages.find(message => message.type === 'error');
      assert.equal(failure, undefined, `Unexpected protocol error: ${JSON.stringify(failure)}`);
      if (predicate()) return true;
      assert.notEqual(this.socket.readyState, WebSocket.CLOSED, `Socket closed before ${description}`);
      return false;
    }, description, timeout);
  }
  output(stream: 'stdout' | 'stderr'): Buffer {
    return Buffer.concat(this.messages.filter(message => message.type === stream).map(message => Buffer.from(message.data!, 'base64')));
  }
  async started(): Promise<void> { await this.wait(() => this.messages.some(message => message.type === 'started'), 'started event'); }
  async write(id: number, data: Buffer | string): Promise<void> {
    this.send({ type: 'stdin', id, data: Buffer.from(data).toString('base64') });
    await this.wait(() => this.messages.some(message => message.type === 'stdin_ack' && message.id === id), `stdin ack ${id}`);
  }
  async eof(): Promise<void> {
    this.send({ type: 'stdin_eof' });
    await this.wait(() => this.messages.some(message => message.type === 'stdin_closed'), 'stdin EOF ack');
  }
  async exit(): Promise<Message> {
    await this.wait(() => this.messages.some(message => message.type === 'exit'), 'exit event');
    return this.messages.find(message => message.type === 'exit')!;
  }
}

test('real v86 WebSocket streaming and uv Python client', { timeout: 240_000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'v86-stream-test-'));
  const project = await fs.realpath(temp);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const vm = await ShellVM.boot({ image: path.join(root, 'images/linux'), mounts: [
    { name: 'project', hostPath: project, preservedPaths: [project] },
  ] });
  const server = createApiServer(vm);
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await vm.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/exec/ws`;

  await t.test('stdout and stderr arrive before blocked reads; successive stdin and EOF preserve exit', async t => {
    const session = await Session.open(url, t);
    session.send({ type: 'start', command: 'printf "ready\\n"; printf "err-ready\\n" >&2; IFS= read -r first; printf "first:%s\\n" "$first"; IFS= read -r second; printf "second:%s\\n" "$second" >&2; cat; exit 23' });
    await session.started();
    await session.wait(() => session.output('stdout').toString() === 'ready\n' && session.output('stderr').toString() === 'err-ready\n', 'output before any input');
    assert.equal(session.messages.some(message => message.type === 'exit'), false);
    await session.write(1, 'hello one\n');
    await session.wait(() => session.output('stdout').toString().includes('first:hello one\n'), 'first response before second input');
    await session.write(2, 'hello two\n');
    await session.wait(() => session.output('stderr').toString().includes('second:hello two\n'), 'second response before EOF');
    await session.write(3, 'tail bytes\n');
    await session.eof();
    const result = await session.exit();
    assert.equal(session.output('stdout').toString(), 'ready\nfirst:hello one\ntail bytes\n');
    assert.equal(session.output('stderr').toString(), 'err-ready\nsecond:hello two\n');
    assert.equal(result.exitCode, 23);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.outputLimitExceeded, false);
    assert.ok(Number.isFinite(result.durationMs));
    assert.equal(session.messages[0].type, 'started');
    assert.ok(session.messages.findIndex(message => message.type === 'stdout') < session.messages.findIndex(message => message.type === 'exit'));
  });

  await t.test('all byte values and cumulative stdin beyond 32 KiB survive both directions', async t => {
    const session = await Session.open(url, t);
    const script = 'import os\nwhile True:\n data=os.read(0,4096)\n if not data: break\n os.write(1,data)\n os.write(2,data)';
    session.send({ type: 'start', command: `python3 -u -c ${quote(script)}`, timeoutMs: 60_000 });
    await session.started();
    const input = Buffer.from(Array.from({ length: 80 * 1024 }, (_, index) => index % 256));
    for (let offset = 0, id = 1; offset < input.length; offset += 4096, id++) {
      await session.write(id, input.subarray(offset, offset + 4096));
      await session.wait(() => session.output('stdout').length >= offset + 4096, `binary output chunk ${id}`);
    }
    await session.eof();
    assert.equal((await session.exit()).exitCode, 0);
    assert.deepEqual(session.output('stdout'), input);
    assert.deepEqual(session.output('stderr'), input);
  });

  await t.test('stdin false gives the process EOF immediately', async t => {
    const session = await Session.open(url, t);
    session.send({ type: 'start', command: 'cat; printf no-input', stdin: false });
    assert.equal((await session.exit()).exitCode, 0);
    assert.equal(session.output('stdout').toString(), 'no-input');
    assert.equal(session.output('stderr').length, 0);
  });

  await t.test('concurrent streaming sessions cannot mix stdout, stderr, or stdin', async t => {
    const a = await Session.open(url, t), b = await Session.open(url, t);
    a.send({ type: 'start', command: 'printf ready-a; read -r x; printf "out-a:%s" "$x"; printf err-a >&2' });
    b.send({ type: 'start', command: 'printf ready-b; read -r x; printf "out-b:%s" "$x"; printf err-b >&2' });
    await Promise.all([a.started(), b.started()]);
    await Promise.all([a.wait(() => a.output('stdout').toString() === 'ready-a', 'session A ready'), b.wait(() => b.output('stdout').toString() === 'ready-b', 'session B ready')]);
    await Promise.all([a.write(1, 'one\n'), b.write(1, 'two\n')]);
    const results = await Promise.all([a.exit(), b.exit()]);
    assert.deepEqual(results.map(result => result.exitCode), [0, 0]);
    assert.equal(a.output('stdout').toString(), 'ready-aout-a:one'); assert.equal(a.output('stderr').toString(), 'err-a');
    assert.equal(b.output('stdout').toString(), 'ready-bout-b:two'); assert.equal(b.output('stderr').toString(), 'err-b');
  });

  await t.test('timeout and explicit cancellation kill blocked guest processes', async t => {
    const timeout = await Session.open(url, t);
    timeout.send({ type: 'start', command: 'printf timeout-ready; sleep 30', timeoutMs: 150 });
    const timed = await timeout.exit();
    assert.equal(timed.timedOut, true); assert.equal(timed.signal, 9);
    const cancelled = await Session.open(url, t);
    cancelled.send({ type: 'start', command: 'printf cancel-ready; sleep 30; printf unwanted > cancel-end' });
    await cancelled.wait(() => cancelled.output('stdout').toString() === 'cancel-ready', 'cancel target started');
    cancelled.send({ type: 'cancel' });
    const result = await cancelled.exit();
    assert.equal(result.signal, 9); assert.equal(result.timedOut, false);
    await until(() => vm.info().activeCommands === 0, 'cancelled process cleanup');
    await assert.rejects(fs.stat(path.join(project, 'cancel-end')), { code: 'ENOENT' });
  });

  await t.test('disconnect cancels the process and descendants without leaking active commands', async t => {
    const session = await Session.open(url, t);
    session.send({ type: 'start', command: 'sleep 30 & child=$!; printf "%s" "$child" > child-pid; printf disconnect-ready; wait "$child"; printf unwanted > disconnect-end' });
    await session.wait(() => session.output('stdout').toString() === 'disconnect-ready', 'disconnect target started');
    const pid = await fs.readFile(path.join(project, 'child-pid'), 'utf8');
    assert.match(pid, /^[0-9]+$/);
    session.socket.close();
    await until(() => vm.info().activeCommands === 0, 'disconnected process cleanup');
    const check = await vm.execute({ command: `if test -r /proc/${pid}/stat; then awk '{print $3}' /proc/${pid}/stat; else printf gone; fi` });
    assert.ok(check.stdout === 'gone' || check.stdout.trim() === 'Z', `Descendant must be dead, found state: ${check.stdout}`);
    await assert.rejects(fs.stat(path.join(project, 'disconnect-end')), { code: 'ENOENT' });
  });

  await t.test('output limit truncates the stream and leaves the VM usable', async t => {
    const session = await Session.open(url, t);
    session.send({ type: 'start', command: 'yes output', maxOutputBytes: 127 });
    const result = await session.exit();
    assert.equal(result.outputLimitExceeded, true);
    assert.ok(session.output('stdout').length + session.output('stderr').length <= 127);
    assert.equal((await vm.execute({ command: 'printf healthy' })).stdout, 'healthy');
  });

  function client(t: TestContext, command: string): {
    child: ChildProcessWithoutNullStreams; stdout: () => Buffer; stderr: () => Buffer;
    done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    waitForOutput: (predicate: () => boolean, description: string, timeout?: number) => Promise<void>;
  } {
    const child = spawn('uv', ['run', '--quiet', '--script', path.join(root, 'scripts/remote_sandbox_exec.py'), command], {
      cwd: project, env: { ...process.env, REMOTE_SANDBOX_API_URL: base }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on('data', data => stdout.push(Buffer.from(data)));
    child.stderr.on('data', data => stderr.push(Buffer.from(data)));
    let done = false;
    const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { done = true; resolve({ code, signal }); });
    });
    void completed.catch(() => {});
    t.after(async () => {
      if (!done) child.kill('SIGKILL');
      child.stdin.destroy();
      await completed.catch(() => {});
    });
    return {
      child, stdout: () => Buffer.concat(stdout), stderr: () => Buffer.concat(stderr), done: completed,
      waitForOutput: (predicate, description, timeout) => until(() => {
        if (predicate()) return true;
        assert.equal(done, false, `Python exited before ${description}: ${Buffer.concat(stderr).toString()}`);
        return false;
      }, description, timeout),
    };
  }

  await t.test('uv Python client forwards live stdout/stderr, later stdin, EOF, and nonzero status', async t => {
    const run = client(t, 'printf "client-ready\\n"; printf "client-error\\n" >&2; read -r first; printf "got:%s\\n" "$first"; cat; exit 37');
    await run.waitForOutput(() => run.stdout().toString() === 'client-ready\n' && run.stderr().toString().includes('client-error\n'), 'Python client output before stdin', 30_000);
    run.child.stdin.write('one\n');
    await run.waitForOutput(() => run.stdout().toString().includes('got:one\n'), 'Python response before second stdin');
    run.child.stdin.write('two\n');
    run.child.stdin.end();
    let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    void run.done.then(value => { result = value; });
    await until(() => result !== undefined, 'Python completion');
    assert.deepEqual(result, { code: 37, signal: null });
    assert.equal(run.stdout().toString(), 'client-ready\ngot:one\ntwo\n');
    assert.equal(run.stderr().toString(), 'client-error\n');
  });

  await t.test('uv Python client preserves arbitrary binary stdin and output', async t => {
    const script = 'import os\nwhile True:\n data=os.read(0,4096)\n if not data: break\n os.write(1,data)\n os.write(2,data)';
    const run = client(t, `python3 -u -c ${quote(script)}`);
    const bytes = Buffer.from(Array.from({ length: 40 * 1024 }, (_, index) => index % 256));
    run.child.stdin.end(bytes);
    let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    void run.done.then(value => { result = value; });
    await until(() => result !== undefined, 'binary Python completion', 30_000);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.deepEqual(run.stdout(), bytes); assert.deepEqual(run.stderr(), bytes);
  });

  await t.test('Python client exits while its parent keeps stdin open', async t => {
    const run = client(t, 'printf done; exit 17');
    let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    void run.done.then(value => { result = value; });
    await until(() => result !== undefined, 'Python exits without local stdin EOF', 15_000);
    assert.deepEqual(result, { code: 17, signal: null });
    assert.equal(run.stdout().toString(), 'done'); assert.equal(run.stderr().toString(), '');
  });
});
