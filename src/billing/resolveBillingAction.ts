import type { ConversationBillingMode } from "../types/conversation.js";

export type BillingAction = "CHARGE" | "FREE";

export interface ResolveBillingActionInput {
  mode: ConversationBillingMode;
  hasPaidAccess: boolean;
}

export function resolveBillingAction(
  input: ResolveBillingActionInput
): BillingAction {
  if (input.hasPaidAccess && input.mode === "byok") {
    return "FREE";
  }

  return "CHARGE";
}
