import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import WebSocket from 'ws';
import { createApiServer } from '../src/http.js';
import type { StreamExecRequest, StreamExit, StreamingProcess } from '../src/streaming.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const exit: StreamExit = { exitCode: 17, signal: null, timedOut: false, outputLimitExceeded: false, durationMs: 123 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(t: TestContext, options: {
  start?: (request: StreamExecRequest, output: (stream: 'stdout' | 'stderr', bytes: Uint8Array) => void, signal: AbortSignal) => Promise<StreamingProcess>;
  write?: (bytes: Uint8Array) => Promise<void>;
  close?: () => Promise<void>;
} = {}) {
  const completion = deferred<StreamExit>();
  let output!: (stream: 'stdout' | 'stderr', bytes: Uint8Array) => void;
  let signal: AbortSignal | undefined;
  let canceled = 0;
  const calls: StreamExecRequest[] = [];
  const inputs: (Buffer | string)[] = [];
  const process: StreamingProcess = {
    processId: 'process-1', completion: completion.promise,
    writeStdin: async bytes => { inputs.push(Buffer.from(bytes)); await options.write?.(bytes); },
    closeStdin: async () => { inputs.push('eof'); await options.close?.(); },
    cancel: () => { canceled++; },
  };
  const server = createApiServer({
    info: () => ({}), execute: async () => { throw new Error('HTTP execute is not used'); },
    start: async (request, emit, abort) => {
      calls.push(request); output = emit; signal = abort;
      return options.start ? options.start(request, emit, abort!) : process;
    },
  });
  const sockets: WebSocket[] = [];
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/exec/ws`;
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  });
  async function connect(extra: WebSocket.ClientOptions = {}, path = url) {
    const socket = new WebSocket(path, extra);
    sockets.push(socket);
    const messages: any[] = [];
    socket.on('message', data => { messages.push(JSON.parse(data.toString())); });
    socket.on('error', () => {});
    const closed = new Promise<{ code: number; reason: string }>(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    await once(socket, 'open');
    async function wait(type: string, count = 1) {
      while (messages.filter(item => item.type === type).length < count) {
        if (socket.readyState === WebSocket.CLOSED) throw new Error(`Closed before ${type}: ${JSON.stringify(messages)}`);
        await new Promise<void>(resolve => {
          const done = () => { socket.off('message', done); socket.off('close', done); resolve(); };
          socket.once('message', done); socket.once('close', done);
        });
      }
      return messages.filter(item => item.type === type)[count - 1];
    }
    return { socket, messages, closed, wait, send: (value: unknown) => socket.send(JSON.stringify(value)) };
  }
  return { server, url, connect, calls, inputs, process, completion, output: (kind: 'stdout' | 'stderr', bytes: Uint8Array) => output(kind, bytes), get signal() { return signal; }, get canceled() { return canceled; } };
}

test('websocket streams separate binary-safe outputs before completion, then exit and close 1000', { timeout: 5000 }, async t => {
  const f = await fixture(t), c = await f.connect();
  c.send({ type: 'start', command: 'cat', cwd: '/mnt/project', env: { A: 'b' } });
  assert.deepEqual(await c.wait('started'), { type: 'started', processId: 'process-1' });
  assert.equal(f.calls[0].stdin, true);
  assert.equal(f.calls[0].timeoutMs, 30000);
  assert.equal(f.calls[0].cwd, '/mnt/project');
  const bytes = Buffer.from([0, 255, 195, 169, 10]);
  f.output('stdout', bytes); f.output('stderr', Buffer.from('warning\n'));
  assert.deepEqual(Buffer.from((await c.wait('stdout')).data, 'base64'), bytes);
  assert.equal(Buffer.from((await c.wait('stderr')).data, 'base64').toString(), 'warning\n');
  assert.equal(c.messages.some(item => item.type === 'exit'), false);
  f.completion.resolve(exit);
  assert.deepEqual(await c.wait('exit'), { type: 'exit', ...exit });
  assert.equal((await c.closed).code, 1000);
  assert.equal(f.canceled, 0);
});

test('buffers early output until started is sent', { timeout: 5000 }, async t => {
  let process!: StreamingProcess;
  const f = await fixture(t, { start: async (_request, output) => { output('stdout', Buffer.from('early')); await tick(); return process; } });
  process = f.process;
  const c = await f.connect(); c.send({ type: 'start', command: 'true' });
  await c.wait('stdout');
  assert.deepEqual(c.messages.map(item => item.type), ['started', 'stdout']);
});

test('stdin writes are acknowledged only after acceptance and EOF follows all writes', { timeout: 5000 }, async t => {
  const first = deferred<void>();
  let writes = 0;
  const f = await fixture(t, { write: async () => { if (++writes === 1) await first.promise; } });
  const c = await f.connect(); c.send({ type: 'start', command: 'cat' }); await c.wait('started');
  c.send({ type: 'stdin', id: 0, data: Buffer.from([255, 0]).toString('base64') });
  c.send({ type: 'stdin', id: 1, data: Buffer.from('later\n').toString('base64') });
  c.send({ type: 'stdin_eof' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(c.messages.some(item => item.type === 'stdin_ack'), false);
  assert.deepEqual(f.inputs, [Buffer.from([255, 0])]);
  first.resolve();
  assert.deepEqual(await c.wait('stdin_ack', 2), { type: 'stdin_ack', id: 1 });
  await c.wait('stdin_closed');
  assert.deepEqual(f.inputs, [Buffer.from([255, 0]), Buffer.from('later\n'), 'eof']);
  assert.deepEqual(c.messages.map(item => item.type), ['started', 'stdin_ack', 'stdin_ack', 'stdin_closed']);
});

test('stdin can arrive during process startup and remains ordered', { timeout: 5000 }, async t => {
  const boot = deferred<StreamingProcess>();
  const f = await fixture(t, { start: () => boot.promise }), c = await f.connect();
  c.send({ type: 'start', command: 'cat' });
  c.send({ type: 'stdin', id: 1, data: 'YQ==' }); c.send({ type: 'stdin_eof' });
  await tick(); boot.resolve(f.process);
  await c.wait('stdin_closed');
  assert.deepEqual(f.inputs, [Buffer.from('a'), 'eof']);
  assert.equal(c.messages[0].type, 'started');
});

test('cancel bypasses an outstanding stdin write', { timeout: 5000 }, async t => {
  const blocked = deferred<void>();
  const f = await fixture(t, { write: () => blocked.promise }), c = await f.connect();
  c.send({ type: 'start', command: 'cat' }); await c.wait('started');
  c.send({ type: 'stdin', id: 0, data: 'YQ==' }); c.send({ type: 'cancel' });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.canceled, 1); assert.equal(f.signal?.aborted, true);
  blocked.resolve(); f.completion.resolve({ ...exit, signal: 15, exitCode: null });
  assert.equal((await c.wait('exit')).signal, 15);
});

test('disconnect aborts execution even while startup is pending', { timeout: 5000 }, async t => {
  const boot = deferred<StreamingProcess>();
  const f = await fixture(t, { start: () => boot.promise }), c = await f.connect();
  c.send({ type: 'start', command: 'sleep 60' });
  while (!f.signal) await tick();
  const aborted = once(f.signal!, 'abort');
  c.socket.terminate(); await c.closed; await aborted;
  assert.equal(f.signal?.aborted, true);
  boot.resolve(f.process); await tick();
  assert.equal(f.canceled, 1);
});

test('server close cancels active websocket processes and closes upgraded sockets', { timeout: 5000 }, async t => {
  const f = await fixture(t), c = await f.connect();
  c.send({ type: 'start', command: 'sleep 60' }); await c.wait('started');
  await new Promise<void>(resolve => f.server.close(() => resolve()));
  await c.closed; assert.equal(f.canceled, 1); assert.equal(f.signal?.aborted, true);
});

test('startup and completion failures send an error without a fabricated exit', { timeout: 5000 }, async t => {
  const f = await fixture(t, { start: async () => { throw new Error('VM unavailable'); } }), c = await f.connect();
  c.send({ type: 'start', command: 'true' });
  assert.match((await c.wait('error')).error, /VM unavailable/); await c.closed;
  assert.equal(c.messages.some(item => item.type === 'exit'), false);
  const g = await fixture(t), d = await g.connect(); d.send({ type: 'start', command: 'true' }); await d.wait('started');
  g.completion.reject(new Error('VM disconnected'));
  assert.match((await d.wait('error')).error, /VM disconnected/); await d.closed;
  assert.equal(d.messages.some(item => item.type === 'exit'), false);
});

test('closed process stdin is benign and does not discard remaining process output', { timeout: 5000 }, async t => {
  const f = await fixture(t, { write: async () => { throw Object.assign(new Error('Broken pipe'), { code: 'EPIPE' }); } }), c = await f.connect();
  c.send({ type: 'start', command: 'true' }); await c.wait('started');
  c.send({ type: 'stdin', id: 0, data: 'YQ==' }); await c.wait('stdin_closed');
  f.output('stdout', Buffer.from('done')); f.completion.resolve(exit);
  await c.wait('exit'); await c.closed;
  assert.equal(c.messages.some(item => item.type === 'error'), false);
  assert.equal(Buffer.from((await c.wait('stdout')).data, 'base64').toString(), 'done');
});

test('rejects invalid protocol messages without executing or accepting invalid stdin', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const value of [null, [], { type: 'stdin', id: 0, data: 'YQ==' }, { type: 'start', command: '' },
    { type: 'start', command: 'true', stdin: 'text' }, { type: 'start', command: 'true', cwd: 'relative' },
    { type: 'start', command: 'true', unknown: 1 }]) {
    const c = await f.connect(); c.send(value); await c.wait('error'); assert.equal((await c.closed).code, 1008);
  }
  assert.equal(f.calls.length, 0);
  for (const message of [ { type: 'start', command: 'again' }, { type: 'unknown' },
    { type: 'stdin', id: -1, data: 'YQ==' }, { type: 'stdin', id: 0.1, data: 'YQ==' },
    { type: 'stdin', id: 0, data: 'a===' }, { type: 'stdin', id: 0, data: 'YQ' },
    { type: 'stdin', id: 0, data: 'YR==' }, { type: 'stdin', id: 0, data: 'YQ==\n' },
    { type: 'stdin', id: 0, data: Buffer.alloc(32769).toString('base64') },
    { type: 'stdin_eof', extra: true }, { type: 'cancel', extra: true },
  ]) {
    const c = await f.connect(); c.send({ type: 'start', command: 'cat' }); await c.wait('started');
    c.send(message); await c.wait('error'); await c.closed;
  }
  assert.equal(f.inputs.length, 0);
});

test('rejects duplicate stdin IDs, writes after EOF, and writes when stdin was disabled', { timeout: 5000 }, async t => {
  const f = await fixture(t), a = await f.connect();
  a.send({ type: 'start', command: 'cat' }); await a.wait('started');
  a.send({ type: 'stdin', id: 7, data: 'YQ==' }); await a.wait('stdin_ack');
  a.send({ type: 'stdin', id: 7, data: 'YQ==' }); await a.wait('error'); await a.closed;
  const b = await f.connect(); b.send({ type: 'start', command: 'cat' }); await b.wait('started');
  b.send({ type: 'stdin_eof' }); await b.wait('stdin_closed');
  b.send({ type: 'stdin', id: 0, data: 'YQ==' }); await b.wait('error'); await b.closed;
  const c = await f.connect(); c.send({ type: 'start', command: 'true', stdin: false }); await c.wait('started');
  c.send({ type: 'stdin', id: 0, data: 'YQ==' }); await c.wait('error'); await c.closed;
});

test('inbound stdin queue is bounded during startup and cancellation bypasses it', { timeout: 5000 }, async t => {
  const boot = deferred<StreamingProcess>();
  const f = await fixture(t, { start: () => boot.promise }), c = await f.connect();
  c.send({ type: 'start', command: 'cat' });
  for (let id = 0; id < 9; id++) c.send({ type: 'stdin', id, data: Buffer.alloc(32768).toString('base64') });
  assert.match((await c.wait('error')).error, /queue|buffer/i); await c.closed;
  assert.equal(f.signal?.aborted, true);
  boot.resolve(f.process); await tick(); assert.equal(f.canceled, 1);
});

test('early outbound output is bounded instead of silently discarded', { timeout: 5000 }, async t => {
  let process!: StreamingProcess;
  const f = await fixture(t, { start: async (_request, output) => { output('stdout', Buffer.alloc(2 * 1024 * 1024)); return process; } });
  process = f.process;
  const c = await f.connect(); c.send({ type: 'start', command: 'flood' });
  assert.match((await c.wait('error')).error, /buffer|output/i); await c.closed;
  assert.equal(f.signal?.aborted, true); assert.equal(f.canceled, 1);
  assert.equal(c.messages.some(item => item.type === 'exit'), false);
});

test('upgrade rejects browser origins, untrusted hosts, and wrong paths', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  async function status(headers: Record<string, string>, path = f.url) {
    const socket = new WebSocket(path, { headers });
    socket.on('error', () => {});
    return new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
      socket.once('open', () => { socket.terminate(); reject(new Error('Unexpected upgrade')); });
    });
  }
  assert.equal(await status({ Origin: 'http://localhost' }), 403);
  assert.equal(await status({ Host: 'evil.example' }), 403);
  assert.equal(await status({}, f.url.replace('/exec/ws', '/bad')), 404);
  assert.equal(f.calls.length, 0);
});

test('rejects binary websocket frames and malformed JSON', { timeout: 5000 }, async t => {
  const f = await fixture(t), a = await f.connect();
  a.socket.send(Buffer.from('{}')); await a.wait('error'); await a.closed;
  const b = await f.connect(); b.socket.send('{'); await b.wait('error'); await b.closed;
  assert.equal(f.calls.length, 0);
});

test('slow websocket readers trigger bounded-buffer cancellation and receive an explicit error', { timeout: 5000 }, async t => {
  const f = await fixture(t), c = await f.connect();
  c.send({ type: 'start', command: 'flood' }); await c.wait('started');
  c.socket.pause();
  const chunk = Buffer.alloc(32768, 120);
  for (let i = 0; i < 1024 && !f.signal?.aborted; i++) f.output('stdout', chunk);
  assert.equal(f.signal?.aborted, true);
  assert.equal(f.canceled, 1);
  c.socket.resume();
  assert.match((await c.wait('error')).error, /output buffer/i);
  assert.equal((await c.closed).code, 1013);
  assert.equal(c.messages.some(item => item.type === 'exit'), false);
});

test('idle websocket connections must start within the deadline', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = await f.connect();
  t.mock.timers.tick(10_001);
  assert.match((await c.wait('error')).error, /within 10 seconds/);
  assert.equal((await c.closed).code, 1008);
  assert.equal(f.calls.length, 0);
  t.mock.timers.reset();
});

test('oversized websocket frames cancel execution', { timeout: 5000 }, async t => {
  const f = await fixture(t), c = await f.connect();
  c.send({ type: 'start', command: 'cat' }); await c.wait('started');
  c.socket.send('x'.repeat(256 * 1024 + 1));
  assert.equal((await c.closed).code, 1009);
  assert.equal(f.signal?.aborted, true);
  assert.equal(f.canceled, 1);
});

test('completion racing a pending stdin write preserves exit without a late acknowledgement or error', { timeout: 5000 }, async t => {
  const blocked = deferred<void>();
  const f = await fixture(t, { write: () => blocked.promise }), c = await f.connect();
  c.send({ type: 'start', command: 'true' }); await c.wait('started');
  c.send({ type: 'stdin', id: 0, data: 'YQ==' });
  while (f.inputs.length === 0) await tick();
  f.completion.resolve(exit);
  await c.wait('exit');
  blocked.reject(Object.assign(new Error('Process exited'), { code: 'ESRCH' }));
  await c.closed;
  assert.deepEqual(c.messages.map(item => item.type), ['started', 'exit']);
});

test('EOF is acknowledged before exit even when closeStdin synchronously completes the process', { timeout: 5000 }, async t => {
  let finish!: () => void;
  const f = await fixture(t, { close: async () => finish() });
  finish = () => f.completion.resolve(exit);
  const c = await f.connect();
  c.send({ type: 'start', command: 'cat' }); await c.wait('started');
  c.send({ type: 'stdin_eof' });
  await c.wait('exit'); await c.closed;
  assert.deepEqual(c.messages.map(item => item.type), ['started', 'stdin_closed', 'exit']);
});

test('closeAllConnections closes current upgraded clients while allowing later connections', { timeout: 5000 }, async t => {
  const f = await fixture(t), a = await f.connect();
  a.send({ type: 'start', command: 'sleep 60' }); await a.wait('started');
  f.server.closeAllConnections();
  await a.closed; assert.equal(f.canceled, 1);
  const b = await f.connect();
  b.send({ type: 'start', command: 'true' });
  assert.equal((await b.wait('started')).processId, 'process-1');
});
