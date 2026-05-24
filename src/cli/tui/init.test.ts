import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripTrailingCodeBlock } from "./init.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import type { Dispatch } from "react";
import type { StoreAction } from "./store.js";

vi.mock("../../llm/investigationFlow.js", () => ({ runInvestigationFlow: vi.fn() }));
vi.mock("../../api/diskKeys.js", () => ({ loadDiskKeys: vi.fn() }));

import { runInit } from "./init.js";
import { runInvestigationFlow } from "../../llm/investigationFlow.js";
import { loadDiskKeys } from "../../api/diskKeys.js";

const LONG_RESPONSE = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n");

const mockFlowResult = (chatResponse: string) => ({
  ok: true as const,
  decisionMode: "investigation" as const,
  chatResponse,
  responseHtml: "",
  contextFiles: [],
  applyPatches: [] as never[],
  fileDiffs: [] as never[],
  toolCallLog: [],
});

describe("runInit", () => {
  let tmp: string;
  let dispatched: StoreAction[];
  let dispatch: Dispatch<StoreAction>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "zone-init-"));
    dispatched = [];
    dispatch = (a: StoreAction) => { dispatched.push(a); };
    vi.mocked(loadDiskKeys).mockResolvedValue({ keys: [] } as never);
    vi.mocked(runInvestigationFlow).mockResolvedValue(mockFlowResult(LONG_RESPONSE));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function texts(): string[] {
    return dispatched
      .filter(a => a.type === "USER_PROMPT")
      .map(a => (a as { type: "USER_PROMPT"; text: string }).text);
  }

  it("refuses and does not call investigator when memory.md already exists and is non-empty", async () => {
    await mkdir(join(tmp, ".zone"), { recursive: true });
    await writeFile(join(tmp, ".zone", "memory.md"), "existing content", "utf-8");

    await runInit(tmp, dispatch);

    expect(vi.mocked(runInvestigationFlow)).not.toHaveBeenCalled();
    expect(texts().some(t => t.includes("already exists"))).toBe(true);
  });

  it("writes chatResponse wrapped in ZONE_INIT markers and emits success notice when file absent", async () => {
    await runInit(tmp, dispatch);

    expect(vi.mocked(runInvestigationFlow)).toHaveBeenCalledOnce();
    const content = await readFile(join(tmp, ".zone", "memory.md"), "utf-8");
    expect(content).toContain("<!-- ZONE_INIT_BEGIN -->");
    expect(content).toContain(LONG_RESPONSE.split("\n")[0]);
    expect(content).toContain("<!-- ZONE_INIT_END -->");
    expect(texts().some(t => t.startsWith("Created .zone/memory.md"))).toBe(true);
  });

  it("still writes file but emits short-response warning when response has <20 lines", async () => {
    const SHORT = "## Project\nZone.\n## Stack\nTS.";
    vi.mocked(runInvestigationFlow).mockResolvedValue(mockFlowResult(SHORT));

    await runInit(tmp, dispatch);

    const content = await readFile(join(tmp, ".zone", "memory.md"), "utf-8");
    expect(content).toContain("<!-- ZONE_INIT_BEGIN -->");
    expect(content).toContain("## Project");
    expect(texts().some(t => t.toLowerCase().includes("short") || t.toLowerCase().includes("review"))).toBe(true);
  });
});

describe("stripTrailingCodeBlock", () => {
  it("T1: removes trailing ```json code block", () => {
    const input = "line1\nline2\n```json\n{\"x\":1}\n```";
    expect(stripTrailingCodeBlock(input)).toBe("line1\nline2");
  });

  it("T2: leaves clean string unchanged", () => {
    const s = "line1\nline2\n- bullet";
    expect(stripTrailingCodeBlock(s)).toBe(s);
  });

  it("T3: preserves interim code block, strips only trailing one", () => {
    const input =
      "intro\n```bash\nnpm test\n```\nsome text\n```json\n{\"x\":1}\n```";
    const result = stripTrailingCodeBlock(input);
    expect(result).toContain("```bash\nnpm test\n```");
    expect(result).not.toContain("```json");
  });
});
