// Note: API still accepts "plan" as alias for "patch" with planApprovalRequired=true; see shouldRequirePlanApproval
export type Mode = "auto" | "chat" | "investigate" | "patch";

export const MODES: readonly Mode[] = [
  "auto",
  "chat",
  "investigate",
  "patch",
];

export function parseMode(value: unknown): Mode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (MODES as readonly string[]).includes(normalized)
    ? (normalized as Mode)
    : null;
}
