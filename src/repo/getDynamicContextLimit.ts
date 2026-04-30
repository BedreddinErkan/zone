import type { ProjectFramework } from "./detectFramework.js";

export function getDynamicContextLimit(
  task: string,
  framework: ProjectFramework
): number {
  const t = String(task || "");
  const hasMultipleFiles = /\b(and|also|both|all|every)\b/i.test(t);
  const isComplex = /\b(refactor|migrate|update all|restructure)\b/i.test(t);
  const isSimple = /\b(remove|delete|rename|add comment)\b/i.test(t);

  if (isSimple) return 3;
  if (isComplex || hasMultipleFiles) return 10;
  if (framework.subProjects?.length > 0) return 8;
  return 5;
}
