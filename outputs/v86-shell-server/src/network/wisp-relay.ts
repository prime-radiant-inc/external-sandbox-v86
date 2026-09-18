import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

// This is a virtual address, never an address passed to host DNS or connect().
export const GUEST_PROXY_IP = '192.168.86.1';
export const GUEST_PROXY_PORT = 8080;
export const GUEST_PROXY_URL = `http://${GUEST_PROXY_IP}:${GUEST_PROXY_PORT}`;
const WINDOW = 128;
const MAX_BUFFER = 2 * 1024 * 1024;
const RECEIVE_WINDOW = 128 * 1024;

export interface ProxyRelay {
  relayUrl: string;
  setGuestQueueSize(read: (streamId: number) => number): void;
  acknowledgeReceive(streamId: number, bytes: number): void;
  close(): Promise<void>;
}

/** Wisp v1 transport, deliberately capable of dialing exactly one host endpoint. */
export async function startProxyRelay(options: { proxyPort: number }): Promise<ProxyRelay> {
  if (!Number.isInteger(options.proxyPort) || options.proxyPort < 1 || options.proxyPort > 65535) throw new Error('Invalid proxy port');
  const tokenPath = '/' + randomBytes(32).toString('hex');
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  let active: WebSocket | undefined;
  let stopped = false;
  let guestQueueSize = (_id: number) => 0;
  const inFlight = new Map<number, number>();
  server.on('upgrade', (request, socket, head) => {
    if (stopped || request.url !== tokenPath || request.headers.origin || active) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    active = ws;
    const streams = new Map<number, Socket>();
    function pull(id: number, socket: Socket) {
      if (streams.get(id) !== socket || ws.readyState !== WebSocket.OPEN) return;
      let queued: number;
      try { queued = guestQueueSize(id); } catch { ws.terminate(); return; }
      const budget = RECEIVE_WINDOW - queued - (inFlight.get(id) ?? 0);
      if (!Number.isFinite(budget) || budget <= 0 || !socket.readableLength) return;
      const bytes = socket.read(Math.min(socket.readableLength, Math.floor(budget), 64 * 1024)) as Buffer | null;
      if (!bytes) return;
      inFlight.set(id, (inFlight.get(id) ?? 0) + bytes.length);
      send(2, id, bytes);
    }
    // Guest ACKs are processed inside the pinned v86 TCP stack. Poll its queue
    // only while this relay session exists; paused host sockets retain normal
    // TCP backpressure upstream instead of accumulating WebSocket messages.
    const receiveTimer = setInterval(() => { for (const [id, socket] of streams) pull(id, socket); }, 10);
    function send(type: number, id: number, payload: Buffer) {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFER) { ws.terminate(); return; }
      const header = Buffer.alloc(5); header[0] = type; header.writeUInt32LE(id, 1);
      ws.send(Buffer.concat([header, payload]));
    }
    function credit(id: number) { const payload = Buffer.alloc(4); payload.writeUInt32LE(WINDOW); send(3, id, payload); }
    function close(id: number, reason = 2, expected?: Socket) {
      if (expected && streams.get(id) !== expected) return;
      const socket = streams.get(id); streams.delete(id); socket?.destroy(); send(4, id, Buffer.from([reason]));
    }
    credit(0);
    ws.on('error', () => {});
    ws.on('close', () => {
      if (active === ws) active = undefined;
      clearInterval(receiveTimer); inFlight.clear();
      for (const socket of streams.values()) socket.destroy();
      streams.clear();
    });
    ws.on('message', (raw, binary) => {
      const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (!binary || frame.length < 5) { ws.close(1002, 'Invalid Wisp frame'); return; }
      const id = frame.readUInt32LE(1);
      if (!id) { ws.close(1002, 'Invalid Wisp stream'); return; }
      if (frame[0] === 1) {
        if (frame.length < 9 || streams.has(id)) { ws.close(1002, 'Invalid Wisp connect'); return; }
        const protocol = frame[5], port = frame.readUInt16LE(6), host = frame.subarray(8).toString('utf8');
        // Never use the requested host/port for a host-side connection.
        if (protocol !== 1 || host !== GUEST_PROXY_IP || port !== GUEST_PROXY_PORT || streams.size >= 64) { close(id, 3); return; }
        const socket = connect({ host: '127.0.0.1', port: options.proxyPort });
        streams.set(id, socket);
        socket.setNoDelay(true);
        socket.setTimeout(120_000, () => close(id, 2, socket));
        socket.on('error', () => close(id, 2, socket));
        socket.on('readable', () => pull(id, socket));
        socket.on('close', () => { if (streams.get(id) === socket) close(id); });
      } else if (frame[0] === 2) {
        const socket = streams.get(id);
        if (!socket) { close(id, 3); return; }
        if (socket.writableLength + frame.length > MAX_BUFFER) { close(id); return; }
        socket.write(frame.subarray(5), error => { if (error) close(id, 2, socket); else if (streams.get(id) === socket) credit(id); });
      } else if (frame[0] === 4 && frame.length === 6) {
        // v86 retains the per-stream callback until the server acknowledges
        // CLOSE, including when the guest initiated the close.
        close(id);
      } else { ws.close(1002, 'Unsupported Wisp frame'); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  return {
    relayUrl: `wisp://127.0.0.1:${port}${tokenPath}`,
    setGuestQueueSize(read) { guestQueueSize = read; },
    acknowledgeReceive(id, bytes) {
      const pending = inFlight.get(id);
      if (pending === undefined) return;
      if (pending <= bytes) inFlight.delete(id); else inFlight.set(id, pending - bytes);
    },
    async close() {
      if (stopped) return;
      stopped = true;
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
