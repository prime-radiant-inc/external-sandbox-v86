# npm package and npx

The application is published to npm as [`external-sandbox-v86`](https://www.npmjs.com/package/external-sandbox-v86). It installs without compiling TypeScript or rebuilding the guest: the package includes compiled JavaScript, a bootable Linux image, and image source/provenance. Runtime dependencies are installed by npm. No Docker, native compiler, or separate proxy service is needed.

Requires Node.js 22 or later with npm on macOS or Linux. Windows is currently excluded because the mount implementation assumes POSIX behavior.

## Run with npx

```sh
npx external-sandbox-v86 --help
npx external-sandbox-v86 --mount "project=$PWD"
```

The second command stays in the foreground and serves the API on `http://127.0.0.1:8686`, including the browser terminal at `/`. Stop it with Ctrl-C. First use downloads the package and its three runtime dependencies into npm's cache; later runs can reuse that cache. The guest image is already in the package and is not downloaded by an install hook.

For managed networking, put your policy in a separate file and add `--proxy-config /path/to/proxy.json`. See [the proxy guide](proxy.md). The config path and mounted directories are resolved from your working directory; bundled VM assets are resolved from the installed package.

## Install once

For a command available on your PATH:

```sh
npm install --global external-sandbox-v86
external-sandbox-v86 --mount "project=$PWD"
```

Or install into an existing project:

```sh
npm install --save-dev external-sandbox-v86
npx --no-install external-sandbox-v86 --mount "project=$PWD"
```

Installing the package requires no lifecycle scripts; environments which disable install scripts can still run it. Building or packing this source checkout does require its development dependencies and `prepack` build step.

## Run from a local archive

A tarball produced by `npm pack` (see below) installs and runs the same way, which is useful for testing a build before it is released:

```sh
npx --yes --package ./external-sandbox-v86-0.3.0.tgz external-sandbox-v86 --help
npx --yes --package ./external-sandbox-v86-0.3.0.tgz external-sandbox-v86 --mount "project=$PWD"
npm install --global ./external-sandbox-v86-0.3.0.tgz
```

Use the explicit `--package` form for a local tarball. Passing the archive path directly as the `npx` command can make npm try to execute the archive itself.

## Streaming client and Claude Code

The npm package provides the `external-sandbox-v86` server command. Shell clients and Claude Code wrappers are maintained once in [external-sandbox/claude-code](https://github.com/prime-radiant-inc/external-sandbox/tree/main/claude-code), with shared setup instructions and tests for both backends. The previous `external-sandbox-v86-exec` command and bundled client scripts have been removed; use the shared Python client or prefix wrapper with `EXTERNAL_SANDBOX_API_URL=http://127.0.0.1:8686`.

Mount the project with `--preserve-paths --mount "project=$PWD"` when Claude needs its host working-directory path to work inside the VM. The shared guide covers the Claude process's shell prefix and temporary-directory settings.

## Produce the package

From a source checkout:

```sh
npm ci
mkdir -p /path/to/output-directory
npm pack --pack-destination /path/to/output-directory
```

`npm pack` does not create the destination directory. `prepack` builds `dist/`. The explicit `files` allowlist includes runtime assets and selected source/rebuild documentation. It excludes dependencies, test scratch space, download caches, environment files, local proxy configurations, and generated archives. `package-lock.json` is retained in the repository; the three runtime dependency versions in `package.json` are pinned exactly.

The project's own source is licensed under Apache 2.0 (`LICENSE`). The package does not assign a new license to its third-party guest components; see [provenance](../PROVENANCE.md) for their sources and licenses.

## Releasing

Releases are published by the [`publish.yml`](../.github/workflows/publish.yml) GitHub Actions workflow using npm [trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored in the repository. To release:

1. Update `version` in `package.json` and commit.
2. Create a GitHub release whose tag is that version, with or without a leading `v` (for example `0.3.1` or `v0.3.1`).

The workflow checks that the tag matches `package.json`, runs `npm run check` and `npm test`, then runs `npm publish`, whose `prepack` step builds `dist/`. The real-VM integration suite does not run in the workflow; run `npm run test:integration` locally before tagging.

On npmjs.com, the package's **Settings → Trusted publishing** lists GitHub Actions with organization `prime-radiant-inc`, repository `external-sandbox-v86`, and workflow `publish.yml`. The `repository.url` in `package.json` must keep matching this GitHub repository for publishing to succeed.

References: [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/), [npm exec/npx](https://docs.npmjs.com/cli/v11/commands/npm-exec/), [package.json fields](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/), and [trusted publishers](https://docs.npmjs.com/trusted-publishers).
