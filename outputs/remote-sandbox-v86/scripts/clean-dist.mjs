import { rm } from 'node:fs/promises';

// Removed entry points must not survive a rebuild or enter the npm tarball.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
