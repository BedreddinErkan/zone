import {
  parseVerificationTag,
  stripVerificationTag,
  inferVerificationFromLog,
  validatePassedClaim,
  validateUnrelatedClaim,
  applyNoInfraVerificationOverride,
} from "../verification/index.js";
import { debugLog } from "../../utils/logger.js";
import type { VerdictInput, VerdictResult } from "./types.js";

export function deriveVerdict(input: VerdictInput): VerdictResult {
  const { finalText, trigger, toolCallLog, filesModified, framework, patchApplied, onProgress } = input;

  const fwNorm = framework
    ? { hasTests: framework.hasTests, testFilesDetected: framework.testFilesDetected ?? false }
    : undefined;

  const tagged = parseVerificationTag(finalText);
  let reason = tagged
    ? tagged
    : trigger === "max_iterations"
      ? inferVerificationFromLog(toolCallLog, fwNorm)
      : "no_verification_attempted";
  let inferredFrom: "tag" | "heuristic" = tagged ? "tag" : "heuristic";
  const strippedText = tagged ? stripVerificationTag(finalText) : finalText;

  if (reason === "tests_passed") {
    const validation = validatePassedClaim(toolCallLog, framework);
    if (!validation.accept) {
      const overriddenTo = validation.demoteTo ?? "tests_inconclusive";
      onProgress?.(JSON.stringify({
        event: "zone-agent-verdict-override",
        triggeredBy: trigger,
        originalVerdict: "tests_passed",
        overriddenTo,
        reason: validation.reason,
      }));
      reason = overriddenTo;
    }
  }

  if (reason === "tests_failed_unrelated") {
    const validation = validateUnrelatedClaim({
      log: toolCallLog,
      patchedFilePaths: filesModified,
      framework,
    });
    if (!validation.accept) {
      reason = validation.demoteTo ?? "tests_inconclusive";
    } else if (
      validation.reason &&
      /resolved by a later successful run_command/i.test(validation.reason)
    ) {
      // Bug 44b: failure demonstrably resolved by a later successful run_command.
      reason = "tests_passed";
    }
  }

  reason = applyNoInfraVerificationOverride({
    verificationReason: reason,
    framework: fwNorm,
    patchApplied,
    triggeredBy: trigger,
  });

  const patchValidatedByAgent =
    reason === "tests_passed" ||
    reason === "tests_skipped_no_infra" ||
    reason === "tests_failed_unrelated";

  debugLog("[zone-agent-verdict-inferred-from]", JSON.stringify({ inferredFrom, reason, trigger }));

  return { reason, patchValidatedByAgent, inferredFrom, strippedText };
}
