import { describe, expect, test } from "bun:test";
import { shouldLogMaskedContent } from "./log-content";

describe("shouldLogMaskedContent", () => {
  // With action "mask", maskedContent has both PII and secrets replaced by
  // placeholders, e.g. "My key is [[API_KEY_SK_1]] and email [[EMAIL_ADDRESS_1]]".
  // Storing it is safe even when secrets were detected (issue #91).
  const maskedWithSecret = "My key is [[API_KEY_SK_1]] and email [[EMAIL_ADDRESS_1]]";
  const maskedPiiOnly = "Email [[EMAIL_ADDRESS_1]]";

  test("logs masked content when secrets were detected and masked", () => {
    expect(
      shouldLogMaskedContent({
        maskedContent: maskedWithSecret,
        logMaskedContent: true,
        secretsDetected: true,
        secretsMasked: true,
      }),
    ).toBe(true);
  });

  test("logs masked content when only PII was detected", () => {
    expect(
      shouldLogMaskedContent({
        maskedContent: maskedPiiOnly,
        logMaskedContent: true,
        secretsDetected: false,
      }),
    ).toBe(true);
  });

  test("does not log when log_masked_content is false", () => {
    expect(
      shouldLogMaskedContent({
        maskedContent: maskedWithSecret,
        logMaskedContent: false,
        secretsDetected: true,
        secretsMasked: true,
      }),
    ).toBe(false);
    expect(
      shouldLogMaskedContent({
        maskedContent: maskedPiiOnly,
        logMaskedContent: false,
      }),
    ).toBe(false);
  });

  test("does not log when secrets were detected but not masked (route_local)", () => {
    // Route mode with action "route_local" leaves secrets raw for the trusted
    // local provider, so the content may contain actual secret material.
    expect(
      shouldLogMaskedContent({
        maskedContent: "My key is sk-live-actual-secret and email [[EMAIL_ADDRESS_1]]",
        logMaskedContent: true,
        secretsDetected: true,
        secretsMasked: false,
      }),
    ).toBe(false);
  });

  test("does not log when there is no masked content", () => {
    expect(
      shouldLogMaskedContent({
        maskedContent: undefined,
        logMaskedContent: true,
      }),
    ).toBe(false);
  });
});
