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
        "src/cgroup.ts": { lines: 96, branches: 89 },
        "src/crash-tracker.ts": { lines: 98, branches: 98 },
        "src/logger.ts": { lines: 98, branches: 73 },
        "src/orchestrator.ts": { lines: 93, branches: 76 },
        "src/platform.ts": { lines: 74, branches: 49 },
        "src/shutdown-coordinator.ts": { lines: 93, branches: 76 },
        "src/sizing.ts": { lines: 78, branches: 48 },
        "src/types.ts": { lines: 98, branches: 98 },
        "src/validation.ts": { lines: 96, branches: 97 },
        "src/worker-manager.ts": { lines: 92, branches: 80 },
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
