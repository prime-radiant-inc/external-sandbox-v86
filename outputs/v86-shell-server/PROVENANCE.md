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
  It was repacked with the updated `images/init` and the four 9p modules;
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

`images/build.mjs` and `images/build-in-container.sh` provide a complete
source-based guest rebuild; `scripts/prepare-image.mjs` provides the fast
deterministic initramfs patch used for the bundled image. The build recipes
were adapted from the original project to retain the 9p module dependency
closure and mount the selected host directories before starting the agent.
