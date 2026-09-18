# Codex exec-server

The server implements the Codex CLI **0.154.0** exec-server wire protocol at
`ws://127.0.0.1:8686/codex`. The endpoint shares the existing Node process and VM.
It needs no Codex binary inside Linux and no Python/uv client on the host.

Codex sends exact argument arrays, working directories, and environment settings
over WebSocket JSON-RPC. The adapter forwards them to the guest agent without
evaluating them in a host shell. Filesystem requests also go through the guest
agent and the same host-enforced mount permissions. Native `apply_patch` works.

## Configure a running server

Start the server with the writable project first, plus any read-only reference
directories. With a global npm install:

```sh
v86-shell-server --port 8686 --preserve-paths \
  --mount-rw project=/absolute/path/to/project \
  --mount-ro reference=/absolute/path/to/reference
```

From a source checkout, substitute `node dist/cli.js` after `npm run build`.
`--preserve-paths` makes the host project path valid as Codex's working directory
inside the VM. Its permissions match the corresponding `/mnt/NAME` path.

Configure `~/.codex/environments.toml` as follows, merging with any existing
environment configuration:

```toml
default = "v86"
include_local = false

[[environments]]
id = "v86"
url = "ws://127.0.0.1:8686/codex"
connect_timeout_sec = 5
initialize_timeout_sec = 10
```

`include_local = false` removes the host-local execution environment from this
configuration. Then start Codex:

```sh
codex --sandbox danger-full-access \
  -c features.shell_snapshot=false \
  -c features.unified_exec_tty=false \
  --cd /absolute/path/to/project
```

Here `danger-full-access` selects unrestricted execution **inside the VM**.
The v86 mount modes and proxy policy still constrain host files and network
access. This adapter rejects additional Codex platform sandbox requirements
instead of claiming to enforce policies it cannot implement. Keep the remote
environment configuration above when using that command.

Codex itself, its authentication, model requests, and host extensions continue
running on the host. This integration routes its executor's process and
filesystem operations. It does not move every host extension into the VM.

For another port, change both the server flag and environment URL. Networking
inside the VM remains disabled unless the server receives `--proxy-config`.
With networking enabled, the guest environment includes proxy settings before
Codex's environment filters run; the underlying egress restriction remains in
force if a command removes those settings. Host environment variables are never
implicitly inherited by guest processes.

## Mount modes

| Option | Access |
| --- | --- |
| `--mount-ro [NAME=]PATH` | Read-only |
| `--mount-rw [NAME=]PATH` | Read-write |
| `--mount [NAME=]PATH` or positional `PATH` | Read-write, for compatibility |

Each mode applies to contents and metadata: file creation, writes, append,
truncate, delete, rename, chmod, timestamps, and link operations are checked on
the host. Reads remain live, so edits made by a host application become visible
inside the VM. Read-only and read-write roots cannot overlap, including aliases
of the same host directory.

When any read-only mount is present, multiply linked host files are treated as
read-only and new host hardlinks are rejected. This prevents existing hardlinks
from exposing a writable alias to a read-only file. All-read-write setups retain
hardlink support. Guest-local files are unaffected. Ordinary read-side access
time updates can still happen on the host filesystem.

## Supported protocol and limits

- `initialize`, `initialized`, `environment/info`, and `environment/status`.
- `process/start`, `read`, `write`, `signal`, and `terminate`; separate streamed
  stdout/stderr, ordered sequence numbers, replay, exit status, and closed events.
- Literal argv/argv0, guest cwd, environment replacement/filtering, pipe stdin,
  deduplicated writes, catchable SIGINT, and cancellation of the process group.
- `fs/readFile`, `writeFile`, `open`, `readBlock`, `close`, `getMetadata`,
  `canonicalize`, `readDirectory`, `createDirectory`, `remove`, `copy`, and `walk`.
  Paths are guest `file://` URIs, including paths outside mounts in the temporary
  guest filesystem. They are never resolved against the host filesystem.

Codex processes have no wall-clock timeout. A process stops at 16 MiB total
output; stdin writes are limited to 32 KiB each. Replay retains at most 1 MiB per
process and 8 MiB per connection, with at most 128 process records. Requests for
evicted output report a failure. Disconnecting cancels that connection's running
processes. Existing HTTP/Python execution timeouts remain unchanged.

Filesystem reads/writes are limited to 8 MiB per file. Open handles are immutable
byte snapshots, limited to 64 handles and 32 MiB per connection; capturing a
snapshot is not atomic against concurrent guest edits. Copy supports regular
files and directories, with a 64 MiB aggregate limit, and rejects symlinks and
special files. Walk is bounded to 10,000 entries, 4,096 directories, and depth
64. Birth time is unavailable and returned as zero. Multi-step filesystem
operations are not transactional.

PTYs, session reconnection/resumption, executor-owned shell snapshots, remote
MCP/HTTP extensions, capability discovery, and additional Codex platform sandbox
or network-proxy launches are currently unsupported. Such requests return
explicit errors. The endpoint is intended for trusted localhost clients and
rejects browser Origin requests, like the existing API.

The protocol is experimental and pinned to the tested Codex version. Its exact
source contracts are
[protocol.rs](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/exec-server-protocol/src/protocol.rs),
[environments.toml parsing](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/exec-server/src/environment_toml.rs),
and [filesystem schemas](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/file-system/src/lib.rs).

## Verification

```sh
npm run check
npm test
node --import tsx --test --test-concurrency=1 test/integration/*.test.ts
```

`test/integration/mount-modes.test.ts` boots the real VM and checks live reads,
read-only mutation failures, aliases, hardlinks, host metadata, and writable
behavior. `codex-protocol.test.ts` drives actual WebSocket RPCs against the VM,
including later stdin, binary filesystem data, interrupts, and disconnect cleanup.

`codex-cli.test.ts` runs **the installed Codex CLI 0.154.0** with an isolated
configuration and four deterministic localhost model responses. It verifies
`exec_command` reports `i686`, reads reference data, writes the project, emits
stderr, and cannot write to the read-only mount. Codex's native `apply_patch`
then succeeds on the writable mount and fails on the read-only mount. The model
responses are simulated; Codex, the exec-server transport, and the VM are real.
No API key or paid inference is involved. Install Codex 0.154.0, or set
`CODEX_CLI_BIN` to its executable; the test skips when no binary is available.
