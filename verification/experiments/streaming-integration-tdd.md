# Streaming integration TDD

Tests authored before production endpoint/client changes in
`outputs/v86-shell-server/test/integration/streaming.test.ts`.

Red run: `node --import tsx --test test/integration/streaming.test.ts`.
This command needs localhost networking outside the filesystem sandbox; the
initial sandboxed run failed with `listen EPERM 127.0.0.1`. The approved
unsandboxed run booted the real v86 Linux guest and completed in 34.6 seconds.

All nine behavioral subtests failed as expected:

- Six WebSocket tests failed with `WebSocket connection failed` because
  `/exec/ws` did not yet exist.
- Incremental Python client test could not receive its readiness output.
- Python binary/client-open-stdin tests exited with status 2 because the client
  script did not yet exist.

The suite exercises readiness before sending stdin, successive independent stdin
chunks, EOF, separated streams, status 23, all 256 byte values, 80 KiB cumulative
stdin using acknowledgement pacing, concurrent sessions, timeout, cancellation,
disconnect killing descendants, output limits, real `uv run --script` client
duplex operation, and command completion while local stdin remains open.

Each protocol observation is deadline-bounded, and failed subtests close their
sockets or child clients. The real VM and temporary mount are destroyed after
the suite.

## First green attempt and integration-discovered race

After the VM/endpoint implementation, all seven WebSocket behavioral subtests
(including an added `stdin: false` immediate-EOF case) passed against the real VM
in 6.2 seconds. The three Python subprocess cases were omitted pending that
client's implementation.

The subsequent full run passed all three actual `uv run --script` subprocess
cases and six of seven WebSocket cases, but exposed an intermittent ordering
race in the first test: the guest exited after EOF and the connection closed
before the `stdin_closed` acknowledgement arrived. The first green attempt had
passed this same assertion. The assertion remained strict and the endpoint
agent was notified to add a deterministic regression and fix the event order.

Runs use `UV_CACHE_DIR=/private/tmp/v86-shell-uv-cache`, shared with the Python
agent's already prepared uv script environment.

## Final green verification

After the endpoint agent's deterministic EOF race regression test and fix,
`UV_CACHE_DIR=/private/tmp/v86-shell-uv-cache node --import tsx --test
test/integration/streaming.test.ts` passed all ten behavioral subtests (eleven
tests including the parent) in 6.7 seconds. The three Python child processes now
invoke `uv run --quiet --script`, matching the wrapper and preventing uv's
first-run installer output from contaminating guest stderr assertions.

The original `test/integration/vm.test.ts` subsequently passed all nine behavioral
subtests (ten tests including the parent) in 6.0 seconds. This verifies existing
HTTP results, live mounted file reads/writes, stdin/environment/path aliases,
concurrency, timeout/output caps, HTTP cancellation, and the original Claude
quoted-command wrapper integration now routed through the streaming Python
client.

No production implementation files were edited by the integration-test agent.
