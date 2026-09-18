import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { startManagedProxy } from '../src/network/managed-proxy.js';
import { createCertificateAuthority } from '../src/network/certificates.js';
import { compileProxyPolicy } from '../src/network/proxy-policy.js';
const SECRET = 'host-only-test-secret-48b';
const PLACEHOLDER = 'guest-placeholder';
async function fixture(t: test.TestContext, trustUpstream = true, hostname = 'upstream.test') {
    const ca = createCertificateAuthority();
    const leaf = ca.issue(hostname);
    const requests: Array<{
        url?: string;
        authorization?: string;
    }> = [];
    let finishStream = () => { };
    const upstreamClosed = Promise.withResolvers<void>();
    const upstream = https.createServer({ key: leaf.privateKey, cert: leaf.certificate }, (req, res) => {
        requests.push({ url: req.url, authorization: req.headers.authorization });
        if (req.url === '/stream') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: first\n\n');
            finishStream = () => res.end('data: second\n\n');
            res.once('close', () => upstreamClosed.resolve());
        }
        else if (req.url === '/upload') {
            req.pipe(res);
        }
        else if (req.url === '/echo') {
            res.setHeader('x-echo', SECRET);
            res.write(SECRET.slice(0, 10));
            setTimeout(() => res.end(SECRET.slice(10)), 10);
        }
        else if (req.url === '/compressed') {
            res.setHeader('content-encoding', 'gzip');
            res.end(SECRET);
        }
        else if (req.url === '/redirect') {
            res.writeHead(302, { location: 'https://forbidden.test/' });
            res.end();
        }
        else
            res.end('ok');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const port = (upstream.address() as net.AddressInfo).port;
    let resolutions = 0;
    const origin = `https://${net.isIP(hostname) === 6 ? '[' + hostname + ']' : hostname}:${port}`;
    const rule = { origin };
    const policy = {
        origins: [origin], guestEnv: {}, secretValues: () => [SECRET],
        authorize(url: URL, method: string, headers: http.IncomingHttpHeaders) {
            if (url.origin !== origin || headers.authorization !== `Bearer ${PLACEHOLDER}`)
                throw Object.assign(new Error('Request denied'), { statusCode: 403 });
            return { rule, headers: { ...headers, authorization: `Bearer ${SECRET}` } };
        },
        async resolve() {
            resolutions++;
            return { address: '127.0.0.1', family: 4 as const };
        },
    };
    const proxy = await startManagedProxy(policy, trustUpstream ? { upstreamCa: ca.certificate } : {});
    t.after(async () => {
        await proxy.close();
        upstream.closeAllConnections();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
    });
    return { proxy, origin, requests, resolutions: () => resolutions, finishStream: () => finishStream(), upstreamClosed: upstreamClosed.promise };
}
async function tunnel(proxy: {
    port: number;
    caCertificate: string;
}, origin: string, servername?: string) {
    const socket = net.connect(proxy.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(`CONNECT ${new URL(origin).host} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\n\r\n`);
    const response = await new Promise<string>((resolve, reject) => { socket.once('error', reject); socket.once('data', data => resolve(data.toString())); });
    assert.match(response, /^HTTP\/1.1 200/);
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    const secure = tls.connect({ socket, servername: servername ?? (net.isIP(hostname) ? undefined : hostname), checkServerIdentity: (_host, cert) => tls.checkServerIdentity(hostname, cert), ca: proxy.caCertificate, ALPNProtocols: ['http/1.1'] });
    await once(secure, 'secureConnect');
    return secure;
}
async function request(proxy: {
    port: number;
    caCertificate: string;
}, origin: string, path = '/', headers: Record<string, string> = {}, onData?: (data: Buffer) => void) {
    const socket = await tunnel(proxy, origin);
    const agent = new http.Agent();
    agent.createConnection = () => socket;
    return await new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
        body: string;
    }>((resolve, reject) => {
        const req = http.request({ method: 'GET', path, host: 'upstream.test', agent, headers: { host: new URL(origin).host, authorization: `Bearer ${PLACEHOLDER}`, ...headers } }, res => {
            const chunks: Buffer[] = [];
            res.on('data', data => { chunks.push(data); onData?.(data); });
            res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}
test('HTTPS proxy replaces exact placeholder and validates upstream CA', async (t) => {
    const f = await fixture(t);
    const response = await request(f.proxy, f.origin);
    assert.equal(response.status, 200);
    assert.equal(response.body, 'ok');
    assert.equal(f.requests[0].authorization, `Bearer ${SECRET}`);
});
test('unauthorized inner token and different Host never reach upstream', async (t) => {
    const f = await fixture(t);
    assert.equal((await request(f.proxy, f.origin, '/', { authorization: 'Bearer wrong' })).status, 403);
    assert.equal((await request(f.proxy, f.origin, '/', { host: 'forbidden.test' })).status, 403);
    assert.equal(f.resolutions(), 0);
    assert.equal(f.requests.length, 0);
});
test('unauthorized CONNECT is rejected before DNS or upstream connections', async (t) => {
    const f = await fixture(t);
    const socket = net.connect(f.proxy.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('CONNECT forbidden.test:443 HTTP/1.1\r\nHost: forbidden.test:443\r\n\r\n');
    const [data] = await once(socket, 'data');
    assert.match(data.toString(), /^HTTP\/1.1 403/);
    socket.destroy();
    assert.equal(f.resolutions(), 0);
});
test('mismatched TLS SNI fails closed', async (t) => {
    const f = await fixture(t);
    await assert.rejects(tunnel(f.proxy, f.origin, 'forbidden.test'));
    assert.equal(f.resolutions(), 0);
});
test('response headers and literal secret split across chunks are redacted', async (t) => {
    const f = await fixture(t);
    const response = await request(f.proxy, f.origin, '/echo');
    assert.equal(response.headers['x-echo'], '[REDACTED]');
    assert.equal(response.body, '[REDACTED]');
});
test('SSE response arrives before upstream finishes, redirects are not followed', async (t) => {
    const f = await fixture(t);
    let receivedFirst = false, finished = false;
    const first = Promise.withResolvers<void>();
    const timer = setTimeout(() => first.reject(new Error('First SSE frame was buffered')), 2000);
    const promise = request(f.proxy, f.origin, '/stream', {}, data => { if (data.includes('first')) {
        receivedFirst = true;
        first.resolve();
    } }).then(result => { finished = true; return result; });
    await first.promise.finally(() => clearTimeout(timer));
    assert.equal(receivedFirst, true);
    assert.equal(finished, false);
    f.finishStream();
    assert.match((await promise).body, /second/);
    const redirect = await request(f.proxy, f.origin, '/redirect');
    assert.equal(redirect.status, 302);
    assert.equal(f.requests.length, 2);
});
test('upstream certificate verification fails closed and compressed responses are rejected', async (t) => {
    const untrusted = await fixture(t, false);
    assert.equal((await request(untrusted.proxy, untrusted.origin)).status, 502);
    assert.equal(untrusted.requests.length, 0);
    const trusted = await fixture(t);
    const compressed = await request(trusted.proxy, trusted.origin, '/compressed');
    assert.equal(compressed.status, 502);
    assert.equal(compressed.body.includes(SECRET), false);
});
test('duplicate authorization and upgrade requests are rejected before resolution', async (t) => {
    const f = await fixture(t);
    for (const extra of [`Authorization: Bearer ${PLACEHOLDER}\r\nAuthorization: Bearer wrong`, `Authorization: Bearer ${PLACEHOLDER}\r\nConnection: upgrade\r\nUpgrade: websocket`]) {
        const socket = await tunnel(f.proxy, f.origin);
        socket.write(`GET / HTTP/1.1\r\nHost: ${new URL(f.origin).host}\r\n${extra}\r\n\r\n`);
        const [data] = await once(socket, 'data');
        assert.match(data.toString(), /^HTTP\/1.1 403/);
        socket.destroy();
    }
    assert.equal(f.resolutions(), 0);
});
test('plain HTTP uses exact allowlist and strips proxy credentials and hop headers', async (t) => {
    let headers: http.IncomingHttpHeaders | undefined;
    const upstream = http.createServer((req, res) => { headers = req.headers; res.end('public'); });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const origin = `http://upstream.test:${(upstream.address() as net.AddressInfo).port}`;
    const policy = compileProxyPolicy({ allow: [{ origin, allowCidrs: ['127.0.0.1/32'] }] }, {}, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
    const proxy = await startManagedProxy(policy);
    t.after(async () => { await proxy.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
    const response = await new Promise<{
        status: number;
        body: string;
    }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: proxy.port, path: origin + '/public', headers: { host: new URL(origin).host, 'proxy-authorization': 'Basic hidden', 'proxy-connection': 'keep-alive', connection: 'x-hop', 'x-hop': 'hidden' } }, res => {
            let body = '';
            res.on('data', data => body += data);
            res.on('end', () => resolve({ status: res.statusCode!, body }));
        });
        req.on('error', reject);
        req.end();
    });
    assert.equal(response.status, 200);
    assert.equal(response.body, 'public');
    assert.equal(headers?.['proxy-authorization'], undefined);
    assert.equal(headers?.['proxy-connection'], undefined);
    assert.equal(headers?.['x-hop'], undefined);
});
test('HTTPS IPv6 literal authority receives an IP certificate and correct upstream verification', async (t) => {
    const f = await fixture(t, true, '::1');
    assert.equal((await request(f.proxy, f.origin)).status, 200);
});
test('oversized request is rejected before resolving or connecting upstream', {timeout: 3000}, async (t) => {
    const f = await fixture(t);
    const result = await request(f.proxy, f.origin, '/', { 'content-length': String(16 * 1024 * 1024 + 1) });
    assert.equal(result.status, 413);
    assert.equal(f.resolutions(), 0);
});

test('client disconnect closes the upstream response', {timeout: 3000}, async (t) => {
    const f = await fixture(t);
    const socket = await tunnel(f.proxy, f.origin);
    socket.write(`GET /stream HTTP/1.1\r\nHost: ${new URL(f.origin).host}\r\nAuthorization: Bearer ${PLACEHOLDER}\r\n\r\n`);
    const [data] = await once(socket, 'data');
    assert.match(data.toString(), /first/);
    socket.destroy();
    await f.upstreamClosed;
});

test('POST request body is streamed through the TLS proxy unchanged', {timeout: 3000}, async (t) => {
    const f = await fixture(t);
    const socket = await tunnel(f.proxy, f.origin);
    const agent = new http.Agent();
    agent.createConnection = () => socket;
    const payload = Buffer.from(Array.from({length: 80_000}, (_, index) => index % 256));
    const response = await new Promise<Buffer>((resolve, reject) => {
        const req = http.request({method: 'POST', path: '/upload', host: 'upstream.test', agent,
            headers: {host: new URL(f.origin).host, authorization: `Bearer ${PLACEHOLDER}`}}, res => {
            const chunks: Buffer[] = [];
            res.on('data', data => chunks.push(data));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.write(payload.subarray(0, 40_000));
        setTimeout(() => req.end(payload.subarray(40_000)), 20);
    });
    assert.deepEqual(response, payload);
});
