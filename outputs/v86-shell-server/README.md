# v86 shell server

A Node.js HTTP JSON API that executes Bash commands inside a Linux VM running
in v86/WebAssembly. Selected host directories are mounted live over 9p: guest
reads see host files and guest writes change those files immediately. There is
no import/export step and no Docker dependency at runtime.

Use `POST /exec` for a buffered JSON response, or WebSocket `/exec/ws` for live
stdout/stderr and incremental stdin. The Python client and Claude Code wrapper
use the streaming endpoint.

The bundled guest is 32-bit Alpine Linux with Bash, Python 3, Git, and BusyBox.
Networking is off by default. Optional managed HTTP(S) egress applies host and
IP rules and substitutes placeholder tokens with host-side API keys.
Commands run as guest UID/GID 1000. Node runs on the
host; Node/npm are not installed in this guest image.

## Run

Requirements: Node.js 22 or later and npm. A prebuilt guest image is included.
Install and build first:

```sh
npm ci
npm run build
```

Start with one or more directories:

```sh
node dist/cli.js --port 8686 \
  --mount project=/absolute/path/to/project \
  --mount data=/absolute/path/to/data
```

These appear as `/mnt/project` and `/mnt/data` inside Linux. An unnamed mount
uses its directory basename; positional paths also work:

```sh
node dist/cli.js /absolute/path/to/project /absolute/path/to/data
```

The listener binds to **127.0.0.1 only**, after the VM and mounts are ready. Stop
with Ctrl-C. Mount contents persist; all other guest filesystem changes vanish
when the server stops. Each request starts a fresh Bash process in the same VM.
The first mount is the default working directory, or `/workspace` with no mounts.

`--preserve-paths` additionally makes each mounted directory available at its
original absolute host path inside Linux using bind mounts. This is useful for
commands containing absolute paths and required for the Claude Code recipe below.
Guest system paths cannot be overwritten, and the total alias configuration
must fit the kernel command line; startup reports an error if it cannot.

Use `node dist/cli.js --help` for `--image`, `--memory`, and `--verbose` options.

## Managed HTTP(S) networking

The optional proxy runs inside this Node process; no separate proxy service,
Docker runtime, OpenSSL executable, or host firewall setup is required.

```sh
# Supply OPENAI_API_KEY to the server from your host-side secret manager.
node dist/cli.js --proxy-config examples/proxy.json --mount project=/path/to/project
```

Guest programs receive a placeholder API key, standard proxy settings, and a
public CA certificate. The host proxy checks each destination and replaces the
exact placeholder header with the real host credential. Direct guest networking
is blocked outside the guest, even when a program ignores proxy settings.

See [configuration, examples, and security boundaries](docs/proxy.md). This mode
supports outbound HTTP(S), including streaming responses, with exact origin
rules, optional methods/paths, and optional CIDR allowlists. It does not enable
arbitrary TCP/UDP or grant package-install privileges. Omitting `--proxy-config`
retains the offline behavior.

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

`durationMs` varies. Successful API requests return HTTP 200 even when the shell
exits nonzero. Validation errors use 4xx; execution/protocol failures use 500.
An invalid guest cwd is an execution error. Output is UTF-8 text; files on the
mounts retain arbitrary binary bytes. For binary command output, encode it with
base64 inside the guest.

| Request field | Meaning |
| --- | --- |
| `command` | Required Bash command string; supports pipelines, redirects, loops, multiline scripts; maximum 64 KiB |
| `cwd` | Absolute guest directory; defaults to first mount |
| `env` | String environment overrides; no host environment is inherited |
| `stdin` | Optional UTF-8 text, up to 32 KiB; EOF follows the text |
| `timeoutMs` | Wall-clock timeout; default 30,000, maximum 300,000 |
| `maxOutputBytes` | Combined retained stdout/stderr bytes; default 4 MiB, maximum 16 MiB |

Timeouts and output limits kill the guest process group. The corresponding flag
is set in the response; `exitCode` is null when terminated by a signal. Outputs
are buffered until command completion. Client disconnection also cancels the
command. Up to 16 commands can run concurrently. Detached processes that
deliberately escape their process group are outside the cleanup guarantee.

`GET /health` returns readiness, guest details, mount mappings, default cwd, and
active command count. `GET /mounts` returns `{ "mounts": [...] }`.

## Streaming API and Python client

Install [uv](https://docs.astral.sh/uv/) on the host to run the Python client.
Its inline dependency metadata pins `websockets`; uv installs it on first use.

```sh
# With the server running and the current directory mounted:
uv run --quiet --script scripts/v86_exec.py 'printf "ready\\n"; read -r line; printf "got: %s\\n" "$line"'

# Pipe stdin through incrementally, including arbitrary binary data:
cat input.bin | uv run --quiet --script scripts/v86_exec.py 'cat' > output.bin

# Close guest stdin immediately when no input is wanted:
uv run --quiet --script scripts/v86_exec.py --no-stdin 'uname -m'
```

The client writes each stdout/stderr chunk to the corresponding local stream
as it arrives. It keeps reading stdin while the process runs, sends EOF when
local stdin closes, and exits promptly even if its parent keeps stdin open.
All three streams preserve binary bytes. `uv --quiet` keeps uv's dependency
setup messages out of command stderr.

WebSocket clients connect to `ws://127.0.0.1:8686/exec/ws`, then send a `start`
message. Each connection runs one process. See the complete
[WebSocket protocol and TDD notes](docs/streaming.md), including flow control,
EOF, cancellation, errors, and a message-by-message example.

## Claude Code shell prefix

Anthropic documents [`CLAUDE_CODE_SHELL_PREFIX`](https://code.claude.com/docs/en/env-vars)
as an executable receiving **one argument containing the complete shell command**.
For Bash calls, that argument also contains Claude's setup and cwd bookkeeping.
The included `scripts/claude-shell-prefix.sh` forwards that exact argument through
the WebSocket API using `uv run --quiet --script scripts/v86_exec.py`; it never
evaluates the command on the host. stdout, stderr, and stdin stream while the
command runs. Install uv and run the client once before launching Claude so its
Python dependency is ready.

Use a Bash shell and put Claude's temporary files inside the mounted project,
so its cwd bookkeeping file is visible to both Claude and the VM. This changes
environment variables only for the Claude process you launch.

In terminal 1:

```sh
APP=/absolute/path/to/v86-shell-server
cd /absolute/path/to/your/project
mkdir -p .v86-claude-tmp
node "$APP/dist/cli.js" --port 8686 --preserve-paths --mount "project=$PWD"
```

In terminal 2, from the same project:

```sh
APP=/absolute/path/to/v86-shell-server
CLAUDE_CODE_SHELL=/bin/bash \
CLAUDE_CODE_TMPDIR="$PWD/.v86-claude-tmp" \
CLAUDE_CODE_SHELL_PREFIX="$APP/scripts/claude-shell-prefix.sh" \
V86_API_URL=http://127.0.0.1:8686 \
claude
```

Add `.v86-claude-tmp/` to your project's gitignore if desired. Mount more
directories by adding `--mount NAME=/absolute/path` to the server command.
Paths outside those explicit mounts remain unavailable to guest commands.
Host shell snapshots under `~/.claude` are not mounted; Claude's optional
snapshot source step can fail harmlessly and the guest uses its own environment.

You can test the wrapper without calling a model:

```sh
"$APP/scripts/claude-shell-prefix.sh" 'uname -m; pwd; printf "hello from Linux\n"'
"$APP/scripts/claude-shell-prefix.sh" 'printf "an error\n" >&2; exit 7'
echo "$?" # 7
```

| Wrapper variable | Default / behavior |
| --- | --- |
| `V86_API_URL` | `http://127.0.0.1:8686`; accepts local `http://` or `ws://` origins |
| `V86_CWD` | Optional explicit absolute guest cwd; otherwise maps the wrapper's host cwd using `/mounts` |
| `V86_TIMEOUT_MS` | `120000`; maximum `300000` |
| `V86_MAX_OUTPUT_BYTES` | Optional override of API output limit |
| `V86_FORWARD_STDIN` | Streams stdin by default; set to `0` to close guest stdin immediately |

The wrapper sends stdout to stdout, stderr to stderr, and preserves normal exit
codes. Signal exits become `128 + signal`, timeout is `124`, and output-limit or
API failures are `125`. SIGINT/SIGTERM/SIGHUP cancel the remote command and close
the WebSocket connection.

The prefix also applies to hooks, status-line commands, and stdio MCP server
startup. Bidirectional pipes support request/response programs. The guest lacks
Node/npm, and networking requires explicit proxy configuration. Long-lived programs remain subject to
the five-minute timeout and 16 MiB output ceiling. No PTY is allocated, so programs
requiring a terminal are unsupported. Claude's native Read/Edit tools still
operate on the host: a shell prefix does not put all of Claude Code inside the VM.
This integration does not change Claude permissions or sandbox settings.

The previous buffered Node client remains available as
`scripts/claude-shell-prefix-http.sh` and `scripts/api-exec.mjs`. Its stdin behavior
is unchanged: opt in with `V86_FORWARD_STDIN=1`, capped at 32 KiB total.

## Mount semantics and scope

- Read, write, append, binary files, creation, removal, directories, rename,
  chmod, timestamps, symlinks, hardlinks, and fsync use the host filesystem.
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
  not swap parent directories during filesystem operations. Existing hardlinks
  retain shared-inode behavior. This is not an adversarial-host sandbox.
- The API is intended for trusted local processes. Browser Origin requests and
  non-local Host headers are rejected; there is no remote access mode or token
  authentication. Other local processes can call it.

## Validation and source

```sh
npm run check
npm test
npm run test:python
npm run test:integration
```

Validated on Node 24 / macOS arm64. The integration suite boots real v86 and
checks shell behavior, streams and nonzero exits, two live host mounts, host
changes after boot, binary writes, file operations, symlink boundaries,
stdin/env, concurrent requests, timeout/output caps, disconnect cancellation,
and the shell prefix with Claude-style prologue/cwd bookkeeping. Managed proxy
tests cover local HTTP/TLS upstreams, secret substitution, host/IP rejection,
streaming, direct-connection bypass attempts, and the uv client through real v86.
Streaming tests
also require output before stdin is sent, successive inputs before EOF, binary
data across both streams, input larger than 32 KiB, and Python client completion
while its local stdin stays open. Python tests also cover terminal input and
cancellation when a downstream output pipe stops reading. The suite uses a
deterministic command shaped like Claude Code's current wrapper; it does not
make a live Claude model call.

Implementation uses v86's public
[`filesystem.handle9p` interface](https://github.com/copy/v86/blob/master/docs/filesystem.md).
`src/vm.ts` uses a dedicated serial channel for the guest command agent.
Runtime source does not spawn host processes for submitted commands.
See [image documentation](images/README.md) for rebuilding and
[provenance](PROVENANCE.md) for reused sources and image components.
