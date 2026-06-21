import type { SecretsDetectionConfig } from "../config";
import type { TextSpan } from "../masking/types";
import type { MessageSecretsResult } from "./patterns/types";

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

let workers: PoolWorker[] = [];
let workerCount = 0;
let initialized = false;
let nextId = 0;

function getWorkerUrl(): string {
  // Bun: resolve the worker file relative to this module
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
    try {
      w.worker.terminate();
    } catch {}
  }
  workers = [];
  initialized = false;
}

function getAvailableWorker(): PoolWorker | null {
  // Respawn any dead workers (mark them as not busy so they're replaced)
  for (let i = workers.length - 1; i >= 0; i--) {
    const w = workers[i];
    try {
      // Test if worker is alive by checking a property
      void w.worker;
    } catch {
      // Worker crashed — remove it
      console.warn(`[WorkerPool] Worker #${i} died, removing from pool`);
      workers.splice(i, 1);
    }
  }

  // Try to respawn if all workers died
  if (workers.length === 0 && workerCount > 0) {
    const workerUrl = getWorkerUrl();
    for (let i = 0; i < workerCount; i++) {
      try {
        const worker = new Worker(workerUrl);
        worker.onerror = (err) => {
          console.error(`[WorkerPool] Worker error:`, err.message);
        };
        workers.push({ worker, busy: false });
      } catch {
        break;
      }
    }
    if (workers.length > 0) {
      console.log(
        `[WorkerPool] Respawned ${workers.length} workers after crash`,
      );
    }
  }

  // Find first idle worker
  const idle = workers.find((w) => !w.busy);
  return idle || null;
}

export async function detectSecretsInSpansWorker(
  spans: TextSpan[],
  config: SecretsDetectionConfig,
): Promise<MessageSecretsResult> {
  // Fast path: disabled config
  if (!config.enabled) {
    return {
      detected: false,
      matches: [],
      spanLocations: spans.map(() => []),
    };
  }

  // Try worker pool
  const worker = getAvailableWorker();

  if (!worker) {
    // Fallback: inline detection
    const { detectSecretsInSpans } = await import("./detect-inline");
    return detectSecretsInSpans(spans, config);
  }

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
        // Worker returned error — might be dead, remove it
        console.error(`[WorkerPool] Worker returned error: ${e.data.error}`);
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
      // Worker crashed — remove from pool
      const idx = workers.findIndex((w) => w.worker === worker.worker);
      if (idx !== -1) workers.splice(idx, 1);
      reject(new Error(`Worker crashed: ${err.message}`));
    });

    worker.worker.postMessage({ id, spans, config });
  });
}
