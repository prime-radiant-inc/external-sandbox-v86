# Guest exec agent

`agent.c` implements the private protocol in [PROTOCOL.md](./PROTOCOL.md) with
POSIX process APIs, nonblocking pipes, and bounded framed JSON queues. It has
no third-party C dependencies. The application starts this program only
inside the v86 guest. Its native build exists exclusively for build-time tests.

Run the portable native tests with:

```sh
make -C guest/agent test
```

The tests launch the compiled agent as a child process and exercise real
filesystem and process behavior in temporary directories. On Linux when run
as root, the tests chown their temporary directories to UID/GID 1000 to match
the guest privilege model. Native macOS coverage does not replace actual
Linux/v86 integration, particularly for orphan reaping and serial transport.

Build the Linux image using the repository's `images/build.mjs` workflow. It
cross-builds a static 32-bit musl executable with pinned Alpine packages and
starts it as root with `--device /dev/ttyS1`. The serial device must be mode
0600 and root-owned; boot logs belong on ttyS0. The init recipe provides
`/workspace` and `/home/agent` owned by UID/GID 1000.

The agent temporarily uses that UID/GID for filesystem requests and fully
drops child command privileges. The root agent retains its transport and
process-control permissions. All transport descriptors are close-on-exec.
The entire v86 guest remains the host isolation boundary.
