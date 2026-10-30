# external-sandbox-v86

A Node.js HTTP JSON API that executes Bash commands inside a Linux VM running in v86/WebAssembly. Selected host directories are mounted live over 9p: guest reads see host files and writes to read-write mounts change them immediately. There is no import/export step and no Docker dependency at runtime.

Use `POST /exec` for a buffered JSON response, or WebSocket `/exec/ws` for live stdout/stderr and incremental stdin. The Python client and Claude Code wrapper use the streaming endpoint. Codex connects to `/codex` using its exec-server protocol for shell execution and filesystem operations, including `apply_patch`.

The bundled guest is 32-bit Alpine Linux with Bash, Python 3, Git, and BusyBox. Networking is off by default. Optional managed HTTP(S) egress applies host and IP rules and substitutes placeholder tokens with host-side API keys. Commands run as guest UID/GID 1000. Node runs on the host; the base guest image does not include Node/npm. Use `--packages` to install additional Alpine tools when the VM starts.

## Run

An unpublished npm tarball can also be run directly with `npx`, including the bundled Linux image; no source build is needed after installation. See [npm installation and npx](docs/npm.md) for local archive, global install, and streaming client instructions.

Requirements: Node.js 22 or later and npm. A prebuilt guest image is included. Install and build first:

```sh
npm ci
npm run build
```

Start with one or more directories:

```sh
node dist/cli.js --port 8686 \
  --mount-rw project=/absolute/path/to/project \
  --mount-ro data=/absolute/path/to/data
```

These appear as `/mnt/project` and `/mnt/data` inside Linux. An unnamed mount uses its directory basename; positional paths also work:

```sh
node dist/cli.js /absolute/path/to/project /absolute/path/to/data
```

`--mount-ro` is read-only; `--mount-rw`, `--mount`, and positional directories are read-write. Read-only checks happen on the host for every mutation and remain effective through preserved paths and symlinks. `/mounts` and `/health` include each mount's `mode`. Overlapping host directories cannot mix modes.

The listener binds to **127.0.0.1 only**, after the VM and mounts are ready. Stop with Ctrl-C. Mount contents persist; all other guest filesystem changes vanish when the server stops. Each request starts a fresh Bash process in the same VM. The first mount is the default working directory, or `/workspace` with no mounts.

`--preserve-paths` additionally makes each mounted directory available at its original absolute host path inside Linux using bind mounts. This is useful for commands containing absolute paths and required for the Claude Code recipe below. Guest system paths cannot be overwritten, and the total alias configuration must fit the kernel command line; startup reports an error if it cannot.

Use `node dist/cli.js --help` for `--image`, `--memory`, and `--verbose` options.

## Browser terminal and proxy controls

Open `http://127.0.0.1:8686/` to run commands, watch separate stdout/stderr, send stdin or EOF, cancel, browse history, and **Copy session** to the clipboard. Each command starts a fresh shell; full-screen TTY programs are unsupported.

With `--proxy-config`, open `/proxy` to edit the live JSON policy and inspect sanitized request activity. Applying a valid policy closes existing proxy connections; invalid edits leave the old policy intact. Changes are runtime-only. See [browser terminal and proxy UI](docs/browser-ui.md).

## Install guest tools at startup

```sh
node dist/cli.js --proxy-config examples/proxy-alpine.json \
  --packages uv,jq,ripgrep --mount-rw "project=$PWD"
```

The VM installs packages from Alpine's HTTPS repositories before serving commands, then runs ordinary commands as UID 1000. The supplied policy permits only Alpine package downloads. Installed tools are ephemeral and reinstalled on the next boot. See [startup packages and uv](docs/packages.md).

## Codex exec-server

The same Node process exposes `ws://127.0.0.1:8686/codex`. Configure this URL in Codex's `environments.toml` and use the VM as its execution environment. No Codex binary, Node installation, or extra service is needed inside the guest. See the shared [Codex setup guide](https://github.com/prime-radiant-inc/external-sandbox/tree/main/codex) and the backend [protocol support and verification](docs/codex-protocol.md).

## Managed HTTP(S) networking

The optional proxy runs inside this Node process; no separate proxy service, Docker runtime, OpenSSL executable, or host firewall setup is required.

```sh
# Supply OPENAI_API_KEY to the server from your host-side secret manager.
node dist/cli.js --proxy-config examples/proxy.json --mount project=/path/to/project
```

Guest programs receive a placeholder API key, standard proxy settings, and a public CA certificate. The host proxy checks each destination and replaces the exact placeholder header with the real host credential. An allowed upstream can transform and echo that credential despite literal response redaction; use credential rules only with trusted services and narrow their methods and paths. Direct guest networking is blocked outside the guest, even when a program ignores proxy settings.

See [configuration, examples, and security boundaries](docs/proxy.md). This mode supports outbound HTTP(S), including streaming responses, with exact origin rules, optional methods/paths, and optional CIDR allowlists. It does not enable arbitrary TCP/UDP or grant ordinary commands package-install privileges. Omitting `--proxy-config` retains the offline behavior.

## JSON API

```sh
curl -sS http://127.0.0.1:8686/exec \
  -H 'Content-Type: application/json' \
  --data '{"command":"printf hello; printf problem >&2; exit 7","cwd":"/mnt/project"}'
```

```json
{
  "stdout": "hello",
  "stderr": "problem",
  "exitCode": 7,
  "signal": null,
  "timedOut": false,
  "outputLimitExceeded": false,
  "durationMs": 42
}
```

`durationMs` varies. Successful API requests return HTTP 200 even when the shell exits nonzero. Validation errors use 4xx; execution/protocol failures use 500. An invalid guest cwd is an execution error. Output is UTF-8 text; files on the mounts retain arbitrary binary bytes. For binary command output, encode it with base64 inside the guest.

| Request field | Meaning |
| --- | --- |
| `command` | Required Bash command string; supports pipelines, redirects, loops, multiline scripts; maximum 64 KiB |
| `cwd` | Absolute guest directory; defaults to first mount |
| `env` | String environment overrides; no host environment is inherited |
| `stdin` | Optional UTF-8 text, up to 32 KiB; EOF follows the text |
| `timeoutMs` | Wall-clock timeout; default 30,000, maximum 300,000 |
| `maxOutputBytes` | Combined retained stdout/stderr bytes; default 4 MiB, maximum 16 MiB |

Timeouts and output limits kill the guest process group. The corresponding flag is set in the response; `exitCode` is null when terminated by a signal. Outputs are buffered until command completion. Client disconnection also cancels the command. Up to 16 commands can run concurrently. Detached processes that deliberately escape their process group are outside the cleanup guarantee.

`GET /health` returns readiness, guest details, mount mappings, default cwd, and active command count. `GET /mounts` returns `{ "mounts": [...] }`.

## Streaming API and shared clients

WebSocket clients connect to `ws://127.0.0.1:8686/exec/ws`, then send a `start` message. Each connection runs one process and supports streaming stdout/stderr, incremental stdin, EOF, and cancellation. Message shapes, flow control, acknowledgements, and error rules are defined in section 3 of the shared [protocol specification](https://github.com/prime-radiant-inc/external-sandbox/blob/main/SPEC.md). This server applies the following bounds:

| Resource | Limit |
| --- | --- |
| Concurrent guest processes | 16 across HTTP and WebSockets |
| WebSocket message | 256 KiB |
| Decoded stdin chunk | 32 KiB |
| Pending stdin | 256 KiB / 256 messages |
| Pending encoded WebSocket output, including startup | 1 MiB |
| Combined command output | 4 MiB default, up to 16 MiB |
| Command timeout | 30 seconds API default, up to five minutes |
| First start message | Ten seconds after connection |

Origin and Host checks apply during WebSocket upgrade, and the server stays bound to `127.0.0.1`.

The Python streaming client, Claude Code shell-prefix wrappers, and their tests now live in the shared [external-sandbox/claude-code](https://github.com/prime-radiant-inc/external-sandbox/tree/main/claude-code) directory. Follow that guide for client installation, Claude environment settings, temporary-directory setup, and examples for either backend. This repository and npm package provide the server; the former `external-sandbox-v86-exec` companion command has been removed in favor of the shared client.

For Claude Code, start this backend with its project mounted at the same absolute path inside the VM:

```sh
node dist/cli.js --port 8686 --preserve-paths --mount "project=/absolute/path/to/project"
```

Set the shared client's `EXTERNAL_SANDBOX_API_URL` to `http://127.0.0.1:8686`. Add explicit `--mount-ro` or `--mount-rw` options for other directories it needs. A shell prefix routes shell commands; Claude's native host tools remain outside this VM.

## Mount semantics and scope

- Read, write, append, binary files, creation, removal, directories, rename,
  chmod, timestamps, symlinks, hardlinks, and fsync use the host filesystem.
  Read-only mounts reject mutating operations with `EROFS`; reads remain live.
  Ordinary filesystem access-time updates caused by reading can still occur.
- While any read-only mount exists, multiply linked regular host files are
  treated as read-only even through a writable mount, and new host hardlinks
  are rejected. This conservative rule prevents an existing hardlink from
  bypassing read-only protection. All-read-write configurations retain hardlink
  support. Guest-local files are unaffected.
- Guest metadata presents files as owned by UID/GID 1000 while retaining host
  permission bits. Host operations use the Node server's account. Changing
  ownership to a different guest UID/GID is unsupported.
- Symlink targets are resolved in the guest namespace. Host I/O never follows
  symlinks through the mount boundary; absolute host symlinks work only when their
  destination is also available at that absolute path inside the guest.
- Device/FIFO creation, extended attributes, and host-wide advisory locks are
  unsupported. Software that relies on those features may need guest-local storage.
- Parent paths are checked before operations, and regular-file opens use
  `O_NOFOLLOW`. Pure Node does not expose `openat2`; a trusted host process must
  not swap parent directories during filesystem operations. This is not an
  adversarial-host sandbox; host applications can still update read-only mounts.
- The API is intended for trusted local processes. Browser Origin requests and
  non-local Host headers are rejected; there is no remote access mode or token
  authentication. Other local processes can call it.

## Validation and source

The terminal and proxy pages use a pinned copy of the independent `external-sandbox-ui` assets and frontend tests. The server retains its own authorization, CSP, and runtime configuration adapters. `npm run check` and `npm run build` verify the copied files against their SHA-256 manifest; see [shared UI update instructions](docs/browser-ui.md#updating-the-shared-ui). Released npm packages include static runtime assets, provenance, and the complete source bundle without requiring the UI repository.

```sh
npm run check
npm test
node --import tsx --test --test-concurrency=1 test/integration/*.test.ts
```

Validated on Node 24 / macOS arm64. The integration suite boots real v86 and checks shell behavior, streams and nonzero exits, two live host mounts, host changes after boot, binary writes, file operations, symlink boundaries, stdin/env, concurrent requests, timeout/output caps, disconnect cancellation, and optional shared-client scenarios with Claude-style prologue/cwd bookkeeping. Managed proxy tests cover local HTTP/TLS upstreams, secret substitution, host/IP rejection, streaming, direct-connection bypass attempts, and the uv client through real v86. Streaming tests also require output before stdin is sent, successive inputs before EOF, binary data across both streams, input larger than 32 KiB, and Python client completion while its local stdin stays open. Shared-client tests cover terminal input and cancellation when a downstream output pipe stops reading. The suite uses a deterministic command shaped like Claude Code's current wrapper; it does not make a live Claude model call.

Codex integration additionally runs the real installed Codex CLI 0.164.0 against the real VM with deterministic localhost model responses. It verifies shell execution and native `apply_patch` on both mount modes without a paid model call. This compatibility test skips if Codex is missing and requires exactly 0.164.0 when present; set `CODEX_CLI_BIN` to select that binary.

Implementation uses v86's public [`filesystem.handle9p` interface](https://github.com/copy/v86/blob/master/docs/filesystem.md). `src/vm.ts` uses a dedicated serial channel for the guest command agent. Runtime source does not spawn host processes for submitted commands. See [image documentation](images/README.md) for rebuilding and [provenance](PROVENANCE.md) for reused sources and image components.

### Optional shared-client integration checks

Ordinary backend tests do not require another repository. To include the external Python client and Claude prefix scenarios in the real-VM suite, provide absolute paths to the shared [client scripts](https://github.com/prime-radiant-inc/external-sandbox/tree/main/claude-code):

```sh
EXTERNAL_SANDBOX_CLIENT=/absolute/path/to/external-sandbox/claude-code/external_sandbox_exec.py \
EXTERNAL_SANDBOX_PREFIX=/absolute/path/to/external-sandbox/claude-code/claude-shell-prefix.sh \
node --import tsx --test --test-concurrency=1 test/integration/*.test.ts
```

Without these settings, only the external-client scenarios are skipped. Setting a path explicitly opts into the checks; an invalid or missing file fails the test. The server's own HTTP, WebSocket, mount, and proxy tests remain available without the shared checkout.
