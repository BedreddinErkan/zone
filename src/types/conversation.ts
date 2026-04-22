export type ConversationBillingMode = "hosted";

export type ConversationRole =
  | "developer"
  | "test_engineer"
  | "data_analyst";

export interface ConversationRecord {
  id: string;
  userId: string;
  mode: ConversationBillingMode;
  repoPath: string;
  role: ConversationRole;
  chargedRunCount: number;
  refinementCount: number;
  hasFreeRefinementBeenUsed: boolean;
  createdAt: string;
  updatedAt: string;
}
