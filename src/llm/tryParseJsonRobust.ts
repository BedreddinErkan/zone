export async function tryParseJsonRobust(raw: string): Promise<unknown | null> {
  if (!raw) return null;

  const attempts: string[] = [];
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  attempts.push(withoutFences);

  const firstObject = withoutFences.indexOf("{");
  const lastObject = withoutFences.lastIndexOf("}");
  if (firstObject !== -1 && lastObject !== -1 && lastObject > firstObject) {
    attempts.push(withoutFences.slice(firstObject, lastObject + 1).trim());
  }

  for (const text of attempts) {
    try {
      return JSON.parse(text);
    } catch {
      // try repairs below
    }
  }

  const repairedAttempts = attempts.flatMap((text) => {
    const withoutTrailingCommas = text.replace(/,(\s*[}\]])/g, "$1");
    const withDoubleQuotes = withoutTrailingCommas
      .replace(/([{,]\s*)'([^'\\]+?)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^'\\]*?)'(\s*[,}\]])/g, ': "$1"$2');
    return [withoutTrailingCommas, withDoubleQuotes];
  });

  for (const text of repairedAttempts) {
    try {
      return JSON.parse(text);
    } catch {
      // fall through
    }
  }

  try {
    const req = Function("return require")() as (specifier: string) => unknown;
    const mod = req("jsonrepair") as {
      jsonrepair?: (value: string) => string;
      default?: (value: string) => string;
    };
    const repairFn =
      typeof mod.jsonrepair === "function"
        ? mod.jsonrepair
        : typeof mod.default === "function"
          ? mod.default
          : null;
    if (repairFn) {
      const repaired = repairFn(withoutFences);
      return JSON.parse(repaired);
    }
  } catch {
    // optional dependency not installed
  }

  return null;
}
