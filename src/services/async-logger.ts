import type { RequestLog } from "./logger";

type LogEntry = Omit<RequestLog, "id">;
type FlushCallback = (entries: LogEntry[]) => void;

let buffer: LogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushCallback: FlushCallback | null = null;
let maxBufferSize = 50;

export function initAsyncLogger(callback: FlushCallback, flushIntervalMs: number = 1000, maxBuf: number = 50): void {
  flushCallback = callback;
  maxBufferSize = maxBuf;
  buffer = [];
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => {
    flushBuffer();
  }, flushIntervalMs);
}

export function enqueueLog(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length >= maxBufferSize) {
    flushBuffer();
  }
}

function flushBuffer(): void {
  if (buffer.length === 0 || !flushCallback) return;
  const toFlush = buffer.splice(0, buffer.length);
  try {
    flushCallback(toFlush);
  } catch (error) {
    console.error("Async logger flush error:", error);
  }
}

export function drainAsyncLogger(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flushBuffer();
}
