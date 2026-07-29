import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { zoneTestHome } from "./src/test/testHome.js";

// Every ~/.zone writer resolves os.homedir() at call time, so redirecting HOME
// isolates all of them at once. This is set through test.env rather than a setup
// file because test.env lands in the worker before any user module is evaluated
// — earlier than a module-level `const` could capture the old value.
const TEST_HOME = zoneTestHome();

export default defineConfig({
  plugins: [react()],
  test: {
    env: { ZONE_TRUST_ALL: "1", HOME: TEST_HOME, USERPROFILE: TEST_HOME },
    globalSetup: ["src/test/setup/globalHome.ts"],
    setupFiles: ["src/test/setup/homeGuard.ts"],
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    exclude: ["src/llm/taskClassifier.archetype.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "dist/**",
        "node_modules/**"
      ]
    }
  }
});