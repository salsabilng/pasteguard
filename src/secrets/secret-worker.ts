import { patternDetectors } from "./patterns";
import type { SecretsDetectionConfig } from "../config";
import type { TextSpan } from "../masking/types";
import type { MessageSecretsResult, SecretLocation, SecretsMatch } from "./patterns/types";

declare var self: Worker;

self.onmessage = (e: MessageEvent) => {
  const { id, spans, config } = e.data as {
    id: number;
    spans: TextSpan[];
    config: SecretsDetectionConfig;
  };

  try {
    if (!config.enabled) {
      self.postMessage({
        id,
        result: {
          detected: false,
          matches: [],
          spanLocations: spans.map(() => []),
        } as MessageSecretsResult,
      });
      return;
    }

    const enabledTypes = new Set(config.entities);
    const scanRoles = config.scan_roles ? new Set(config.scan_roles) : null;
    const matchCounts = new Map<string, number>();
    const spanLocations: SecretLocation[][] = [];

    for (const span of spans) {
      if (scanRoles && span.role && !scanRoles.has(span.role)) {
        spanLocations.push([]);
        continue;
      }

      const textToScan =
        config.max_scan_chars > 0
          ? span.text.slice(0, config.max_scan_chars)
          : span.text;

      const spanMatches: SecretsMatch[] = [];
      const spanLocs: SecretLocation[] = [];

      for (const detector of patternDetectors) {
        const hasEnabled = detector.patterns.some((p) => enabledTypes.has(p));
        if (!hasEnabled) continue;

        const result = detector.detect(textToScan, enabledTypes);
        spanMatches.push(...result.matches);
        if (result.locations) spanLocs.push(...result.locations);
      }

      for (const match of spanMatches) {
        matchCounts.set(
          match.type,
          (matchCounts.get(match.type) || 0) + match.count,
        );
      }
      spanLocs.sort((a, b) => b.start - a.start);
      spanLocations.push(spanLocs);
    }

    const allMatches: SecretsMatch[] = [];
    for (const [type, count] of matchCounts) {
      allMatches.push({ type: type as SecretLocation["type"], count });
    }

    const hasLocations = spanLocations.some((locs) => locs.length > 0);

    self.postMessage({
      id,
      result: {
        detected: hasLocations,
        matches: allMatches,
        spanLocations,
      } as MessageSecretsResult,
    });
  } catch (err: any) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
