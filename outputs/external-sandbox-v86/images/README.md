# Linux guest image

`linux/image.json` describes the ready-to-boot image. It pins v86 0.5.458,
512 MiB RAM, asset sizes, and SHA-256 checksums. No Docker or native Linux VM
is needed to run this image. The guest has BusyBox, Bash, Python 3, Git, and
ripgrep.

The initramfs boots Alpine x86 with Linux 6.12.109. `init` loads four kernel
modules and mounts the server's `host9p` virtio filesystem at `/mnt` using
`9p2000.L,cache=none`. Each named host directory appears below that mount.
The server always supplies this filesystem, including when no directories
were selected. Failure to load a module or mount the filesystem aborts boot
and writes a diagnostic to the serial console.

Networking remains disabled unless the server passes `v86_network=proxy`.
In that mode init loads `failover`, `net_failover`, and `virtio_net`, configures
`eth0` as `192.168.86.100/24`, and uses `192.168.86.1` as its virtual gateway.
The host Wisp relay can dial only the managed HTTP proxy; it never dials a
guest-requested destination directly. Guest DNS is left unconfigured, and
v86's internal DNS mode is explicitly static to prevent its default DoH path
from making requests outside the managed proxy.

The server installs the proxy's public CA certificate at
`/home/agent/.v86-proxy-ca.pem` after boot and supplies proxy and CA environment
variables to commands. No CA private key or upstream API credential enters
the image. The guest user can replace its own public trust file; doing so
does not change the host policy or grant additional egress.

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

## Add a package to the bundled guest

```sh
node images/add-package.mjs apks/NAME-VERSION.apk
```

The package must be pinned in `sources.lock.json`, and its dependencies must
already be in the image. This tool unpacks the bundled initramfs in Docker with
`--network none`, installs that one package, repacks the initramfs, and
refreshes the package inventory and manifest. The kernel and every other
installed package stay as they are. It requires Docker with `linux/386` support.

## Rebuild the complete guest

Alpine's mirror keeps only the current build of each package on a stable branch,
and some inputs pinned in `sources.lock.json`, including the kernel, musl, and
Python, are no longer available there. A complete rebuild needs those pins
refreshed first, which upgrades the kernel and requires re-extracting
`images/modules/`.


```sh
node images/build.mjs
# Or retain the bundled image and write elsewhere:
node images/build.mjs --output ./work/rebuilt-linux
```

Requirements: Node.js 22 or later, Docker with `linux/386` support, and network
access to download the pinned inputs. Inputs are verified against
`sources.lock.json` and cached under `images/cache`. Docker builds with
`--network none` after downloads complete. The build compiles the C agent,
installs the pinned Alpine packages, retains the four virtio-9p modules and
three virtio-net modules, and
writes a new kernel, initramfs, BIOS files, package inventory, and manifest.

The kernel module files in `modules/` were extracted from the same pinned
`linux-virt-6.12.109-r0.apk` used to build the bundled kernel. Their hashes are
recorded in `linux/image.json`. No source path from the original project is
referenced by these build scripts or the application at runtime.
