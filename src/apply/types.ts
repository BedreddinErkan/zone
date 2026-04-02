export type ApplyBlockReason =
  | "blocked_mode"
  | "missing_patch"
  | "unsafe_scope"
  | "destructive_change"
  | "user_confirmation_required";

export type ApplyStrategy = "confirmed_apply";

export type ApplyEligibility =
  | {
      allowed: false;
      reason: ApplyBlockReason;
      message: string;
    }
  | {
      allowed: true;
      strategy: ApplyStrategy;
      message: string;
    };

export type ApplyRequest = {
  confirm: boolean;
};

export type ApplyResult = {
  applied: boolean;
  filesChanged: string[];
  summary: string;
};