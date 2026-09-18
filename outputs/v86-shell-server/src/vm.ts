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

export interface VMMount extends Mount { preservedPaths?: string[] }
export interface VMOptions {
  image: string;
  mounts: VMMount[];
  memoryMiB?: number;
  bootTimeoutMs?: number;
  onBootLog?: (text: string) => void;
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
  ) {}

  static async boot(options: VMOptions): Promise<ShellVM> {
    const directory = path.resolve(options.image);
    const manifest = JSON.parse(await readFile(path.join(directory, 'image.json'), 'utf8'));
    if (manifest.formatVersion !== 1 || manifest.v86Version !== '0.5.458') throw new Error('Expected image format 1 for v86 0.5.458');
    const memory = options.memoryMiB ?? 512;
    if (!Number.isSafeInteger(memory) || memory < 128 || memory > 2048) throw new Error('Memory must be 128–2048 MiB');
    const [bios, vga, kernel, initrd] = await Promise.all(['bios', 'vgaBios', 'bzimage', 'initrd'].map(key => asset(directory, manifest.assets[key])));
    const aliases = options.mounts.filter(m => m.preservedPaths?.length).map(m => ({ name: m.name, paths: m.preservedPaths }));
    const cmdline = manifest.cmdline + (aliases.length ? ` v86_mounts=${Buffer.from(JSON.stringify(aliases)).toString('base64url')}` : '');
    if (Buffer.byteLength(cmdline) > 2000) throw new Error('Too many preserved paths for the Linux kernel command line; shorten paths or omit --preserve-paths');
    const filesystem = await createHostFilesystem(options.mounts);
    const require = createRequire(import.meta.url);
    const emulator = new V86({
      wasm_path: path.join(path.dirname(require.resolve('v86')), 'v86.wasm'),
      memory_size: memory * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024,
      bios: { buffer: bios }, vga_bios: { buffer: vga }, bzimage: { buffer: kernel }, initrd: { buffer: initrd },
      cmdline, uart1: true, autostart: false,
      filesystem: { handle9p: filesystem.handle9p },
      disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    });
    const guest = new GuestClient(frame => emulator.serial_send_bytes(1, frame));
    const vm = new ShellVM(emulator, guest, filesystem, options);
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
        emulator.add_listener('emulator-loaded', () => { void emulator.run(); });
      });
      guest.on('failure', () => { void vm.destroy().catch(() => {}); });
      return vm;
    } catch (error) { await vm.destroy(); throw error; }
  }

  info() {
    return {
      status: this.stopped ? 'stopped' : 'ready', backend: 'v86', architecture: 'i686',
      shell: '/bin/bash', network: false,
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
      const process = await startGuestProcess(this.guest, request, {
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
    await this.emulator.destroy();
    await this.filesystem.close();
  }
}
