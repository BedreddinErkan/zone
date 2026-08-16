import { describe, expect, it } from "vitest";
import { rankRelevantFiles, extractEntityTerms, shouldSkipPath } from "./rankRelevantFiles.js";
import type { RepoFile } from "../types/project.js";

function buildRepoFile(
  path: string,
  category: RepoFile["category"] = "unknown"
): RepoFile {
  const extension = path.includes(".") ? path.split(".").pop() ?? "" : "";
  return {
    path,
    absolutePath: `C:/repo/${path}`,
    extension,
    category,
  };
}

describe("rankRelevantFiles", async () => {
  it("prioritizes frontend component files for component tasks", async () => {
    const ranked = await rankRelevantFiles({
      task: "update the booking component UI",
      files: [
        buildRepoFile("server/routes/bookings.ts", "backend"),
        buildRepoFile("src/components/BookingCard.tsx", "frontend"),
        buildRepoFile("README.md"),
      ],
    });

    expect(ranked[0].path).toBe("src/components/BookingCard.tsx");
  });

  it("prioritizes backend endpoint files for endpoint tasks", async () => {
    const ranked = await rankRelevantFiles({
      task: "fix the bookings endpoint response",
      files: [
        buildRepoFile("src/components/BookingCard.tsx", "frontend"),
        buildRepoFile("server/routes/bookings.ts", "backend"),
        buildRepoFile("server/controllers/bookingsController.ts", "backend"),
      ],
    });

    expect(ranked[0].path).toBe("server/controllers/bookingsController.ts");
    expect(ranked[1].path).toBe("server/routes/bookings.ts");
  });

  it("prioritizes auth-related files for auth tasks", async () => {
    const ranked = await rankRelevantFiles({
      task: "fix auth bug in login flow",
      files: [
        buildRepoFile("src/components/Dashboard.tsx", "frontend"),
        buildRepoFile("server/middleware/auth.ts", "backend"),
        buildRepoFile("server/routes/login.ts", "backend"),
      ],
    });

    expect(ranked[0].path).toBe("server/middleware/auth.ts");
    expect(ranked[1].path).toBe("server/routes/login.ts");
  });

  it("prioritizes config files for config and build tasks", async () => {
    const ranked = await rankRelevantFiles({
      task: "update build config for vite",
      files: [
        buildRepoFile("src/components/App.tsx", "frontend"),
        buildRepoFile("vite.config.ts"),
        buildRepoFile("package.json"),
      ],
    });

    expect(ranked[0].path).toBe("vite.config.ts");
    expect(ranked[1].path).toBe("package.json");
  });

  it("falls back deterministically for ambiguous tasks", async () => {
    const ranked = await rankRelevantFiles({
      task: "improve flow",
      files: [
        buildRepoFile("README.md"),
        buildRepoFile("src/app.ts", "unknown"),
        buildRepoFile("server/index.ts", "backend"),
      ],
    });

    expect(ranked[0].path).toBe("server/index.ts");
    expect(ranked[1].path).toBe("src/app.ts");
    expect(ranked[2].path).toBe("README.md");
  });

  it("prioritizes ui html and css files for font and styling tasks", async () => {
    const ranked = await rankRelevantFiles({
      task: "improve font size and css styling for the ui header",
      files: [
        buildRepoFile("server/routes/bookings.ts", "backend"),
        buildRepoFile("src/ui/index.html", "frontend"),
        buildRepoFile("src/ui/styles.css", "frontend"),
        buildRepoFile("src/components/Header.tsx", "frontend"),
      ],
    });

    expect(ranked[0].path).toBe("src/ui/index.html");
    expect(ranked[1].path).toBe("src/ui/styles.css");
  });

  it("prioritizes css directory files for spacing and layout tasks", async () => {
    const ranked = await rankRelevantFiles({
      task: "fix layout spacing and padding in css",
      files: [
        buildRepoFile("src/app.ts", "frontend"),
        buildRepoFile("src/css/global.css", "frontend"),
        buildRepoFile("src/styles/theme.scss", "frontend"),
        buildRepoFile("server/index.ts", "backend"),
      ],
    });

    expect(ranked[0].path).toBe("src/css/global.css");
    expect(ranked[1].path).toBe("src/styles/theme.scss");
  });

  it("prioritizes src/ui/index.html for button background tasks", async () => {
    const ranked = await rankRelevantFiles({
      task: "change Execute button background color in the Zone UI",
      files: [
        buildRepoFile("src/components/LoginForm.tsx", "frontend"),
        buildRepoFile("src/ui/index.html", "frontend"),
        buildRepoFile("src/ui/styles.css", "frontend"),
      ],
    });

    expect(ranked[0].path).toBe("src/ui/index.html");
  });

  it("prioritizes src/ui/index.html when task explicitly mentions index.html or known ui classes", async () => {
    const ranked = await rankRelevantFiles({
      task: "update src/ui index.html exec-btn color and decision-badge styling",
      files: [
        buildRepoFile("src/components/LoginForm.tsx", "frontend"),
        buildRepoFile("src/ui/index.html", "frontend"),
        buildRepoFile("src/ui/styles.css", "frontend"),
      ],
    });

    expect(ranked[0].path).toBe("src/ui/index.html");
  });

  it("strongly boosts explicit basename matches from the task text", async () => {
    const ranked = await rankRelevantFiles({
      task: "In PatientDetail.jsx add uploading state",
      files: [
        buildRepoFile("client/src/pages/ForgotPasswordPage.jsx", "frontend"),
        buildRepoFile("client/src/pages/PatientDetail.jsx", "frontend"),
      ],
    });

    expect(ranked[0].path).toBe("client/src/pages/PatientDetail.jsx");
  });

  it("heavily boosts exact component-name matches and suppresses generic page boosts for other pages", async () => {
    const ranked = await rankRelevantFiles({
      task: "In PatientDetail add uploading state",
      files: [
        buildRepoFile("client/src/pages/ForgotPasswordPage.jsx", "frontend"),
        buildRepoFile("client/src/pages/PatientDetail.jsx", "frontend"),
        buildRepoFile("client/src/pages/PatientList.jsx", "frontend"),
      ],
    });

    expect(ranked[0].path).toBe("client/src/pages/PatientDetail.jsx");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThanOrEqual(ranked[2].score);
  });

  it("prefers a localized page file over a broad app shell for page form validation tasks", async () => {
    const ranked = await rankRelevantFiles({
      task: "Add minimal client-side validation to the Patients page create form",
      files: [
        buildRepoFile("client/src/App.jsx", "frontend"),
        buildRepoFile("client/src/pages/PatientsPage.jsx", "frontend"),
        buildRepoFile("client/src/components/PatientCreateForm.jsx", "frontend"),
      ],
    });

    expect(ranked[0].path).toBe("client/src/pages/PatientsPage.jsx");
    expect(ranked[1].path).toBe("client/src/components/PatientCreateForm.jsx");
    expect(ranked[2].path).toBe("client/src/App.jsx");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
  });
});

describe("extractEntityTerms", () => {
  it("extracts a camelCase identifier", () => {
    expect(extractEntityTerms("call fetchUserData now")).toEqual(["fetchuserdata"]);
  });

  it("extracts a SCREAMING_SNAKE_CASE identifier", () => {
    expect(extractEntityTerms("set DATABASE_URL now")).toEqual(["database_url"]);
  });

  // Filler kept to three characters or fewer deliberately -- an earlier draft used
  // "explain"/"helper" here, both of which are themselves snake_case-branch-eligible
  // (5+ lowercase chars, no underscore) and made this test fail under a guard mutation
  // that has nothing to do with the quoted branch this test exists to pin.
  it("extracts a quoted identifier", () => {
    expect(extractEntityTerms("see `hasClerkEnv` now")).toEqual(["hasclerkenv"]);
  });

  it("extracts a snake_case identifier", () => {
    expect(extractEntityTerms("check user_session now")).toEqual(["user_session"]);
  });

  // Verbatim text of the frozen ranker ground's T6 (rankerBaseline.snapshot.json) --
  // one of item 79's own zero-term tasks. "projects" and "contains" both match the
  // snake_case branch's regex but are dropped for lacking an underscore; nothing else
  // in the sentence reaches any branch.
  it("drops plain lowercase words with no underscore, on a real zero-term ground task", () => {
    expect(extractEntityTerms("how do we tell what kind of projects this contains")).toEqual([]);
  });

  // Filler kept short so this is isolated from the underscore guard above -- the one
  // collected-test interaction with ENTITY_TERM_BLOCKLIST before this file (item 79,
  // 8c24e8f3) lived incidentally in preparePlanContext.test.ts; this pins it directly.
  it("removes a quoted stopword via the blocklist", () => {
    expect(extractEntityTerms('fix "test" now')).toEqual([]);
  });

  it("returns the same term sequence on repeated calls, in extraction order rather than sorted", () => {
    // camelCase's own pass matches `zoneMarker` (it is itself camelCase-shaped) before
    // the quoted pass ever runs, which is why it lands second rather than trailing after
    // the SCREAMING_SNAKE match -- confirmed both by reading (the camelCase regex
    // matches "zoneMarker") and by running (a patched copy that skips only that token in
    // the camelCase pass moves it to the end, exactly where the quoted pass would place
    // it), not assumed.
    const task =
      "call fetchUserData and set DATABASE_URL then use user_session and read the `zoneMarker` note";
    const first = extractEntityTerms(task);
    expect(first).toEqual(["fetchuserdata", "zonemarker", "database_url", "user_session"]);
    expect(extractEntityTerms(task)).toEqual(first);
  });
});

// A representative subset of the 52 tracked src/ files this repo's own unanchored substring
// match silently dropped (measured fresh this pass: two independent instruments, identical
// 52-file sets, every one a false positive on the token "build" inside a camelCase filename —
// none is under a directory literally named build/dist/venv/etc.).
describe("shouldSkipPath — no longer a false positive on a filename that merely contains a token", () => {
  it.each([
    "src/core/buildEnv.ts",
    "src/core/buildDecisionTrace.ts",
    "src/cli/buildGeneratedPatchPlanPreview.ts",
  ])("%s is not skipped", (path) => {
    expect(shouldSkipPath(path)).toBe(false);
  });

  // Beyond this repo's own 52 — proves the fix generalizes past the one token this repo
  // happened to expose, not just past the specific files found here.
  it.each(["src/rebuild.rs", "src/distance.rs", "src/distributor.py"])(
    "%s (token as a substring of a segment, not a whole segment) is not skipped",
    (path) => {
      expect(shouldSkipPath(path)).toBe(false);
    }
  );
});

// No real build/dist/venv/etc. directory exists under this repo's src/ today (established this
// pass) — these are constructed paths, proving the fix still catches a genuine one rather than
// having traded false positives for false negatives.
describe("shouldSkipPath — a genuine skip directory is still caught at every position, both separators", () => {
  it.each([
    ["build/src/index.ts", true, "first segment, forward slash"],
    ["src/build/index.ts", true, "middle segment, forward slash"],
    ["src/foo/build", true, "last segment, forward slash"],
    ["build\\src\\index.ts", true, "first segment, backslash"],
    ["src\\build\\index.ts", true, "middle segment, backslash"],
    ["src\\foo\\build", true, "last segment, backslash"],
  ] as const)("%s -> %s (%s)", (path, expected) => {
    expect(shouldSkipPath(path)).toBe(expected);
  });

  it("every token in the list is independently reachable as a segment", () => {
    for (const token of ["venv", ".venv", "site-packages", "__pycache__", "node_modules", ".git", "dist", "build", ".next"]) {
      expect(shouldSkipPath(`src/${token}/file.ts`), `token "${token}" did not skip`).toBe(true);
    }
  });
});
