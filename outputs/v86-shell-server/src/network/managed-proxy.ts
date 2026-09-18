import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net, { type Socket } from 'node:net';
import tls from 'node:tls';
import { Transform, pipeline } from 'node:stream';
import { createCertificateAuthority } from './certificates.js';
import { redactProxyValue, type ProxyConfig, type ProxyPolicy } from './proxy-policy.js';
import { isDeepStrictEqual } from 'node:util';

export interface ProxyEvent {
    timestamp: string;
    method: string;
    origin: string;
    path: string;
    status: number;
    decision: 'allowed' | 'denied' | 'error';
    reason: string;
    durationMs: number;
    credentialInjected: boolean;
}
export interface ProxyManagement {
    snapshot(): { enabled: true; policy: ProxyConfig; events: ProxyEvent[] };
    updatePolicy(config: unknown): void;
}
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const MAX_CONNECTIONS = 64;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
class ByteLimit extends Transform {
    private bytes = 0;
    constructor(private readonly limit: number) {
        super();
    }
    _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        this.bytes += chunk.length;
        if (this.bytes > this.limit) {
            callback(new Error('Stream size limit exceeded'));
            return;
        }
        this.push(chunk);
        callback();
    }
}
function cleanHeaders(input: IncomingHttpHeaders): IncomingHttpHeaders {
    const headers = { ...input };
    for (const name of (String(input.connection ?? '').split(',').map(value => value.trim().toLowerCase())))
        delete headers[name];
    for (const name of HOP_HEADERS)
        delete headers[name];
    return headers;
}
function authorityOrigin(authority: string, scheme: 'http:' | 'https:'): string {
    if (!authority || /[\s/@?#\\]/.test(authority))
        throw new Error('Invalid authority');
    const url = new URL(`${scheme}//${authority}`);
    if (url.pathname !== '/' || url.username || url.password)
        throw new Error('Invalid authority');
    return url.origin;
}
function deny(response: ServerResponse, status = 403) {
    if (response.headersSent) {
        response.destroy();
        return;
    }
    response.writeHead(status, { 'content-type': 'text/plain', 'connection': 'close' });
    response.end(status === 403 ? 'Request denied\n' : 'Upstream unavailable\n');
}
function rejectSocket(socket: Socket, status = 403) {
    socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
function repeatedSensitiveHeaders(request: IncomingMessage) {
    const seen = new Set<string>();
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i].toLowerCase();
        if (seen.has(name) && (name === 'host' || name === 'authorization' || name === 'proxy-authorization' || name === 'content-length' || name === 'transfer-encoding'))
            return true;
        seen.add(name);
    }
    return false;
}
function redactText(value: string, secrets: readonly string[]) {
    for (const secret of secrets) {
        if (secret) value = value.split(secret).join('[REDACTED]');
    }
    return value;
}
/** Holds only a suffix that could begin a secret, so ordinary SSE frames flush immediately. */
class SecretRedactor extends Transform {
    private pending = Buffer.alloc(0);
    private readonly secrets: Buffer[];
    constructor(secrets: readonly string[]) {
        super();
        this.secrets = [...new Set(secrets)].filter(Boolean)
            .sort((a, b) => b.length - a.length).map(value => Buffer.from(value));
    }
    _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        const data = Buffer.concat([this.pending, chunk]);
        let offset = 0;
        while (offset < data.length) {
            let match = -1, found: Buffer | undefined;
            for (const secret of this.secrets) {
                const position = data.indexOf(secret, offset);
                if (position >= 0 && (match < 0 || position < match)) {
                    match = position;
                    found = secret;
                }
            }
            if (match < 0)
                break;
            if (match > offset)
                this.push(data.subarray(offset, match));
            this.push(Buffer.from('[REDACTED]'));
            offset = match + found!.length;
        }
        let hold = 0;
        for (const secret of this.secrets)
            for (let length = Math.min(secret.length - 1, data.length - offset); length > hold; length--)
                if (data.subarray(data.length - length).equals(secret.subarray(0, length))) {
                    hold = length;
                    break;
                }
        if (data.length - hold > offset)
            this.push(data.subarray(offset, data.length - hold));
        this.pending = Buffer.from(data.subarray(data.length - hold));
        callback();
    }
    _flush(callback: () => void) {
        if (this.pending.length) this.push(this.pending);
        this.pending = Buffer.alloc(0);
        callback();
    }
}
export async function startManagedProxy(policy: ProxyPolicy, options: {
    upstreamCa?: string;
} = {}) {
    const ca = createCertificateAuthority();
    const sockets = new Set<Socket>();
    const connections = new Set<Socket>();
    const outgoing = new Set<http.ClientRequest>();
    const tunnelOrigins = new WeakMap<Socket, string>();
    let closing = false;
    let activeRequests = 0;
    let generation = 0;
    const events: ProxyEvent[] = [];
    const knownSecrets = new Set(policy.secretValues());
    const pendingEvents = new Set<() => void>();
    const record = (requestPolicy: ProxyPolicy, start: number, method: string, url: URL | undefined,
        status: number, decision: ProxyEvent['decision'], reason: string, injected = false) => {
        const secrets = [...new Set([...knownSecrets, ...requestPolicy.secretValues()])];
        const event: ProxyEvent = {
            timestamp: new Date().toISOString(),
            // Redact before shortening: a long secret must not leak its prefix.
            method: redactProxyValue(method, secrets).slice(0, 32),
            origin: redactProxyValue(url?.origin ?? '', secrets).slice(0, 512),
            path: redactProxyValue(url?.pathname ?? '', secrets).slice(0, 2048),
            status, decision, reason,
            durationMs: Math.max(0, Math.round(performance.now() - start)),
            credentialInjected: injected,
        };
        events.push(redactProxyValue(event, secrets));
        if (events.length > 500) events.shift();
    };
    const revokeConnections = () => {
        generation++;
        for (const finish of pendingEvents) finish();
        for (const request of outgoing) request.destroy();
        for (const socket of sockets) socket.destroy();
    };
    const track = (socket: Socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        socket.setTimeout(120_000, () => socket.destroy());
    };
    const handle = async (request: IncomingMessage, response: ServerResponse) => {
        const requestPolicy = policy;
        const requestGeneration = generation;
        const secrets = [...knownSecrets];
        const start = performance.now();
        const method = request.method ?? 'GET';
        let url: URL | undefined;
        let status = 502;
        let decision: ProxyEvent['decision'] = 'error';
        let reason = 'upstream_or_transport_error';
        let injected = false;
        let recorded = false;
        let counted = false;
        let upstream: http.ClientRequest | undefined;
        let deadline: NodeJS.Timeout | undefined;
        const finish = () => {
            if (recorded) return;
            recorded = true;
            pendingEvents.delete(revoked);
            record(requestPolicy, start, method, url, status, decision, reason, injected);
        };
        const revoked = () => { status = 503; decision = 'error'; reason = 'proxy_closed_or_policy_updated'; finish(); };
        pendingEvents.add(revoked);
        response.once('finish', finish);
        response.once('close', () => {
            finish();
            if (counted) activeRequests--;
            clearTimeout(deadline);
            upstream?.destroy();
        });
        const fail = (code = 403, failureReason = code === 403 ? 'policy_denied' : 'upstream_or_transport_error') => {
            status = code;
            decision = code === 403 ? 'denied' : 'error';
            reason = failureReason;
            deny(response, code);
        };
        if (closing || activeRequests >= MAX_CONNECTIONS) return fail(503, 'connection_limit');
        activeRequests++;
        counted = true;
        deadline = setTimeout(() => {
            status = 504; decision = 'error'; reason = 'timeout';
            upstream?.destroy();
            response.destroy();
        }, 300_000);
        deadline.unref();
        try {
            if (closing || repeatedSensitiveHeaders(request))
                return fail();
            if (Number(request.headers['content-length'] ?? 0) > MAX_REQUEST_BYTES)
                return fail(413, 'request_too_large');
            const tunnelOrigin = tunnelOrigins.get(request.socket);
            if (tunnelOrigin) {
                if (authorityOrigin(String(request.headers.host ?? ''), 'https:') !== tunnelOrigin)
                    return fail();
                url = request.url?.startsWith('/') ? new URL(request.url, tunnelOrigin) : new URL(request.url ?? '');
                if (url.origin !== tunnelOrigin || url.protocol !== 'https:')
                    return fail();
            }
            else {
                url = new URL(request.url ?? '');
                if (url.protocol !== 'http:' || authorityOrigin(String(request.headers.host ?? ''), 'http:') !== url.origin)
                    return fail();
            }
            if (url.username || url.password || url.hash)
                return fail();
            const authorized = requestPolicy.authorize(url, method, cleanHeaders(request.headers));
            let resolveTimer: NodeJS.Timeout | undefined;
            const timeout = new Promise<never>((_resolve, reject) => {
                resolveTimer = setTimeout(() => reject(new Error('Resolution timed out')), 10_000);
                resolveTimer.unref();
            });
            const address = await Promise.race([requestPolicy.resolve(url, authorized.rule), timeout])
                .finally(() => clearTimeout(resolveTimer));
            if (request.destroyed || response.destroyed || closing || requestGeneration !== generation)
                return;
            injected = Boolean(authorized.rule.credential);
            const headers = cleanHeaders(authorized.headers as IncomingHttpHeaders);
            headers.host = url.host;
            headers['accept-encoding'] = 'identity';
            headers.connection = 'close';
            const transport = url.protocol === 'https:' ? https : http;
            const hostname = url.hostname.replace(/^\[|\]$/g, '');
            upstream = transport.request({
                protocol: url.protocol,
                hostname: address.address,
                family: address.family,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: request.method,
                headers,
                agent: false,
                ...(url.protocol === 'https:' ? {
                    servername: net.isIP(hostname) ? undefined : hostname,
                    checkServerIdentity: (_host: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(hostname, cert),
                    rejectUnauthorized: true,
                    ca: options.upstreamCa,
                } : {}),
            }, upstreamResponse => {
                if (response.destroyed) {
                    upstreamResponse.destroy();
                    return;
                }
                if (upstreamResponse.statusCode === 101 || (upstreamResponse.headers['content-encoding'] && upstreamResponse.headers['content-encoding'] !== 'identity')) {
                    upstreamResponse.destroy();
                    fail(502, 'upstream_response_not_supported');
                    return;
                }
                const outgoingHeaders = cleanHeaders(upstreamResponse.headers);
                if (Object.keys(outgoingHeaders).some(name => secrets.some(secret => name.includes(secret)))) {
                    upstreamResponse.destroy();
                    fail(502, 'upstream_response_not_supported');
                    return;
                }
                for (const name of ['content-length', 'content-md5', 'digest', 'etag'])
                    delete outgoingHeaders[name];
                for (const [name, value] of Object.entries(outgoingHeaders))
                    if (value !== undefined)
                        outgoingHeaders[name] = Array.isArray(value) ? value.map(item => redactText(item, secrets)) : redactText(String(value), secrets);
                status = upstreamResponse.statusCode ?? 502;
                // The finish listener runs before pipeline's callback, so only
                // a complete response is classified as allowed.
                response.prependOnceListener('finish', () => { decision = 'allowed'; reason = 'completed'; });
                response.writeHead(status, outgoingHeaders);
                pipeline(upstreamResponse, new ByteLimit(MAX_RESPONSE_BYTES), new SecretRedactor(secrets), response, () => { });
            });
            outgoing.add(upstream);
            upstream.once('close', () => outgoing.delete(upstream!));
            upstream.setTimeout(120000, () => upstream!.destroy());
            upstream.on('error', () => fail(502));
            upstream.on('upgrade', (_res, socket) => { socket.destroy(); fail(502, 'upstream_upgrade_not_supported'); });
            request.once('aborted', () => upstream!.destroy());
            pipeline(request, new ByteLimit(MAX_REQUEST_BYTES), upstream, () => { });
        }
        catch {
            upstream?.destroy();
            if (requestGeneration !== generation) return;
            fail();
        }
    };
    const server = http.createServer({ maxHeaderSize: 32768 }, (req, res) => { void handle(req, res); });
    const inner = http.createServer({ maxHeaderSize: 32768 }, (req, res) => { void handle(req, res); });
    for (const instance of [server, inner]) {
        instance.headersTimeout = 10000;
        instance.requestTimeout = 120000;
        instance.keepAliveTimeout = 1000;
        instance.on('upgrade', (request, socket) => {
            let url: URL | undefined;
            try { url = new URL(request.url ?? '', tunnelOrigins.get(socket as Socket)); } catch { /* no raw URL in events */ }
            record(policy, performance.now(), request.method ?? '', url, 403, 'denied', 'policy_denied');
            rejectSocket(socket as Socket);
        });
        instance.on('clientError', (_error, socket) => {
            record(policy, performance.now(), '', undefined, 400, 'error', 'invalid_http');
            rejectSocket(socket as Socket);
        });
    }
    server.on('connection', socket => {
        if (closing || connections.size >= MAX_CONNECTIONS) {
            socket.destroy();
            return;
        }
        connections.add(socket);
        socket.once('close', () => connections.delete(socket));
        track(socket);
    });
    server.on('connect', (request, socket, head) => {
        const requestPolicy = policy;
        const start = performance.now();
        let url: URL | undefined;
        const reject = () => {
            record(requestPolicy, start, 'CONNECT', url, 403, 'denied', 'policy_denied');
            rejectSocket(socket as Socket);
        };
        try {
            const raw = socket as Socket;
            if (closing || repeatedSensitiveHeaders(request))
                return reject();
            const origin = authorityOrigin(request.url ?? '', 'https:');
            url = new URL(origin);
            if (!requestPolicy.origins.includes(origin) || (request.headers.host && authorityOrigin(request.headers.host, 'https:') !== origin))
                return reject();
            const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, '');
            const leaf = ca.issue(hostname);
            const context = tls.createSecureContext({ key: leaf.privateKey, cert: leaf.certificate });
            raw.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length)
                raw.unshift(head);
            const secure = new tls.TLSSocket(raw, {
                isServer: true,
                secureContext: context,
                ALPNProtocols: ['http/1.1'],
                SNICallback: (name, callback) => {
                    if (name.toLowerCase() !== hostname.toLowerCase()) callback(new Error('Request denied'));
                    else callback(null, context);
                },
            });
            track(secure);
            tunnelOrigins.set(secure, origin);
            inner.emit('connection', secure);
            secure.once('error', () => raw.destroy());
        }
        catch {
            reject();
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    return {
        port: (server.address() as net.AddressInfo).port,
        caCertificate: ca.certificate,
        snapshot(): ReturnType<ProxyManagement['snapshot']> {
            return {
                enabled: true,
                policy: redactProxyValue(policy.configuration?.() ?? { allow: policy.origins.map(origin => ({ origin })), guestEnv: { ...policy.guestEnv } }, [...knownSecrets]),
                // A newly configured secret may already appear in past paths.
                events: redactProxyValue(events, [...knownSecrets]),
            };
        },
        updatePolicy(config: unknown) {
            if (closing) throw new Error('Proxy is closed');
            if (!policy.replacement) throw new Error('Live updates require a compiled proxy policy');
            const replacement = policy.replacement(config);
            if (!isDeepStrictEqual(replacement.guestEnv, policy.guestEnv))
                throw new Error('Changing guestEnv requires restarting the server');
            // All validation completes before either policy or sockets change.
            policy = replacement;
            for (const secret of policy.secretValues()) knownSecrets.add(secret);
            ca.clearCache();
            revokeConnections();
        },
        async close() {
            if (closing) return;
            closing = true;
            revokeConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
            inner.close();
        },
    };
}
