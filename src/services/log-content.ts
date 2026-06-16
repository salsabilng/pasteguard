export interface LogContentDecision {
  maskedContent?: string;
  logMaskedContent: boolean;
  secretsDetected?: boolean;
  secretsMasked?: boolean;
}

/**
 * Decide whether masked content should be persisted to the request log.
 *
 * When secrets_detection.action is "mask" (the default), maskedContent has both
 * PII and secrets replaced by placeholders (e.g. "[[API_KEY_SK_1]]",
 * "[[EMAIL_ADDRESS_1]]") by the time it reaches the logger, so it is safe to
 * store even when secrets were detected — gating follows log_masked_content.
 *
 * The exception is route mode with action "route_local": secrets are detected
 * but intentionally left unmasked for the trusted local provider, so the
 * content may contain raw secret material and must never be persisted.
 */
export function shouldLogMaskedContent(decision: LogContentDecision): boolean {
  const { maskedContent, logMaskedContent, secretsDetected, secretsMasked } = decision;
  if (!maskedContent || !logMaskedContent) return false;
  // Detected but unmasked secrets (action: route_local) are still raw in the content
  if (secretsDetected && !secretsMasked) return false;
  return true;
}
