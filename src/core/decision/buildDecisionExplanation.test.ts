import { describe, expect, it } from "vitest";
import { buildDecisionExplanation } from "./buildDecisionExplanation.js";
import { renderDecisionSummary } from "./renderDecisionSummary.js";
import type { DecideExecutionModeResult } from "./decideExecutionMode.js";
import {
  buildDecisionReasonDetails,
  type DecisionReasonCode as MetadataDecisionReasonCode
} from "./decisionReasonCodeMeta.js";
import type {
  DecisionReason as ExecutionDecisionReason,
  DecisionReasonCode as ExecutionDecisionReasonCode
} from "./decideExecutionMode.js";
function buildBlockedExplanationResult(): DecideExecutionModeResult {
  return {
    mode: "blocked",
    confidenceScore: 25,
    reasons: [
      {
        code: "PATCH_VALIDATION_ERROR",
        severity: "critical",
        message: "Patch validation failed."
      }
    ]
  };
}
function buildReasonsFromMetadataCodes(
  codes: readonly MetadataDecisionReasonCode[]
): ExecutionDecisionReason[] {
  return buildDecisionReasonDetails([...codes]).map((reason) => ({
    code: reason.code as ExecutionDecisionReasonCode,
    severity:
      reason.severity === "high"
        ? "critical"
        : reason.severity === "medium"
          ? "warning"
          : "info",
    message: reason.summary
  }));
}

describe("buildDecisionExplanation", () => {
  it("explains blocked mode with critical reasons", () => {
    const output = buildDecisionExplanation({
      mode: "blocked",
      confidenceScore: 0,
      reasons: [
        {
          code: "PATCH_VALIDATION_ERROR",
          severity: "critical",
          message: "Patch validation failed."
        }
      ]
    });

    expect(output).toContain("Decision was set to BLOCKED");
    expect(output).toContain("1 critical reason(s) affected the decision");
    expect(output).toContain(
      "Automatic apply is not recommended until blocking issues are resolved."
    );
  });

  it("explains preview_only mode with warning reasons", () => {
    const output = buildDecisionExplanation({
      mode: "preview_only",
      confidenceScore: 68,
      reasons: [
        {
          code: "PATCH_VALIDATION_WARNING",
          severity: "warning",
          message: "Patch should be reviewed."
        },
        {
          code: "ARCHITECTURE_WARNING",
          severity: "warning",
          message: "Architecture mismatch warning."
        }
      ]
    });

    expect(output).toContain("Decision was set to PREVIEW ONLY");
    expect(output).toContain("2 warning-level reason(s) affected the decision");
    expect(output).toContain(
      "Automatic apply is not recommended until review is completed."
    );
  });

  it("includes medium or high top risk count when present", () => {
    const output = buildDecisionExplanation({
      mode: "preview_only",
      confidenceScore: 70,
      reasons: [
        {
          code: "PATCH_RISK_WARNING",
          severity: "warning",
          message: "Risk warnings detected."
        }
      ],
      topRisks: [
        {
          id: "risk-1",
          title: "Dangerous patch target",
          description: "Target may be unsafe.",
          severity: "high",
          score: 91,
          category: "patch",
          source: "warning"
        },
        {
          id: "risk-2",
          title: "Schema mismatch",
          description: "Schema may be incomplete.",
          severity: "medium",
          score: 66,
          category: "schema",
          source: "derived"
        },
        {
          id: "risk-3",
          title: "Low concern note",
          description: "Minor note.",
          severity: "low",
          score: 20,
          category: "other",
          source: "derived"
        }
      ]
    });

    expect(output).toContain(
      "2 medium/high top risk(s) remain visible in the result"
    );
  });

  it("explains safe_to_apply mode with informational reason", () => {
    const output = buildDecisionExplanation({
      mode: "safe_to_apply",
      confidenceScore: 92,
      reasons: [
        {
          code: "SAFE_TO_APPLY",
          severity: "info",
          message: "No blocking or warning-level execution risks were detected."
        }
      ]
    });

    expect(output).toContain("Decision was set to SAFE TO APPLY");
    expect(output).toContain(
      "1 informational confirmation reason(s) were recorded"
    );
    expect(output).toContain(
      "Automatic apply can proceed under the current safeguards."
    );
  });

  it("still returns fallback explanation when reasons are empty", () => {
    const output = buildDecisionExplanation({
      mode: "preview_only",
      confidenceScore: 60,
      reasons: []
    });

    expect(output).toContain("Decision was set to PREVIEW ONLY");
    expect(output).toContain(
      "Automatic apply is not recommended until review is completed."
    );
  });
it("includes metadata-driven why line when reasonCodes are provided", () => {
  const reasonCodes: readonly MetadataDecisionReasonCode[] = [
    "BLOCKED_DESTRUCTIVE_OPERATION",
    "BLOCKED_HIGH_RISK_SCORE"
  ];

  const output = buildDecisionExplanation(
    {
      mode: "blocked",
      confidenceScore: 25,
      reasons: buildReasonsFromMetadataCodes(reasonCodes),
      topRisks: [
        {
          id: "risk-1",
          title: "Potentially destructive change",
          description: "May cause irreversible loss",
          severity: "high",
          score: 91,
          category: "patch",
          source: "warning"
        }
      ]
    },
    {
      reasonCodes
    }
  );

  expect(output).toContain(
    "Decision was set to BLOCKED because blocking validation signals were detected."
  );
  expect(output).toContain("Why:");
  expect(output).toContain(
    "Automatic apply is not recommended until blocking issues are resolved."
  );
});
  it("does not include why line when reasonCodes are omitted", () => {
    const output = buildDecisionExplanation({
      mode: "preview_only",
      confidenceScore: 55,
      reasons: [
        {
          code: "PATCH_VALIDATION_WARNING",
          message: "Confidence is too low",
          severity: "warning"
        }
      ],
      topRisks: []
    });

    expect(output).not.toContain("Why:");
    expect(output).toContain(
      "Decision was set to PREVIEW ONLY because manual review is still required."
    );
  });

});
it("keeps existing summary lines and closing line intact", () => {
  const reasonCodes: readonly MetadataDecisionReasonCode[] = [
    "SAFE_LOW_RISK_LOCALIZED",
    "SAFE_HIGH_CONFIDENCE"
  ];

  const output = buildDecisionExplanation(
    {
      mode: "safe_to_apply",
      confidenceScore: 92,
      reasons: buildReasonsFromMetadataCodes(reasonCodes),
      topRisks: []
    },
    {
      reasonCodes
    }
  );

  expect(output).toContain("Why:");
  expect(output).toContain(
    "- 2 informational confirmation reason(s) were recorded"
  );
  expect(output).toContain(
    "Automatic apply can proceed under the current safeguards."
  );
});
describe("buildDecisionExplanation + renderDecisionSummary parity", () => {
  it("keeps explanation mode wording aligned with rendered summary for blocked", () => {
    const result = buildBlockedExplanationResult();

    const explanation = buildDecisionExplanation(result);
    const summary = renderDecisionSummary(result);

    expect(explanation).toContain("Decision was set to BLOCKED");
    expect(summary).toContain("blocked");
  });
});

describe("buildDecisionExplanation – reason parity", () => {
it("builds explanation when reasonCodes and reasons are aligned", () => {
  const reasonCodes: readonly MetadataDecisionReasonCode[] = [
    "PREVIEW_LOW_CONFIDENCE"
  ];

  const explanation = buildDecisionExplanation(
    {
      mode: "preview_only",
      confidenceScore: 75,
      reasons: buildReasonsFromMetadataCodes(reasonCodes),
      topRisks: []
    },
    {
      reasonCodes
    }
  );

  expect(explanation).toContain("Decision was set to PREVIEW ONLY");
});
  it("throws when a provided reasonCode does not exist in reasons", () => {
    expect(() =>
      buildDecisionExplanation(
        {
          mode: "preview_only",
          confidenceScore: 75,
          reasons: [
            {
              code: "PATCH_VALIDATION_WARNING",
              severity: "warning",
              message: "Patch should be reviewed."
            }
          ],
          topRisks: []
        },
        {
          reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"]
        }
      )
    ).toThrow("DECISION_EXPLANATION_REASON_MISMATCH");
  });

  it("remains backward compatible when reasonCodes are omitted", () => {
    const explanation = buildDecisionExplanation({
      mode: "safe_to_apply",
      confidenceScore: 100,
      reasons: [
        {
          code: "SAFE_TO_APPLY",
          severity: "info",
          message: "No blocking or warning-level execution risks were detected."
        }
      ],
      topRisks: []
    });

    expect(explanation).toContain("SAFE TO APPLY");
  });
});