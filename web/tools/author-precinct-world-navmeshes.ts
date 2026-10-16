/** Deterministic original two-world, two-profile navmesh authoring. Never writes authored render assets. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import type { AuthoredCollisionGeometry } from "../src/lib/precinct/effectiveWorldGeometry.ts";
import type { WorldNavmeshBundle } from "../src/lib/precinct/worldNavigation.ts";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("./") && !specifier.endsWith(".ts") && context.parentURL?.includes("/web/src/lib/precinct/") === true) return nextResolve(`${specifier}.ts`, context);
  return nextResolve(specifier, context);
} });
const { EFFECTIVE_WORLD_GEOMETRY_VERSION } = await import("../src/lib/precinct/effectiveWorldGeometry.ts");
const { worldNavmeshSource, WORLD_NAVMESH_SCHEMA } = await import("../src/lib/precinct/worldNavigation.ts");
const { buildPrecinctNavmesh, canonicalNavmeshSource, validatePrecinctNavmesh } = await import("../src/lib/precinct/precinctNavmesh.ts");
const { REVIEWER_COLLIDER_V2 } = await import("../src/lib/precinct/proceduralReviewerV2.ts");
const root = resolve(process.argv[2] ?? ".");
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const variants = [
  { id: "office", manifest: "precinct-manifest.json", sha256: "fc85679e66e176e2fc29c1b6caa2ad364b3a4c60e099fc3c22cc46b26b24552f" },
  { id: "courtyard", manifest: "precinct-courtyard-manifest.json", sha256: "a70a2d7685d48231f4fbd1d3d0ad647d370a8ea42670cf3a795476c7ac1caa96" },
] as const;
const outputFor = (id: string) => resolve(root, "web/public/world", `precinct-${id}-navmesh.json`);
const reportPath = resolve(root, "assets-src/precinct-world-navmesh-report.json");
if ([...variants.map(({ id }) => outputFor(id)), reportPath].some(existsSync)) throw new Error("Refusing to overwrite a frozen navigation artifact; use a fresh staging root.");
// Build and validate all four profiles before any output. Both worlds use the exact imported overlay.
const results = variants.map((variant) => {
  const bytes = readFileSync(resolve(root, "web/public/world", variant.manifest));
  if (hash(bytes) !== variant.sha256) throw new Error(`Unexpected authored manifest identity: ${variant.id}`);
  const authored = JSON.parse(bytes.toString("utf8")) as AuthoredCollisionGeometry;
  const make = (profile: "player" | "staff") => {
    const source = worldNavmeshSource(authored, profile);
    const overlay = source.colliders.filter((collider) => collider.id === REVIEWER_COLLIDER_V2.id);
    if (overlay.length !== 1 || JSON.stringify(overlay[0]) !== JSON.stringify(REVIEWER_COLLIDER_V2)) throw new Error(`Reviewer overlay mismatch: ${variant.id}`);
    const mesh = buildPrecinctNavmesh(source, hash(canonicalNavmeshSource(source)));
    const issues = validatePrecinctNavmesh(mesh, source);
    if (issues.length > 0) throw new Error(`${variant.id}/${profile}: ${issues.join("; ")}`);
    return mesh;
  };
  const bundle: WorldNavmeshBundle = { schema: WORLD_NAVMESH_SCHEMA, worldId: variant.id, player: make("player"), staff: make("staff") };
  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  if (Buffer.byteLength(json) > 5_242_880) throw new Error(`Navmesh exceeds committed file cap: ${variant.id}`);
  return { variant, bundle, json };
});
const report = { version: 1, geometryAdapter: EFFECTIVE_WORLD_GEOMETRY_VERSION, reviewerCollider: REVIEWER_COLLIDER_V2,
  authoredManifestsUnchanged: true, browserValidated: false, variants: results.map(({ variant, bundle, json }) => ({
    id: variant.id, authoredManifestSha256: variant.sha256, navmeshSha256: hash(json), bytes: Buffer.byteLength(json),
    artifact: `web/public/world/precinct-${variant.id}-navmesh.json`,
    profiles: ["player", "staff"].map((profile) => {
      const mesh = profile === "player" ? bundle.player : bundle.staff;
      return { profile, floorY: mesh.floorY, radius: mesh.agentRadius, effectiveSourceSha256: mesh.sourceSha256,
        polygons: mesh.polygons.length, portals: mesh.portals.length };
    }),
  })) };
const reportJson = `${JSON.stringify(report, null, 2)}\n`;
if (Buffer.byteLength(reportJson) > 5_242_880) throw new Error("Navmesh report exceeds committed file cap.");
mkdirSync(dirname(reportPath), { recursive: true });
for (const result of results) writeFileSync(outputFor(result.variant.id), result.json, { flag: "wx" });
writeFileSync(reportPath, reportJson, { flag: "wx" });
console.info(JSON.stringify(report, null, 2));
