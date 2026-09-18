/**
 * Bounds host allocations in the pinned v86 0.5.458 Wisp adapter. Wisp v1 has no
 * receive-side flow control; websocket backpressure does not reach its guest TCP
 * buffers. Exceeding these limits stops the VM, rather than risking host OOM.
 */
const PER_STREAM = 2 * 1024 * 1024;
const TOTAL = 16 * 1024 * 1024;
const CONNECTIONS = 64;
const QUEUED_FRAMES = 4096;

interface Connection {
  stream_id?: number;
  send_buffer: { length: number; buffer: Uint8Array };
}
interface Adapter {
  tcp_conn: Record<string, Connection>;
  connections: Record<string, { congestion: number }>;
  congested_buffer: Array<{ data: Uint8Array; type: string }>;
  process_incoming_wisp_frame(frame: Uint8Array): void;
  on_tcp_connection(connection: Connection, packet: unknown): boolean;
  send_packet(frame: Uint8Array, type: string, id: number): void;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface V86NetworkGuard {
  /** Unacknowledged guest TCP bytes, for relay backpressure; Infinity after shutdown. */
  queuedBytes(streamId: number): number;
}

export function installV86NetworkGuard(value: unknown, onLimit: () => void,
  onDataDelivered?: (streamId: number, bytes: number) => void): V86NetworkGuard {
  const failLayout = () => { onLimit(); throw new Error('Unsupported v86 network adapter'); };
  if (!record(value) || !record(value.tcp_conn) || !record(value.connections)
    || !Array.isArray(value.congested_buffer) || typeof value.process_incoming_wisp_frame !== 'function'
    || typeof value.on_tcp_connection !== 'function' || typeof value.send_packet !== 'function') return failLayout();
  const adapter = value as unknown as Adapter;
  const incoming = adapter.process_incoming_wisp_frame;
  const connect = adapter.on_tcp_connection;
  const send = adapter.send_packet;
  const tracked = new Set<Connection>();
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; onLimit(); } };

  function snapshot() {
    if (!record(adapter.tcp_conn) || !record(adapter.connections) || !Array.isArray(adapter.congested_buffer)) throw new Error();
    const tcp = new Set(Object.values(adapter.tcp_conn));
    for (const conn of tracked) {
      if (!tcp.has(conn) && !adapter.connections[String(conn.stream_id)]) tracked.delete(conn);
    }
    for (const conn of tcp) tracked.add(conn);
    if (tracked.size > CONNECTIONS || adapter.congested_buffer.length > QUEUED_FRAMES) throw new Error();
    let allocated = 0;
    const streams = new Map<number, Connection>();
    for (const conn of tracked) {
      const buffer = conn?.send_buffer;
      if (!buffer || !(buffer.buffer instanceof Uint8Array) || !Number.isSafeInteger(buffer.length)
        || buffer.length < 0 || buffer.length > buffer.buffer.byteLength
        || buffer.buffer.byteLength < 1 || buffer.buffer.byteLength > PER_STREAM
        || !Number.isSafeInteger(conn.stream_id) || conn.stream_id! < 1 || streams.has(conn.stream_id!)) throw new Error();
      allocated += buffer.buffer.byteLength;
      streams.set(conn.stream_id!, conn);
    }
    const queued = new Map<number, number>();
    for (const item of adapter.congested_buffer) {
      if (!(item.data instanceof Uint8Array) || item.data.byteLength < 5) throw new Error();
      const id = new DataView(item.data.buffer, item.data.byteOffset, item.data.byteLength).getUint32(1, true);
      queued.set(id, (queued.get(id) ?? 0) + item.data.byteLength);
      if (queued.get(id)! > PER_STREAM) throw new Error();
      allocated += item.data.byteLength;
    }
    if (allocated > TOTAL) throw new Error();
    return { allocated, streams, queued };
  }

  adapter.process_incoming_wisp_frame = function(frame) {
    if (stopped) return;
    try {
      if (!(frame instanceof Uint8Array) || frame.byteLength < 5) throw new Error();
      if (frame[0] === 2) {
        const current = snapshot();
        const id = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, true);
        const conn = current.streams.get(id);
        if (!conn) throw new Error();
        const required = conn.send_buffer.length + frame.byteLength - 5;
        let capacity = conn.send_buffer.buffer.byteLength;
        if (required > PER_STREAM) throw new Error();
        while (capacity < required) capacity *= 2;
        if (capacity > PER_STREAM || current.allocated + capacity - conn.send_buffer.buffer.byteLength > TOTAL) throw new Error();
      }
      incoming.call(adapter, frame);
      if (!stopped && frame[0] === 2) {
        const id = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, true);
        onDataDelivered?.(id, frame.byteLength - 5);
      }
    } catch { stop(); }
  };

  adapter.on_tcp_connection = function(conn, packet) {
    if (stopped) return false;
    try {
      const current = snapshot();
      const capacity = conn?.send_buffer?.buffer?.byteLength;
      if (tracked.size >= CONNECTIONS || !capacity || capacity > PER_STREAM || current.allocated + capacity > TOTAL) throw new Error();
      const result = connect.call(adapter, conn, packet);
      tracked.add(conn);
      snapshot();
      return result;
    } catch { stop(); return false; }
  };

  adapter.send_packet = function(frame, type, id) {
    if (stopped) return;
    try {
      const current = snapshot();
      if (!(frame instanceof Uint8Array) || frame.byteLength < 5) throw new Error();
      const stream = adapter.connections[String(id)];
      if (stream && (!Number.isFinite(stream.congestion) || stream.congestion < 0)) throw new Error();
      if (stream?.congestion === 0 && (adapter.congested_buffer.length >= QUEUED_FRAMES
        || current.allocated + frame.byteLength > TOTAL || (current.queued.get(id) ?? 0) + frame.byteLength > PER_STREAM)) throw new Error();
      send.call(adapter, frame, type, id);
    } catch { stop(); }
  };
  return {
    queuedBytes(streamId: number) {
      if (stopped) return Infinity;
      try { return snapshot().streams.get(streamId)?.send_buffer.length ?? 0; }
      catch { stop(); return Infinity; }
    },
  };
}
