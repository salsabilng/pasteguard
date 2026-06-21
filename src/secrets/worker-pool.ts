import type { SecretsDetectionConfig } from "../config";
import type { TextSpan } from "../masking/types";
import type { MessageSecretsResult } from "./patterns/types";

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

export interface WorkerPoolStats {
  total: number;
  busy: number;
  idle: number;
  alive: boolean;
  requests_routed_to_pool: number;
  requests_routed_to_inline: number;
}

let workers: PoolWorker[] = [];
let workerCount = 0;
let initialized = false;
let nextId = 0;
let poolRoutedCount = 0;
let inlineRoutedCount = 0;

function getWorkerUrl(): string {
  return new URL("./secret-worker.ts", import.meta.url).href;
}

export async function initWorkerPool(): Promise<void> {
  if (initialized) return;

  try {
    const os = await import("node:os");
    workerCount = Math.min(os.cpus().length, 4);
  } catch {
    workerCount = 2;
  }
  if (workerCount < 1) workerCount = 1;

  const workerUrl = getWorkerUrl();

  for (let i = 0; i < workerCount; i++) {
    try {
      const worker = new Worker(workerUrl);
      worker.onerror = (err) => {
        console.error(`[WorkerPool] Worker #${i} error:`, err.message);
      };
      workers.push({ worker, busy: false });
    } catch (err: any) {
      console.error(`[WorkerPool] Failed to create worker #${i}:`, err.message);
    }
  }

  initialized = true;

  if (workers.length > 0) {
    console.log(
      `[STARTUP] Worker pool initialized with ${workers.length}/${workerCount} workers`,
    );
  } else {
    console.warn(
      "[STARTUP] Worker pool disabled — all workers failed, using inline fallback",
    );
  }
}

export function shutdownWorkerPool(): void {
  for (const w of workers) {
    try { w.worker.terminate(); } catch {}
  }
  workers = [];
  initialized = false;
}

export function getWorkerPoolStats(): WorkerPoolStats {
  // Remove dead workers
  for (let i = workers.length - 1; i >= 0; i--) {
    try { void workers[i].worker; } catch { workers.splice(i, 1); }
  }
  const busy = workers.filter((w) => w.busy).length;
  return {
    total: workers.length,
    busy,
    idle: workers.length - busy,
    alive: workers.length > 0,
    requests_routed_to_pool: poolRoutedCount,
    requests_routed_to_inline: inlineRoutedCount,
  };
}

function getAvailableWorker(): PoolWorker | null {
  // Clean dead workers
  for (let i = workers.length - 1; i >= 0; i--) {
    try { void workers[i].worker; } catch {
      console.warn(`[WorkerPool] Worker #${i} died, removing from pool`);
      workers.splice(i, 1);
    }
  }

  // Respawn if all died
  if (workers.length === 0 && workerCount > 0) {
    const workerUrl = getWorkerUrl();
    for (let i = 0; i < workerCount; i++) {
      try {
        const worker = new Worker(workerUrl);
        worker.onerror = (err) => console.error(`[WorkerPool] Worker error:`, err.message);
        workers.push({ worker, busy: false });
      } catch { break; }
    }
    if (workers.length > 0) {
      console.log(`[WorkerPool] Respawned ${workers.length} workers after crash`);
    }
  }

  return workers.find((w) => !w.busy) || null;
}

export async function detectSecretsInSpansWorker(
  spans: TextSpan[],
  config: SecretsDetectionConfig,
): Promise<MessageSecretsResult> {
  if (!config.enabled) {
    return { detected: false, matches: [], spanLocations: spans.map(() => []) };
  }

  const worker = getAvailableWorker();

  if (!worker) {
    inlineRoutedCount++;
    const { detectSecretsInSpans } = await import("./detect-inline");
    return detectSecretsInSpans(spans, config);
  }

  poolRoutedCount++;
  worker.busy = true;
  const id = nextId++;

  return new Promise<MessageSecretsResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.busy = false;
      reject(new Error("Worker timeout"));
    }, 30_000);

    const handler = (e: MessageEvent) => {
      if (!e.data || e.data.id !== id) return;
      worker.worker.removeEventListener("message", handler);
      clearTimeout(timeout);
      worker.busy = false;

      if (e.data.error) {
        console.error(`[WorkerPool] Worker error: ${e.data.error}`);
        const idx = workers.findIndex((w) => w.worker === worker.worker);
        if (idx !== -1) workers.splice(idx, 1);
        reject(new Error(e.data.error));
      } else {
        resolve(e.data.result as MessageSecretsResult);
      }
    };

    worker.worker.addEventListener("message", handler);
    worker.worker.addEventListener("error", (err) => {
      clearTimeout(timeout);
      worker.busy = false;
      const idx = workers.findIndex((w) => w.worker === worker.worker);
      if (idx !== -1) workers.splice(idx, 1);
      reject(new Error(`Worker crashed: ${err.message}`));
    });

    worker.worker.postMessage({ id, spans, config });
  });
}
