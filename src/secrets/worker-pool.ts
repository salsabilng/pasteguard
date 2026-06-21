import { getConfig } from "../config";
import type { SecretsDetectionConfig } from "../config";
import type { RequestExtractor, TextSpan } from "../masking/types";
import type { MessageSecretsResult } from "./patterns/types";

let workers: Array<{ worker: any; busy: boolean }> = [];
let workerCount = 0;
let initialized = false;

// Worker script content - runs in a separate thread
const workerScript = `
import { patternDetectors } from "./patterns/index";

self.onmessage = function(e) {
  const { id, spans, config } = e.data;
  try {
    const enabledTypes = new Set(config.entities);
    const scanRoles = config.scan_roles ? new Set(config.scan_roles) : null;
    const matchCounts = new Map();
    const spanLocations = [];

    for (const span of spans) {
      if (scanRoles && span.role && !scanRoles.has(span.role)) {
        spanLocations.push([]);
        continue;
      }
      const textToScan = config.max_scan_chars > 0 ? span.text.slice(0, config.max_scan_chars) : span.text;
      const allMatches = [];
      const allLocations = [];
      for (const detector of patternDetectors) {
        const hasEnabledPattern = detector.patterns.some((p) => enabledTypes.has(p));
        if (!hasEnabledPattern) continue;
        const result = detector.detect(textToScan, enabledTypes);
        allMatches.push(...result.matches);
        if (result.locations) allLocations.push(...result.locations);
      }
      for (const match of allMatches) {
        matchCounts.set(match.type, (matchCounts.get(match.type) || 0) + match.count);
      }
      allLocations.sort((a, b) => b.start - a.start);
      spanLocations.push(allLocations);
    }

    const allMatches = [];
    for (const [type, count] of matchCounts) {
      allMatches.push({ type, count });
    }
    const hasLocations = spanLocations.some((locs) => locs.length > 0);
    self.postMessage({ id, result: { detected: hasLocations, matches: allMatches, spanLocations } });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
`;

export async function initWorkerPool(): Promise<void> {
  if (initialized) return;
  const os = await import("node:os");
  workerCount = Math.min(os.cpus().length, 4);
  if (workerCount < 1) workerCount = 1;

  const { join } = await import("node:path");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const tmpDir = join(process.cwd(), ".pg-workers");
  mkdirSync(tmpDir, { recursive: true });
  const scriptPath = join(tmpDir, "secret-worker.mjs");
  writeFileSync(scriptPath, workerScript, "utf-8");

  for (let i = 0; i < workerCount; i++) {
    const worker = new (globalThis as any).Worker(scriptPath);
    workers.push({ worker, busy: false });
  }
  initialized = true;
  console.log(`[STARTUP] Worker pool initialized with ${workerCount} workers`);
}

export function shutdownWorkerPool(): void {
  for (const w of workers) {
    try { w.worker.terminate(); } catch {}
  }
  workers = [];
  initialized = false;
}

let nextId = 0;

export async function detectSecretsInSpansWorker(
  spans: TextSpan[],
  config: SecretsDetectionConfig,
): Promise<MessageSecretsResult> {
  if (!initialized || workers.length === 0) {
    // Fallback: inline detection
    const { detectSecretsInSpans } = await import("./detect-inline");
    return detectSecretsInSpans(spans, config);
  }

  // Find free worker
  const idle = workers.find((w) => !w.busy);
  if (!idle) {
    // All busy — run inline as fallback
    const { detectSecretsInSpans } = await import("./detect-inline");
    return detectSecretsInSpans(spans, config);
  }

  idle.busy = true;
  const id = nextId++;

  return new Promise<MessageSecretsResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      idle.busy = false;
      reject(new Error("Worker timeout"));
    }, 30000);

    const handler = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      idle.worker.removeEventListener("message", handler);
      clearTimeout(timeout);
      idle.busy = false;
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.result);
    };

    idle.worker.addEventListener("message", handler);
    idle.worker.postMessage({ id, spans, config });
  });
}
