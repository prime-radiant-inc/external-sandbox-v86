# v86 shell sandbox experiments

The application is in [`outputs/v86-shell-server`](outputs/v86-shell-server). It runs Linux in v86/WebAssembly and exposes localhost JSON and WebSocket command APIs, live host directory mounts, and a Python streaming client for shell integrations.

- [`outputs/v86-shell-server/README.md`](outputs/v86-shell-server/README.md): setup, API, tests, and Claude Code shell prefix.
- [`outputs/v86-demo`](outputs/v86-demo): software built and tested through the sandbox client, with command transcripts.
- [`work`](work): reproducible resource measurements and earlier integration experiments.

Install and test from the application directory:

```sh
cd outputs/v86-shell-server
npm ci
npm run build
npm test
npm run test:python
npm run test:integration
```

Bootable image assets are included with pinned provenance and rebuild scripts.
Dependencies, compiled JavaScript, download caches, local credentials, and the
redundant distribution archive are excluded from version control.

Browser assets and frontend tests are copied from a versioned `exec-server-ui` release and committed with a source commit and file hashes. See the [shared UI workflow](outputs/v86-shell-server/docs/browser-ui.md#updating-the-shared-ui) for updating that copy. Ordinary builds and installed packages are self-contained.
