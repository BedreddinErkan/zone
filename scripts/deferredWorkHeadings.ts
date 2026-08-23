/**
 * Ledger heading/entry-body parsing, extracted from `deferredWorkSnapshot.test.ts`
 * (item 36) into its own non-test module so it can be imported without pulling
 * that file's own `describe`/`it` registrations along with it — importing a
 * `.test.ts` file directly re-executes its top-level test registrations as a
 * side effect (confirmed empirically: a probe importing one function from it
 * ran that file's full 23-test suite, not the 1 test the probe itself
 * defined). Matches the existing split for `deferredWorkAnaphorSweep.ts` /
 * `.test.ts` and `deferredWorkPositionalSweep.ts` / `.test.ts`.
 */

export interface Heading {
  n: number;
  closed: boolean;
  /** Line index of the "## N. ..." heading itself — the entry body runs from
   *  here to the next heading (or the snapshot section). */
  line: number;
}

export function parseHeadings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  lines.forEach((line, i) => {
    const m = /^## (\d+)\. (.*)$/.exec(line);
    if (m) out.push({ n: Number(m[1]), closed: /^Closed —/.test(m[2]!), line: i });
  });
  return out;
}

export function entryBodiesByNumber(lines: string[], headings: Heading[]): Map<number, string> {
  const snapshotStart = lines.findIndex((l) => /^## Status snapshot/.test(l));
  const result = new Map<number, string>();
  for (let idx = 0; idx < headings.length; idx++) {
    const { n, line } = headings[idx]!;
    const endLine =
      idx + 1 < headings.length
        ? headings[idx + 1]!.line
        : snapshotStart === -1
          ? lines.length
          : snapshotStart;
    result.set(n, lines.slice(line, endLine).join("\n"));
  }
  return result;
}
