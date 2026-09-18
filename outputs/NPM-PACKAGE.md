# v86-shell-server npm package

Built `v86-shell-server@0.1.0` as an installable npm archive. **Not published.**
The package retains `private: true` to prevent accidental publication.

[Download the package](v86-shell-server-0.1.0.tgz) ·
[Machine-readable measurements](npm-package-report.json) ·
[Commands and verification output](npm-package-verification.log)

## Size

| Measurement | Bytes | MiB |
| --- | ---: | ---: |
| Package download, compressed | 33,548,089 | 32.0 |
| Package unpacked, 106 files | 34,243,178 | 32.7 |
| Three runtime dependency downloads | 4,421,647 | 4.2 |
| All four npm archives combined | 37,969,736 | 36.2 |
| Fresh installation, including dependencies | 54,539,489 | 52.0 |

MiB means 1,048,576 bytes. Installed size is the sum of file lengths in a fresh
production `node_modules`, including its npm metadata; filesystem allocation
can be larger. These figures exclude npm/uv caches, Node itself, Python and the
optional Python client dependency, and running VM memory. The default guest
RAM allocation is 512 MiB.

The compressed initramfs and Linux kernel account for nearly all of the package
download. Keeping them bundled makes installation straightforward: no guest
image download or build is needed at first boot. Splitting out the image would
mostly move that download to a later step.

## Run with npx

Requires Node.js 22+ and npm. The package targets macOS and Linux; Windows is
currently excluded. No Docker, native compiler, or separate proxy service is
required.

From the directory containing the downloaded archive:

```sh
npx --yes --package ./v86-shell-server-0.1.0.tgz \
  v86-shell-server --mount "project=$PWD"
```

This boots Linux and serves the API on `http://127.0.0.1:8686`, with the current
directory mounted read/write at `/mnt/project`. Use an absolute archive path to
run from another project directory. Repeat `--mount` for additional directories;
add `--port 9000` to choose another localhost port. Stop with Ctrl-C.

Use the explicit `--package` form for local tarballs. Testing the shorthand
`npx /path/to/archive.tgz` failed because npm tried to execute the archive.
The explicit form above passed. npm installs requested packages in its cache;
see the official [npm exec/npx documentation](https://docs.npmjs.com/cli/v11/commands/npm-exec/).

Networking remains disabled by default. To enable the embedded policy proxy,
add `--proxy-config /path/to/proxy.json`; policy files and real credentials stay
outside the package. See the [proxy guide](v86-shell-server/docs/proxy.md).

## Install once

```sh
npm install --global ./v86-shell-server-0.1.0.tgz
v86-shell-server --mount "project=$PWD"
```

Or install it into a project:

```sh
npm install --save-dev /absolute/path/to/v86-shell-server-0.1.0.tgz
npx --no-install v86-shell-server --mount "project=$PWD"
```

The archive contains compiled JavaScript and needs no install scripts. Its three
runtime dependencies are pinned: `v86@0.5.458`, `node-forge@1.4.0`, and `ws@8.21.3`.

## Streaming client

Install [uv](https://docs.astral.sh/uv/) for the bundled Python client. After a
global package install, run this from a directory mounted by the running server:

```sh
v86-exec 'printf "hello from Linux\n"; printf "stderr\n" >&2; exit 7'
```

Without a global install:

```sh
npx --yes --package ./v86-shell-server-0.1.0.tgz \
  v86-exec 'printf "hello from Linux\n"'
```

The new `v86-exec` executable locates the Python script through npm's executable
links and forwards commands, stdin, output, exit codes, and cancellation. The
server itself does not need uv. Full instructions, including Claude Code setup,
are in the [package guide](v86-shell-server/docs/npm.md).

## Verification

Tested on macOS ARM64 using Node 24.14.1 and npm 11.16.0. Linux is a supported
target but was not tested in this packaging run.

- Four launcher tests were written first and passed, including npm-style
  symlinks, literal command/stdin forwarding, exit status, missing uv, and signals.
- TypeScript checking and the package build passed.
- A fresh install with `--omit=dev --ignore-scripts` succeeded.
- Both the installed binaries and `npx` booted the bundled image from a different
  working directory, with 256 MiB guest RAM. Observed startup was 4.7 and 5.4
  seconds respectively; these are single runs, not benchmarks.
- JSON execution returned the correct stdout, stderr, and exit status 23.
- The streaming client emitted both output streams before input arrived, accepted
  later stdin, wrote a file through the mount, and exited with status 7.
- The package allowlist was checked for required assets and exclusion of local
  configurations, environment files, private keys, caches, and dependencies.

SHA-256:

```text
a174728a082284c105ecee612d15a5939afd5133ea12cc499bb31fab5b1f3990
```

## Publishing later

After a registry name is chosen and the package is published, the command could
become `npx v86-shell-server@0.1.0 --mount "project=$PWD"`. This is illustrative;
the current name has not been reserved or checked for availability. Publishing
also requires choosing the project license and reviewing bundled component
notices/source distribution before deliberately removing `private`.

Source changes are on `feature/npm-package`. To build another archive from the
source checkout, run `npm ci` followed by `npm pack --pack-destination ..`.
