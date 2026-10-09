// Native agent tests are build-time tests only. The runtime never spawns this binary on the host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, chown, symlink, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const binary = process.env.AGENT_BINARY ?? fileURLToPath(new URL('./v86-agent', import.meta.url));
class Agent {
  constructor() {
    this.child = spawn(binary, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {});
    this.pending = new Map(); this.messages = []; this.id = 0; this.rx = Buffer.alloc(0);
    this.stderr = ''; this.child.stderr.on('data', data => { this.stderr += data; });
    this.child.stdout.on('data', data => {
      this.rx = Buffer.concat([this.rx, data]);
      while (this.rx.length >= 4 && this.rx.length >= this.rx.readUInt32BE(0) + 4) {
        const size = this.rx.readUInt32BE(0);
        const message = JSON.parse(this.rx.subarray(4, size + 4));
        this.rx = this.rx.subarray(size + 4);
        this.messages.push(message);
        if ('id' in message) {
          const pending = this.pending.get(message.id); this.pending.delete(message.id);
          if (message.error) pending?.reject(Object.assign(new Error(message.error.message), message.error));
          else pending?.resolve(message.result);
        }
      }
    });
  }
  request(method, params = {}, fragmented = false) {
    const id = ++this.id, body = Buffer.from(JSON.stringify({ id, method, params }));
    const frame = Buffer.alloc(body.length + 4); frame.writeUInt32BE(body.length); body.copy(frame, 4);
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    if (fragmented) for (let i = 0; i < frame.length; i++) this.child.stdin.write(frame.subarray(i, i + 1));
    else this.child.stdin.write(frame);
    return result;
  }
  async until(predicate, timeout = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (this.child.exitCode !== null) throw new Error(`Agent exited: ${this.stderr}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`Agent event timed out. Events: ${JSON.stringify(this.messages)}; stderr: ${this.stderr}`);
  }
  async completed(processId) {
    await this.until(message => message.event === 'process.closed' && message.processId === processId);
    const events = this.messages.filter(message => message.processId === processId);
    const output = stream => Buffer.concat(events.filter(message => message.event === 'process.output' && message.stream === stream).map(message => Buffer.from(message.data, 'base64')));
    const exit = events.find(message => message.event === 'process.exited');
    return { events, stdout: output('stdout'), stderr: output('stderr'), exit };
  }
  async stop() {
    this.child.stdin.end();
    if (this.child.exitCode === null) await new Promise(resolve => this.child.once('exit', resolve));
  }
}
async function fixture(fn) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'v86-agent-test-')));
  if (process.getuid?.() === 0) await chown(directory, 1000, 1000);
  const agent = new Agent();
  try {
    await agent.until(message => message.event === 'ready');
    assert.deepEqual(await agent.request('hello', { version: 1 }, true), { version: 1 });
    await fn(agent, directory);
  } finally { await agent.stop(); await rm(directory, { recursive: true, force: true }); }
}

test('argv, cwd, replacement environment, binary streams, final output and failed exec', { timeout: 10000 }, async () => {
  await fixture(async (agent, cwd) => {
    const { processId } = await agent.request('process.start', {
      argv: ['/bin/sh', '-c', 'printf "%s|%s|%s" "$1" "$CUSTOM" "$PWD"; printf "\\000\\377"; printf err >&2; exit 42', 'arg zero', 'a $ b'],
      cwd, env: { CUSTOM: 'env spaces', PATH: '/usr/bin:/bin' }, envReplace: true,
    });
    const result = await agent.completed(processId);
    assert.deepEqual(result.stdout, Buffer.concat([Buffer.from(`a $ b|env spaces|${cwd}`), Buffer.from([0, 255])]));
    assert.equal(result.stderr.toString(), 'err'); assert.equal(result.exit.exitCode, 42); assert.equal(result.exit.signal, null);
    const outputs = result.events.filter(event => event.event === 'process.output');
    assert.deepEqual(outputs.map(event => event.seq), outputs.map((_, i) => i));
    assert.deepEqual(result.events.slice(-2).map(event => event.event), ['process.exited', 'process.closed']);
    await assert.rejects(agent.request('process.start', { argv: ['/absent-executable'], cwd }), { code: 'ENOENT' });
    await assert.rejects(agent.request('process.signal', { processId, signal: 9 }), { code: 'ESRCH' });
    const replacement = await agent.request('process.start', { argv: ['/bin/sh', '-c', 'printf "%s|%s" "$0" "${HOME-unset}"'], cwd, arg0: 'emoji 🧪 "\n', env: {}, envReplace: true });
    assert.equal((await agent.completed(replacement.processId)).stdout.toString(), 'emoji 🧪 "\n|unset');
    const executableText = join(cwd, 'not-a-program');
    await agent.request('fs.writeFile', { path: executableText, mode: 0o755, data: Buffer.from('printf must-not-use-an-implicit-shell').toString('base64') });
    await assert.rejects(agent.request('process.start', { argv: [executableText], cwd }), { code: 'ENOEXEC' });
  });
});

test('malformed frames, duplicate keys and escaped NUL cannot mutate files', { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'v86-agent-invalid-')));
  if (process.getuid?.() === 0) await chown(directory, 1000, 1000);
  const path = join(directory, 'must-not-exist');
  const documents = [
    `{"id":1,"method":"fs.writeFile","params":{"path":${JSON.stringify(path)},"path":${JSON.stringify(path)},"data":""}}`,
    `{"id":1,"method":"fs.writeFile","params":{"path":${JSON.stringify(path).slice(0, -1)}\\u0000suffix","data":""}}`,
    '{"id":1,"method":"hello","params":{"version":1,"bad\\u0000key":2}}',
    '{"id":1,"method":"hello","params":{"version":1},"unexpected":"\\ud800"}',
    '{"id":9007199254740992,"method":"hello","params":{"version":1}}',
    '{"id":1e309,"method":"hello","params":{"version":1}}',
    '{"id":1,"method":"hello","params":{"version":NaN}}',
    '{"id":1,"method":"hello","params":{"version":1}}\u0000',
  ];
  try {
    for (const document of documents) {
      const agent = new Agent();
      try {
        await agent.until(message => message.event === 'ready');
        const data = Buffer.from(document), frame = Buffer.alloc(data.length + 4);
        frame.writeUInt32BE(data.length); data.copy(frame, 4);
        const exit = new Promise(resolve => agent.child.once('exit', resolve));
        agent.child.stdin.write(frame);
        assert.equal(await exit, 1, document);
      } finally { await agent.stop(); }
    }
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('output limit fails explicitly while the protocol remains usable', { timeout: 10000 }, async () => {
  await fixture(async (agent, cwd) => {
    const { processId } = await agent.request('process.start', { argv: ['/bin/sh', '-c', 'head -c 20000000 /dev/zero'], cwd });
    const result = await agent.completed(processId);
    assert.equal(result.events.find(event => event.event === 'process.error')?.code, 'E2BIG');
    assert.ok(result.stdout.length <= 16 * 1024 * 1024);
    assert.equal((await agent.request('process.status')).active, 0);
  });
});

test('multiple stdin writes, EOF, concurrency, and shutdown status', { timeout: 10000 }, async () => {
  await fixture(async (agent, cwd) => {
    const first = await agent.request('process.start', { argv: ['/bin/cat'], cwd });
    const second = await agent.request('process.start', { argv: ['/bin/sh', '-c', 'printf concurrent'], cwd });
    const chunks = [Buffer.from([0, 1, 255, 10]), Buffer.from('another\n')];
    for (const chunk of chunks) assert.equal((await agent.request('process.write', { processId: first.processId, data: chunk.toString('base64') })).written, chunk.length);
    await agent.request('process.closeStdin', { processId: first.processId });
    assert.deepEqual((await agent.completed(first.processId)).stdout, Buffer.concat(chunks));
    assert.equal((await agent.completed(second.processId)).stdout.toString(), 'concurrent');
    await agent.request('process.start', { argv: ['/bin/sh', '-c', 'sleep 60'], cwd });
    await agent.request('process.shutdown');
    for (let i = 0; i < 400; i++) {
      const status = await agent.request('process.status');
      if (!status.active) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('Processes were not quiescent after shutdown');
  });
});

test('guest file API bytes, offsets, metadata, symlinks and recursive removal', { timeout: 10000 }, async () => {
  await fixture(async (agent, cwd) => {
    const directory = join(cwd, 'sub', 'nested'), path = join(directory, 'binary');
    await agent.request('fs.createDirectory', { path: directory, recursive: true });
    const bytes = Buffer.from([0, 255, 127, 10, 13]);
    await agent.request('fs.writeFile', { path, data: bytes.toString('base64'), truncate: true, mode: 0o755, follow: false });
    await agent.request('fs.writeFile', { path, data: Buffer.from([42]).toString('base64'), offset: 1 });
    bytes[1] = 42;
    const read = await agent.request('fs.readFile', { path, length: 2, offset: 1 });
    assert.deepEqual(Buffer.from(read.data, 'base64'), bytes.subarray(1, 3)); assert.equal(read.eof, false);
    assert.deepEqual(await readFile(path), bytes);
    const metadata = await agent.request('fs.getMetadata', { path }); assert.equal(metadata.kind, 'file'); assert.equal(metadata.mode, 0o755);
    assert.deepEqual((await agent.request('fs.readDirectory', { path: directory })).entries, [{ name: 'binary', kind: 'file' }]);
    const link = join(directory, 'link'); await symlink(path, link);
    assert.equal((await agent.request('fs.getMetadata', { path: link })).kind, 'symlink');
    assert.equal((await agent.request('fs.getMetadata', { path: link, follow: true })).kind, 'file');
    await assert.rejects(agent.request('fs.readFile', { path: link, follow: false }), { code: 'ELOOP' });
    await assert.rejects(agent.request('fs.writeFile', { path: link, follow: false, data: '' }), { code: 'ELOOP' });
    await agent.request('fs.remove', { path: link, recursive: true });
    assert.equal((await agent.request('fs.canonicalize', { path })).path, path);
    await agent.request('fs.remove', { path: join(cwd, 'sub'), recursive: true });
    await assert.rejects(agent.request('fs.getMetadata', { path }), { code: 'ENOENT' });
    await assert.rejects(agent.request('fs.writeFile', { path: join(cwd, 'bad'), data: 'Zh==' }), { code: 'EINVAL' });
    await assert.rejects(agent.request('fs.remove', { path: '/', recursive: true }), { code: 'EPERM' });
  });
});

test('control remains live during an output flood and terminates descendants', { timeout: 10000 }, async () => {
  await fixture(async (agent, cwd) => {
    const { processId } = await agent.request('process.start', { argv: ['/bin/sh', '-c', 'sleep 60 & while :; do printf flood; done'], cwd });
    await agent.until(message => message.event === 'process.output' && message.processId === processId);
    const start = Date.now(); await agent.request('process.terminate', { processId });
    const result = await agent.completed(processId);
    assert.ok(Date.now() - start < 4000);
    assert.ok(result.exit.signal === 15 || result.exit.signal === 9);
    assert.equal((await agent.request('process.status')).active, 0);
  });
});

test('no-follow filesystem operations reject symlinks in every ancestor', { timeout: 10000 }, async () => {
  await fixture(async (agent, cwd) => {
    const safe = join(cwd, 'safe'), alias = join(cwd, 'alias'), file = join(safe, 'file');
    await agent.request('fs.createDirectory', { path: safe, follow: false });
    await agent.request('fs.writeFile', { path: file, data: Buffer.from('untouched').toString('base64'), follow: false });
    await symlink(safe, alias);
    const rejects = [
      ['fs.readFile', { path: join(alias, 'file') }],
      ['fs.writeFile', { path: join(alias, 'file'), data: '', truncate: true }],
      ['fs.getMetadata', { path: join(alias, 'file') }],
      ['fs.readDirectory', { path: alias }],
      ['fs.createDirectory', { path: join(alias, 'new', 'nested'), recursive: true }],
      ['fs.createDirectory', { path: alias, recursive: true }],
      ['fs.remove', { path: join(alias, 'file') }],
    ];
    for (const [method, params] of rejects) await assert.rejects(agent.request(method, { ...params, follow: false }), error => ['ELOOP', 'ENOTDIR'].includes(error.code));
    assert.equal((await readFile(file)).toString(), 'untouched');
    await agent.request('fs.createDirectory', { path: join(safe, 'new', 'nested'), recursive: true, follow: false });
    assert.equal((await agent.request('fs.getMetadata', { path: join(safe, 'new', 'nested'), follow: false })).kind, 'directory');
    await agent.request('fs.remove', { path: alias, recursive: true, follow: false });
    assert.equal((await readFile(file)).toString(), 'untouched');
    await agent.request('fs.remove', { path: safe, recursive: true, follow: false });
  });
});
