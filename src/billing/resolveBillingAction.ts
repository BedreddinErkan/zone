import type { ConversationBillingMode } from "../types/conversation.js";

export type BillingAction = "CHARGE" | "FREE" | "LIMIT_EXCEEDED";

export interface ResolveBillingActionInput {
  mode: ConversationBillingMode;
  hasPaidAccess?: boolean;
  runsUsedThisMonth: number;
  credits: number;
}

export function resolveBillingAction(
  input: ResolveBillingActionInput
): BillingAction {
  if (input.mode === "byok") {
    return "FREE";
  }

  if (input.runsUsedThisMonth >= input.credits) {
    return "LIMIT_EXCEEDED";
  }

  return "CHARGE";
}
