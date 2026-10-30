# npm package and npx

The application can be installed from an npm `.tgz` without compiling TypeScript or rebuilding the guest. It includes compiled JavaScript, a bootable Linux image, and image source/provenance. Runtime dependencies are installed by npm. No Docker, native compiler, or separate proxy service is needed.

The package is named `external-sandbox-v86` and is **not published**. `private: true` intentionally prevents npm publication while still allowing local tarball installs. These commands use the local archive, not an existing registry package that happens to share its name.

## Run from a downloaded archive

Requires Node.js 22 or later with npm on macOS or Linux. Windows is currently excluded because the mount implementation assumes POSIX behavior.

From the directory containing the downloaded package:

```sh
npx --yes --package ./external-sandbox-v86-0.3.0.tgz external-sandbox-v86 --help
npx --yes --package ./external-sandbox-v86-0.3.0.tgz external-sandbox-v86 --mount "project=$PWD"
```

The second command stays in the foreground and serves the API on `http://127.0.0.1:8686`, including the browser terminal at `/`. Stop it with Ctrl-C. First use downloads the three runtime dependencies into npm's cache; later runs can reuse that cache. The guest image is already in the package and is not downloaded by an install hook.

Use the explicit `--package` form for a local tarball. Passing the archive path directly as the `npx` command can make npm try to execute the archive itself.

For managed networking, put your policy in a separate file and add `--proxy-config /path/to/proxy.json`. See [the proxy guide](proxy.md). The config path and mounted directories are resolved from your working directory; bundled VM assets are resolved from the installed package.

## Install once

For a command available on your PATH:

```sh
npm install --global ./external-sandbox-v86-0.3.0.tgz
external-sandbox-v86 --mount "project=$PWD"
```

Or install into an existing project:

```sh
npm install --save-dev /absolute/path/to/external-sandbox-v86-0.3.0.tgz
npx --no-install external-sandbox-v86 --mount "project=$PWD"
```

Installing a prebuilt tarball requires no lifecycle scripts; environments which disable install scripts can still run it. Building or packing this source checkout does require its development dependencies and `prepack` build step.

## Streaming client and Claude Code

The npm package provides the `external-sandbox-v86` server command. Shell clients and Claude Code wrappers are maintained once in [external-sandbox/claude-code](https://github.com/prime-radiant-inc/external-sandbox/tree/main/claude-code), with shared setup instructions and tests for both backends. The previous `external-sandbox-v86-exec` command and bundled client scripts have been removed; use the shared Python client or prefix wrapper with `EXTERNAL_SANDBOX_API_URL=http://127.0.0.1:8686`.

Mount the project with `--preserve-paths --mount "project=$PWD"` when Claude needs its host working-directory path to work inside the VM. The shared guide covers the Claude process's shell prefix and temporary-directory settings.

## Produce the package

From a source checkout:

```sh
npm ci
npm pack --pack-destination /path/to/output-directory
```

`prepack` builds `dist/`. The explicit `files` allowlist includes runtime assets and selected source/rebuild documentation. It excludes dependencies, test scratch space, download caches, environment files, local proxy configurations, and generated archives. `package-lock.json` is retained in the repository; the three runtime dependency versions in `package.json` are pinned exactly.

## If published later

Once a registry name/version has been chosen and published, usage could become:

```sh
# Illustrative only: this version has not been published.
npx external-sandbox-v86@0.3.0 --mount "project=$PWD"
npm install --global external-sandbox-v86@0.3.0
```

The current name has not been reserved or checked for registry availability. Before publishing, choose the project's source license and review the bundled components' notices/source distribution, then deliberately remove `private`. The package does not assign a new license to its third-party guest components.

References: [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/), [npm exec/npx](https://docs.npmjs.com/cli/v11/commands/npm-exec/), and [package files/bin/private](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/).
