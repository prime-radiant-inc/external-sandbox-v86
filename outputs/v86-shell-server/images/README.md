# Linux guest image

`linux/image.json` describes the ready-to-boot image. It pins v86 0.5.458,
512 MiB RAM, asset sizes, and SHA-256 checksums. No Docker or native Linux VM
is needed to run this image. The guest has BusyBox, Bash, Python 3, and Git.

The initramfs boots Alpine x86 with Linux 6.12.109. `init` loads four kernel
modules and mounts the server's `host9p` virtio filesystem at `/mnt` using
`9p2000.L,cache=none`. Each named host directory appears below that mount.
The server always supplies this filesystem, including when no directories
were selected. Failure to load a module or mount the filesystem aborts boot
and writes a diagnostic to the serial console.

The optional `v86_mounts` kernel argument contains a base64url-encoded JSON
array of `{ "name": "mount-name", "paths": ["/absolute/guest/path"] }`
entries. Init bind-mounts these explicit aliases before starting the agent.
The server validates target paths before passing this argument.

`guest/agent/agent.c` is compiled inside the image. The agent handles framed
requests on ttyS1 and runs commands as UID/GID 1000. ttyS0 carries boot
diagnostics. `/workspace` is a writable, volatile guest working directory.

## Update the init script

```sh
node scripts/prepare-image.mjs
```

This pure Node.js build-time tool patches the bundled initramfs from
`images/init` and `images/modules/*.ko.gz`, preserves existing inode metadata
and hardlinks, and refreshes the image manifest. Repeated runs with unchanged
inputs produce identical bytes. It does not compile changes to `agent.c`;
use the full rebuild below for those changes.

## Rebuild the complete guest

```sh
node images/build.mjs
# Or retain the bundled image and write elsewhere:
node images/build.mjs --output ./work/rebuilt-linux
```

Requirements: Node.js 22 or later, Docker with `linux/386` support, and network
access to download the pinned inputs. Inputs are verified against
`sources.lock.json` and cached under `images/cache`. Docker builds with
`--network none` after downloads complete. The build compiles the C agent,
installs the pinned Alpine packages, retains the four virtio-9p modules, and
writes a new kernel, initramfs, BIOS files, package inventory, and manifest.

The kernel module files in `modules/` were extracted from the same pinned
`linux-virt-6.12.109-r0.apk` used to build the bundled kernel. Their hashes are
recorded in `linux/image.json`. No source path from the original project is
referenced by these build scripts or the application at runtime.
