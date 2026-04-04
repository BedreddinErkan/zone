import { describe, expect, it } from "vitest";
import { rankRelevantFiles } from "./rankRelevantFiles.js";
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

describe("rankRelevantFiles", () => {
  it("prioritizes frontend component files for component tasks", () => {
    const ranked = rankRelevantFiles({
      task: "update the booking component UI",
      files: [
        buildRepoFile("server/routes/bookings.ts", "backend"),
        buildRepoFile("src/components/BookingCard.tsx", "frontend"),
        buildRepoFile("README.md"),
      ],
    });

    expect(ranked[0].path).toBe("src/components/BookingCard.tsx");
  });

  it("prioritizes backend endpoint files for endpoint tasks", () => {
    const ranked = rankRelevantFiles({
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

  it("prioritizes auth-related files for auth tasks", () => {
    const ranked = rankRelevantFiles({
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

  it("prioritizes config files for config and build tasks", () => {
    const ranked = rankRelevantFiles({
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

  it("falls back deterministically for ambiguous tasks", () => {
    const ranked = rankRelevantFiles({
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

  it("prioritizes ui html and css files for font and styling tasks", () => {
    const ranked = rankRelevantFiles({
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

  it("prioritizes css directory files for spacing and layout tasks", () => {
    const ranked = rankRelevantFiles({
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
});
