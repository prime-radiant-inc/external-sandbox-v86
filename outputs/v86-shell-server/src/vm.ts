import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { V86 } from 'v86';
import { GuestClient, GuestError, type GuestEvent } from './guest/client.js';
import { startGuestProcess } from './guest/process.js';
import type { OutputHandler, StreamExecRequest, StreamingProcess } from './streaming.js';
import { createHostFilesystem, type Mount } from './host-filesystem.js';
import type { ExecRequest, ExecResult } from './http.js';
import { startProxyRelay, GUEST_PROXY_URL, type ProxyRelay } from './network/wisp-relay.js';
import { installV86NetworkGuard } from './network/v86-network-guard.js';

export interface VMMount extends Mount { preservedPaths?: string[] }
export interface VMOptions {
  image: string;
  mounts: VMMount[];
  memoryMiB?: number;
  bootTimeoutMs?: number;
  onBootLog?: (text: string) => void;
  /** Host-local managed proxy. Only its public CA and placeholder environment enter the guest. */
  managedNetwork?: { proxyPort: number; caCertificate: string; env?: Record<string, string> };
}
interface Asset { path: string; sha256: string }

async function asset(directory: string, value: Asset): Promise<ArrayBuffer> {
  if (!value || typeof value.path !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Invalid image manifest');
  const file = path.resolve(directory, value.path);
  const relative = path.relative(directory, file);
  if (path.isAbsolute(value.path) || relative === '..' || relative.startsWith('../')) throw new Error('Image asset escapes its directory');
  const bytes = await readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== value.sha256) throw new Error(`Image checksum mismatch: ${value.path}`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Commands only cross the serial protocol. No host process execution. */
export class ShellVM {
  private stopped = false;
  private active = 0;
  private constructor(
    private readonly emulator: V86,
    private readonly guest: GuestClient,
    private readonly filesystem: Awaited<ReturnType<typeof createHostFilesystem>>,
    private readonly options: VMOptions,
    private readonly relay?: ProxyRelay,
  ) {}

  static async boot(options: VMOptions): Promise<ShellVM> {
    const directory = path.resolve(options.image);
    const manifest = JSON.parse(await readFile(path.join(directory, 'image.json'), 'utf8'));
    if (manifest.formatVersion !== 1 || manifest.v86Version !== '0.5.458') throw new Error('Expected image format 1 for v86 0.5.458');
    const memory = options.memoryMiB ?? 512;
    if (!Number.isSafeInteger(memory) || memory < 128 || memory > 2048) throw new Error('Memory must be 128–2048 MiB');
    const [bios, vga, kernel, initrd] = await Promise.all(['bios', 'vgaBios', 'bzimage', 'initrd'].map(key => asset(directory, manifest.assets[key])));
    const aliases = options.mounts.filter(m => m.preservedPaths?.length).map(m => ({ name: m.name, paths: m.preservedPaths }));
    const cmdline = manifest.cmdline + (aliases.length ? ` v86_mounts=${Buffer.from(JSON.stringify(aliases)).toString('base64url')}` : '') + (options.managedNetwork ? ' v86_network=proxy' : '');
    if (Buffer.byteLength(cmdline) > 2000) throw new Error('Too many preserved paths for the Linux kernel command line; shorten paths or omit --preserve-paths');
    const filesystem = await createHostFilesystem(options.mounts);
    const require = createRequire(import.meta.url);
    let relay: ProxyRelay | undefined;
    let emulator: V86;
    try {
      if (options.managedNetwork) relay = await startProxyRelay({ proxyPort: options.managedNetwork.proxyPort });
      emulator = new V86({
        wasm_path: path.join(path.dirname(require.resolve('v86')), 'v86.wasm'),
        memory_size: memory * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024,
        bios: { buffer: bios }, vga_bios: { buffer: vga }, bzimage: { buffer: kernel }, initrd: { buffer: initrd },
        cmdline, uart1: true, autostart: false,
        filesystem: { handle9p: filesystem.handle9p },
        disable_keyboard: true, disable_mouse: true, disable_speaker: true,
        // Static DNS stays entirely inside v86. Wisp's default DoH would make host
        // fetch() requests outside the policy proxy, so it must never be enabled.
        ...(relay ? { net_device: { type: 'virtio' as const, relay_url: relay.relayUrl, dns_method: 'static' as const } } : {}),
      });
    } catch (error) { await relay?.close(); await filesystem.close(); throw error; }
    const guest = new GuestClient(frame => emulator.serial_send_bytes(1, frame));
    const vm = new ShellVM(emulator, guest, filesystem, options, relay);
    guest.setMaxListeners(40);
    emulator.add_listener('serial1-output-byte', (value: number) => guest.feed(Uint8Array.of(value)));
    let log = '';
    emulator.add_listener('serial0-output-byte', (value: number) => {
      const char = String.fromCharCode(value);
      log = (log + char).slice(-8000);
      options.onBootLog?.(char);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Guest boot timed out.\n${log}`)); }, options.bootTimeoutMs ?? 180_000);
        const cleanup = () => { clearTimeout(timer); guest.off('event', event); guest.off('failure', fail); };
        const fail = (error: Error) => { cleanup(); reject(error); };
        const event = (message: GuestEvent) => {
          if (message.event !== 'ready') return;
          cleanup();
          if (message.version !== 1) reject(new Error('Unsupported guest agent protocol')); else resolve();
        };
        guest.on('event', event); guest.on('failure', fail);
        emulator.add_listener('emulator-loaded', () => {
          try {
            if (relay) {
              const guard = installV86NetworkGuard((emulator as unknown as { network_adapter: unknown }).network_adapter,
                () => guest.fail(new Error('Managed network buffer limit exceeded; VM stopped')),
                (id, bytes) => relay!.acknowledgeReceive(id, bytes));
              relay.setGuestQueueSize(id => guard.queuedBytes(id));
            }
            void emulator.run();
          } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        });
      });
      guest.on('failure', () => { void vm.destroy().catch(() => {}); });
      if (options.managedNetwork) {
        const encoded = Buffer.from(options.managedNetwork.caCertificate).toString('base64');
        const setup = await vm.execute({ command: `umask 077; printf '%s' '${encoded}' | base64 -d > /home/agent/.v86-proxy-ca.pem`, cwd: '/home/agent' });
        if (setup.exitCode !== 0) throw new Error('Failed to install managed proxy public CA in guest');
      }
      return vm;
    } catch (error) { await vm.destroy(); throw error; }
  }

  info() {
    return {
      status: this.stopped ? 'stopped' : 'ready', backend: 'v86', architecture: 'i686',
      shell: '/bin/bash', network: this.relay ? 'managed-http' : false,
      mounts: this.options.mounts.map(m => ({ ...m, guestPath: `/mnt/${m.name}` })),
      defaultCwd: this.options.mounts[0] ? `/mnt/${this.options.mounts[0].name}` : '/workspace',
      activeCommands: this.active,
    };
  }

  async start(request: StreamExecRequest, onOutput: OutputHandler, signal?: AbortSignal): Promise<StreamingProcess> {
    if (this.stopped) throw new Error('VM is stopped');
    if (this.active >= 16) throw Object.assign(new Error('At most 16 commands may run concurrently'), { statusCode: 429 });
    if (signal?.aborted) throw new Error('Request cancelled');
    this.active++;
    try {
      const caPath = '/home/agent/.v86-proxy-ca.pem';
      const defaults = this.relay ? {
        http_proxy: GUEST_PROXY_URL, https_proxy: GUEST_PROXY_URL,
        HTTP_PROXY: GUEST_PROXY_URL, HTTPS_PROXY: GUEST_PROXY_URL, no_proxy: '', NO_PROXY: '',
        SSL_CERT_FILE: caPath, CURL_CA_BUNDLE: caPath, REQUESTS_CA_BUNDLE: caPath,
        GIT_SSL_CAINFO: caPath, NODE_EXTRA_CA_CERTS: caPath,
        ...this.options.managedNetwork?.env,
      } : {};
      const process = await startGuestProcess(this.guest, { ...request, env: { ...defaults, ...request.env } }, {
        defaultCwd: this.info().defaultCwd, onOutput,
        onUnresponsive: () => this.destroy(),
      }, signal);
      void process.completion.finally(() => { this.active--; }).catch(() => {});
      return process;
    } catch (error) { this.active--; throw error; }
  }

  async execute(request: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const process = await this.start({ ...request, stdin: Boolean(request.stdin?.length) },
      (stream, data) => { (stream === 'stderr' ? stderr : stdout).push(Buffer.from(data)); }, signal);
    try {
      if (request.stdin?.length) {
        try {
          await process.writeStdin(Buffer.from(request.stdin));
          await process.closeStdin();
        } catch (error) {
          // A command may legitimately close its input without reading all of it.
          if (!(error instanceof GuestError) || error.code !== 'EPIPE') throw error;
        }
      }
      return { ...await process.completion, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
    } catch (error) {
      process.cancel();
      await process.completion.catch(() => {});
      throw error;
    }
  }

  async destroy() {
    if (this.stopped) return;
    this.stopped = true;
    this.guest.fail(new Error('VM stopped'));
    try { await this.emulator.destroy(); }
    finally { await this.relay?.close(); await this.filesystem.close(); }
  }
}
