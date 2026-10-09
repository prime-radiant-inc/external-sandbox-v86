# Managed proxy development and validation

Implemented on `feature/managed-egress-proxy` after preserving the existing application, image, clients, demo, and measurements in four commits on `main`.

## Test-driven changes

Tests were written and observed failing before the new modules were implemented. Subsequent regression tests also exposed concrete failures:

- A proxy-only header reached an upstream; header filtering now removes it.
- IPv6 literal origins needed bracket removal and IP certificate SANs.
- An oversized declared upload could leave a request pending; it now returns 413
  before destination resolution or connection.
- Configuration could accidentally expose a real secret as a placeholder or
  guest environment value; startup now rejects those cases without echoing it.
- Wisp's WebSocket buffers did not bound v86's internal TCP buffers. Tests now
  cover a separate hard allocation guard and the pinned adapter layout.
- A fast 8 MiB response overwhelmed the transport. The relay now accounts for
  unread guest bytes and in-flight Wisp frames, limits the receive window to
  128 KiB per stream, and applies upstream TCP backpressure.

## Reproduce

From the application directory:

```sh
npm run check
npm run build
npm test
npm run test:proxy
npm run test:python
npm run test:integration
```

`test:proxy` is a subset of `npm test`. Its 43 tests cover policy and CIDRs, configuration loading, TLS interception, verified upstream certificates, credential substitution, literal response redaction, SSE and binary uploads, redirect and upgrade rejection, disconnect cleanup, relay restrictions, and queue accounting. The existing Node suite also passed; after adding the final three backpressure tests, the affected proxy subset passed again.

All 17 Python client tests passed. Both existing offline real-VM suites passed (21 reported tests including their two parent tests). Three additional real-VM network tests passed:

1. HTTP through the fixed proxy endpoint, direct TCP rejection, and synthetic
   guest DNS with no external host `fetch` call.
2. HTTPS with the public guest CA and a UUID placeholder, through the API server
   and uv Python client. The local TLS upstream receives the synthetic real key;
   stdout arrives before the upstream finishes, stderr remains separate, and a
   disallowed host is blocked.
3. A stalled reader leaves the VM responsive with a bounded queue. After
   cancellation, an 8 MiB download completes with every byte intact.

The CLI was also exercised against `https://example.com` through the uv client and guest Python: HTTP 200 with the expected page content. No real API keys or paid API calls were used. Test VMs, listeners, and client processes were stopped.

Validation used Node 26 on macOS arm64. The earlier resource measurements remain separate observations made with Node 24 and networking disabled.

## Known boundaries

See [proxy configuration and limits](proxy.md). In particular, this is HTTP/1.1 egress, the CA expires after 30 days, literal redaction is not a guarantee against a malicious allowed upstream encoding a secret, and the hard queue guard relies on the pinned v86 implementation. Monetary budgets, credential expiry policies, raw TCP capabilities, HTTP/2, and WebSocket proxying are not implemented.
