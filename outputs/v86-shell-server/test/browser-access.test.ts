import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import { checkUiAccess, rawHeaderValues, safeEqual, uiHeaders } from '../src/ui/browser-access.js';

function request(headers: string[], url = '/'): IncomingMessage {
  return { rawHeaders: headers, url, socket: {} } as IncomingMessage;
}

test('browser pages permit only loopback and exact same origin including port', () => {
  for (const host of ['127.0.0.1:8686', 'localhost:8686', '[::1]:8686']) {
    assert.doesNotThrow(() => checkUiAccess(request(['Host', host])));
    assert.doesNotThrow(() => checkUiAccess(request(['Host', host, 'Origin', `http://${host}`, 'Sec-Fetch-Site', 'same-origin'])));
  }
  for (const headers of [
    [], ['Host', 'evil.example'], ['Host', '127.0.0.1:0'], ['Host', 'localhost:65536'],
    ['Host', '127.0.0.1:8686', 'Origin', 'http://127.0.0.1:8687'],
    ['Host', '127.0.0.1:8686', 'Origin', 'null'],
    ['Host', 'localhost', 'Host', 'localhost'],
    ['Host', 'localhost', 'Origin', 'http://localhost', 'Origin', 'http://localhost'],
    ['Host', 'localhost', 'Sec-Fetch-Site', 'same-site'],
    ['Host', 'localhost', 'Sec-Fetch-Site', 'cross-site'],
    ['Host', 'localhost', 'Sec-Fetch-Site', 'none', 'Sec-Fetch-Site', 'none'],
  ]) assert.throws(() => checkUiAccess(request(headers)), { statusCode: 403 });
  assert.throws(() => checkUiAccess(request(['Host', 'localhost'], 'http://localhost/')), { statusCode: 400 });
});

test('shared browser helpers retain duplicate headers and emit restrictive headers', () => {
  assert.deepEqual(rawHeaderValues(request(['Origin', 'a', 'origin', 'b']), 'origin'), ['a', 'b']);
  assert.equal(safeEqual('token', 'token'), true);
  assert.equal(safeEqual('token', 'wrong'), false);
  assert.equal(safeEqual('token', ''), false);
  assert.equal(uiHeaders()['cache-control'], 'no-store');
  assert.equal(uiHeaders()['x-frame-options'], 'DENY');
  assert.equal(uiHeaders()['access-control-allow-origin'], undefined);
});
