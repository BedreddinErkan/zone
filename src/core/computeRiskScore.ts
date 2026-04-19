import { computeRiskScoreDetails } from "./computeRiskScoreDetails.js";

export type RiskSignal =
  | "destructive"
  | "schema"
  | "critical_domain"
  | "low_risk"
  | "mass_scope";

export type RoleModifier = {
  destructiveMultiplier: number;
  criticalMultiplier: number;
  massScopeMultiplier: number;
  schemaMultiplier: number;
};

export type ComputeRiskScoreResult = {
  score: number;
  signals: RiskSignal[];
  breakdown: {
    destructive: number;
    schema: number;
    critical: number;
    lowRisk: number;
    massScope: number;
  };
};

type ComputeRiskScoreInput = {
  task: string;
  role?: string;
  codeIntent?: import("./taskIntentParser.js").CodePatchIntent;
};

function logRiskDebug(label: string, payload: Record<string, unknown>): void {
  console.log(`[zone-debug] ${label}: ${JSON.stringify(payload)}`);
}

const ROLE_MODIFIERS: Record<string, RoleModifier> = {
  test_engineer: {
    destructiveMultiplier: 0.3,
    criticalMultiplier: 0.5,
    massScopeMultiplier: 0.4,
    schemaMultiplier: 0.0,
  },
  developer: {
    destructiveMultiplier: 0.8,
    criticalMultiplier: 1.2,
    massScopeMultiplier: 1.0,
    schemaMultiplier: 1.0,
  },
  data_analyst: {
    destructiveMultiplier: 1.5,
    criticalMultiplier: 0.8,
    massScopeMultiplier: 2.0,
    schemaMultiplier: 0.0,
  },
};

function getRoleModifier(role?: string): RoleModifier {
  return ROLE_MODIFIERS[role ?? ""] ?? {
    destructiveMultiplier: 1.0,
    criticalMultiplier: 1.0,
    massScopeMultiplier: 1.0,
    schemaMultiplier: 1.0,
  };
}

export function computeRiskScore(
  input: string | ComputeRiskScoreInput
): ComputeRiskScoreResult {
  const task = typeof input === "string" ? input : input.task;
  const role = typeof input === "string" ? undefined : input.role;

  const details = computeRiskScoreDetails({
    task,
    codeIntent: typeof input === "string" ? undefined : input.codeIntent,
  });
  const modifier = getRoleModifier(role);

  const destructiveScore = Math.round(
    details.riskBreakdown.destructive * modifier.destructiveMultiplier
  );
  const criticalScore = Math.round(
    details.riskBreakdown.critical * modifier.criticalMultiplier
  );
  const massScopeScore = Math.round(
    details.riskBreakdown.massScope * modifier.massScopeMultiplier
  );

  // Role-aware schema penalty adjustment:
  // test_engineer: writing tests is not a schema risk
  // data_analyst: schema changes are expected, handled separately
  const schemaScore =
    role === "test_engineer" || role === "data_analyst" || role === "developer"
      ? 0
      : details.riskBreakdown.schema;

  const signals: RiskSignal[] = [];

  if (destructiveScore > 0) signals.push("destructive");
  if (schemaScore > 0) signals.push("schema");
  if (criticalScore > 0) signals.push("critical_domain");
  if (details.riskBreakdown.lowRisk < 0) signals.push("low_risk");
  if (massScopeScore > 0) signals.push("mass_scope");

  const adjustedScore = Math.max(
    0,
    Math.min(
      100,
      destructiveScore +
        schemaScore +
        criticalScore +
        details.riskBreakdown.lowRisk +
        massScopeScore +
        details.compoundPenalty
    )
  );

  logRiskDebug("computeRiskScore result", {
    task,
    role,
    details,
    destructiveScore,
    schemaScore,
    criticalScore,
    massScopeScore,
    adjustedScore,
    signals,
  });

  return {
    score: adjustedScore,
    signals,
    breakdown: {
      destructive: destructiveScore,
      schema: schemaScore,
      critical: criticalScore,
      lowRisk: details.riskBreakdown.lowRisk,
      massScope: massScopeScore,
    },
  };
}
