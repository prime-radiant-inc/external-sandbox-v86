import type { ExecRequest, ExecResult } from './http.js';

export type StreamExecRequest = Omit<ExecRequest, 'stdin'> & { stdin?: boolean };
/** Internal direct execution request; argv is sent to the guest without a shell. */
export type ArgvExecRequest = Omit<StreamExecRequest, 'command'> & {
  argv: string[];
  arg0?: string;
  envReplace?: boolean;
};
export type StreamExit = Omit<ExecResult, 'stdout' | 'stderr'>;
export type OutputHandler = (stream: 'stdout' | 'stderr', data: Uint8Array) => void;
export interface StreamingProcess {
  processId: string;
  completion: Promise<StreamExit>;
  writeStdin(data: Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  /** Deliver a catchable guest process-group signal without cancelling stdin. */
  signal?(signal: 2 | 15): Promise<void>;
  cancel(): void;
}
export interface StreamingExecutor {
  start(request: StreamExecRequest, onOutput: OutputHandler, signal?: AbortSignal): Promise<StreamingProcess>;
}
