import { Buffer } from 'node:buffer';
import type { Server, IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { checkBrowserAccess, RequestError, validateExec } from './http.js';
import type { StreamExecRequest, StreamingExecutor, StreamingProcess } from './streaming.js';

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_STDIN_CHUNK_BYTES = 32 * 1024;
const MAX_STDIN_QUEUE_BYTES = 256 * 1024;
const MAX_STDIN_QUEUE_MESSAGES = 256;
const MAX_OUTPUT_BUFFER_BYTES = 1024 * 1024;
const START_DEADLINE_MS = 10_000;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown field: ${key}.`);
  }
}

function startRequest(value: Record<string, unknown>): StreamExecRequest {
  if (value.stdin !== undefined && typeof value.stdin !== 'boolean') throw new Error('stdin must be a boolean.');
  const { type: _type, stdin, ...fields } = value;
  // Reuse the HTTP command, environment, path, and resource limit validation.
  return { ...validateExec(fields), stdin: stdin ?? true } as StreamExecRequest;
}

function stdinBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_STDIN_CHUNK_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`stdin data must be canonical base64 encoding at most ${MAX_STDIN_CHUNK_BYTES} bytes.`);
  }
  const data = Buffer.from(value, 'base64');
  if (data.length > MAX_STDIN_CHUNK_BYTES || data.toString('base64') !== value) {
    throw new Error(`stdin data must be canonical base64 encoding at most ${MAX_STDIN_CHUNK_BYTES} bytes.`);
  }
  return data;
}

/** Attach the streaming execution endpoint and include upgraded sockets in shutdown. */
export function attachWebSocketApi(server: Server, executor: StreamingExecutor, options: {
  codex?: boolean;
  terminal?: { authorizeWebSocket(request: IncomingMessage): void; protocol: string };
} = {}): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false,
    // Never echo the token-bearing offered subprotocol in the handshake response.
    handleProtocols: protocols => options.terminal && protocols.has(options.terminal.protocol) ? options.terminal.protocol : false,
  });
  const connections = new Map<WebSocket, () => void>();
  let stopping = false;

  server.on('upgrade', (request, socket, head) => {
    if (options.codex && request.url?.startsWith('/') && new URL(request.url, 'http://localhost').pathname === '/codex') return;
    try {
      if (stopping) throw new RequestError(503, 'Server is shutting down.');
      if (!request.url?.startsWith('/')) throw new RequestError(400, 'An absolute-path request target is required.');
      if (new URL(request.url, 'http://localhost').pathname !== '/exec/ws') throw new RequestError(404, 'Route not found.');
      if (request.headers.origin !== undefined && options.terminal) options.terminal.authorizeWebSocket(request);
      else checkBrowserAccess(request);
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
    } catch (error) {
      const status = error instanceof RequestError ? error.statusCode : 400;
      const body = JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid upgrade request.' });
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
  });

  wss.on('connection', ws => {
    const controller = new AbortController();
    let child: StreamingProcess | undefined;
    let childCanceled = false;
    let terminal = false;
    let receivedStart = false;
    let announced = false;
    let stdinEnabled = false;
    let eofRequested = false;
    let stdinClosed = false;
    let lastStdinId = -1;
    let queuedStdinBytes = 0;
    let queuedStdinMessages = 0;
    let earlyOutputBytes = 0;
    const earlyOutput: string[] = [];
    let starting: Promise<StreamingProcess | undefined> = Promise.resolve(undefined);
    let inputQueue: Promise<void> = Promise.resolve();
    const deadline = setTimeout(() => fail('A start message is required within 10 seconds.', 1008), START_DEADLINE_MS);
    deadline.unref();

    function cancel(): void {
      controller.abort();
      if (child && !childCanceled) {
        childCanceled = true;
        child.cancel();
      }
    }

    function fail(message: string, code = 1011): void {
      if (terminal) return;
      terminal = true;
      clearTimeout(deadline);
      earlyOutput.length = 0;
      earlyOutputBytes = 0;
      cancel();
      if (ws.readyState === WebSocket.OPEN) {
        // The error is small and deliberately bypasses the output limit: lost output
        // must be reported instead of looking like successful process completion.
        ws.send(JSON.stringify({ type: 'error', error: message }));
        ws.close(code);
      }
    }

    function sendEncoded(message: string): boolean {
      if (terminal || ws.readyState !== WebSocket.OPEN) return false;
      if (ws.bufferedAmount + Buffer.byteLength(message) > MAX_OUTPUT_BUFFER_BYTES) {
        fail('WebSocket output buffer exceeded 1048576 bytes; execution canceled.', 1013);
        return false;
      }
      ws.send(message, error => { if (error) fail(error.message); });
      return true;
    }

    function send(value: unknown): boolean {
      return sendEncoded(JSON.stringify(value));
    }

    function output(stream: 'stdout' | 'stderr', bytes: Uint8Array): void {
      if (terminal) return;
      const message = JSON.stringify({ type: stream, data: Buffer.from(bytes).toString('base64') });
      if (announced) {
        sendEncoded(message);
      } else {
        earlyOutputBytes += Buffer.byteLength(message);
        if (earlyOutputBytes > MAX_OUTPUT_BUFFER_BYTES) {
          fail('WebSocket output buffer exceeded 1048576 bytes during startup; execution canceled.', 1013);
        } else {
          earlyOutput.push(message);
        }
      }
    }

    function closeInputNotice(): void {
      if (stdinClosed) return;
      stdinClosed = true;
      send({ type: 'stdin_closed' });
    }

    function queueInput(data: Buffer | undefined, id?: number): void {
      queuedStdinBytes += data?.length ?? 0;
      queuedStdinMessages++;
      if (queuedStdinBytes > MAX_STDIN_QUEUE_BYTES || queuedStdinMessages > MAX_STDIN_QUEUE_MESSAGES) {
        throw new Error('Pending stdin queue exceeded its limit.');
      }
      inputQueue = inputQueue.then(async () => {
        const process = await starting;
        if (!process || terminal || stdinClosed || controller.signal.aborted) return;
        try {
          if (data !== undefined) {
            await process.writeStdin(data);
            if (!terminal) send({ type: 'stdin_ack', id });
          } else {
            await process.closeStdin();
            closeInputNotice();
          }
        } catch (error) {
          const code = (error as { code?: string })?.code;
          if (code === 'EPIPE' || code === 'ESRCH') closeInputNotice();
          else if (!terminal && !controller.signal.aborted) fail(error instanceof Error ? error.message : 'stdin write failed.');
        }
      }).finally(() => {
        queuedStdinBytes -= data?.length ?? 0;
        queuedStdinMessages--;
      }).catch(error => {
        if (!terminal) fail(error instanceof Error ? error.message : 'stdin operation failed.');
      });
    }

    ws.on('message', (raw, isBinary) => {
      if (terminal) return;
      try {
        if (isBinary) throw new Error('WebSocket messages must be UTF-8 JSON text.');
        let message: unknown;
        try { message = JSON.parse(raw.toString()); } catch { throw new Error('WebSocket messages must contain valid JSON.'); }
        if (!object(message) || typeof message.type !== 'string') throw new Error('A JSON object with a type field is required.');
        if (!receivedStart) {
          if (message.type !== 'start') throw new Error('The first message must have type start.');
          const request = startRequest(message);
          receivedStart = true;
          stdinEnabled = request.stdin !== false;
          clearTimeout(deadline);
          // Keep startup independent of the input chain so cancellation can abort it.
          starting = (async () => {
            try {
              child = await executor.start(request, output, controller.signal);
              // Always observe completion, including disconnects during startup.
              void child.completion.then(result => {
                if (terminal) return;
                // Exit confirms the input pipe is closed even if the EOF RPC's
                // promise continuation has not run yet. Do not wait for blocked
                // writes or acknowledge bytes that the guest never accepted.
                if (eofRequested) closeInputNotice();
                if (send({ type: 'exit', ...result })) {
                  terminal = true;
                  ws.close(1000);
                }
              }, error => fail(error instanceof Error ? error.message : 'Execution failed.'));
              if (terminal || controller.signal.aborted) {
                cancel();
                if (terminal) return undefined;
              }
              if (!send({ type: 'started', processId: child.processId })) return undefined;
              announced = true;
              for (const message of earlyOutput) if (!sendEncoded(message)) break;
              earlyOutput.length = 0;
              earlyOutputBytes = 0;
              return child;
            } catch (error) {
              fail(error instanceof Error ? error.message : 'Execution failed.');
              return undefined;
            }
          })();
          return;
        }
        if (message.type === 'start') throw new Error('Only one start message is allowed per connection.');
        if (message.type === 'cancel') {
          exactKeys(message, ['type']);
          cancel();
          return;
        }
        if (message.type === 'stdin') {
          exactKeys(message, ['type', 'id', 'data']);
          if (!stdinEnabled || eofRequested || stdinClosed) throw new Error('stdin is closed.');
          if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || message.id < 0 || message.id <= lastStdinId) {
            throw new Error('stdin id must be a strictly increasing nonnegative safe integer.');
          }
          const data = stdinBytes(message.data);
          lastStdinId = message.id;
          queueInput(data, message.id);
          return;
        }
        if (message.type === 'stdin_eof') {
          exactKeys(message, ['type']);
          if (!stdinEnabled || eofRequested || stdinClosed) throw new Error('stdin is already closed.');
          eofRequested = true;
          queueInput(undefined);
          return;
        }
        throw new Error(`Unknown message type: ${message.type}.`);
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Invalid protocol message.', 1008);
      }
    });
    const disconnect = () => {
      if (!terminal) { terminal = true; cancel(); }
      clearTimeout(deadline);
      earlyOutput.length = 0;
      earlyOutputBytes = 0;
      connections.delete(ws);
    };
    connections.set(ws, disconnect);
    ws.on('close', disconnect);
    ws.on('error', disconnect);
  });

  function disconnectAll(): void {
    for (const [ws, disconnect] of connections) {
      disconnect();
      ws.terminate();
    }
  }
  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    disconnectAll();
    wss.close();
  }
  // Node's closeAllConnections explicitly excludes upgraded sockets. Include them
  // here so existing CLI shutdown and embedders cannot leave guest processes alive.
  const close = server.close.bind(server);
  server.close = callback => { shutdown(); return close(callback); };
  const closeAll = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => { disconnectAll(); closeAll(); };
}
