export const LIMITS = Object.freeze({
  frameBytes: 1024 * 1024,
  transferBytes: 32 * 1024,
  fileBytes: 8 * 1024 * 1024,
  workspaceBytes: 64 * 1024 * 1024,
  workspaceEntries: 10_000,
  websocketMessageBytes: 12 * 1024 * 1024,
  websocketBufferedBytes: 16 * 1024 * 1024,
  pendingRequests: 64,
  requestTimeoutMs: 60_000,
  bootTimeoutMs: 180_000,
  shutdownTimeoutMs: 15_000,
  processes: 16,
});
