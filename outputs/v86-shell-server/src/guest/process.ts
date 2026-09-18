import { GuestError, type GuestClient, type GuestEvent } from './client.js';
import type { OutputHandler, StreamExecRequest, StreamingProcess, StreamExit } from '../streaming.js';
import { LIMITS } from '../limits.js';

export interface ProcessOptions {
  defaultCwd: string;
  onOutput: OutputHandler;
  onUnresponsive: () => void | Promise<void>;
  stopTimeoutMs?: number;
}

export async function startGuestProcess(
  guest: Pick<GuestClient, 'request' | 'on' | 'off'>,
  request: StreamExecRequest,
  options: ProcessOptions,
  signal?: AbortSignal,
): Promise<StreamingProcess> {
  if (signal?.aborted) throw new Error('Request cancelled');
  const started = performance.now();
  const outputLimit = request.maxOutputBytes ?? 4 * 1024 * 1024;
  const early = new Map<unknown, { events: GuestEvent[]; bytes: number; overflow: boolean; exit?: GuestEvent }>();
  let totalOutput = 0, pendingInput = 0;
  let processId: string | undefined;
  let done = false, cancelling = false, signalSent = false;
  let inputClosed = request.stdin === false, eofRequested = request.stdin === false;
  let timedOut = false, outputLimitExceeded = false;
  let processError: Error | undefined;
  let stopTimer: NodeJS.Timeout | undefined;
  let inputQueue = Promise.resolve();
  let resolveExit!: (value: StreamExit) => void;
  let rejectExit!: (error: Error) => void;
  const completion = new Promise<StreamExit>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  // The process can exit or fail while its start acknowledgement is being read.
  void completion.catch(() => {});
  const cleanup = () => {
    clearTimeout(timeout); clearTimeout(stopTimer);
    early.clear();
    guest.off('event', event); guest.off('failure', failure);
    signal?.removeEventListener('abort', cancel);
  };
  const fail = (error: Error) => {
    if (done) return;
    done = true; inputClosed = true; cleanup(); rejectExit(error);
  };
  const failure = (error: Error) => fail(error);
  function cancel() {
    if (done) return;
    cancelling = true;
    stopTimer ??= setTimeout(() => {
      fail(new Error('Guest failed to stop the command; VM shut down'));
      void Promise.resolve(options.onUnresponsive()).catch(() => {});
    }, options.stopTimeoutMs ?? 10_000);
    if (processId && !signalSent) {
      signalSent = true;
      void guest.request('process.signal', { processId, signal: 9 }).catch(() => {});
    }
  }
  function event(message: GuestEvent) {
    if (done || !message.event.startsWith('process.')) return;
    if (!processId) {
      // A synchronous serial feed may deliver output immediately after its
      // start response, before the request promise continuation gets to run.
      // Keep separate bounds for each of the guest's at most 16 processes:
      // output from another running command must never cancel this new one.
      if (!['process.output', 'process.error', 'process.exited'].includes(message.event)) return;
      let buffered = early.get(message.processId);
      if (!buffered) {
        if (early.size >= LIMITS.processes) {
          processError = new Error('Guest exceeded the process limit during startup'); cancel(); return;
        }
        buffered = { events: [], bytes: 0, overflow: false };
        early.set(message.processId, buffered);
      }
      if (message.event === 'process.exited') buffered.exit = message;
      if (!buffered.overflow) {
        // Count metadata as well, so empty output frames cannot grow the array
        // without consuming the bound. Preserve exit evidence after overflow.
        buffered.bytes += 128 + (typeof message.data === 'string' ? message.data.length : 0);
        if (buffered.bytes > 2 * 1024 * 1024) {
          buffered.overflow = true; buffered.events.length = 0;
        } else buffered.events.push(message);
      }
      return;
    }
    if (message.processId !== processId) return;
    if (message.event === 'process.output') {
      const bytes = Buffer.from(String(message.data), 'base64');
      const kept = bytes.subarray(0, Math.max(0, outputLimit - totalOutput));
      totalOutput += bytes.length;
      if (kept.length && !processError) {
        try { options.onOutput(message.stream === 'stderr' ? 'stderr' : 'stdout', kept); }
        catch (error) { processError = error instanceof Error ? error : new Error(String(error)); cancel(); }
      }
      if (totalOutput > outputLimit) { outputLimitExceeded = true; cancel(); }
    } else if (message.event === 'process.error') {
      if (message.code === 'EPIPE') { inputClosed = true; eofRequested = true; }
      else if (message.code === 'E2BIG') { outputLimitExceeded = true; cancel(); }
      else { processError = new Error(`Guest process error: ${message.code}: ${message.message}`); cancel(); }
    } else if (message.event === 'process.exited') {
      done = true; inputClosed = true; cleanup();
      if (processError) rejectExit(processError);
      else resolveExit({ exitCode: message.exitCode as number | null, signal: message.signal as number | null,
        timedOut, outputLimitExceeded, durationMs: Math.round(performance.now() - started) });
    }
  }
  const timeout = setTimeout(() => { timedOut = true; cancel(); }, request.timeoutMs ?? 30_000);
  guest.on('event', event); guest.on('failure', failure);
  signal?.addEventListener('abort', cancel, { once: true });
  const closedError = () => new GuestError('EPIPE', 'Process stdin is closed or EOF was requested');
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const next = inputQueue.then(operation);
    inputQueue = next.catch(() => {});
    return next;
  };
  try {
    const start = guest.request<{ processId: string }>('process.start', {
      argv: ['/bin/bash', '-c', request.command], cwd: request.cwd ?? options.defaultCwd,
      env: request.env ?? {}, stdin: request.stdin !== false,
    });
    const result = await Promise.race([start, completion.then(() => { throw new Error('Process stopped before start was acknowledged'); })]);
    processId = result.processId;
    const buffered = early.get(processId);
    early.clear();
    if (buffered?.overflow) {
      processError = new Error('Too much output before process start acknowledgement');
      if (buffered.exit) event(buffered.exit);
      else cancel();
    } else if (buffered) {
      for (const message of buffered.events) event(message);
    }
    if (cancelling || signal?.aborted) cancel();
    return {
      processId, completion, cancel,
      writeStdin(data) {
        if (done || cancelling || inputClosed || eofRequested) return Promise.reject(closedError());
        if (data.byteLength > 32 * 1024) return Promise.reject(new GuestError('E2BIG', 'stdin chunks must not exceed 32 KiB'));
        if (pendingInput + data.byteLength > 256 * 1024) return Promise.reject(new GuestError('EAGAIN', 'Too much queued stdin'));
        const bytes = Buffer.from(data);
        pendingInput += bytes.length;
        return enqueue(async () => {
          try {
            for (;;) {
              if (done || cancelling || inputClosed) throw closedError();
              try {
                await guest.request('process.write', { processId, data: bytes.toString('base64') });
                return;
              } catch (error) {
                if (error instanceof GuestError && error.code === 'EAGAIN') {
                  // The C agent only rejects before accepting any bytes; safe to retry.
                  await new Promise(resolve => setTimeout(resolve, 5)); continue;
                }
                if (error instanceof GuestError && ['EPIPE', 'ESRCH', 'ENOENT', 'EBADF'].includes(error.code)) {
                  inputClosed = true; eofRequested = true; throw closedError();
                }
                processError = error instanceof Error ? error : new Error(String(error)); cancel(); throw error;
              }
            }
          } finally { pendingInput -= bytes.length; }
        });
      },
      closeStdin() {
        if (eofRequested || inputClosed || done) return inputQueue;
        eofRequested = true;
        return enqueue(async () => {
          if (done || cancelling || inputClosed) return;
          try { await guest.request('process.closeStdin', { processId }); }
          catch (error) {
            if (!(error instanceof GuestError) || !['EPIPE', 'ESRCH', 'ENOENT', 'EBADF'].includes(error.code)) {
              processError = error instanceof Error ? error : new Error(String(error)); cancel(); throw error;
            }
          }
          inputClosed = true;
        });
      },
    };
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
