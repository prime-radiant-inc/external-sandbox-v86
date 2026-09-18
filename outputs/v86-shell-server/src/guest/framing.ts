import { LIMITS } from '../limits.js';

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length === 0 || body.length > LIMITS.frameBytes) throw new Error('Guest frame exceeds limit');
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/** Incremental decoder: allocates only after a complete, validated length header. */
export class FrameDecoder {
  private readonly header = Buffer.alloc(4);
  private headerUsed = 0;
  private body: Buffer | undefined;
  private bodyUsed = 0;
  private failed = false;
  constructor(private readonly onMessage: (message: unknown) => void) {}

  push(chunk: Uint8Array): void {
    if (this.failed) throw new Error('Guest decoder is closed after protocol failure');
    let offset = 0;
    try {
      while (offset < chunk.length) {
        if (!this.body) {
          const count = Math.min(4 - this.headerUsed, chunk.length - offset);
          this.header.set(chunk.subarray(offset, offset + count), this.headerUsed);
          this.headerUsed += count;
          offset += count;
          if (this.headerUsed !== 4) continue;
          const size = this.header.readUInt32BE();
          if (size === 0 || size > LIMITS.frameBytes) throw new Error(`Invalid guest frame length: ${size}`);
          this.body = Buffer.allocUnsafe(size);
          this.bodyUsed = 0;
        }
        const count = Math.min(this.body.length - this.bodyUsed, chunk.length - offset);
        this.body.set(chunk.subarray(offset, offset + count), this.bodyUsed);
        this.bodyUsed += count;
        offset += count;
        if (this.bodyUsed === this.body.length) {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(this.body);
          const message: unknown = JSON.parse(text);
          this.body = undefined;
          this.headerUsed = 0;
          this.bodyUsed = 0;
          this.onMessage(message);
        }
      }
    } catch (error) {
      this.failed = true;
      this.body = undefined;
      throw error;
    }
  }
}
