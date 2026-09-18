import { EventEmitter } from 'node:events';
import { LIMITS } from '../limits.js';
import { encodeFrame, FrameDecoder } from './framing.js';

export interface GuestEvent { event: string; [key: string]: unknown }
export interface GuestAPI {
  request<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: 'event', listener: (event: GuestEvent) => void): unknown;
  off(event: 'event', listener: (event: GuestEvent) => void): unknown;
}
export class GuestError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class GuestClient extends EventEmitter implements GuestAPI {
  private nextId = 1;
  private closed = false;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  readonly decoder = new FrameDecoder(message => this.receive(message));
  constructor(private readonly send: (frame: Buffer) => void | Promise<void>) { super(); }

  feed(bytes: Uint8Array): void {
    try { this.decoder.push(bytes); } catch (error) { this.fail(error as Error); }
  }

  request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Guest connection is closed'));
    if (this.pending.size >= LIMITS.pendingRequests) return Promise.reject(new GuestError('OVERLOADED', 'Too many pending guest requests'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out mutation has unknown state: fail the channel instead of retrying it.
        this.fail(new Error(`Guest request timed out: ${method}`));
      }, LIMITS.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        Promise.resolve(this.send(encodeFrame({ id, method, params }))).catch(error => this.fail(error));
      } catch (error) { this.fail(error as Error); }
    });
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid guest message');
    const message = value as Record<string, any>;
    if (typeof message.event === 'string') {
      this.emit('event', message);
      return;
    }
    if (!Number.isSafeInteger(message.id)) throw new Error('Guest response lacks request ID');
    const pending = this.pending.get(message.id);
    if (!pending) throw new Error('Guest sent an unknown response ID');
    if (!('result' in message) && !message.error) throw new Error('Guest response lacks result or error');
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new GuestError(String(message.error.code), String(message.error.message)));
    else if ('result' in message) pending.resolve(message.result);
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.emit('failure', error);
  }
}
