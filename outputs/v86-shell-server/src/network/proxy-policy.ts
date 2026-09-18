import { lookup as dnsLookup } from 'node:dns/promises';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';

export interface ProxyCredential {
  header: string;
  placeholder: string;
  secretEnv: string;
  prefix?: string;
}

export interface ProxyRule {
  origin: string;
  methods?: readonly string[];
  paths?: readonly string[];
  allowCidrs?: readonly string[];
  credential?: Readonly<ProxyCredential>;
}

export interface ProxyConfig {
  allow: readonly ProxyRule[];
  guestEnv?: Record<string, string>;
}

export interface ProxyAddress { address: string; family: 4 | 6 }

export interface ProxyPolicyOptions {
  /** Injection point for offline tests; production resolves all addresses once per request. */
  lookup?: (hostname: string) => Promise<ProxyAddress[]>;
}

export interface ProxyPolicy {
  readonly origins: readonly string[];
  readonly guestEnv: Record<string, string>;
  authorize(url: URL, method: string, headers: IncomingHttpHeaders): { headers: OutgoingHttpHeaders; rule: ProxyRule };
  /** Returns an approved address that the caller must pin for the upstream connection. */
  resolve(url: URL, rule: ProxyRule): Promise<ProxyAddress>;
  /** Host-only, non-enumerable accessor for best-effort literal response redaction. */
  secretValues(): readonly string[];
}

export class ProxyPolicyError extends Error {
  readonly statusCode = 403;
  constructor() { super('Proxy policy denied request'); this.name = 'ProxyPolicyError'; }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\x20-\x7e]*$/;
const MAX_VALUE_BYTES = 16 * 1024;
const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'trailer',
  'te', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
]);

function invalid(): never { throw new Error('Invalid proxy configuration'); }
function deny(): never { throw new ProxyPolicyError(); }

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) invalid();
  return result;
}

function text(value: unknown, nonempty = true): string {
  if (typeof value !== 'string' || (nonempty && !value) || Buffer.byteLength(value) > MAX_VALUE_BYTES
    || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}

function list(value: unknown, validate: (item: unknown) => string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) invalid();
  const items = value.map(validate);
  if (new Set(items).size !== items.length) invalid();
  return Object.freeze(items);
}

function origin(value: unknown): string {
  const input = text(value);
  let url: URL;
  try { url = new URL(input); } catch { return invalid(); }
  // Requiring a canonical origin avoids URL parser conveniences such as 127.1,
  // hexadecimal IPs, credentials, escaped hostnames, and silently removed controls.
  if (!['http:', 'https:'].includes(url.protocol) || input !== url.origin || url.port === '0') invalid();
  const hostname = url.hostname;
  if (hostname.startsWith('[')) {
    if (!isIP(hostname.slice(1, -1)) || hostname.includes('%')) invalid();
  } else if (!isIP(hostname)) {
    if (hostname.length > 253 || hostname.split('.').some(label =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) invalid();
  }
  return url.origin;
}

interface NumericAddress extends ProxyAddress { value: bigint }
interface Network { family: 4 | 6; value: bigint; shift: bigint }

function address(input: string): NumericAddress | undefined {
  const family = isIP(input);
  if (!family || input.includes('%')) return undefined;
  if (family === 4) {
    const octets = input.split('.').map(Number);
    return { address: octets.join('.'), family: 4,
      value: octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n) };
  }
  let source = input.toLowerCase();
  if (source.includes('.')) {
    const separator = source.lastIndexOf(':');
    const tail = address(source.slice(separator + 1));
    if (!tail || tail.family !== 4) return undefined;
    source = `${source.slice(0, separator)}:${(tail.value >> 16n).toString(16)}:${(tail.value & 0xffffn).toString(16)}`;
  }
  const halves = source.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const value = parts.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n);
  // IPv4-mapped IPv6 must use the IPv4 policy, regardless of textual spelling.
  if (value >> 32n === 0xffffn) {
    const ipv4 = value & 0xffffffffn;
    return { address: [24n, 16n, 8n, 0n].map(bits => Number((ipv4 >> bits) & 255n)).join('.'), family: 4, value: ipv4 };
  }
  return { address: source, family: 6, value };
}

function network(input: string): Network {
  const match = /^([^/]+)\/(0|[1-9][0-9]*)$/.exec(input);
  if (!match) return invalid();
  const parsed = address(match[1]);
  if (!parsed) return invalid();
  let prefix = Number(match[2]);
  const originalFamily = isIP(match[1]);
  if (prefix > (originalFamily === 4 ? 32 : 128)) return invalid();
  if (originalFamily === 6 && parsed.family === 4) {
    if (prefix < 96) return invalid();
    prefix -= 96;
  }
  const shift = BigInt((parsed.family === 4 ? 32 : 128) - prefix);
  return { family: parsed.family, value: parsed.value >> shift, shift };
}

function contains(range: Network, target: NumericAddress): boolean {
  return range.family === target.family && target.value >> range.shift === range.value;
}

// Conservative public destination policy: special-purpose and transition ranges
// require explicit allowCidrs, even where individual exceptions may be routable.
const NONPUBLIC_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
].map(network);
const GLOBAL_V6 = network('2000::/3');
const NONPUBLIC_V6 = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].map(network);

function isPublic(target: NumericAddress): boolean {
  return target.family === 4
    ? !NONPUBLIC_V4.some(range => contains(range, target))
    : contains(GLOBAL_V6, target) && !NONPUBLIC_V6.some(range => contains(range, target));
}

interface CompiledRule {
  rule: ProxyRule;
  ranges?: Network[];
  credentialValue?: string;
}

export function compileProxyPolicy(config: unknown, secrets: Record<string, string | undefined> = process.env,
  options: ProxyPolicyOptions = {}): ProxyPolicy {
  const root = object(config, ['allow', 'guestEnv']);
  if (!Array.isArray(root.allow) || root.allow.length > 64) return invalid();
  const compiled = new Map<string, CompiledRule>();
  const secretValues = new Set<string>();
  for (const value of root.allow) {
    const input = object(value, ['origin', 'methods', 'paths', 'allowCidrs', 'credential']);
    const rule: ProxyRule = { origin: origin(input.origin) };
    if (compiled.has(rule.origin)) invalid();
    rule.methods = list(input.methods, item => {
      const method = text(item);
      if (!/^[A-Z]+$/.test(method)) invalid();
      return method;
    });
    rule.paths = list(input.paths, item => {
      const path = text(item);
      if (!path.startsWith('/') || path.startsWith('//') || /[?#]/.test(path)
        || new URL(path, 'https://policy.invalid').pathname !== path) invalid();
      return path;
    });
    rule.allowCidrs = list(input.allowCidrs, item => { const cidr = text(item); network(cidr); return cidr; });
    let credentialValue: string | undefined;
    if (input.credential !== undefined) {
      const inputCredential = object(input.credential, ['header', 'placeholder', 'secretEnv', 'prefix']);
      const header = text(inputCredential.header).toLowerCase();
      const placeholder = text(inputCredential.placeholder);
      const secretEnv = text(inputCredential.secretEnv);
      const prefix = inputCredential.prefix === undefined ? '' : text(inputCredential.prefix, false);
      if (!rule.origin.startsWith('https://') || !HEADER_NAME.test(header) || FORBIDDEN_CREDENTIAL_HEADERS.has(header)
        || !HEADER_VALUE.test(placeholder) || !HEADER_VALUE.test(prefix) || !ENV_NAME.test(secretEnv)) invalid();
      const secret = secrets[secretEnv];
      if (typeof secret !== 'string' || !secret.trim() || Buffer.byteLength(secret) > MAX_VALUE_BYTES || !HEADER_VALUE.test(secret)) invalid();
      credentialValue = prefix + secret;
      secretValues.add(secret);
      rule.credential = Object.freeze({ header, placeholder, secretEnv, prefix });
    }
    Object.freeze(rule);
    compiled.set(rule.origin, { rule, ranges: rule.allowCidrs?.map(network), credentialValue });
  }
  const guestEnv: Record<string, string> = {};
  if (root.guestEnv !== undefined) {
    if (!root.guestEnv || typeof root.guestEnv !== 'object' || Array.isArray(root.guestEnv)) invalid();
    if (Object.keys(root.guestEnv).length > 128) invalid();
    for (const [key, value] of Object.entries(root.guestEnv)) {
      if (!ENV_NAME.test(key)) invalid();
      Object.defineProperty(guestEnv, key, { value: text(value, false), enumerable: true });
    }
  }
  // Catch the common configuration mistake of copying a real key into the guest
  // token field. Check across every rule, so one rule cannot expose another key.
  const guestValues = [...Object.values(guestEnv), ...[...compiled.values()]
    .flatMap(entry => entry.rule.credential ? [entry.rule.credential.placeholder] : [])];
  if ([...secretValues].some(secret => guestValues.some(value => value.includes(secret)))) invalid();
  Object.freeze(guestEnv);
  const lookup = options.lookup ?? (async (hostname: string) => {
    const results = await dnsLookup(hostname, { all: true, verbatim: true });
    return results.map(result => ({ address: result.address, family: result.family as 4 | 6 }));
  });
  const policy = {
    origins: Object.freeze([...compiled.keys()]),
    guestEnv,
    authorize(url: URL, method: string, headers: IncomingHttpHeaders) {
      const entry = compiled.get(url.origin);
      if (!entry || url.username || url.password || url.hash || !/^[A-Z]+$/.test(method)) return deny();
      const rule = entry.rule;
      if ((rule.methods && !rule.methods.includes(method)) || (rule.paths && !rule.paths.includes(url.pathname))) return deny();
      const outgoing: OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(headers)) {
        const key = name.toLowerCase();
        if (!HEADER_NAME.test(name) || Object.hasOwn(outgoing, key)) return deny();
        if (value !== undefined && (Array.isArray(value) ? value : [value]).some(item => /[\x00-\x1f\x7f]/.test(item))) return deny();
        Object.defineProperty(outgoing, key, { value: Array.isArray(value) ? [...value] : value,
          enumerable: true, configurable: true, writable: true });
      }
      if (rule.credential) {
        if (outgoing[rule.credential.header] !== rule.credential.placeholder) return deny();
        outgoing[rule.credential.header] = entry.credentialValue;
      }
      return { headers: outgoing, rule };
    },
    async resolve(url: URL, rule: ProxyRule): Promise<ProxyAddress> {
      const entry = compiled.get(url.origin);
      if (!entry || entry.rule !== rule || url.username || url.password || url.hash) return deny();
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const literal = address(hostname);
      let answers: ProxyAddress[];
      try { answers = literal ? [literal] : await lookup(hostname); } catch { return deny(); }
      for (const answer of answers) {
        const parsed = address(answer.address);
        if (!parsed || isIP(answer.address) !== answer.family) continue;
        if (entry.ranges ? entry.ranges.some(range => contains(range, parsed)) : isPublic(parsed)) {
          return { address: parsed.address, family: parsed.family };
        }
      }
      return deny();
    },
  } as ProxyPolicy;
  const values = Object.freeze([...secretValues]);
  Object.defineProperty(policy, 'secretValues', { value: () => values });
  return Object.freeze(policy);
}
