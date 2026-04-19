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
  if (input.mode === "byok" && input.hasPaidAccess) {
    return "FREE";
  }

  if (input.credits <= 0) {
    return "LIMIT_EXCEEDED";
  }

  return "CHARGE";
}
