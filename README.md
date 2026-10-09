# remote-sandbox-v86

The application is in [`outputs/remote-sandbox-v86`](outputs/remote-sandbox-v86). It runs Linux in v86/WebAssembly and exposes localhost JSON and WebSocket command APIs and live host directory mounts. Shared shell clients and Claude Code integration live in [remote-sandbox/claude-code](https://github.com/prime-radiant-inc/remote-sandbox/tree/main/claude-code).

- [`outputs/remote-sandbox-v86/README.md`](outputs/remote-sandbox-v86/README.md): setup, API, tests, and connection details for shared clients.
- [`outputs/v86-demo`](outputs/v86-demo): software built and tested through the sandbox client, with command transcripts.
- [`work`](work): reproducible resource measurements and earlier integration experiments.

Install and test from the application directory:

```sh
cd outputs/remote-sandbox-v86
npm ci
npm run build
npm test
npm run test:integration
```

Bootable image assets are included with pinned provenance and rebuild scripts. Dependencies, compiled JavaScript, download caches, local credentials, and the redundant distribution archive are excluded from version control.

Browser assets and frontend tests are copied from a versioned `remote-sandbox-ui` release and committed with a source commit and file hashes. See the [shared UI workflow](outputs/remote-sandbox-v86/docs/browser-ui.md#updating-the-shared-ui) for updating that copy. Ordinary builds and installed packages are self-contained.

Historical verification reports, archive checksums, and demo transcripts in `outputs/` and `work/` retain the project names and paths used when those results were recorded. Current application source and commands use `remote-sandbox-v86`; guest image provenance and v86 engine identifiers are preserved.
