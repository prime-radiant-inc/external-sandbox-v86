import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexSession } from '../src/codex/server.js';

function fixture() {
  const messages: any[] = [], starts: any[] = [], writes: Buffer[] = [], signals: number[] = [];
  let output: any, finish: any, cancelled = 0;
  const completion = new Promise<any>(resolve => { finish = resolve; });
  const executor = {
    info: () => ({ defaultCwd: '/mnt/project' }),
    guestEnvironment: () => ({ PATH: '/usr/bin:/bin', HOME: '/home/agent', http_proxy: 'http://guest-proxy', TEST_A: 'first', TEST_AB: 'second' }),
    startArgv: async (request: any, handler: any) => {
      starts.push(request); output = handler;
      handler('stdout', Buffer.from('early\n'));
      return { processId: 'private-guest-id', completion,
        writeStdin: async (data: Uint8Array) => { writes.push(Buffer.from(data)); },
        closeStdin: async () => {}, cancel: () => { cancelled++; },
        signal: async (sig: number) => { signals.push(sig); },
      };
    },
    guestFilesystemRequest: async () => { throw new Error('Unexpected filesystem request'); },
  };
  const session = new CodexSession(executor, message => { messages.push(message); });
  let id = 0;
  async function request(method: string, params: any = {}) {
    const current = ++id;
    await session.dispatch({ id: current, method, params });
    return messages.find(m => m.id === current);
  }
  async function initialized() {
    const init = await request('initialize', { clientName: 'test' });
    assert.equal(init.result.environmentInfo.platformOs, 'linux');
    await session.dispatch({ method: 'initialized', params: {} });
  }
  return { session, messages, starts, writes, signals, request, initialized,
    output: (...args: any[]) => output(...args), cancelled: () => cancelled,
    finish: (code = 7) => finish({ exitCode: code, signal: null, timedOut: false, outputLimitExceeded: false, durationMs: 1 }) };
}
const startParams = { processId: 'chosen', argv: ['/bin/bash', '-c', 'echo "$HOME"; exit 7'], cwd: 'file:///mnt/project', env: {}, tty: false };

test('Codex handshake and exact argv execution have ordered streaming/replay and exit events', async () => {
  const f = fixture(); await f.initialized();
  const started = await f.request('process/start', startParams);
  assert.deepEqual(started.result, { processId: 'chosen', sandboxType: 'none' });
  assert.deepEqual(f.starts[0].argv, startParams.argv);
  assert.equal(f.starts[0].cwd, '/mnt/project');
  assert.equal(f.starts[0].stdin, false);
  assert.equal(f.starts[0].timeoutMs, 0);
  assert.deepEqual({ ...f.starts[0].env }, {}, 'Absent envPolicy means exact env, never inherited defaults');
  assert.equal(f.messages.findIndex(m => m === started) < f.messages.findIndex(m => m.method === 'process/output'), true);
  f.output('stderr', Buffer.from('error\n'));
  f.finish(); await new Promise(resolve => setImmediate(resolve));
  const events = f.messages.filter(m => m.method?.startsWith('process/'));
  assert.deepEqual(events.map(m => [m.method, m.params.seq]), [['process/output', 1], ['process/output', 2], ['process/exited', 3], ['process/closed', 4]]);
  assert.equal(events[1].params.stream, 'stderr');
  const read = await f.request('process/read', { processId: 'chosen', afterSeq: 1 });
  assert.equal(read.result.chunks[0].chunk, Buffer.from('error\n').toString('base64'));
  assert.equal(read.result.exitCode, 7); assert.equal(read.result.closed, true); assert.equal(read.result.nextSeq, 5);
  f.session.close();
});

test('Codex filesystem missing paths use the protocol not-found error code', async () => {
  const messages: any[] = [];
  const session = new CodexSession({
    info: () => ({}), startArgv: async () => { throw new Error('Unexpected spawn'); },
    guestFilesystemRequest: async () => { throw Object.assign(new Error('No such file'), { code: 'ENOENT' }); },
  }, message => { messages.push(message); });
  await session.dispatch({ id: 1, method: 'initialize', params: { clientName: 'test' } });
  await session.dispatch({ method: 'initialized' });
  await session.dispatch({ id: 2, method: 'fs/getMetadata', params: { path: 'file:///missing' } });
  assert.equal(messages.find(m => m.id === 2).error.code, -32004);
  session.close();
});

test('Codex environment policy filters guest defaults, supports question marks, and removes transport credentials', async () => {
  const f = fixture(); await f.initialized();
  const result = await f.request('process/start', { ...startParams,
    env: { OPENAI_IDENTITY_TOKEN_FILE: '/private/token', CUSTOM: 'explicit' },
    envPolicy: { inherit: 'all', ignoreDefaultExcludes: true, exclude: ['http_*'], set: {}, includeOnly: ['TEST_?'] },
  });
  assert.ok(result.result);
  assert.deepEqual({ ...f.starts[0].env }, { TEST_A: 'first', CUSTOM: 'explicit' });
  f.session.close(); f.finish();
});

test('Codex stdin retries are idempotent, interrupts signal the guest, disconnect cancels it', async () => {
  const f = fixture(); await f.initialized();
  await f.request('process/start', { ...startParams, pipeStdin: true });
  const write = { processId: 'chosen', writeId: 'one', chunk: Buffer.from('line\n').toString('base64') };
  assert.deepEqual((await f.request('process/write', write)).result, { status: 'accepted' });
  assert.deepEqual((await f.request('process/write', write)).result, { status: 'accepted' });
  assert.equal(f.writes.length, 1);
  assert.ok((await f.request('process/write', { ...write, chunk: 'Yg==' })).error);
  await f.request('process/signal', { processId: 'chosen', signal: 'interrupt' });
  assert.deepEqual(f.signals, [2]);
  f.session.close(); assert.equal(f.cancelled(), 1);
  f.finish();
});

test('Codex does not silently discard additional sandbox or unsupported terminal requirements', async () => {
  const f = fixture(); await f.initialized();
  for (const fields of [{ tty: true }, { sandbox: { permissions: { type: 'managed' } } }, { enforceManagedNetwork: true }, { networkProxy: {} }, { shellSnapshot: {} }]) {
    const result = await f.request('process/start', { ...startParams, ...fields });
    assert.ok(result.error, JSON.stringify(fields));
  }
  assert.equal(f.starts.length, 0);
  assert.ok((await f.request('fs/readFile', { path: 'file:///etc/passwd', sandbox: { permissions: { type: 'managed' } } })).error);
  f.session.close();
});

test('Codex validates initialization, process IDs, paths and environment without host fallback', async () => {
  const f = fixture();
  assert.ok((await f.request('process/start', startParams)).error);
  await f.initialized();
  for (const fields of [{ argv: [] }, { cwd: 'file://outside/etc/passwd' }, { env: { TOKEN: 42 } }, { processId: '' }]) {
    assert.ok((await f.request('process/start', { ...startParams, ...fields })).error);
  }
  await f.request('process/start', startParams);
  assert.ok((await f.request('process/start', startParams)).error);
  assert.equal((await f.request('no/suchMethod')).error.code, -32601);
  assert.equal(f.starts.length, 1);
  f.session.close(); f.finish();
});
