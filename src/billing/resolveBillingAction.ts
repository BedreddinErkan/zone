import type { ConversationBillingMode } from "../types/conversation.js";

export type BillingAction = "CHARGE" | "FREE" | "LIMIT_EXCEEDED";

export interface ResolveBillingActionInput {
  mode: ConversationBillingMode;
  hasPaidAccess?: boolean;
  runsUsedThisMonth: number;
  credits: number;
  tokenCreditsUsed?: number;
  tokenCreditsLimit?: number;
}

export function resolveBillingAction(
  input: ResolveBillingActionInput
): BillingAction {
  const tokenCreditsUsed = input.tokenCreditsUsed ?? 0;
  const tokenCreditsLimit = input.tokenCreditsLimit ?? 500000;

  if (tokenCreditsLimit >= 999999999) {
    return "FREE";
  }

  if (tokenCreditsUsed >= tokenCreditsLimit) {
    return "LIMIT_EXCEEDED";
  }

  return "CHARGE";
}
