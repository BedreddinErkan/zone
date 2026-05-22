export type VerificationReason =
  | 'tests_passed'
  | 'tests_skipped_no_infra'
  | 'tests_inconclusive'
  | 'tests_failed_unrelated'
  | 'tests_failed_by_patch'
  | 'no_verification_attempted'
  | 'verification_failed_staged'
  // Phase J.3: distinguishes "patch introduced new errors" (rolled_back UI)
  // from "patch had pre-existing errors but didn't regress them" (apply OK).
  | 'verification_regressed'
  // Phase F.2: warn-mode regression — patches flushed to disk, errors surfaced
  // as warnings. Distinct from 'verification_regressed' (rollback) so that
  // downstream isVerificationRegressed strict-equals check does NOT trigger
  // decisionMode='rolled_back' UI banner.
  | 'verification_warnings'
  | 'no_changes_made';
