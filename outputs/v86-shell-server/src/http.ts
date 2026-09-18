import { Buffer } from 'node:buffer';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { attachWebSocketApi } from './websocket.js';
import type { StreamingExecutor } from './streaming.js';

export interface ExecRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  durationMs: number;
}

export interface Executor {
  execute(request: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;
  info(): object;
  start?: StreamingExecutor['start'];
}

export interface ApiOptions {
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_STDIN_BYTES = 32 * 1024;
const MAX_ENV_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const REQUEST_KEYS = new Set(['command', 'cwd', 'env', 'stdin', 'timeoutMs', 'maxOutputBytes']);

export class RequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

export function checkBrowserAccess(req: IncomingMessage): void {
  // An Origin is rejected even if it claims to be localhost: there is no browser UI.
  if (req.headers.origin !== undefined) {
    throw new RequestError(403, 'Browser Origin requests are not allowed.');
  }
  const hostHeaders = req.rawHeaders.filter((_, index) => index % 2 === 0)
    .filter(name => name.toLowerCase() === 'host');
  const host = req.headers.host;
  const match = typeof host === 'string'
    ? /^(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host)
    : null;
  if (hostHeaders.length !== 1 || !match || (match[1] !== undefined && (+match[1] < 1 || +match[1] > 65535))) {
    throw new RequestError(403, 'Host must be localhost, 127.0.0.1, or [::1].');
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declaredLength = req.headers['content-length'];
  if (declaredLength !== undefined && Number(declaredLength) > maxBytes) {
    req.resume();
    return Promise.reject(new RequestError(413, `Request body exceeds ${maxBytes} bytes.`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        cleanup();
        chunks.length = 0;
        req.resume();
        reject(new RequestError(413, `Request body exceeds ${maxBytes} bytes.`));
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAborted = () => {
      cleanup();
      reject(new RequestError(400, 'Request body was interrupted.'));
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, field: string, maxBytes: number, allowNul = false): string {
  if (typeof value !== 'string') throw new RequestError(400, `${field} must be a string.`);
  if (Buffer.byteLength(value) > maxBytes) throw new RequestError(400, `${field} exceeds ${maxBytes} UTF-8 bytes.`);
  if (!allowNul && value.includes('\0')) throw new RequestError(400, `${field} must not contain NUL bytes.`);
  return value;
}

function boundedInteger(value: unknown, field: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RequestError(400, `${field} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

export function validateExec(value: unknown): ExecRequest {
  if (!isObject(value)) throw new RequestError(400, 'JSON body must be an object.');
  for (const key of Object.keys(value)) {
    if (!REQUEST_KEYS.has(key)) throw new RequestError(400, `Unknown field: ${key}.`);
  }
  const command = boundedString(value.command, 'command', MAX_COMMAND_BYTES);
  if (!command.trim()) throw new RequestError(400, 'command must not be empty.');
  const request: ExecRequest = {
    command,
    timeoutMs: boundedInteger(value.timeoutMs, 'timeoutMs', 30_000, 300_000),
    maxOutputBytes: boundedInteger(value.maxOutputBytes, 'maxOutputBytes', 4 * 1024 * 1024, MAX_OUTPUT_BYTES),
  };
  if (value.cwd !== undefined) {
    request.cwd = boundedString(value.cwd, 'cwd', 4096);
    if (!request.cwd.startsWith('/')) throw new RequestError(400, 'cwd must be an absolute path inside the VM.');
  }
  if (value.stdin !== undefined) request.stdin = boundedString(value.stdin, 'stdin', MAX_STDIN_BYTES, true);
  if (value.env !== undefined) {
    if (!isObject(value.env)) throw new RequestError(400, 'env must be an object of string values.');
    const entries = Object.entries(value.env);
    if (entries.length > 128) throw new RequestError(400, 'env must have at most 128 entries.');
    const env: Record<string, string> = Object.create(null);
    let size = 0;
    for (const [key, raw] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new RequestError(400, `Invalid environment variable name: ${key}.`);
      const item = boundedString(raw, `env.${key}`, MAX_ENV_BYTES);
      size += Buffer.byteLength(key) + Buffer.byteLength(item) + 2;
      if (size > MAX_ENV_BYTES) throw new RequestError(400, `env exceeds ${MAX_ENV_BYTES} UTF-8 bytes.`);
      env[key] = item;
    }
    request.env = env;
  }
  return request;
}

/** Create an unbound JSON API server. The caller must bind it to a loopback address. */
export function createApiServer(executor: Executor, options: ApiOptions = {}): Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new RangeError('maxBodyBytes must be a positive integer.');
  const server = createServer((req, res) => {
    const controller = new AbortController();
    const onAborted = () => controller.abort();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', onAborted);
    res.once('close', onClose);
    void (async () => {
      checkBrowserAccess(req);
      if (!req.url?.startsWith('/')) throw new RequestError(400, 'An absolute-path request target is required.');
      const path = new URL(req.url, 'http://localhost').pathname;
      const methods: Record<string, string> = { '/health': 'GET', '/mounts': 'GET', '/exec': 'POST' };
      const method = methods[path];
      if (!method) throw new RequestError(404, 'Route not found.');
      if (req.method !== method) {
        res.setHeader('allow', method);
        throw new RequestError(405, `Use ${method} for ${path}.`);
      }
      if (path === '/health') {
        json(res, 200, { status: 'ready', ...executor.info() });
        return;
      }
      if (path === '/mounts') {
        const info = executor.info() as { mounts?: unknown };
        json(res, 200, { mounts: info.mounts ?? [] });
        return;
      }
      if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        throw new RequestError(415, 'Content-Type must be application/json.');
      }
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
        throw new RequestError(415, 'Compressed request bodies are not supported.');
      }
      const body = await readBody(req, maxBodyBytes);
      let value: unknown;
      try {
        // Reject invalid UTF-8 instead of silently replacing bytes before execution.
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      } catch {
        throw new RequestError(400, 'Request body must be valid UTF-8 JSON.');
      }
      const request = validateExec(value);
      if (controller.signal.aborted) return;
      json(res, 200, await executor.execute(request, controller.signal));
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const executorStatus = (error as { statusCode?: number })?.statusCode;
      const status = error instanceof RequestError ? error.statusCode : executorStatus === 429 ? 429 : 500;
      json(res, status, { error: error instanceof Error ? error.message : 'Execution failed.' });
    }).finally(() => {
      req.off('aborted', onAborted);
      res.off('close', onClose);
      // Drain rejected requests so their connections can be reused safely.
      if (!req.complete && !req.destroyed) req.resume();
    });
  });
  if (executor.start) attachWebSocketApi(server, { start: executor.start.bind(executor) });
  return server;
}
