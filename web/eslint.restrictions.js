// @ts-check
/**
 * The architectural import and call restrictions of the web app, as flat-config objects shared by
 * `eslint.config.js` and by `tools/eslint-restrictions.test.ts` (which proves each forbidden
 * pattern fails lint).
 *
 *   - FE-TECH-3 (S6 1.2): `fetch(` only inside `src/lib/api/`; no `@supabase/*` import anywhere.
 *   - FE-SSE-7 (S6 5.4): animated components (`src/components/{companion,avatar,arena,motion,world,overlay}/**`)
 *     import nothing from `src/lib/api/`; they read reducer state only.
 *
 * This is a tripwire for the ordinary violation, not a sandbox: it does not follow aliases of the
 * browser global (`const w = window; w.fetch(...)`) or resolve `..` segments in relative specifiers;
 * code review owns those.
 *
 * A flat-config rule set replaces, never merges with, an earlier one for the same files, so the
 * component entry repeats the Supabase pattern next to the API patterns.
 */

const SUPABASE_PATTERN = {
  group: ["@supabase/*"],
  message: "FE-TECH-3: the browser never talks to Supabase; data comes from the arena-api through src/lib/api/.",
};

const API_PATTERN = {
  group: ["**/lib/api", "**/lib/api/**"],
  message: "FE-SSE-7: animated components read projected reducer state only; they never import src/lib/api/.",
};

/**
 * Dynamic `import(...)` and `require(...)` bypass `no-restricted-imports`. This forbids them for a
 * module-name pattern, whether the specifier is a string literal or a template literal.
 * @param {string} pattern regular-expression source matched against the specifier
 * @param {string} message
 */
function dynamicLoadSyntax(pattern, message) {
  const re = `/${pattern.replaceAll("/", "\\/")}/`;
  return [
    { selector: `ImportExpression[source.value=${re}]`, message },
    { selector: `TSImportType[argument.literal.value=${re}]`, message },
    { selector: `ImportExpression[source.type='TemplateLiteral'][source.quasis.0.value.cooked=${re}]`, message },
    { selector: `CallExpression:matches([callee.name='require'], [callee.property.name='require'], [callee.property.value='require'], [callee.property.quasis.0.value.cooked='require'])[arguments.0.value=${re}]`, message },
    {
      selector: `CallExpression:matches([callee.name='require'], [callee.property.name='require'], [callee.property.value='require'], [callee.property.quasis.0.value.cooked='require'])[arguments.0.type='TemplateLiteral'][arguments.0.quasis.0.value.cooked=${re}]`,
      message,
    },
  ];
}

/**
 * A dynamic load whose specifier is not statically known cannot be checked against any boundary
 * (`import(name)`, `require(`${scope}/x`)`), so it fails closed. The bundler needs static specifiers anyway.
 */
const OPAQUE_LOAD_SYNTAX = [
  {
    selector: "ImportExpression[source.type!='Literal'][source.type!='TemplateLiteral']",
    message: "A dynamic import must name its module statically so the import boundaries can be checked.",
  },
  {
    selector: "ImportExpression[source.type='TemplateLiteral'][source.expressions.length>0]",
    message: "A dynamic import must name its module statically so the import boundaries can be checked.",
  },
  {
    selector: "CallExpression:matches([callee.name='require'], [callee.property.name='require'], [callee.property.value='require'], [callee.property.quasis.0.value.cooked='require'])[arguments.0.type!='Literal'][arguments.0.type!='TemplateLiteral']",
    message: "A require must name its module statically so the import boundaries can be checked.",
  },
  {
    selector: "CallExpression:matches([callee.name='require'], [callee.property.name='require'], [callee.property.value='require'], [callee.property.quasis.0.value.cooked='require'])[arguments.0.type='TemplateLiteral'][arguments.0.expressions.length>0]",
    message: "A require must name its module statically so the import boundaries can be checked.",
  },
];

const SUPABASE_SYNTAX = dynamicLoadSyntax("^@supabase/", "FE-TECH-3: no @supabase/* import anywhere in web.");
/** Vite expands `import.meta.glob(...)` into imports of every match, so it can reach src/lib/api/ unseen. */
const GLOB_SYNTAX = [
  {
    selector: "CallExpression[callee.object.type='MetaProperty'][callee.property.name='glob']",
    message: "FE-SSE-7: animated components may not glob-import modules; a glob can reach src/lib/api/.",
  },
];

const API_SYNTAX = dynamicLoadSyntax(
  "(^|/)lib/api(/|$)",
  "FE-SSE-7: animated components read projected reducer state only; they never load src/lib/api/.",
);

/** Every source extension this config parses (typed block: ts, tsx, mts, cts; plain-JS block: js, jsx, mjs, cjs); a boundary must not depend on the extension. */
const EXT = "{js,jsx,mjs,cjs,ts,tsx,mts,cts}";

const FETCH_MESSAGE = "FE-TECH-3: fetch is allowed only inside src/lib/api/ (the one wrapper adds the CSRF header).";

/** @type {import("eslint").Linter.Config[]} */
export const restrictions = [
  {
    files: [`**/*.${EXT}`],
    rules: {
      "no-restricted-imports": ["error", { patterns: [SUPABASE_PATTERN] }],
      "no-restricted-syntax": ["error", ...SUPABASE_SYNTAX, ...OPAQUE_LOAD_SYNTAX],
    },
  },
  {
    files: [`**/*.${EXT}`],
    // tools/ holds Node-side tests and scripts that are never bundled into the browser app (the dev-proxy
    // test calls fetch against a local server); everything the bundler can reach is covered.
    ignores: ["src/lib/api/**", "tools/**"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: FETCH_MESSAGE }],
      "no-restricted-properties": [
        "error",
        ...["window", "globalThis", "self"].map((object) => ({ object, property: "fetch", message: FETCH_MESSAGE })),
      ],
    },
  },
  {
    files: [`src/components/{companion,avatar,arena,motion,world,overlay}/**/*.${EXT}`],
    rules: {
      "no-restricted-imports": ["error", { patterns: [SUPABASE_PATTERN, API_PATTERN] }],
      "no-restricted-syntax": ["error", ...SUPABASE_SYNTAX, ...API_SYNTAX, ...GLOB_SYNTAX, ...OPAQUE_LOAD_SYNTAX],
    },
  },
];
