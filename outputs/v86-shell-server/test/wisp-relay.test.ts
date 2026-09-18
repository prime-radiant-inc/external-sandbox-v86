import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startProxyRelay, GUEST_PROXY_IP, GUEST_PROXY_PORT } from '../src/network/wisp-relay.js';

function connectFrame(id: number, hostname: string, port: number, protocol = 1) {
  const frame = Buffer.alloc(8 + Buffer.byteLength(hostname));
  frame[0] = 1; frame.writeUInt32LE(id, 1); frame[5] = protocol; frame.writeUInt16LE(port, 6); frame.write(hostname, 8);
  return frame;
}
function dataFrame(id: number, data: string) {
  const frame = Buffer.alloc(5 + Buffer.byteLength(data)); frame[0] = 2; frame.writeUInt32LE(id, 1); frame.write(data, 5); return frame;
}
function messages(ws: WebSocket) {
  const queue: Buffer[] = []; let pending: ((data: Buffer) => void) | undefined;
  ws.on('message', data => { const frame = Buffer.from(data as Buffer); if (pending) { const done = pending; pending = undefined; done(frame); } else queue.push(frame); });
  return async function next(type?: number): Promise<Buffer> {
    for (;;) {
      const frame = queue.shift() ?? await new Promise<Buffer>(resolve => { pending = resolve; });
      if (type === undefined || frame[0] === type) return frame;
    }
  };
}
async function fixture(t: TestContext) {
  let connections = 0;
  const target = net.createServer(socket => { connections++; socket.pipe(socket); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const relay = await startProxyRelay({ proxyPort: (target.address() as net.AddressInfo).port });
  t.after(async () => { await relay.close(); await new Promise<void>(resolve => target.close(() => resolve())); });
  const ws = new WebSocket(relay.relayUrl.replace('wisp:', 'ws:'));
  const next = messages(ws); await once(ws, 'open');
  const initial = await next(); assert.equal(initial[0], 3); assert.equal(initial.readUInt32LE(1), 0); assert.ok(initial.readUInt32LE(5) > 0);
  return { relay, ws, next, connections: () => connections };
}

test('Wisp relay carries only the fixed guest proxy endpoint', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.ws.send(connectFrame(1, GUEST_PROXY_IP, GUEST_PROXY_PORT));
  f.ws.send(dataFrame(1, 'GET http://allowed.example/ HTTP/1.1\r\n\r\n'));
  const response = await f.next(2);
  assert.equal(response.readUInt32LE(1), 1);
  assert.equal(response.subarray(5).toString(), 'GET http://allowed.example/ HTTP/1.1\r\n\r\n');
  assert.equal(f.connections(), 1);
});

test('Wisp relay rejects direct TCP, hostname targets, and UDP without dialing', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (const [host, port, protocol] of [ ['1.1.1.1', 443, 1], ['127.0.0.1', 8080, 1], [GUEST_PROXY_IP, 443, 1], ['api.openai.com', 443, 1], [GUEST_PROXY_IP, GUEST_PROXY_PORT, 2] ] as const) {
    f.ws.send(connectFrame(1, host, port, protocol));
    const response = await f.next(4); assert.equal(response.readUInt32LE(1), 1);
  }
  assert.equal(f.connections(), 0);
});

test('Wisp relay acknowledges guest close and permits a fresh stream', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.ws.send(connectFrame(1, GUEST_PROXY_IP, GUEST_PROXY_PORT));
  f.ws.send(dataFrame(1, 'first')); await f.next(2);
  const close = Buffer.alloc(6); close[0] = 4; close.writeUInt32LE(1, 1); close[5] = 2;
  f.ws.send(close);
  const response = await f.next(4); assert.equal(response.readUInt32LE(1), 1);
  f.ws.send(connectFrame(1, GUEST_PROXY_IP, GUEST_PROXY_PORT));
  f.ws.send(dataFrame(1, 'second'));
  assert.equal((await f.next(2)).subarray(5).toString(), 'second');
  assert.equal(f.connections(), 2);
});

test('relay bounds in-flight receive bytes and resumes when guest credit returns', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let guestQueued = 128 * 1024, received = 0;
  f.relay.setGuestQueueSize(() => guestQueued);
  f.ws.on('message', raw => { const frame = Buffer.from(raw as Buffer); if (frame[0] === 2) received += frame.length - 5; });
  f.ws.send(connectFrame(1, GUEST_PROXY_IP, GUEST_PROXY_PORT));
  for (let index = 0; index < 5; index++) f.ws.send(dataFrame(1, 'x'.repeat(32 * 1024)));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(received, 0, 'a full guest queue must pause host reads');
  guestQueued = 0;
  for (let index = 0; index < 100 && received < 128 * 1024; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(received, 128 * 1024);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(received, 128 * 1024, 'in-flight WebSocket frames also consume receive credit');
  f.relay.acknowledgeReceive(1, received);
  for (let index = 0; index < 100 && received < 160 * 1024; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(received, 160 * 1024);
});

test('Wisp relay rejects malformed frames and cannot be used at an unguessable-path mismatch', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const closed = once(f.ws, 'close'); f.ws.send(Buffer.from([1, 2])); await closed;
  const bad = new WebSocket(f.relay.relayUrl.replace('wisp:', 'ws:').replace(/\/[^/]+$/, '/wrong'));
  bad.on('error', () => {});
  const [, response] = await once(bad, 'unexpected-response');
  assert.equal(response.statusCode, 403);
  bad.terminate();
});
