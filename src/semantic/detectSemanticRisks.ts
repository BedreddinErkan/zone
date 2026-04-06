import { semanticRiskRules } from "./semanticRiskRules.js";
import type {
  DetectSemanticRiskInput,
  SemanticRisk,
} from "./semanticRiskTypes.js";

export function detectSemanticRisks(
  input: DetectSemanticRiskInput
): SemanticRisk[] {
  return semanticRiskRules.flatMap((rule) => rule(input));
}
