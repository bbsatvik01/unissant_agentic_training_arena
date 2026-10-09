import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config.ts";

/**
 * Coverage gate (S6 12): 90% on `src/lib/**`, the pure modules (reducers, machines, SSE client). Lines
 * and branches are the spec's floor; functions and statements are held at the same level, as in the
 * TechnoMile gate this one is lifted from. Test files are not source and are not counted.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "node",
      include: ["src/**/*.test.{ts,tsx}", "tools/**/*.test.ts"],
      coverage: {
        provider: "v8",
        include: ["src/lib/**"],
        exclude: ["src/**/*.test.{ts,tsx}"],
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
