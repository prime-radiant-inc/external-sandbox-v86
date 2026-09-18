import assert from 'node:assert/strict';
import test from 'node:test';
import { installV86NetworkGuard } from '../src/network/v86-network-guard.js';

const MIB = 1024 * 1024;
function connection(id: number, length = 0, allocated = 16) {
  return { stream_id: id, send_buffer: { length, buffer: new Uint8Array(allocated) } };
}
function data(id: number, bytes: number) {
  const frame = new Uint8Array(5 + bytes);
  frame[0] = 2; new DataView(frame.buffer).setUint32(1, id, true); return frame;
}
function fixture() {
  let received = 0, created = 0, stopped = 0;
  const delivered: Array<{ id: number; bytes: number; received: number }> = [];
  const adapter = {
    tcp_conn: {} as Record<string, ReturnType<typeof connection>>,
    connections: {} as Record<string, unknown>,
    congested_buffer: [] as Array<{ data: Uint8Array; type: string }>,
    send_packet(frame: Uint8Array, type: string, id: number) {
      const stream = this.connections[String(id)] as { congestion: number } | undefined;
      if (stream && stream.congestion <= 0) this.congested_buffer.push({ data: frame, type });
    },
    process_incoming_wisp_frame(_frame: Uint8Array) { received++; },
    on_tcp_connection(conn: ReturnType<typeof connection>, _packet: unknown) {
      created++; this.tcp_conn[`stream-${conn.stream_id}`] = conn;
      this.connections[String(conn.stream_id)] = { congestion: 128 }; return true;
    },
  };
  const guard = installV86NetworkGuard(adapter, () => { stopped++; }, (id, bytes) => {
    delivered.push({ id, bytes, received });
  });
  return { adapter, guard, delivered, stopped: () => stopped, received: () => received, created: () => created };
}

test('allows bounded Wisp DATA and ordinary control frames', () => {
  const f = fixture();
  f.adapter.on_tcp_connection(connection(1, 10), {});
  f.adapter.process_incoming_wisp_frame(data(1, 20));
  const credit = new Uint8Array(9); credit[0] = 3;
  f.adapter.process_incoming_wisp_frame(credit);
  assert.equal(f.stopped(), 0); assert.equal(f.received(), 2);
});

test('stops the VM before a slow guest can exceed the per-stream receive queue', () => {
  const f = fixture();
  f.adapter.on_tcp_connection(connection(1, 2 * MIB, 2 * MIB), {});
  f.adapter.process_incoming_wisp_frame(data(1, 1));
  f.adapter.process_incoming_wisp_frame(data(1, 1));
  assert.equal(f.stopped(), 1); assert.equal(f.received(), 0);
});

test('includes retained allocation of drained and closing connections in the VM-wide budget', () => {
  const f = fixture();
  for (let i = 1; i <= 8; i++) f.adapter.on_tcp_connection(connection(i, 0, 2 * MIB), {});
  // All logical queues have drained, but their backing allocations remain live.
  f.adapter.on_tcp_connection(connection(9, 0, 16), {});
  assert.equal(f.stopped(), 1); assert.equal(f.created(), 8);
});

test('predicts ring-buffer growth before aggregate allocation exceeds the budget', () => {
  const f = fixture();
  for (let i = 1; i <= 7; i++) f.adapter.on_tcp_connection(connection(i, 0, 2 * MIB), {});
  f.adapter.on_tcp_connection(connection(8, MIB, MIB), {});
  f.adapter.on_tcp_connection(connection(9, 0, 16), {});
  f.adapter.process_incoming_wisp_frame(data(8, 1));
  assert.equal(f.stopped(), 1); assert.equal(f.received(), 0);
});

test('limits guest TCP connection creation including connections awaiting a close acknowledgement', () => {
  const f = fixture();
  for (let i = 1; i <= 64; i++) f.adapter.on_tcp_connection(connection(i), {});
  f.adapter.on_tcp_connection(connection(65), {});
  assert.equal(f.stopped(), 1); assert.equal(f.created(), 64);
});

test('fails closed when the pinned v86 adapter layout is missing or changes', () => {
  let stopped = 0;
  assert.throws(() => installV86NetworkGuard({}, () => { stopped++; }), /Unsupported v86 network adapter/);
  assert.equal(stopped, 1);
  const f = fixture();
  f.adapter.on_tcp_connection(connection(1), {});
  (f.adapter.tcp_conn['stream-1'].send_buffer as any).buffer = null;
  f.adapter.process_incoming_wisp_frame(data(1, 1));
  assert.equal(f.stopped(), 1); assert.equal(f.received(), 0);
});

test('does not permit orphaned Wisp callbacks to hide live receive buffers', () => {
  const f = fixture();
  f.adapter.connections['1'] = {};
  f.adapter.process_incoming_wisp_frame(data(1, 1));
  assert.equal(f.stopped(), 1); assert.equal(f.received(), 0);
});

test('bounds guest-to-host frames while upstream credits are stalled', () => {
  const f = fixture();
  f.adapter.on_tcp_connection(connection(1), {});
  f.adapter.connections['1'] = { congestion: 0 };
  f.adapter.send_packet(data(1, MIB), 'DATA', 1);
  f.adapter.send_packet(data(1, MIB), 'DATA', 1);
  assert.equal(f.stopped(), 1); assert.equal(f.adapter.congested_buffer.length, 1);
});

test('retains callbacks removed from the TCP table in allocation and connection accounting', () => {
  const f = fixture();
  for (let i = 1; i <= 8; i++) {
    f.adapter.on_tcp_connection(connection(i, 0, 2 * MIB), {});
    delete f.adapter.tcp_conn[`stream-${i}`];
  }
  f.adapter.on_tcp_connection(connection(9), {});
  assert.equal(f.stopped(), 1); assert.equal(f.created(), 8);
});

test('releases accounting after both the TCP state and Wisp callbacks disappear', () => {
  const f = fixture();
  for (let i = 1; i <= 100; i++) {
    f.adapter.on_tcp_connection(connection(i, 0, 2 * MIB), {});
    delete f.adapter.tcp_conn[`stream-${i}`];
    delete f.adapter.connections[String(i)];
  }
  assert.equal(f.stopped(), 0); assert.equal(f.created(), 100);
});

test('reports current unread guest bytes and acknowledges DATA only after delivery', () => {
  const f = fixture();
  f.adapter.on_tcp_connection(connection(1, 10, 32), {});
  assert.equal(f.guard.queuedBytes(1), 10);
  assert.equal(f.guard.queuedBytes(999), 0);
  f.adapter.process_incoming_wisp_frame(data(1, 20));
  assert.deepEqual(f.delivered, [{ id: 1, bytes: 20, received: 1 }]);
  f.adapter.tcp_conn['stream-1'].send_buffer.length = 3;
  assert.equal(f.guard.queuedBytes(1), 3);
  delete f.adapter.tcp_conn['stream-1'];
  delete f.adapter.connections['1'];
  assert.equal(f.guard.queuedBytes(1), 0);
});

test('stopped guard pauses relay reads and never acknowledges rejected DATA', () => {
  const f = fixture();
  f.adapter.on_tcp_connection(connection(1, 2 * MIB, 2 * MIB), {});
  f.adapter.process_incoming_wisp_frame(data(1, 1));
  assert.equal(f.guard.queuedBytes(1), Infinity);
  assert.equal(f.guard.queuedBytes(999), Infinity);
  assert.deepEqual(f.delivered, []);
});
