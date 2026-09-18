# npm package and npx

The application can be installed from an npm `.tgz` without compiling TypeScript
or rebuilding the guest. It includes compiled JavaScript, a bootable Linux image,
the Python client, and image source/provenance. Runtime dependencies are installed
by npm. No Docker, native compiler, or separate proxy service is needed.

The package is **not published**. `private: true` intentionally prevents npm
publication while still allowing local tarball installs. These commands use the
local archive, not an existing registry package that happens to share its name.

## Run from a downloaded archive

Requires Node.js 22 or later with npm on macOS or Linux. Windows is currently
excluded because the mount implementation and client signal handling assume
POSIX behavior.

From the directory containing the downloaded package:

```sh
npx --yes --package ./v86-shell-server-0.3.0.tgz v86-shell-server --help
npx --yes --package ./v86-shell-server-0.3.0.tgz v86-shell-server --mount "project=$PWD"
```

The second command stays in the foreground and serves the API on
`http://127.0.0.1:8686`, including the browser terminal at `/`. Stop it with Ctrl-C. First use downloads the three runtime
dependencies into npm's cache; later runs can reuse that cache. The guest image
is already in the package and is not downloaded by an install hook.

Use the explicit `--package` form for a local tarball. Passing the archive path
directly as the `npx` command can make npm try to execute the archive itself.

For managed networking, put your policy in a separate file and add
`--proxy-config /path/to/proxy.json`. See [the proxy guide](proxy.md). The config
path and mounted directories are resolved from your working directory; bundled
VM assets are resolved from the installed package.

## Install once

For a command available on your PATH:

```sh
npm install --global ./v86-shell-server-0.3.0.tgz
v86-shell-server --mount "project=$PWD"
```

Or install into an existing project:

```sh
npm install --save-dev /absolute/path/to/v86-shell-server-0.3.0.tgz
npx --no-install v86-shell-server --mount "project=$PWD"
```

Installing a prebuilt tarball requires no lifecycle scripts; environments which
disable install scripts can still run it. Building or packing this source
checkout does require its development dependencies and `prepack` build step.

## Streaming client and Claude Code

The package provides a second executable, `v86-exec`, which locates the bundled
Python client correctly through npm's executable links. Install
[uv](https://docs.astral.sh/uv/) to use it; the server itself needs only Node/npm.

With the server running and the working directory mounted:

```sh
npx --yes --package ./v86-shell-server-0.3.0.tgz v86-exec 'printf "hello from Linux\\n"'
# After a global install:
v86-exec 'printf "stdout\\n"; printf "stderr\\n" >&2; exit 7'
```

`v86-exec` forwards the complete command as an argument to the Python client. It
does not evaluate it on the host. stdout, stderr, stdin, exit status, and
cancellation retain the existing client's behavior. On first use, uv resolves
its pinned Python dependency and can download a suitable Python interpreter.

After a global install, Claude Code can use `CLAUDE_CODE_SHELL_PREFIX` pointing
to the installed `v86-exec` command. Retain the mount, `--preserve-paths`, and
temporary-directory setup described in the [main README](../README.md).

## Produce the package

From a source checkout:

```sh
npm ci
npm pack --pack-destination /path/to/output-directory
```

`prepack` builds `dist/`. The explicit `files` allowlist includes runtime assets
and selected source/rebuild documentation. It excludes dependencies, test
scratch space, download caches, environment files, local proxy configurations,
and generated archives. `package-lock.json` is retained in the repository;
the three runtime dependency versions in `package.json` are pinned exactly.

## If published later

Once a registry name/version has been chosen and published, usage could become:

```sh
# Illustrative only: this version has not been published.
npx v86-shell-server@0.3.0 --mount "project=$PWD"
npm install --global v86-shell-server@0.3.0
```

The current name has not been reserved or checked for registry availability.
Before publishing, choose the project's source license and review the bundled
components' notices/source distribution, then deliberately remove `private`.
The package does not assign a new license to its third-party guest components.

References: [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/),
[npm exec/npx](https://docs.npmjs.com/cli/v11/commands/npm-exec/), and
[package files/bin/private](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/).
