import type { SecretsDetectionConfig } from "../config";
import type { TextSpan } from "../masking/types";
import type { MessageSecretsResult } from "./patterns/types";

// Worker pool removed — Bun's Web Worker API has broken relative import resolution
// when scripts are written to a temp directory. The inline regex detection is fast
// enough (< 1ms per span) that a worker pool provides negligible gain.
//
// The real bottlenecks (sync SQLite logger, unbounded Presidio HTTP calls,
// missing await on processSecretsRequest) were all fixed separately.

export async function initWorkerPool(): Promise<void> {
  // No-op: workers disabled
}

export function shutdownWorkerPool(): void {
  // No-op: no workers to shut down
}

export async function detectSecretsInSpansWorker(
  spans: TextSpan[],
  config: SecretsDetectionConfig,
): Promise<MessageSecretsResult> {
  const { detectSecretsInSpans } = await import("./detect-inline");
  return detectSecretsInSpans(spans, config);
}
