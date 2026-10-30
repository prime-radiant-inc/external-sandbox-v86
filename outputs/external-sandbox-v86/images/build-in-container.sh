#!/bin/sh
set -eu
set -o pipefail
umask 022
apk add --no-network --no-scripts /cache/apks/*.apk
cc -O2 -std=c11 -Wall -Wextra -Werror -static -s "/src/${AGENT_SOURCE:-guest/agent/agent.c}" -o /tmp/v86-agent
mkdir -p /rootfs
tar -xzf /cache/alpine-minirootfs-3.21.0-x86.tar.gz -C /rootfs
# The cache is a checksum-verified complete package closure. No repository
# resolution or network is permitted in this build phase.
apk --root /rootfs --no-network --no-scripts add /cache/apks/*.apk
mkdir -p /rootfs/usr/local/sbin
cp /tmp/v86-agent /rootfs/usr/local/sbin/v86-agent
cp /rootfs/boot/vmlinuz-virt /out/bzimage
cp /cache/seabios.bin /out/seabios.bin
cp /cache/vgabios.bin /out/vgabios.bin
cp "/src/${INIT_SOURCE:-images/init}" /rootfs/init
chmod 0755 /rootfs/init
printf 'agent:x:1000:1000:Guest agent:/home/agent:/bin/sh\n' >> /rootfs/etc/passwd
printf 'agent:x:1000:\n' >> /rootfs/etc/group
printf 'v86-exec\n' > /rootfs/etc/hostname
# No credentials or inherited host files enter this root filesystem.
rm -f /rootfs/etc/resolv.conf
mkdir -p /rootfs/workspace /rootfs/home/agent
chown 1000:1000 /rootfs/workspace /rootfs/home/agent
# Remove the compiler toolchain from the runtime filesystem.
apk --root /rootfs --no-network --no-scripts del gcc musl-dev cpio binutils gmp isl26 mpc1 mpfr4 libstdc++ libgomp libatomic jansson
# Installing from local files records each world entry with a checksum pin.
# Plain names let runtime package installs upgrade these packages from the
# repository when a newer package depends on a newer build.
sed -i 's/><[^[:space:]]*$//' /rootfs/etc/apk/world
apk --root /rootfs info -v | LC_ALL=C sort > /out/packages.txt
# Keep the virtio-9p and optional virtio-net dependency closures.
mkdir -p /rootfs/usr/local/lib/v86-modules
for module in fs/netfs/netfs net/9p/9pnet net/9p/9pnet_virtio fs/9p/9p net/core/failover drivers/net/net_failover drivers/net/virtio_net; do
    gzip -dc "/rootfs/lib/modules/6.12.109-0-virt/kernel/$module.ko.gz" > "/rootfs/usr/local/lib/v86-modules/${module##*/}.ko"
done
rm -rf /rootfs/boot /rootfs/lib/modules /rootfs/usr/lib/gcc /rootfs/usr/include /rootfs/usr/share/man /rootfs/usr/share/doc /rootfs/var/cache/apk
# Busybox applet links normally come from package triggers, suppressed above.
chroot /rootfs /bin/busybox --install -s
cd /rootfs
find . -exec touch -h -t 202412050000.00 {} +
find . -print0 | LC_ALL=C sort -z | cpio --null -o --format=newc --reproducible 2>/out/cpio.log | gzip -9n > /out/initrd.img
