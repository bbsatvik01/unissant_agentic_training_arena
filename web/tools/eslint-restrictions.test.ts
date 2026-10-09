/**
 * Negative fixtures for the S6 lint restrictions: each forbidden pattern must FAIL lint, and the
 * allowed neighbours must pass, so the gate cannot be emptied without a test going red.
 * Fixtures are linted as text at virtual paths (no type information needed for these rules).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

import { restrictions } from "../eslint.restrictions.js";

const eslint = new ESLint({
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  overrideConfigFile: true,
  overrideConfig: [
    { files: ["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"], languageOptions: { parser: tseslint.parser, globals: { fetch: "readonly", window: "readonly" } } },
    ...restrictions,
  ],
});

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? "parse-error");
}

describe("FE-TECH-3: fetch only inside src/lib/api/", () => {
  const cases: [string, string][] = [
    ["a bare fetch call in a route", 'void fetch("/api/me");'],
    ["window.fetch", 'void window.fetch("/api/me");'],
    ["globalThis.fetch", 'void globalThis.fetch("/api/me");'],
    ["self.fetch", 'void self.fetch("/api/me");'],
  ];
  it.each(cases)("fails %s", async (_name, code) => {
    const ids = await ruleIds(code, "src/routes/room.tsx");
    expect(ids.some((id) => id === "no-restricted-globals" || id === "no-restricted-properties")).toBe(true);
  });
  it.each(["src/routes/network.js", "src/lib/network.mjs", "public/worker.js", "src/lib/network.mts", "src/lib/network.cts", "src/routes/network.jsx", "shared/network.js", "network.js"])("fails fetch in %s", async (filePath) => {
    expect(await ruleIds('void fetch("/api/me");', filePath)).toContain("no-restricted-globals");
  });
  it("fails fetch in a lib module outside api/", async () => {
    expect(await ruleIds('void fetch("/x");', "src/lib/sse/x.ts")).toContain("no-restricted-globals");
  });
  it("exempts only Node-side tools/, which the bundler never reaches", async () => {
    expect(await ruleIds('void fetch("http://127.0.0.1/x");', "tools/proxy.test.ts")).toEqual([]);
    expect(await ruleIds('void fetch("/x");', "vite.config.ts")).toContain("no-restricted-globals");
  });
  it("allows fetch inside src/lib/api/", async () => {
    expect(await ruleIds('void fetch("/api/me");', "src/lib/api/client.ts")).toEqual([]);
  });
  it("allows a local binding that merely shares the name's neighbours", async () => {
    expect(await ruleIds("const fetchImpl = () => 1; void fetchImpl();", "src/routes/room.tsx")).toEqual([]);
  });
});

describe("FE-TECH-3: no Supabase anywhere in web", () => {
  const cases: [string, string, string][] = [
    ["a static import in src", 'import { createClient } from "@supabase/supabase-js";\nvoid createClient;', "src/lib/x.ts"],
    ["a subpath import", 'import "@supabase/ssr";', "src/lib/x.ts"],
    ["a dynamic import", 'void import("@supabase/supabase-js");', "src/lib/x.ts"],
    ["a require", 'require("@supabase/supabase-js");', "tools/x.js"],
    ["a dynamic import in a template literal", "void import(`@supabase/supabase-js`);", "src/lib/x.ts"],
    ["a require in a template literal", "require(`@supabase/supabase-js`);", "tools/x.cjs"],
    ["an import in an .mjs tool", 'import "@supabase/supabase-js";', "tools/x.mjs"],
    ["a template-literal module.require", "module.require(`@supabase/supabase-js`);", "tools/x.cjs"],
    ["an inline type import", 'export type C = import("@supabase/supabase-js").SupabaseClient;', "src/lib/x.ts"],
    ["a bracket module[\"require\"]", 'module["require"]("@supabase/supabase-js");', "tools/x.cjs"],
    ["a template-literal bracket require", "module[`require`](`@supabase/supabase-js`);", "tools/x.cjs"],
    ["an interpolated bracket require", 'const a = "x"; module["require"](`${a}/y`);', "tools/x.cjs"],
    ["module.require", 'module.require("@supabase/supabase-js");', "tools/x.cjs"],
    ["a require with an interpolated specifier", "const scope = 'a'; require(`${scope}/supabase-js`);", "tools/x.cjs"],
    ["a dynamic import of a variable", "const name = 'a'; void import(name);", "src/lib/x.ts"],
    ["an import in tooling", 'import "@supabase/supabase-js";', "vite.config.ts"],
  ];
  it.each(cases)("fails %s", async (_name, code, filePath) => {
    const ids = await ruleIds(code, filePath);
    expect(ids.some((id) => id === "no-restricted-imports" || id === "no-restricted-syntax")).toBe(true);
  });
});

describe("FE-SSE-7: animated components never import src/lib/api/", () => {
  const dirs = ["companion", "avatar", "arena", "motion"];
  const imports = ['import { api } from "../../lib/api/client";', 'import { api } from "../../../lib/api";', 'import "../../lib/api/index";'];
  for (const dir of dirs) {
    it.each(imports)(`fails in components/${dir}: %s`, async (code) => {
      expect(await ruleIds(`${code}\nvoid 0;`, `src/components/${dir}/Thing.tsx`)).toContain("no-restricted-imports");
    });
  }
  const loads = [
    'export type C = import("../../lib/api/client").Client;',
    "module.require(`../../lib/api/client`);",
    'module["require"]("../../lib/api/client");','void import("../../lib/api/client");', "void import(`../../lib/api/client`);", 'require("../../lib/api/client");', "require(`../../lib/api`);"];
  it.each(loads)("fails a dynamic load in components/motion: %s", async (code) => {
    expect(await ruleIds(code, "src/components/motion/Thing.tsx")).toContain("no-restricted-syntax");
  });
  it.each([
    'void import.meta.glob("/src/lib/api/*.ts", { eager: true });',
    'void import.meta.glob("../../lib/**/*.ts");',
    'void import.meta.glob(["../x/*.ts"], { import: "default" });',
  ])("fails a Vite glob import in a component: %s", async (code) => {
    expect(await ruleIds(code, "src/components/arena/probe.mjs")).toContain("no-restricted-syntax");
  });
  it("allows a glob outside animated components", async () => {
    expect(await ruleIds('void import.meta.glob("./*.ts");', "src/routes/x.ts")).toEqual([]);
  });
  it("fails an API import in a .js component", async () => {
    expect(await ruleIds('import "../../lib/api/client";', "src/components/companion/network.js")).toContain("no-restricted-imports");
  });
  it("allows a dynamic load of a reducer module in a component", async () => {
    expect(await ruleIds('void import("../../lib/companion/fsm");', "src/components/arena/Thing.tsx")).toEqual([]);
  });
  it("still bans Supabase there", async () => {
    expect(await ruleIds('import "@supabase/supabase-js";', "src/components/arena/Thing.tsx")).toContain("no-restricted-imports");
  });
  it("allows reducer-state imports in components and api imports elsewhere", async () => {
    expect(await ruleIds('import { x } from "../../lib/companion/fsm";\nvoid x;', "src/components/companion/Thing.tsx")).toEqual([]);
    expect(await ruleIds('import { api } from "../lib/api/client";\nvoid api;', "src/routes/room.tsx")).toEqual([]);
  });
});

describe("the shipped eslint.config.js", () => {
  const shipped = new ESLint({ cwd: fileURLToPath(new URL("..", import.meta.url)) });
  const files = [
    "src/lib/x.ts",
    "src/routes/x.tsx",
    "src/lib/x.mts",
    "src/lib/x.cts",
    "src/lib/x.js",
    "src/lib/x.mjs",
    "src/lib/x.cjs",
    "public/worker.js",
  ];
  it.each(files)("applies the fetch restriction to %s", async (filePath) => {
    const config = (await shipped.calculateConfigForFile(filePath)) as { rules?: Record<string, unknown> } | undefined;
    expect(config?.rules?.["no-restricted-globals"]).toBeDefined();
    expect(config?.rules?.["no-restricted-syntax"]).toBeDefined();
  });
  it.each(["src/components/arena/x.mts", "src/components/motion/x.js"])("applies the API-import ban to %s", async (filePath) => {
    const config = (await shipped.calculateConfigForFile(filePath)) as { rules?: Record<string, unknown> } | undefined;
    expect(JSON.stringify(config?.rules?.["no-restricted-imports"])).toContain("lib/api");
  });
  it("lints a real .jsx file with the shipped config and rejects fetch in it", async () => {
    const [result] = await shipped.lintText('export const A = () => <a href={fetch("/api/me")} />;\n', { filePath: "src/routes/probe.jsx" });
    expect((result?.messages ?? []).map((m) => m.ruleId)).toContain("no-restricted-globals");
  });
  it("leaves src/lib/api/ free to call fetch", async () => {
    const config = (await shipped.calculateConfigForFile("src/lib/api/client.ts")) as { rules?: Record<string, unknown> } | undefined;
    expect(config?.rules?.["no-restricted-globals"]).toBeUndefined();
  });
});

describe("FE-TECH-3: no script ESLint cannot see", () => {
  it("index.html carries no inline script, so every fetch is in a linted module", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/<script\b[^>]*>\s*[^<\s]/i);
  });
});
