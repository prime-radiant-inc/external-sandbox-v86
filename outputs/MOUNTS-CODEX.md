# Read-only mounts and Codex exec-server

Implemented and tested on branch `feature/mounts-codex-exec-server`.

[Unpublished npm package 0.2.0](v86-shell-server-0.2.0.tgz) ·
[Codex setup and limits](remote-sandbox-v86/docs/codex.md) ·
[Full test output](mounts-codex-test-results.txt) ·
[Package checksum and measurements](mounts-codex-verification.json)

## What changed

- `--mount-ro [NAME=]PATH` and `--mount-rw [NAME=]PATH` select each mount's mode.
  Existing `--mount` and positional directories remain read-write. Modes are
  reported by `/mounts` and `/health`.
- Read-only enforcement occurs in the host 9P bridge for file contents and
  metadata. Preserved guest paths and symlinks cannot bypass it. Mixed-mode
  overlapping host directories are rejected. Multiply linked host files are
  protected and new host hardlinks are disabled when any read-only mount exists.
- `/codex` implements the Codex 0.154.0 exec-server protocol on the same localhost
  port and in the same Node process. Shell commands and filesystem requests run
  inside the VM. Native Codex `apply_patch` uses the same mount enforcement.
- Exact argv/environment forwarding, stdout/stderr streaming, later stdin,
  interrupts, termination, output replay, and disconnect cancellation are supported.

## Run

From the directory containing the downloaded archive:

```sh
npx --yes --package ./v86-shell-server-0.2.0.tgz \
  v86-shell-server --preserve-paths \
  --mount-rw project=/absolute/path/to/project \
  --mount-ro reference=/absolute/path/to/reference
```

Use separate, non-overlapping host directories for different modes.
The JSON API is `http://127.0.0.1:8686`; the Codex endpoint is
`ws://127.0.0.1:8686/codex`. Configure it in Codex's `environments.toml` using the
[complete setup instructions](remote-sandbox-v86/docs/codex.md). No global Codex
configuration was changed during implementation or testing.

## Evidence

Tests were written before the mount guards, argv forwarding, adapter, and
filesystem implementation. Initial failures demonstrated writable read-only
mounts, missing adapters, and the absent WebSocket endpoint. All final checks pass:

| Check | Result |
| --- | --- |
| TypeScript validation and package build | Passed |
| Unit tests | 130 passed |
| Real-VM integration tests | 66 passed, none skipped |
| Python client tests using uv | 17 passed |
| Unpublished npm package through npx | Passed |

The installed **Codex CLI 0.154.0** was tested against a real v86 VM using four
deterministic localhost model responses. Codex's shell command reported
`architecture=i686`, read the reference mount, wrote the project mount, emitted
stderr, and failed to write to the read-only mount. Codex's native `apply_patch`
then created a writable project file and was denied on the read-only mount.
The host files were checked afterward. Codex, its transport, and the VM were
real; only model responses were simulated. No API key or paid inference was used.

Additional real-VM tests exercised 25 read-only mutation attempts, live host
updates, preserved paths, symlink/hardlink aliases, unchanged host metadata,
binary filesystem data, stdin arriving after output, catchable SIGINT,
termination, and descendant cleanup on disconnect. Existing HTTP, WebSocket,
Claude wrapper, and managed-proxy regression tests remain green.

The packaged test used `npx` to boot the distributed image with 256 MiB RAM,
checked the CLI mount modes, received separate stdout/stderr and exit status 5
through Codex RPC, wrote a host-visible project file, and verified a denied
read-only write left the reference file unchanged. The archive is 33,578,525
bytes, approximately **32.0 MiB**. It has not been published.

## Current limits

The experimental protocol is tested against Codex 0.154.0. PTYs, session
resumption, executor shell snapshots, and additional Codex platform sandboxes
are unsupported and return errors. Codex uses unrestricted execution inside
the VM; the server's mount and networking policies remain enforced. Filesystem
RPCs have an 8 MiB per-file limit. The existing guest agent reports some errno
values as `EIO` while preserving the correct message, including read-only
filesystem errors; the host bridge itself returns `EROFS`.

See the setup guide for remaining resource limits, hardlink behavior, and the
scope of the integration. The existing 0.1.0 archive and its size report remain
available as the previous package build.
