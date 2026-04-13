import type { ConversationBillingMode, ConversationRecord } from "../types/conversation.js";

export type BillingAction = "CHARGE" | "FREE";

export interface ResolveBillingActionInput {
  mode: ConversationBillingMode;
  conversation: Pick<
    ConversationRecord,
    "chargedRunCount" | "hasFreeRefinementBeenUsed"
  >;
}

export function resolveBillingAction(
  input: ResolveBillingActionInput
): BillingAction {
  if (input.mode === "byok") {
    return "FREE";
  }

  if (input.conversation.chargedRunCount === 0) {
    return "CHARGE";
  }

  if (!input.conversation.hasFreeRefinementBeenUsed) {
    return "FREE";
  }

  return "CHARGE";
}
