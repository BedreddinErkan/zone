const JS_TS_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mts", "cts"]);
const MAX_OUTLINE_ENTRIES = 160;

type OutlineEntry = {
  kind: string;
  name: string;
  line: number;
  exported: boolean;
};

export function generateFileOutline(content: string, filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!JS_TS_EXTENSIONS.has(ext ?? "")) return "";

  const lines = content.split("\n");
  const entries: OutlineEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const exportMatch = line.match(
      /^export\s+(async\s+)?(function|class|const|interface|type|enum|let|var)\s+([A-Za-z_$][\w$]*)/
    );
    if (exportMatch) {
      entries.push({
        kind: exportMatch[2],
        name: exportMatch[3],
        line: i + 1,
        exported: true,
      });
      continue;
    }

    const defaultMatch = line.match(
      /^export\s+default\s+(async\s+)?(function|class)\s+([A-Za-z_$][\w$]*)?/
    );
    if (defaultMatch) {
      entries.push({
        kind: defaultMatch[2],
        name: defaultMatch[3] ? `${defaultMatch[3]} (default)` : "(default)",
        line: i + 1,
        exported: true,
      });
      continue;
    }

    const declarationMatch = line.match(
      /^(async\s+)?(function|class|const|interface|type|enum|let|var)\s+([A-Za-z_$][\w$]*)/
    );
    if (declarationMatch) {
      entries.push({
        kind: declarationMatch[2],
        name: declarationMatch[3],
        line: i + 1,
        exported: false,
      });
    }
  }

  if (entries.length === 0) return "";

  const visibleEntries = entries.slice(0, MAX_OUTLINE_ENTRIES);
  const formatted = visibleEntries.map((entry) => {
    const name = entry.exported ? entry.name : `${entry.name} (local)`;
    return `  ${entry.kind.padEnd(10)} ${name.padEnd(40)} (line ${entry.line})`;
  });
  if (entries.length > visibleEntries.length) {
    formatted.push(
      `  ... ${entries.length - visibleEntries.length} more declarations omitted; use lineRange for specific sections.`
    );
  }
  return ["Top-level exports/declarations:", ...formatted].join("\n");
}
