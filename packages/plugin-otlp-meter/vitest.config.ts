import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "lcov", "html"],
      exclude: ["node_modules/**", "dist/**", "**/*.d.ts", "**/*.config.ts", "test/**"],
      // Per-file floors pinned ~2 points below measured coverage so
      // newly uncovered code in any file fails CI. Globals below still gate totals.
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
        statements: 85,
        "src/index.ts": { lines: 90, branches: 82 },
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
