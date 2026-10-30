# Codex protocol implementation

The server implements the Codex CLI **0.164.0** exec-server wire protocol at `ws://127.0.0.1:8686/codex`. The endpoint shares the existing Node process and VM. It needs no Codex binary inside Linux and no Python/uv client on the host.

Codex sends exact argument arrays, working directories, and environment settings over WebSocket JSON-RPC. The adapter forwards them to the guest agent without evaluating them in a host shell. Filesystem requests also go through the guest agent and the same host-enforced mount permissions. Native `apply_patch` works.

Client setup and environment selection are documented in the shared [Codex integration guide](https://github.com/prime-radiant-inc/remote-sandbox/tree/main/codex). This document records the v86 adapter, mount enforcement, and backend verification.

## Mount modes

| Option | Access |
| --- | --- |
| `--mount-ro [NAME=]PATH` | Read-only |
| `--mount-rw [NAME=]PATH` | Read-write |
| `--mount [NAME=]PATH` or positional `PATH` | Read-write, for compatibility |

Each mode applies to contents and metadata: file creation, writes, append, truncate, delete, rename, chmod, timestamps, and link operations are checked on the host. Reads remain live, so edits made by a host application become visible inside the VM. Read-only and read-write roots cannot overlap, including aliases of the same host directory.

When any read-only mount is present, multiply linked host files are treated as read-only and new host hardlinks are rejected. This prevents existing hardlinks from exposing a writable alias to a read-only file. All-read-write setups retain hardlink support. Guest-local files are unaffected. Ordinary read-side access time updates can still happen on the host filesystem.

## Supported protocol and limits

- `initialize`, `initialized`, `environment/info`, and `environment/status`.
- `process/start`, `read`, `write`, `signal`, and `terminate`; separate streamed stdout/stderr, ordered sequence numbers, replay, exit status, and closed events.
- Literal argv/argv0, guest cwd, environment replacement/filtering, pipe stdin, deduplicated writes, catchable SIGINT, and cancellation of the process group.
- `fs/readFile`, `writeFile`, `open`, `readBlock`, `close`, `getMetadata`, `canonicalize`, `readDirectory`, `createDirectory`, `remove`, `copy`, and `walk`. Paths are guest `file://` URIs, including paths outside mounts in the temporary guest filesystem. They are never resolved against the host filesystem.

Codex processes have no wall-clock timeout. A process stops at 16 MiB total output; stdin writes are limited to 32 KiB each. Replay retains at most 1 MiB per process and 8 MiB per connection, with at most 128 process records. Requests for evicted output report a failure. Disconnecting cancels that connection's running processes. Existing HTTP and streaming API execution timeouts remain unchanged.

Filesystem reads/writes are limited to 8 MiB per file. Open handles are immutable byte snapshots, limited to 64 handles and 32 MiB per connection; capturing a snapshot is not atomic against concurrent guest edits. Copy supports regular files and directories, with a 64 MiB aggregate limit, and rejects symlinks and special files. Walk is bounded to 10,000 entries, 4,096 directories, and depth 64. Birth time is unavailable and returned as zero. Multi-step filesystem operations are not transactional.

PTYs, session reconnection/resumption, executor-owned shell snapshots, remote MCP/HTTP extensions, capability discovery, and additional Codex platform sandbox or network-proxy launches are currently unsupported. Such requests return explicit errors. The endpoint is intended for trusted localhost clients and rejects browser Origin requests, like the existing API.

The protocol is experimental and pinned to the tested Codex version. Its exact source contracts are [protocol.rs](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/exec-server-protocol/src/protocol.rs), [environments.toml parsing](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/exec-server/src/environment_toml.rs), [default environment selection](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/exec-server/src/environment.rs), and [filesystem schemas](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/file-system/src/lib.rs). The CLI flags were checked against installed `codex --help` and `codex exec --help` for 0.164.0; also see the [official CLI reference](https://developers.openai.com/codex/cli/reference/).

## Verification

```sh
npm run check
npm test
node --import tsx --test --test-concurrency=1 test/integration/*.test.ts
```

`test/integration/mount-modes.test.ts` boots the real VM and checks live reads, read-only mutation failures, aliases, hardlinks, host metadata, and writable behavior. `codex-protocol.test.ts` drives actual WebSocket RPCs against the VM, including later stdin, binary filesystem data, interrupts, and disconnect cleanup.

`codex-cli.test.ts` runs **the installed Codex CLI 0.164.0** with an isolated configuration and four deterministic localhost model responses. It verifies `exec_command` reports `i686`, reads reference data, writes the project, emits stderr, and cannot write to the read-only mount. Codex's native `apply_patch` then succeeds on the writable mount and fails on the read-only mount. The model responses are simulated; Codex, the exec-server transport, and the VM are real. No API key or paid inference is involved. Install Codex 0.164.0, or set `CODEX_CLI_BIN` to its executable; the test skips when no binary is available. The isolated `CODEX_HOME` in this test uses the same VM-only environment configuration described in the shared integration guide; it does not change the user's default.
