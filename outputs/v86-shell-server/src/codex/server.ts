import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { checkBrowserAccess, RequestError } from '../http.js';
import type { ArgvExecRequest, OutputHandler, StreamingProcess } from '../streaming.js';
import { createCodexFilesystem, guestPathFromUri, guestPathToUri } from './filesystem.js';

/** Wire contract: openai/codex rust-v0.154.0, exec-server-protocol/src/protocol.rs. */
export interface CodexExecutor {
  info(): { defaultCwd?: string };
  guestEnvironment?(): Record<string, string>;
  startArgv(request: ArgvExecRequest, onOutput: OutputHandler, signal?: AbortSignal): Promise<StreamingProcess>;
  guestFilesystemRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
}
type ObjectValue = Record<string, any>;
type Chunk = { seq: number; stream: 'stdout' | 'stderr'; chunk: string };
interface ProcessRecord {
  id: string; controller: AbortController; child?: StreamingProcess; announced: boolean;
  notifications: ObjectValue[]; chunks: Chunk[]; bytes: number; nextSeq: number;
  closed: boolean; exitCode: number | null; failure: string | null; events: EventEmitter; lostThrough: number;
  writes: Map<string, { hash: string; result: Promise<{ status: string }> }>;
  stdin: boolean;
}
class RpcError extends Error {
  constructor(readonly rpcCode: number, message: string) { super(message); }
}
function object(value: unknown): value is ObjectValue { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid(message: string): never { throw new RpcError(-32602, message); }
function text(value: unknown, name: string, maximum = 4096): string {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > maximum) invalid(`Invalid ${name}`);
  return value;
}
function integer(value: unknown, name: string, fallback: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) invalid(`Invalid ${name}`);
  return value as number;
}
function environment(value: unknown): Record<string, string> {
  if (!object(value) || Object.keys(value).length > 128) invalid('env must contain at most 128 string values');
  const result: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) invalid('Invalid environment key');
    result[key] = text(item, 'environment value', 32768); bytes += Buffer.byteLength(key) + Buffer.byteLength(item) + 2;
  }
  if (bytes > 32768) invalid('Environment exceeds 32 KiB');
  return result;
}
function matches(pattern: string, key: string): boolean {
  return new RegExp('^' + [...pattern].map(char => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', 'i').test(key);
}

/** The VM and mounts are the sandbox. Never silently discard a second sandbox. */
function checkSandbox(params: ObjectValue): void {
  const context = params.sandbox;
  if (context !== undefined && context !== null) {
    if (!object(context) || !object(context.permissions) || context.permissions.type !== 'disabled') {
      throw new RpcError(-32602, 'Additional Codex sandbox policies are unsupported. Use danger-full-access inside this VM; host access is limited by its mounts and proxy policy.');
    }
  }
  if (params.enforceManagedNetwork || params.managedNetwork != null || params.networkProxy != null) {
    throw new RpcError(-32602, 'Codex-managed networking is unsupported; configure the v86 managed proxy instead.');
  }
}

export class CodexSession {
  private state: 'new' | 'initialized' | 'ready' | 'closed' = 'new';
  private readonly processes = new Map<string, ProcessRecord>();
  private readonly filesystem;
  private readonly lifetime = new AbortController();
  private readonly sessionId = randomUUID();
  private retainedBytes = 0;
  get isInitialized(): boolean { return this.state === 'ready'; }
  constructor(private readonly executor: CodexExecutor, private readonly send: (message: ObjectValue) => void) {
    this.filesystem = createCodexFilesystem(executor.guestFilesystemRequest.bind(executor));
  }
  private environmentInfo() {
    return { shell: { name: 'bash', path: '/bin/bash' }, executorVersion: '0.0.0',
      cwd: guestPathToUri(this.executor.info().defaultCwd ?? '/workspace'),
      userHomeDir: 'file:///home/agent', platformOs: 'linux', temporaryDirectories: ['file:///tmp'], tempDir: 'file:///tmp', capabilities: {} };
  }
  async dispatch(message: unknown): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    if (!object(message) || typeof message.method !== 'string') throw new RpcError(-32600, 'Invalid RPC envelope');
    if (!('id' in message)) {
      if (message.method === 'initialized' && this.state === 'initialized') this.state = 'ready';
      return;
    }
    if (!(typeof message.id === 'string' && message.id.length <= 256) && !Number.isSafeInteger(message.id)) throw new RpcError(-32600, 'Invalid request ID');
    try {
      const params = message.params ?? {};
      if (!object(params)) invalid('params must be an object');
      const result = await this.request(message.method, params);
      if (this.lifetime.signal.aborted) return;
      this.send({ id: message.id, result });
      if (message.method === 'process/start') {
        const record = this.processes.get(params.processId)!;
        record.announced = true;
        for (const notification of record.notifications) this.send(notification);
        record.notifications.length = 0;
      }
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      const e = error as Error & { code?: string; rpcCode?: number };
      const code = e.rpcCode ?? (e.code === 'ENOSYS' ? -32601 : e.code === 'ENOENT' ? -32004 : ['EINVAL', 'EACCES', 'EPERM'].includes(e.code ?? '') ? -32600 : -32603);
      this.send({ id: message.id, error: { code, message: e.message,
        ...(e.code ? { data: { code: e.code } } : {}) } });
    }
  }
  private emit(record: ProcessRecord, method: string, params: ObjectValue) {
    if (this.lifetime.signal.aborted) return;
    const notification = { method, params: { processId: record.id, ...params } };
    if (record.announced) this.send(notification); else record.notifications.push(notification);
    record.events.emit('change');
  }
  private finish(record: ProcessRecord, exitCode: number, failure: string | null = null) {
    if (record.closed) return;
    record.closed = true; record.exitCode = exitCode; record.failure = failure;
    record.writes.clear();
    this.emit(record, 'process/exited', { seq: record.nextSeq++, exitCode, sandboxDenied: false });
    this.emit(record, 'process/closed', { seq: record.nextSeq++ });
  }
  private process(params: ObjectValue): ProcessRecord {
    const record = this.processes.get(text(params.processId, 'processId', 256));
    if (!record) invalid('Unknown process ID');
    return record;
  }
  private async request(method: string, params: ObjectValue): Promise<unknown> {
    if (method === 'initialize') {
      if (this.state !== 'new') invalid('Session already initialized');
      if (!text(params.clientName, 'clientName', 256)) invalid('clientName must not be empty');
      if (params.resumeSessionId != null) invalid('Session resumption is unsupported; initialize a new VM connection');
      this.state = 'initialized';
      return { sessionId: this.sessionId, environmentInfo: this.environmentInfo() };
    }
    if (this.state !== 'ready') throw new RpcError(-32002, 'initialize and initialized are required');
    if (method === 'environment/info') return this.environmentInfo();
    if (method === 'environment/status') return { status: 'ready' };
    if (method.startsWith('fs/')) {
      checkSandbox(params);
      const { sandbox: _sandbox, ...fields } = params;
      return this.filesystem.handle(method, fields, this.lifetime.signal);
    }
    if (method === 'process/start') return this.start(params);
    if (method === 'process/read') {
      const record = this.process(params), after = integer(params.afterSeq, 'afterSeq', 0, Number.MAX_SAFE_INTEGER);
      const maximum = integer(params.maxBytes, 'maxBytes', 1024 * 1024, 16 * 1024 * 1024);
      const wait = integer(params.waitMs, 'waitMs', 0, 30000);
      if (!record.closed && record.nextSeq <= after + 1 && wait) {
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); record.events.off('change', done); resolve(); };
          const timer = setTimeout(done, wait); record.events.once('change', done);
        });
      }
      const chunks: Chunk[] = []; let bytes = 0, nextSeq = record.nextSeq;
      for (const chunk of record.chunks) {
        if (chunk.seq <= after) continue;
        const length = Buffer.byteLength(chunk.chunk, 'base64');
        if (chunks.length && bytes + length > maximum) break;
        chunks.push(chunk); bytes += length; nextSeq = chunk.seq + 1;
        if (bytes >= maximum) break;
      }
      if (params.maxBytes == null) nextSeq = record.nextSeq;
      const evicted = after < record.lostThrough;
      return { chunks, nextSeq, exited: record.closed, exitCode: record.exitCode, closed: record.closed,
        failure: evicted ? 'Requested output is older than the retained output buffer' : record.failure, sandboxDenied: false };
    }
    if (method === 'process/write') {
      const id = text(params.processId, 'processId', 256), record = this.processes.get(id);
      if (!record) return { status: 'unknownProcess' };
      if (!record.child) return { status: 'starting' };
      if (record.closed || !record.stdin) return { status: 'stdinClosed' };
      const writeId = text(params.writeId, 'writeId', 256);
      if (!writeId) invalid('writeId must not be empty');
      const encoded = text(params.chunk, 'chunk', 43692), data = Buffer.from(encoded, 'base64');
      if (data.length > 32768 || data.toString('base64') !== encoded) invalid('stdin requires canonical base64, at most 32 KiB');
      const hash = createHash('sha256').update(data).digest('hex');
      const prior = record.writes.get(writeId);
      if (prior) { if (prior.hash !== hash) invalid('writeId reused with different data'); return prior.result; }
      const result = record.child.writeStdin(data).then(() => ({ status: 'accepted' }), error => {
        if (['EPIPE', 'ESRCH', 'ENOENT'].includes(error.code)) { record.stdin = false; return { status: 'stdinClosed' }; }
        throw error;
      });
      record.writes.set(writeId, { hash, result });
      if (record.writes.size > 4096) record.writes.delete(record.writes.keys().next().value!);
      return result;
    }
    if (method === 'process/signal') {
      const record = this.processes.get(text(params.processId, 'processId', 256));
      if (params.signal !== 'interrupt') invalid('Only the interrupt signal is supported');
      if (record && !record.closed) {
        if (!record.child?.signal) invalid('Process is not ready for signals');
        await record.child.signal(2);
      }
      return {};
    }
    if (method === 'process/terminate') {
      const record = this.processes.get(text(params.processId, 'processId', 256));
      const running = !!record && !record.closed;
      if (running) record.controller.abort();
      return { running };
    }
    throw new RpcError(-32601, `Unsupported exec-server method: ${method}`);
  }
  private async start(params: ObjectValue) {
    checkSandbox(params);
    if (params.tty !== false) invalid('PTY execution is unsupported; disable features.unified_exec_tty in Codex');
    if (params.pipeStdin !== undefined && typeof params.pipeStdin !== 'boolean') invalid('pipeStdin must be boolean');
    if (params.shellSnapshot != null) invalid('Executor shell snapshots are unsupported');
    const id = text(params.processId, 'processId', 256);
    if (!id || this.processes.has(id)) invalid('processId must be new and nonempty');
    if (!Array.isArray(params.argv) || !params.argv.length || params.argv.length > 1024) invalid('argv must be a nonempty array');
    const argv = params.argv.map((arg: unknown) => text(arg, 'argv', 65536));
    if (!argv[0] || argv.reduce((size: number, arg: string) => size + Buffer.byteLength(arg) + 1, 0) > 65536) invalid('argv exceeds 64 KiB');
    const cwd = guestPathFromUri(params.cwd), overrides = environment(params.env);
    let env: Record<string, string> = {};
    if (params.envPolicy != null) {
      const policy = params.envPolicy;
      if (!object(policy) || !['all', 'core', 'none'].includes(policy.inherit)) invalid('Invalid envPolicy');
      if (policy.inherit !== 'none') env = { ...(this.executor.guestEnvironment?.() ?? { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/agent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', USER: 'agent', LOGNAME: 'agent', SHELL: '/bin/bash' }) };
      if (policy.inherit === 'core') for (const key of Object.keys(env)) if (!['PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'USER'].includes(key.toUpperCase())) delete env[key];
      for (const key of ['exclude', 'includeOnly']) if (!Array.isArray(policy[key]) || policy[key].length > 128 || policy[key].some((p: unknown) => typeof p !== 'string' || p.length > 256)) invalid(`Invalid envPolicy.${key}`);
      for (const key of Object.keys(env)) if ((!policy.ignoreDefaultExcludes && /key|secret|token/i.test(key)) || policy.exclude.some((p: string) => matches(p, key))) delete env[key];
      Object.assign(env, environment(policy.set ?? {}));
      if (policy.includeOnly.length) for (const key of Object.keys(env)) if (!policy.includeOnly.some((p: string) => matches(p, key))) delete env[key];
    }
    Object.assign(env, overrides);
    for (const key of Object.keys(env)) if (['CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN', 'NODE_REPL_AUTH_TOKEN', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT'].includes(key.toUpperCase())) delete env[key];
    environment(env);
    const arg0 = params.arg0 == null ? undefined : text(params.arg0, 'arg0', 65536);
    // Bound retained completed handles without affecting active processes.
    if (this.processes.size >= 128) for (const [key, process] of this.processes) { if (process.closed) { this.retainedBytes -= process.bytes; this.processes.delete(key); break; } }
    if (this.processes.size >= 128) invalid('Too many retained processes');
    const record: ProcessRecord = { id, controller: new AbortController(), announced: false, notifications: [], chunks: [], bytes: 0,
      nextSeq: 1, closed: false, exitCode: null, failure: null, lostThrough: 0, events: new EventEmitter().setMaxListeners(32), writes: new Map(), stdin: params.pipeStdin === true };
    this.processes.set(id, record);
    try {
      record.child = await this.executor.startArgv({ argv, cwd, env, envReplace: true, arg0, stdin: record.stdin, timeoutMs: 0, maxOutputBytes: 16 * 1024 * 1024 }, (stream, data) => {
        const chunk = { seq: record.nextSeq++, stream, chunk: Buffer.from(data).toString('base64') };
        record.chunks.push(chunk); record.bytes += data.length; this.retainedBytes += data.length;
        const evict = (p: ProcessRecord) => {
          const removed = p.chunks.shift()!;
          const length = Buffer.byteLength(removed.chunk, 'base64');
          p.bytes -= length; this.retainedBytes -= length; p.lostThrough = removed.seq;
        };
        while (record.bytes > 1024 * 1024 || record.chunks.length > 8192) evict(record);
        for (const p of this.processes.values()) while (this.retainedBytes > 8 * 1024 * 1024 && p.chunks.length) evict(p);
        this.emit(record, 'process/output', chunk);
      }, record.controller.signal);
      if (this.lifetime.signal.aborted) record.child.cancel();
      void record.child.completion.then(exit => {
        const failure = exit.timedOut ? 'Process timed out' : exit.outputLimitExceeded ? 'Process output exceeded 16 MiB' : null;
        this.finish(record, failure ? 125 : exit.exitCode ?? 128 + (exit.signal ?? 9), failure);
      }, error => this.finish(record, 125, error.message));
      return { processId: id, sandboxType: 'none' };
    } catch (error) { this.retainedBytes -= record.bytes; this.processes.delete(id); throw error; }
  }
  close() {
    if (this.lifetime.signal.aborted) return;
    this.state = 'closed'; this.lifetime.abort(); this.filesystem.close();
    for (const record of this.processes.values()) {
      record.controller.abort(); if (!record.closed) record.child?.cancel();
      record.events.emit('change'); record.notifications.length = 0; record.chunks.length = 0; record.writes.clear();
    }
    this.processes.clear();
    this.retainedBytes = 0;
  }
}

export function attachCodexExecServer(server: Server, executor: CodexExecutor): void {
  const maximum = 12 * 1024 * 1024;
  const wss = new WebSocketServer({ noServer: true, maxPayload: maximum, perMessageDeflate: false });
  const sessions = new Map<WebSocket, CodexSession>();
  let stopping = false;
  server.on('upgrade', (request, socket, head) => {
    if (!request.url?.startsWith('/') || new URL(request.url, 'http://localhost').pathname !== '/codex') return;
    try {
      checkBrowserAccess(request);
      if (stopping || sessions.size >= 16) throw new RequestError(503, 'Codex connection limit reached or server stopping');
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
    } catch (error) {
      const code = error instanceof RequestError ? error.statusCode : 400;
      socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  wss.on('connection', ws => {
    let pending = 0, pendingBytes = 0;
    const session = new CodexSession(executor, message => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const json = JSON.stringify(message);
      if (ws.bufferedAmount + Buffer.byteLength(json) > maximum) { session.close(); ws.terminate(); return; }
      ws.send(json, error => { if (error) { session.close(); ws.terminate(); } });
    });
    sessions.set(ws, session);
    const deadline = setTimeout(() => { session.close(); ws.terminate(); }, 10000); deadline.unref();
    ws.on('message', data => {
      const size = Buffer.byteLength(data as Buffer);
      if (++pending > 32 || (pendingBytes += size) > maximum) { session.close(); ws.terminate(); return; }
      void (async () => {
        try { await session.dispatch(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data as Buffer))); if (session.isInitialized) clearTimeout(deadline); }
        catch { session.close(); ws.close(1008, 'Invalid Codex RPC message'); }
        finally { pending--; pendingBytes -= size; }
      })();
    });
    const disconnect = () => { clearTimeout(deadline); session.close(); sessions.delete(ws); };
    ws.on('close', disconnect); ws.on('error', disconnect);
  });
  const disconnectAll = () => { for (const [ws, session] of sessions) { session.close(); ws.terminate(); } };
  const close = server.close.bind(server);
  server.close = callback => { stopping = true; disconnectAll(); wss.close(); return close(callback); };
  const closeAll = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => { disconnectAll(); closeAll(); };
}
