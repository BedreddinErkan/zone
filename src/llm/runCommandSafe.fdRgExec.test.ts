/**
 * Change 1 regression: fd/rg exec-flag vectors must be blocked by the blacklist.
 * fd is anchored (head-command only); rg is unanchored (catches mid-pipeline use).
 */

import { describe, expect, it } from "vitest";
import { checkCommandSafe } from "./runCommandSafe.js";

describe("fd exec-flag blacklist (anchored)", () => {
  it("fd -x rm {} is blocked", () => {
    expect(checkCommandSafe("fd -x rm {}").safe).toBe(false);
  });
  it("fd --exec node x.js is blocked", () => {
    expect(checkCommandSafe("fd --exec node x.js").safe).toBe(false);
  });
  it("fd -X rm {} is blocked (exec-batch short flag)", () => {
    expect(checkCommandSafe("fd -X rm {}").safe).toBe(false);
  });
  it("fd --exec-batch node is blocked", () => {
    expect(checkCommandSafe("fd --exec-batch node").safe).toBe(false);
  });
  it("fd --exec=node is blocked (= form)", () => {
    expect(checkCommandSafe("fd --exec=node").safe).toBe(false);
  });
  it("plain fd search is allowed", () => {
    expect(checkCommandSafe("fd foo").safe).toBe(true);
  });
  it("fd with extension filter is allowed", () => {
    expect(checkCommandSafe("fd -e txt src/").safe).toBe(true);
  });
  it("fd-as-arg in ls command is NOT blocked (anchored pattern)", () => {
    expect(checkCommandSafe("ls fd -x").safe).toBe(true);
  });
  it("fd-as-arg in grep (filename) is NOT blocked (anchored pattern)", () => {
    expect(checkCommandSafe("grep fd.txt -x foo").safe).toBe(true);
  });
});

describe("rg pre-processor blacklist (unanchored)", () => {
  it("rg --pre ./run.sh pat is blocked", () => {
    expect(checkCommandSafe("rg --pre ./run.sh pat").safe).toBe(false);
  });
  it("rg --pre-glob '*.sh' pat is blocked", () => {
    expect(checkCommandSafe("rg --pre-glob '*.sh' pat").safe).toBe(false);
  });
  it("rg --pre=./script.sh is blocked (= form)", () => {
    expect(checkCommandSafe("rg --pre=./script.sh pattern").safe).toBe(false);
  });
  it("cat file.txt | rg --pre ./run.sh pattern is blocked (mid-pipeline rg exec vector)", () => {
    expect(checkCommandSafe("cat file.txt | rg --pre ./run.sh pattern").safe).toBe(false);
  });
  it("plain rg search is allowed", () => {
    expect(checkCommandSafe("rg foo src/").safe).toBe(true);
  });
  it("rg with safe flags is allowed", () => {
    expect(checkCommandSafe("rg --type ts --hidden pattern src/").safe).toBe(true);
  });
});
