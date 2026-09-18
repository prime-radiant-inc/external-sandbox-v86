# Managed HTTP and HTTPS egress

The proxy runs inside the same Node.js process as the API and v86. There is no
separate proxy daemon, Docker runtime, OpenSSL command, or host firewall setup.
Networking remains disabled unless `--proxy-config` is supplied.

The host owns the allowed destinations and real credentials. Guest programs
receive ordinary proxy settings, a public CA certificate, and any configured
placeholder tokens. They can use HTTP clients and SDKs without receiving the
real API keys.

## Start

From the application directory:

```sh
npm ci
npm run build
# Set OPENAI_API_KEY in the server's environment using your secret manager.
node dist/cli.js --proxy-config examples/proxy.json --mount project=/path/to/project
```

The example configuration allows GET/POST requests to `https://api.openai.com`
with credential substitution, and GET/HEAD requests to the Alpine package CDN
without credentials. All other origins are denied. Missing host credentials
and invalid configuration fail startup before booting the guest.

Copy the example to `proxy.local.json` for local changes. The repository ignores
`*.local.json` and `.env` files. Configuration references host environment
variables by name; do not put real keys in JSON or mounted directories.

The example UUID is public demonstration data. Generate a fresh token when
creating a sandbox and update both `credential.placeholder` and `guestEnv`:

```sh
node -e 'console.log(crypto.randomUUID())'
```

Guest programs see `OPENAI_API_KEY` containing the UUID. A matching request
arrives at the proxy with `Authorization: Bearer <UUID>`; the proxy forwards
`Authorization: Bearer <host OPENAI_API_KEY>` over verified upstream HTTPS.

## Policy

The top-level object contains `allow` (up to 64 exact origins) and optional
`guestEnv`. Each rule has:

| Field | Meaning |
| --- | --- |
| `origin` | Exact HTTP or HTTPS origin, including a non-default port if needed; no wildcard, credentials, path, query, or fragment |
| `methods` | Optional list of permitted HTTP methods; omitted allows supported methods |
| `paths` | Optional list of exact URL pathnames; omitted allows all paths on that origin |
| `allowCidrs` | Optional IP allowlist for the actual resolved upstream address; omitted permits public addresses only |
| `credential` | Optional exact header substitution; allowed only for HTTPS |

A credential rule has `header`, `placeholder`, `secretEnv`, and optional `prefix`.
The complete header value must equal `placeholder`. The outgoing value becomes
`prefix + hostEnvironment[secretEnv]`. Missing or incorrect placeholders are
denied. For bearer authentication, use `prefix: "Bearer "`. For an API-key header,
use its header name and omit the prefix.

`guestEnv` is a literal map of guest environment variables. Its values are never
expanded using the host environment. Per-command environment overrides remain
available, but changing or removing proxy variables does not open another
egress route.

For a private service, explicitly allow its IP range as well as its origin:

```json
{
  "allow": [{
    "origin": "https://build.internal.example:8443",
    "methods": ["GET"],
    "allowCidrs": ["10.20.0.0/16"]
  }]
}
```

An explicit CIDR list replaces the default public-address rule. The selected
numeric address is checked and pinned for that upstream connection; TLS still
verifies the original hostname. Redirects are returned to clients, and any
follow-up request is authorized independently. Credential injection never
automatically follows a redirect to another origin.

## Transport and trust

The guest's virtual network uses v86's Wisp TCP backend. A private host relay
accepts only the fixed guest proxy endpoint and maps it to the embedded proxy.
Direct external TCP, alternative host ports, and external UDP are denied. v86's external
DNS-over-HTTPS fallback is disabled; upstream names are resolved by the proxy
after request authorization. Proxy environment variables are convenience
settings, not the security boundary.

For HTTPS, the proxy accepts CONNECT, terminates guest TLS, checks the decrypted
request, and opens a new verified TLS connection upstream. It creates an
ephemeral CA at startup and installs only its public certificate in the guest.
No CA is added to the host trust store and no CA private key is written to disk.
Standard proxy and CA environment variables are provided to guest commands.
The ephemeral certificates expire after 30 days; restart the server before then
to create a fresh CA and guest trust certificate.
Certificate-pinned clients or clients that ignore those settings may fail;
certificate verification is never disabled to make them work.

The proxy belongs to one VM. The existing CLI still creates a single VM; a
future manager should create separate policy/proxy instances for each sandbox.

## Scope

- Guest filesystem changes and the generated trust certificate are ephemeral.
- Real secrets stay outside the guest, but an agent can still use the API
  operations permitted by its placeholder. This implementation has no monetary
  budget accounting or automatic token expiry.
- Literal secret echoes in responses are filtered as a defense in depth.
  Allowed upstream services must still be trusted: arbitrary encoding or
  transformation can defeat literal redaction.
- Host-side agent tools must not be able to read the proxy's credentials through
  another route. A shell adapter alone does not restrict host file tools.
- The host API remains intended for trusted local processes. This is not a
  multi-tenant service for mutually untrusted host users.
- This mode supplies outbound HTTP(S), not arbitrary TCP/UDP, SSH, incoming
  connections, or WebSocket upgrades. It speaks HTTP/1.1, including streaming
  responses such as SSE; clients that require HTTP/2 cannot use it yet.
- Requests are capped at 16 MiB and responses at 256 MiB, with a five-minute
  request lifetime and a two-minute idle timeout. Responses must use identity
  content encoding so literal secret redaction cannot be bypassed by compression;
  the proxy requests identity encoding and rejects an upstream that ignores it.
- The relay pauses downloads when the guest stops consuming data. A separate
  hard limit stops the VM if its network buffers exceed 2 MiB per stream or
  16 MiB total, with a maximum of 64 retained connections and 4,096 queued frames.
  This guard depends on the pinned v86 version and fails startup if the expected
  internal buffer layout changes. The limits cover v86's network queues, not
  total Node process memory.
- The guest still runs commands as UID 1000; network access does not itself grant
  package-install privileges or provide Node/npm inside the guest.

Run `npm run test:proxy` for policy, proxy, relay, and queue-guard tests, `npm test`
for all Node unit tests, and `npm run test:integration`
for tests through real v86. Tests use local upstreams and synthetic credentials;
they do not call paid APIs or use personal secrets.
