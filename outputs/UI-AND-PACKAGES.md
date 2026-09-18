# v86 shell server 0.3.0

Unpublished npm archive: [v86-shell-server-0.3.0.tgz](v86-shell-server-0.3.0.tgz).
It is **33,617,952 bytes (32.1 MiB)** compressed, with 145 files and
34,552,260 unpacked bytes. The package includes the Linux image and browser
assets; npm installs its three existing runtime dependencies separately.
[SHA-256 checksum](v86-shell-server-0.3.0.tgz.sha256).

## Included changes

- Browser terminal at `/`, copied from the newer sandbox project: live
  stdout/stderr, stdin, EOF, cancellation, cwd/timeout controls, history,
  examples, bounded scrollback, and the new **Copy session** button.
- Proxy editor at `/proxy`, with atomic live JSON policy updates, immediate
  connection revocation, and a bounded, sanitized request activity log.
- Per-server browser tokens and exact same-origin checks. Existing CLI clients
  retain access; buffered execution and Codex still reject browser Origins.
- `--packages` installs Alpine packages before command execution starts.
  Package installation runs as guest root; subsequent commands run as UID 1000.
- `NODE_USE_ENV_PROXY=1` joins the existing guest proxy environment settings.
  Automatic Node proxy behavior still depends on the installed Node version.

## Run the archive

From the directory containing the downloaded archive:

```sh
npx --yes --package ./v86-shell-server-0.3.0.tgz v86-shell-server \
  --port 8686 --mount-rw "project=$PWD"
```

Open `http://127.0.0.1:8686/`. For packages and proxy controls, create
`proxy-alpine.json` containing:

```json
{"allow":[{"origin":"https://dl-cdn.alpinelinux.org","methods":["GET","HEAD"]}]}
```

Then run:

```sh
npx --yes --package ./v86-shell-server-0.3.0.tgz v86-shell-server \
  --proxy-config ./proxy-alpine.json --packages uv,jq \
  --mount-rw "project=$PWD"
```

The guest's Alpine 3.21 x86 repository supplies uv 0.5.31 and jq 1.7.1.
Both were installed and executed successfully through the packaged server.
`uv run --no-project --offline python -c 'print("hello")'` uses existing guest
Python. Python/npm registries need separate allow rules. Packages are ephemeral
and reinstalled on each boot; proxy policy edits are also runtime-only.

## Verification

TypeScript checks, **183 unit tests**, **76 real-VM integration tests**, and
**17 Python client tests** passed, with no skipped tests in the final run.
The real Codex CLI fixture also passed using locally simulated model responses.

The uploadable archive was launched through `npx` from a separate working
directory. It booted Linux, downloaded uv/jq through the managed HTTPS proxy,
ran Python using uv as UID 1000, accepted incremental stdin, returned separate
stdout/stderr and exit code 7, wrote a read-write host mount, rejected a
read-only write, served the Copy session asset, displayed package activity,
rejected an invalid policy, and applied a deny-all policy.

Browser QA also exercised the actual terminal, interactive stdin, Copy session
feedback, proxy activity with query omission, and applying policy in the editor.
Six copy-specific client tests cover transcript contents, active-command
snapshots, token exclusion, clipboard fallback, focus/selection, failure,
and empty-session behavior. The terminal JavaScript matches the latest source
copy byte-for-byte, including the concurrently added copy feature.

[Full test output](ui-packages-test-results.txt) ·
[Machine-readable verification](ui-packages-verification.json) ·
[Browser UI guide](v86-shell-server/docs/browser-ui.md) ·
[Package installation guide](v86-shell-server/docs/packages.md).
