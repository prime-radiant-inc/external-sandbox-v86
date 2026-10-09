import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GuestError } from '../src/guest/client.js';
import { startGuestProcess } from '../src/guest/process.js';
import type { ArgvExecRequest } from '../src/streaming.js';

class Guest extends EventEmitter {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  handler: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown> = method =>
    method === 'process.start' ? { processId: 'p1' } : {};
  async request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    return await this.handler(method, params) as T;
  }
  output(stream: string, data: Buffer, processId = 'p1') { this.emit('event', { event: 'process.output', processId, stream, data: data.toString('base64') }); }
  exit(exitCode: number | null = 0, signal: number | null = null) { this.emit('event', { event: 'process.exited', processId: 'p1', exitCode, signal }); }
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const opts = (onOutput = (_stream: 'stdout' | 'stderr', _data: Uint8Array) => {}) => ({ defaultCwd: '/workspace', onOutput, onUnresponsive() {} });

test('direct execution preserves exact argv, arg0 and replacement environment without a shell', async t => {
  const guest = new Guest();
  const request: ArgvExecRequest = {
    argv: ['/usr/bin/tool', 'a b', '', '$(touch /tmp/unwanted)', '"quoted"', 'line\nbreak'],
    arg0: 'custom name', envReplace: true, env: { ONLY: 'literal $HOME' }, cwd: '/mnt/project', stdin: false,
  };
  const process = await startGuestProcess(guest, request, opts());
  t.after(() => guest.exit());
  assert.deepEqual(guest.calls[0], { method: 'process.start', params: {
    argv: request.argv, arg0: 'custom name', envReplace: true,
    env: { ONLY: 'literal $HOME' }, cwd: '/mnt/project', stdin: false,
  } });
  guest.exit(23);
  assert.equal((await process.completion).exitCode, 23);
});

test('direct argv defaults and existing shell requests retain their distinct protocol forms', async t => {
  for (const request of [
    { argv: ['/bin/echo', 'literal'], envReplace: false, arg0: '' },
    { command: 'printf "%s" "$HOME"' },
  ]) {
    const guest = new Guest();
    const process = await startGuestProcess(guest, request, opts());
    t.after(() => guest.exit());
    assert.deepEqual(guest.calls[0].params, {
      ...('argv' in request ? { argv: request.argv, envReplace: false, arg0: '' } : { argv: ['/bin/bash', '-c', request.command] }),
      env: {}, cwd: '/workspace', stdin: true,
    });
    guest.exit(); await process.completion;
  }
});

test('INT and TERM signals preserve live stdin and output and become no-ops after exit', async t => {
  const guest = new Guest(); const chunks: string[] = [];
  const process = await startGuestProcess(guest, { argv: ['/bin/cat'] }, opts((_stream, data) => chunks.push(Buffer.from(data).toString())));
  t.after(() => guest.exit());
  assert.equal(typeof process.signal, 'function');
  await process.signal!(2);
  await process.signal!(15);
  await process.writeStdin(Buffer.from('still open'));
  guest.output('stdout', Buffer.from('still running'));
  assert.deepEqual(chunks, ['still running']);
  assert.deepEqual(guest.calls.filter(call => call.method === 'process.signal').map(call => call.params), [
    { processId: 'p1', signal: 2 }, { processId: 'p1', signal: 15 },
  ]);
  guest.exit(null, 15);
  const result = await process.completion;
  assert.equal(result.signal, 15); assert.equal(result.timedOut, false);
  const before = guest.calls.length;
  await process.signal!(2);
  assert.equal(guest.calls.length, before);
});

test('an explicit signal failure is returned without cancelling a still-live process', async t => {
  const guest = new Guest();
  guest.handler = method => {
    if (method === 'process.start') return { processId: 'p1' };
    if (method === 'process.signal') throw new GuestError('EPERM', 'signal denied');
    return {};
  };
  const process = await startGuestProcess(guest, { argv: ['/bin/cat'] }, opts());
  t.after(() => guest.exit());
  assert.equal(typeof process.signal, 'function');
  await assert.rejects(process.signal!(2), { code: 'EPERM' });
  await process.writeStdin(Buffer.from('still writable'));
  assert.equal(guest.calls.filter(call => call.method === 'process.signal').length, 1);
  guest.exit(); assert.equal((await process.completion).exitCode, 0);
});

test('internal timeout zero permits a long-lived command without immediate cancellation', async t => {
  const guest = new Guest();
  const process = await startGuestProcess(guest, { argv: ['/bin/cat'], timeoutMs: 0 }, opts());
  t.after(() => guest.exit());
  await delay(20);
  assert.equal(guest.calls.some(call => call.method === 'process.signal'), false);
  await process.writeStdin(Buffer.from('after timer turn'));
  guest.exit(); assert.equal((await process.completion).timedOut, false);
});

test('guest process emits binary stdout/stderr before exit, including startup output', async () => {
  const guest = new Guest(); const chunks: [string, Buffer][] = [];
  guest.handler = method => {
    if (method === 'process.start') { guest.output('stdout', Buffer.from([0, 255])); return { processId: 'p1' }; }
    return {};
  };
  const process = await startGuestProcess(guest, { command: 'binary' }, opts((stream, data) => chunks.push([stream, Buffer.from(data)])));
  guest.output('stderr', Buffer.from('error')); guest.output('stdout', Buffer.from('ignore'), 'other');
  assert.deepEqual(chunks, [['stdout', Buffer.from([0, 255])], ['stderr', Buffer.from('error')]]);
  let exited = false; void process.completion.then(() => { exited = true; });
  await delay(5); assert.equal(exited, false);
  guest.exit(17); const result = await process.completion;
  assert.equal(result.exitCode, 17); assert.equal(result.signal, null);
  assert.equal('stdout' in result, false); assert.equal(guest.listenerCount('event'), 0);
});

test('incremental stdin writes retain ordering, retry guest pressure, then close at EOF', async () => {
  const guest = new Guest(); let attempts = 0;
  guest.handler = method => {
    if (method === 'process.start') return { processId: 'p1' };
    if (method === 'process.write' && ++attempts === 1) throw new GuestError('EAGAIN', 'queue full');
    return {};
  };
  const process = await startGuestProcess(guest, { command: 'cat' }, opts());
  const one = process.writeStdin(Buffer.from('one'));
  const two = process.writeStdin(Buffer.from('two'));
  const eof = process.closeStdin();
  await Promise.all([one, two, eof]);
  const calls = guest.calls.filter(c => c.method !== 'process.start');
  assert.deepEqual(calls.map(c => c.method), ['process.write', 'process.write', 'process.write', 'process.closeStdin']);
  assert.deepEqual(calls.slice(0, 3).map(c => Buffer.from(String(c.params.data), 'base64').toString()), ['one', 'one', 'two']);
  await assert.rejects(process.writeStdin(Buffer.from('late')), /closed|EOF/i);
  guest.exit(); await process.completion;
});

test('cancellation bypasses queued stdin and cleans up listeners', async () => {
  const guest = new Guest();
  guest.handler = method => {
    if (method === 'process.start') return { processId: 'p1' };
    if (method === 'process.write') throw new GuestError('EAGAIN', 'queue full');
    if (method === 'process.signal') guest.exit(null, 9);
    return {};
  };
  const process = await startGuestProcess(guest, { command: 'sleep 30' }, opts());
  const pending = process.writeStdin(Buffer.from('waiting'));
  void pending.catch(() => {});
  await delay(5); process.cancel();
  const result = await process.completion;
  assert.equal(result.signal, 9); await assert.rejects(pending);
  assert.equal(guest.listenerCount('event'), 0); assert.equal(guest.listenerCount('failure'), 0);
});

test('timeout and output limit stop execution without emitting bytes beyond the limit', async () => {
  for (const kind of ['timeout', 'output']) {
    const guest = new Guest(); const chunks: Buffer[] = [];
    guest.handler = method => {
      if (method === 'process.start') return { processId: 'p1' };
      if (method === 'process.signal') guest.exit(null, 9);
      return {};
    };
    const process = await startGuestProcess(guest, { command: 'run', timeoutMs: kind === 'timeout' ? 10 : 1000, maxOutputBytes: 3 }, opts((_stream, data) => chunks.push(Buffer.from(data))));
    if (kind === 'output') guest.output('stdout', Buffer.from('abcdef'));
    const result = await process.completion;
    assert.equal(result.timedOut, kind === 'timeout'); assert.equal(result.outputLimitExceeded, kind === 'output');
    assert.equal(Buffer.concat(chunks).toString(), kind === 'output' ? 'abc' : '');
  }
});

test('failure to acknowledge start is bounded even before a process ID exists', async () => {
  const guest = new Guest(); guest.handler = () => new Promise(() => {});
  let destroyed = false;
  await assert.rejects(startGuestProcess(guest, { command: 'hang', timeoutMs: 5 }, { ...opts(), stopTimeoutMs: 10, onUnresponsive() { destroyed = true; } }), /stop|respond|timed out/i);
  assert.equal(destroyed, true); assert.equal(guest.listenerCount('event'), 0);
});

test('output callback failure cancels and waits for confirmed exit before rejecting', async () => {
  const guest = new Guest();
  const process = await startGuestProcess(guest, { command: 'output' }, opts(() => { throw new Error('slow receiver'); }));
  guest.output('stdout', Buffer.from('hello'));
  let settled = false; void process.completion.catch(() => { settled = true; });
  await delay(5); assert.equal(settled, false);
  assert.ok(guest.calls.some(c => c.method === 'process.signal'));
  guest.exit(null, 9); await assert.rejects(process.completion, /slow receiver/);
});

test('guest closed stdin and immediate exit are handled without hanging', async () => {
  const guest = new Guest();
  guest.handler = method => {
    if (method === 'process.start') return { processId: 'p1' };
    if (method === 'process.write') throw new GuestError('EPIPE', 'stdin closed');
    return {};
  };
  const process = await startGuestProcess(guest, { command: 'head -c 1' }, opts());
  await assert.rejects(process.writeStdin(Buffer.from('more')), { code: 'EPIPE' });
  guest.exit(0); assert.equal((await process.completion).exitCode, 0);
  await assert.rejects(process.writeStdin(Buffer.from('late')));
});

test('unrelated startup output cannot overflow or cancel a quiet concurrent process', async () => {
  const guest = new Guest(); const chunks: Buffer[] = [];
  guest.handler = method => {
    if (method === 'process.start') {
      guest.output('stdout', Buffer.from('before'));
      for (let i = 0; i < 49; i++) guest.output('stdout', Buffer.alloc(32768), 'other');
      guest.output('stdout', Buffer.from('after'));
      return { processId: 'p1' };
    }
    if (method === 'process.signal') guest.exit(null, 9);
    return {};
  };
  const process = await startGuestProcess(guest, { command: 'quiet' }, opts((_stream, data) => chunks.push(Buffer.from(data))));
  assert.equal(guest.calls.some(call => call.method === 'process.signal'), false);
  guest.exit(0);
  assert.equal((await process.completion).exitCode, 0);
  assert.equal(Buffer.concat(chunks).toString(), 'beforeafter');
});

test('a matching startup output overflow fails explicitly, including an already-exited process', async () => {
  for (const exitedEarly of [false, true]) {
    const guest = new Guest();
    guest.handler = method => {
      if (method === 'process.start') {
        for (let i = 0; i < 49; i++) guest.output('stdout', Buffer.alloc(32768));
        if (exitedEarly) guest.exit(0);
        return { processId: 'p1' };
      }
      if (method === 'process.signal') guest.exit(null, 9);
      return {};
    };
    const process = await startGuestProcess(guest, { command: 'flood' }, { ...opts(), stopTimeoutMs: 20 });
    await assert.rejects(process.completion, /Too much output before process start acknowledgement/);
    assert.equal(guest.listenerCount('event'), 0);
    assert.equal(guest.listenerCount('failure'), 0);
  }
});
