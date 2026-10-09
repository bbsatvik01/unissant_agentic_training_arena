// @ts-check
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

import { restrictions } from "./eslint.restrictions.js";

export default defineConfig([
  // Build and test output, and one machine-written file: the wire validators ajv compiles at build time
  // (src/lib/contracts/generated/validators.js, S6 1.3: the CSP forbids compiling them in the page). Its generator
  // (tools/validators-codegen.ts) is linted and typed, a test fails when the file differs from a fresh generation,
  // and every wire fixture runs through it (validate.test.ts). Every hand-written source file is linted.
  globalIgnores(["dist/**", "coverage/**", "src/lib/contracts/generated/validators.js"]),
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, reactHooks.configs.flat.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // FE-TECH-3 and FE-SSE-7 (S6): fetch only in src/lib/api/, no Supabase, no API in animated components.
  ...restrictions,
  {
    // Plain-JavaScript JSX is not part of the typed project, but Vite compiles it: it is linted, so the
    // FE-TECH-3 and FE-SSE-7 restrictions cannot be sidestepped by a file extension.
    files: ["**/*.jsx"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  {
    // This file itself: plain JavaScript, outside every tsconfig, so no type-aware rules.
    files: ["**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
]);
