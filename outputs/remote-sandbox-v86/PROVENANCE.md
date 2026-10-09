# Source and image provenance

This application reuses the guest agent, pinned build inputs, and Alpine
boot assets from the user's earlier `exec-server-v86` project. The original
project was read only during assembly. All files needed to run this app are
included here or installed by npm; it has no dependency on that original
checkout.

- `guest/agent/agent.c`, its Makefile, native tests, and protocol documentation
  were copied unchanged. The C source SHA-256 is
  `bacee19f548cbbc7b7e52144a81c70eabea0a8691a2a778c6608b2f1bb930739`.
  No standalone license file was present in the original project.
- The original `dev-linux` initramfs SHA-256 was
  `731ab294bcdba73b9ea8f7baf70a3d70f623cdba3d72e5e3cc6d0a2b02b19f05`.
  It was repacked with the updated `images/init`, the four 9p modules, and
  the three optional networking modules (`failover`, `net_failover`, `virtio_net`);
  other archive records were preserved. Current asset hashes are in
  `images/linux/image.json`.
- The kernel and modules come from Alpine's x86
  `linux-virt-6.12.109-r0.apk`, SHA-256
  `3833870669441684fe9edb2b22c79fa339ab1d1116f65a5946ccd91d6a40612f`.
  Its package metadata identifies `GPL-2.0-only`, origin `linux-lts`, and
  Alpine aports commit `27ab7d9afedda2c0383cb846499d23cb2124ba40`.
  [Alpine kernel build sources](https://gitlab.alpinelinux.org/alpine/aports/-/tree/27ab7d9afedda2c0383cb846499d23cb2124ba40/main/linux-lts)
  describe the upstream Linux source and patches.
- The base root filesystem is Alpine 3.21.0 x86. The complete pinned package
  download URLs and hashes are in `images/sources.lock.json`; the runtime
  package inventory is `images/linux/packages.txt`. Package license and
  source-origin metadata is also retained inside the guest's APK database
  (`/lib/apk/db/installed`). Alpine packages retain their respective upstream
  licenses; the application does not relicense them.
- SeaBIOS and VGA BIOS are the binaries from
  [v86 revision d96be774e549a83371b038b86e819804c96b921f](https://github.com/copy/v86/tree/d96be774e549a83371b038b86e819804c96b921f/bios).
  Their upstream projects are [SeaBIOS](https://www.seabios.org/) and
  [VGABIOS](https://www.nongnu.org/vgabios/).
- The JavaScript/WebAssembly emulator is npm package `v86` version 0.5.458.
  Its BSD-style two-clause license is distributed by the npm package and
  reproduced in `images/V86-LICENSE`.
- The optional managed proxy uses npm package `node-forge` version 1.4.0
  to generate ephemeral host-side X.509 certificates. Actual TLS connections
  use Node's built-in TLS implementation. The dependency's license is bundled
  in its npm package; no private key or upstream API credential enters the guest.

`images/build.mjs` and `images/build-in-container.sh` provide a complete
source-based guest rebuild; `scripts/prepare-image.mjs` provides the fast
deterministic initramfs patch used for the bundled image. The build recipes
were adapted from the original project to retain the 9p module dependency
closure and mount the selected host directories before starting the agent.
The managed-proxy branch also retains the virtio-net dependency closure from
the same checksum-verified kernel package. The pinned kernel version and
original guest agent are unchanged.

The browser terminal, Copy session feature, proxy editor HTML/CSS/JavaScript,
and browser client tests were copied or ported from the user's Python
`sandbox-exec-server` project, checked at commit
`6e851e3324622bb8a0e9c252d840e03b72f2908b`. Terminal JavaScript is copied
unchanged; server routes and live proxy management are adapted to Node.js.
All assets are bundled here, with no runtime dependency on that checkout.

Startup package support extends `images/init` and repacks the base initramfs.
At runtime a separate in-memory archive supplies package names and the public
CA; downloaded packages are installed only inside the ephemeral VM. The base
package inventory describes the bundled image, before optional installation.
