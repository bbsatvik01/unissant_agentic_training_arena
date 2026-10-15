import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config.ts";

/**
 * Coverage gate (S6 12): 90% on `src/lib/**`, the pure modules (reducers, machines, SSE client). Lines
 * and branches are the spec's floor; functions and statements are held at the same level, as in the
 * TechnoMile gate this one is lifted from. Test files are not source and are not counted; nor is the one
 * machine-written validator module (see the exclude below).
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "node",
      // Keep the complete suite within shared-cloud/laptop memory; no tests, timeouts,
      // coverage rules or assertions are relaxed. Excess forks can fail before tests start.
      maxWorkers: 2,
      include: ["src/**/*.test.{ts,tsx}", "tools/**/*.test.ts"],
      coverage: {
        provider: "v8",
        include: ["src/lib/**"],
        // Test files are not source. The build-time compiled validators (compiled/validators.js, about 1.7 MB of
        // ajv output) are machine-written: drift-checked against a fresh generation (tools/validators-codegen.test.ts)
        // and exercised by every valid and invalid wire fixture (validate.test.ts); their generator is covered.
        exclude: ["src/**/*.test.{ts,tsx}", "src/lib/contracts/compiled/validators.js"],
        reporter: ["text", "json-summary"],
        thresholds: {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
      },
    },
  }),
);
