# Additional Alpine packages

Use `--packages` to install software once during each VM startup:

```sh
external-sandbox-v86 --proxy-config /path/to/proxy-alpine.json \
  --packages uv,jq,ripgrep --mount-rw "project=$PWD"
```

For a source checkout, use `node dist/cli.js` and `--proxy-config examples/proxy-alpine.json`. The minimal policy is:

```json
{
  "allow": [
    {"origin": "https://dl-cdn.alpinelinux.org", "methods": ["GET", "HEAD"]}
  ]
}
```

`--packages uv,jq --packages ripgrep` and `--packages=uv,jq,ripgrep` are equivalent. Duplicate names are removed. Up to 64 plain Alpine package names are accepted; flags, URLs, local APK paths, whitespace, and version selectors are rejected. No package names are evaluated as shell code.

An explicit `--proxy-config` is required. Package setup uses the same host proxy policy as ordinary guest commands, without adding implicit allow rules. The example permits only Alpine package downloads. Additional registries need their own allow rules; installing npm or uv does not authorize their traffic.

## What startup does

The host appends a private bootstrap configuration to the in-memory initramfs. It contains package names, the public proxy CA, and the fixed guest proxy URL; it contains no host credentials. The bundled image on disk is unchanged by a server run. Guest init removes this configuration, configures HTTPS Alpine v3.21 `main` and `community` repositories, and runs `apk --no-cache add` as root before mounting host directories and starting the command agent.

TLS certificate validation and Alpine package signature checks remain enabled. Failed downloads, denied origins, missing packages, and install errors fail startup; the command API does not become ready with a partial installation. The install subprocess has a four-minute timeout, within a five-minute default boot deadline. Use `--verbose` to see boot and APK progress.

Ordinary commands continue running as UID/GID 1000, with no new root execution API. Installed packages live only in that VM's root filesystem and disappear on shutdown. A new launch downloads/installs them again. This option does not modify the host, build a persistent image, or cache packages on the host. Large dependency sets need sufficient `--memory` and take longer under x86 emulation. Custom images must advertise the startup-package capability and implement the same bootstrap contract; unsupported images fail explicitly.

## uv on this guest

The guest is Alpine 3.21 **x86**, not x86_64. Its community repository includes [uv 0.5.31-r0 for x86](https://pkgs.alpinelinux.org/package/v3.21/community/x86/uv), providing both `uv` and `uvx`. It is an older uv release, so newer uv options may not be available. With `--packages uv,jq`, these commands were verified through the real VM:

```sh
id -u                       # 1000
uv --version                # uv 0.5.31
jq --version                # jq-1.7.1
uv run --no-project --offline python -c 'print("guest uv executed Python")'
```

The offline example uses the guest's existing Python. To resolve/download Python packages, usually allow `https://pypi.org` and `https://files.pythonhosted.org`; packages using additional sources require their own rules. Available binary wheels depend on 32-bit musl compatibility; some packages need build tools or do not support this architecture. Managed Python downloads are a separate capability and are not promised by this test.

Proxy and CA environment settings are supplied to guest commands, including `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, and `NODE_USE_ENV_PROXY=1`. Node's automatic proxy support depends on the installed Node version and client; installing Alpine's Node package does not guarantee the Node 24 networking behavior of the separate Apple Container demo.

Run the public-repository test explicitly:

```sh
EXTERNAL_SANDBOX_TEST_PACKAGE_NETWORK=1 node --import tsx --test test/integration/startup-packages.test.ts
```

This downloads `uv` and `jq` from Alpine through verified HTTPS. The default suite still runs the offline deny-policy startup test. No API keys are used.
