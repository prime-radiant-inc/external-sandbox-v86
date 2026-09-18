import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { ShellVM } from '../../src/vm.js';
import { createApiServer } from '../../src/http.js';

const image = fileURLToPath(new URL('../../images/linux', import.meta.url));
const uri = (value: string) => pathToFileURL(value).href;
type Message = { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string; data?: unknown } };

async function until(predicate: () => boolean, description: string, timeoutMs = 15_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

class Session {
  readonly messages: Message[] = [];
  private nextId = 1;
  private failure: Error | undefined;
  private constructor(readonly socket: WebSocket) {
    socket.on('message', bytes => {
      try { this.messages.push(JSON.parse(bytes.toString())); }
      catch (error) { this.failure = error as Error; }
    });
    socket.on('error', error => { this.failure = error; });
  }
  static async open(url: string, t: TestContext): Promise<Session> {
    const session = new Session(new WebSocket(url));
    t.after(() => session.socket.terminate());
    await session.wait(() => session.socket.readyState === WebSocket.OPEN, 'Codex WebSocket upgrade');
    const initialized = await session.request('initialize', { clientName: 'v86-real-vm-integration' });
    assert.equal(typeof initialized.sessionId, 'string');
    assert.equal(initialized.environmentInfo.platformOs, 'linux');
    session.socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
    return session;
  }
  async wait(predicate: () => boolean, description: string): Promise<void> {
    await until(() => {
      if (this.failure) throw this.failure;
      if (predicate()) return true;
      assert.notEqual(this.socket.readyState, WebSocket.CLOSED, `Socket closed before ${description}`);
      return false;
    }, description);
  }
  async request(method: string, params: object): Promise<any> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    await this.wait(() => this.messages.some(message => message.id === id), `${method} response`);
    const response = this.messages.find(message => message.id === id)!;
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code, data: response.error.data });
    return response.result;
  }
  events(processId: string): Message[] { return this.messages.filter(message => message.method?.startsWith('process/') && message.params?.processId === processId); }
  output(processId: string, stream: string): Buffer {
    return Buffer.concat(this.events(processId).filter(message => message.method === 'process/output' && message.params.stream === stream)
      .map(message => Buffer.from(message.params.chunk, 'base64')));
  }
  async closed(processId: string): Promise<number> {
    await this.wait(() => this.events(processId).some(message => message.method === 'process/closed'), `${processId} closed`);
    return this.events(processId).find(message => message.method === 'process/exited')!.params.exitCode;
  }
  start(processId: string, argv: string[], extra: object = {}): Promise<any> {
    return this.request('process/start', { processId, argv, cwd: uri('/mnt/rw'), env: {}, tty: false, pipeStdin: false, ...extra });
  }
}

test('real v86 Codex exec-server protocol executes processes and enforces mount modes', { timeout: 180_000 }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'v86-codex-protocol-'));
  const host = await fs.realpath(temporary), ro = path.join(host, 'read only'), rw = path.join(host, 'read write');
  let vm: ShellVM | undefined;
  t.after(async () => { await vm?.destroy(); await fs.rm(temporary, { recursive: true, force: true }); });
  await fs.mkdir(ro); await fs.mkdir(rw);
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  await fs.writeFile(path.join(ro, 'binary'), bytes);
  await fs.writeFile(path.join(rw, 'snapshot'), 'original snapshot');
  await fs.symlink('binary', path.join(ro, 'binary-link'));
  vm = await ShellVM.boot({ image, mounts: [
    { name: 'rw', hostPath: rw, mode: 'rw', preservedPaths: [rw] },
    { name: 'ro', hostPath: ro, mode: 'ro', preservedPaths: [ro] },
  ] });
  const server = createApiServer(vm);
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/codex`;
  const session = await Session.open(url, t);

  await t.test('exact argv stays literal, stderr and nonzero exit are sequenced and replayable', async () => {
    const args = ['a b', '', '$(touch injected)', '; printf injected', '"quotes"', 'line\nbreak'];
    const script = 'import json,sys;print(json.dumps(sys.argv[1:]));sys.stderr.write("guest-error\\n");sys.exit(23)';
    const started = await session.start('exact-argv', ['/usr/bin/python3', '-c', script, ...args]);
    assert.equal(started.processId, 'exact-argv');
    assert.equal(await session.closed('exact-argv'), 23);
    assert.deepEqual(JSON.parse(session.output('exact-argv', 'stdout').toString()), args);
    assert.equal(session.output('exact-argv', 'stderr').toString(), 'guest-error\n');
    await assert.rejects(fs.stat(path.join(rw, 'injected')), { code: 'ENOENT' });
    const events = session.events('exact-argv');
    assert.deepEqual(events.map(event => event.params.seq), events.map((_, index) => index + 1));
    const replay = await session.request('process/read', { processId: 'exact-argv', afterSeq: 0, maxBytes: 65536, waitMs: 0 });
    assert.equal(replay.exited, true); assert.equal(replay.closed, true); assert.equal(replay.exitCode, 23);
    assert.deepEqual(replay.chunks, events.filter(event => event.method === 'process/output')
      .map(event => ({ seq: event.params.seq, stream: event.params.stream, chunk: event.params.chunk })));
    assert.equal(replay.nextSeq, replay.chunks.at(-1).seq + 1);
    const consumed = await session.request('process/read', { processId: 'exact-argv', afterSeq: replay.nextSeq - 1, waitMs: 0 });
    assert.deepEqual(consumed.chunks, []);
    assert.equal(consumed.nextSeq, events.length + 1);
  });

  await t.test('later stdin is streamed after ready output and write IDs prevent duplicate input', async () => {
    const script = 'import sys;print("ready",flush=True);sys.stderr.write("waiting\\n");sys.stderr.flush();line=sys.stdin.readline();print("received:"+line,end="",flush=True);line=sys.stdin.readline();sys.stderr.write("second:"+line);sys.exit(17)';
    await session.start('interactive', ['/usr/bin/python3', '-u', '-c', script], { pipeStdin: true });
    await session.wait(() => session.output('interactive', 'stdout').toString() === 'ready\n' && session.output('interactive', 'stderr').toString() === 'waiting\n', 'output before any stdin');
    assert.equal(session.events('interactive').some(event => event.method === 'process/exited'), false);
    const first = { processId: 'interactive', writeId: 'first', chunk: Buffer.from('one\n').toString('base64') };
    assert.equal((await session.request('process/write', first)).status, 'accepted');
    assert.equal((await session.request('process/write', first)).status, 'accepted');
    await session.wait(() => session.output('interactive', 'stdout').toString().includes('received:one\n'), 'first response before second input');
    assert.equal((await session.request('process/write', { processId: 'interactive', writeId: 'second', chunk: Buffer.from('two\n').toString('base64') })).status, 'accepted');
    assert.equal(await session.closed('interactive'), 17);
    assert.equal(session.output('interactive', 'stdout').toString(), 'ready\nreceived:one\n');
    assert.equal(session.output('interactive', 'stderr').toString(), 'waiting\nsecond:two\n');
  });

  await t.test('arg0 and replacement environment policy reach the guest process', async () => {
    await session.start('environment', ['/bin/bash', '-c', 'printf "%s|%s|%s" "$0" "$ONLY" "${HOME-unset}"'], {
      arg0: 'custom argv0', env: { ONLY: 'override literal $HOME' },
      envPolicy: { inherit: 'none', ignoreDefaultExcludes: true, exclude: [], set: { ONLY: 'policy' }, includeOnly: [] },
    });
    assert.equal(await session.closed('environment'), 0);
    assert.equal(session.output('environment', 'stdout').toString(), 'custom argv0|override literal $HOME|unset');
  });

  await t.test('interrupt delivers catchable SIGINT and terminate kills blocked guest processes', async () => {
    const script = 'import signal,sys,time\ndef stopped(*args):\n print("caught-int",flush=True)\n sys.exit(42)\nsignal.signal(signal.SIGINT,stopped)\nprint("signal-ready",flush=True)\ntime.sleep(60)';
    await session.start('interrupt', ['/usr/bin/python3', '-u', '-c', script]);
    await session.wait(() => session.output('interrupt', 'stdout').toString() === 'signal-ready\n', 'signal handler ready');
    await session.request('process/signal', { processId: 'interrupt', signal: 'interrupt' });
    assert.equal(await session.closed('interrupt'), 42);
    assert.equal(session.output('interrupt', 'stdout').toString(), 'signal-ready\ncaught-int\n');
    await session.start('terminate', ['/bin/bash', '-c', 'printf terminate-ready; sleep 60; printf bad > terminated-late']);
    await session.wait(() => session.output('terminate', 'stdout').toString() === 'terminate-ready', 'terminate target ready');
    await session.request('process/terminate', { processId: 'terminate' });
    assert.notEqual(await session.closed('terminate'), 0);
    await until(() => vm!.info().activeCommands === 0, 'terminated guest cleanup');
    await assert.rejects(fs.stat(path.join(rw, 'terminated-late')), { code: 'ENOENT' });
  });

  await t.test('filesystem RPC reads binary guest data and writes only writable mounts', async () => {
    const read = await session.request('fs/readFile', { path: uri('/mnt/ro/binary') });
    assert.deepEqual(Buffer.from(read.dataBase64, 'base64'), bytes);
    await session.request('fs/writeFile', { path: uri(path.join(rw, 'written.bin')), dataBase64: bytes.toString('base64') });
    assert.deepEqual(await fs.readFile(path.join(rw, 'written.bin')), bytes);
    for (const target of ['/mnt/ro/binary', path.join(ro, 'created.bin')]) {
      await assert.rejects(session.request('fs/writeFile', { path: uri(target), dataBase64: Buffer.from('bad').toString('base64') }), /read.only|EROFS/i);
    }
    assert.deepEqual(await fs.readFile(path.join(ro, 'binary')), bytes);
    await assert.rejects(fs.stat(path.join(ro, 'created.bin')), { code: 'ENOENT' });
    const metadata = await session.request('fs/getMetadata', { path: uri('/mnt/ro/binary') });
    assert.equal(metadata.isFile, true); assert.equal(metadata.isDirectory, false); assert.equal(metadata.isSymlink, false); assert.equal(metadata.size, 256);
    assert.ok(Number.isFinite(metadata.modifiedAtMs));
    assert.deepEqual(await session.request('fs/canonicalize', { path: uri('/mnt/ro/binary-link') }), { path: uri('/mnt/ro/binary') });
    const entries = (await session.request('fs/readDirectory', { path: uri('/mnt/rw') })).entries;
    assert.ok(entries.some((entry: any) => entry.fileName === 'written.bin' && entry.isFile));
    const guestOnly = await session.request('fs/readFile', { path: uri('/etc/os-release') });
    assert.match(Buffer.from(guestOnly.dataBase64, 'base64').toString(), /alpine/i);
  });

  await t.test('file handles retain a bounded snapshot and close releases the handle', async () => {
    assert.deepEqual(await session.request('fs/open', { handleId: 'snapshot', path: uri('/mnt/rw/snapshot') }), { handleId: 'snapshot' });
    await fs.writeFile(path.join(rw, 'snapshot'), 'replaced by host');
    const first = await session.request('fs/readBlock', { handleId: 'snapshot', offset: 0, len: 8 });
    assert.equal(Buffer.from(first.chunk, 'base64').toString(), 'original'); assert.equal(first.eof, false);
    const rest = await session.request('fs/readBlock', { handleId: 'snapshot', offset: 8, len: 64 });
    assert.equal(Buffer.from(rest.chunk, 'base64').toString(), ' snapshot'); assert.equal(rest.eof, true);
    await session.request('fs/close', { handleId: 'snapshot' });
    await assert.rejects(session.request('fs/readBlock', { handleId: 'snapshot', offset: 0, len: 1 }), { data: { code: 'EBADF' } });
  });

  await t.test('copy and bounded walks use guest paths and cannot modify read-only exports', async () => {
    await session.request('fs/createDirectory', { path: uri('/mnt/rw/tree/sub'), recursive: true });
    await session.request('fs/copy', { sourcePath: uri('/mnt/ro/binary'), destinationPath: uri('/mnt/rw/tree/sub/copied'), recursive: false });
    assert.deepEqual(await fs.readFile(path.join(rw, 'tree/sub/copied')), bytes);
    await assert.rejects(session.request('fs/copy', { sourcePath: uri('/mnt/rw/written.bin'), destinationPath: uri('/mnt/ro/copy'), recursive: false }), /read.only|EROFS/i);
    const walked = await session.request('fs/walk', { path: uri('/mnt/rw/tree'), options: { maxDepth: 3, maxDirectories: 10, maxEntries: 10, followDirectorySymlinks: false } });
    assert.deepEqual(walked.errors, []); assert.equal(walked.truncated, false);
    assert.ok(walked.entries.some((entry: any) => entry.path === uri('/mnt/rw/tree/sub/copied') && entry.kind === 'file'));
    await session.request('fs/remove', { path: uri('/mnt/rw/tree'), recursive: true, force: false });
    await assert.rejects(fs.stat(path.join(rw, 'tree')), { code: 'ENOENT' });
    await assert.rejects(session.request('fs/remove', { path: uri('/mnt/ro/binary'), recursive: false, force: false }), /read.only|EROFS/i);
  });

  await t.test('unsupported PTY and managed sandbox requests fail explicitly', async () => {
    await assert.rejects(session.start('no-pty', ['/bin/true'], { tty: true }), /tty|pty|terminal/i);
    await assert.rejects(session.start('no-managed-network', ['/bin/true'], { enforceManagedNetwork: true, managedNetwork: { loopbackPorts: [], allowLocalBinding: false } }), /managed|network|sandbox/i);
    await assert.rejects(session.start('no-platform-sandbox', ['/bin/true'], { sandbox: { permissions: { type: 'managed' }, cwd: uri('/mnt/rw') } }), /sandbox|permission/i);
  });

  await t.test('disconnect cancels the process group including a guest descendant', async t => {
    const disconnected = await Session.open(url, t);
    await disconnected.start('disconnect', ['/bin/bash', '-c', 'sleep 60 & child=$!; printf "%s" "$child" > child-pid; printf disconnect-ready; wait "$child"; printf bad > disconnect-late']);
    await disconnected.wait(() => disconnected.output('disconnect', 'stdout').toString() === 'disconnect-ready', 'disconnect target ready');
    const pid = await fs.readFile(path.join(rw, 'child-pid'), 'utf8');
    assert.match(pid, /^[0-9]+$/);
    disconnected.socket.close();
    await until(() => vm!.info().activeCommands === 0, 'disconnect cancellation');
    const result = await vm!.execute({ command: `if test -r /proc/${pid}/stat; then awk '{print $3}' /proc/${pid}/stat; else printf gone; fi` });
    assert.ok(result.stdout === 'gone' || result.stdout.trim() === 'Z', `Descendant must be dead: ${result.stdout}`);
    await assert.rejects(fs.stat(path.join(rw, 'disconnect-late')), { code: 'ENOENT' });
  });

  await t.test('browser Origin cannot open the Codex execution endpoint', async () => {
    const rejected = new WebSocket(url, { headers: { Origin: 'https://example.test' } });
    const failure = await new Promise<Error>((resolve, reject) => {
      rejected.once('error', resolve);
      rejected.once('open', () => { rejected.terminate(); reject(new Error('Browser Origin was accepted')); });
    });
    assert.match(failure.message, /403/);
  });
});
