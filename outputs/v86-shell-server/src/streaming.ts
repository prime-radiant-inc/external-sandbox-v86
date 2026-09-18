import type { ExecRequest, ExecResult } from './http.js';

export type StreamExecRequest = Omit<ExecRequest, 'stdin'> & { stdin?: boolean };
export type StreamExit = Omit<ExecResult, 'stdout' | 'stderr'>;
export type OutputHandler = (stream: 'stdout' | 'stderr', data: Uint8Array) => void;
export interface StreamingProcess {
  processId: string;
  completion: Promise<StreamExit>;
  writeStdin(data: Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  cancel(): void;
}
export interface StreamingExecutor {
  start(request: StreamExecRequest, onOutput: OutputHandler, signal?: AbortSignal): Promise<StreamingProcess>;
}
