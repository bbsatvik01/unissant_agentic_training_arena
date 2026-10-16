import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MATRIX, movementEvidence, projectTarget, routingOptions, routingOutcome } from "./precinct-floor-routing-model";

const args = ["--url=http://127.0.0.1:4173/", "--out=/tmp/owned-qa", "--dist=/tmp/owned-build/dist", "--artifact-label=final-candidate-sha"];
describe("real floor-route browser acceptance contract", () => {
  it("always requires all four world and camera cases and an identified production artifact", () => {
    expect(MATRIX).toEqual([{ scene: "office", camera: "first" }, { scene: "office", camera: "third" }, { scene: "courtyard", camera: "first" }, { scene: "courtyard", camera: "third" }]);
    expect(routingOptions(args)).toMatchObject({ output: "/tmp/owned-qa", software: false, headed: false, slowStartDiagnostic: false });
    expect(routingOptions([...args, "--software", "--headed"]).software).toBe(true);
    expect(routingOptions([...args, "--slow-start-diagnostic"]).slowStartDiagnostic).toBe(true);
    for (const invalid of [[], args.slice(0, 3), [...args, "--scene=office"], [...args, "--software=false"], [...args, "--slow-start-diagnostic=false"], [...args, "--out=/tmp/other"], ["--url=https://example.org/", ...args.slice(1)], ["--url=http://localhost/?x=1", ...args.slice(1)], [args[0] ?? "", "--out=relative", ...args.slice(2)], [args[0] ?? "", "--out=/workspace/shared/unissant_agentic_training_arena/report", ...args.slice(2)]]) expect(() => routingOptions(invalid)).toThrow();
  });
  it("retains nonzero acceptance after independent functional completion with failed cold entry", () => {
    expect(routingOutcome(true, true)).toEqual({ status: "passed", exitCode: 0 });
    expect(routingOutcome(false, true)).toEqual({ status: "functional-completed-cold-start-failed", exitCode: 1 });
    expect(routingOutcome(true, false)).toEqual({ status: "failed", exitCode: 1 });
    expect(routingOutcome(false, false)).toEqual({ status: "failed", exitCode: 1 });
    const source = readFileSync(new URL("./precinct-floor-routing-smoke.ts", import.meta.url), "utf8");
    expect(source).toContain("ENTRY_MS = 5000"); expect(source).toContain("FOLLOWUP_MS = 60_000");
    expect(source).toContain("if (!options.slowStartDiagnostic) throw coldStartError");
    expect(source).toContain("result.coldEntry.followupReady = false; throw coldStartError");
    expect(source).toContain('return report.status === "passed" ? 0 : 1');
  });
  it("selects fixed Studio through the existing helper and verifies actual root attributes", () => {
    const source = readFileSync(new URL("./precinct-floor-routing-smoke.ts", import.meta.url), "utf8");
    expect(source).toContain('import { selectBenchmarkTheme, verifyBenchmarkTheme } from "./precinct-performance-theme.ts"');
    expect(source).toContain('await selectBenchmarkTheme(live, "studio")');
    expect(source).toContain('result.theme.beforeEntry = await live.locator(".precinct-root").getAttribute("data-theme")');
    expect(source).toContain('verifyBenchmarkTheme(result.theme.beforeEntry, "studio")');
    expect(source).toContain('result.theme.afterFunctional = await live.locator(".precinct-root").getAttribute("data-theme")');
    expect(source).toContain('verifyBenchmarkTheme(result.theme.afterFunctional, "studio")');
    expect(source).toContain('label: "initial default Office load"');
    expect(source).not.toMatch(/import[^;]+from ["'][^"']+(?:\.tsx|precinct-performance\.ts)["']/u);
    expect(() => routingOptions([...args, "--theme=office"])).toThrow();
  });
  it("rejects stationary, endpoint-only teleport, incomplete and jitter traces", () => {
    const a = { x: 0, z: -4.2 }, b = { x: 1.4, z: -7.4 };
    const sample = (x: number, z: number, elapsedMs: number) => ({ x, z, elapsedMs });
    for (const trace of [[], [sample(0, -4.2, 1000)], [sample(1.4, -7.4, 1000)], [sample(0.01, -4.21, 200), sample(0.02, -4.22, 400)], [sample(0.3, -5, 200), sample(0.3, -5, 400), sample(1.4, -7.4, 1000)], [sample(0.3, -5, 200), sample(0.6, -5.8, 600)]]) expect(movementEvidence(a, b, trace).passed).toBe(false);
    expect(movementEvidence(a, b, [sample(0.3, -5, 200), sample(0.6, -5.8, 600), sample(1.4, -7.4, 1800)])).toMatchObject({ passed: true, endpointError: 0, distinctIntermediatePositions: 2 });
  });
  it("projects a fresh camera sample and fails closed for hidden or malformed targets", () => {
    const camera = { cameraPosition: [0, 1.65, -4.2], cameraQuaternion: [0, 0, 0, 1] };
    const rect = { x: 10, y: 20, width: 1440, height: 900 };
    const center = projectTarget([0, 1.65, -10], camera, "first", rect);
    expect(center.x).toBeCloseTo(730); expect(center.y).toBeCloseTo(470);
    expect(projectTarget([1, 0.015, -8], camera, "third", rect).x).toBeGreaterThan(center.x);
    for (const point of [[0, 1.65, 10], [100, 0, -5], [NaN, 0, -7]] as const) expect(() => projectTarget(point, camera, "first", rect)).toThrow();
    expect(() => projectTarget([0, 0, -7], { ...camera, cameraQuaternion: [] }, "first", rect)).toThrow();
  });
  it("pins the read-only probe, live camera FOV, actual route handler and original transparent floor contract", () => {
    const source = readFileSync(new URL("../src/components/precinct/PrecinctCanvas.tsx", import.meta.url), "utf8");
    expect(source).toContain('const fov = anchor?.fov ?? (mode === "first" ? 66 : 58)');
    expect(source).toContain('props.onControlInput?.({ action: "click", target: "precinct:floor", button: event.button })');
    expect(source).toContain("path.current = planNavigationRoute(position.current, destination, props.manifest, props.manifest.playerNavigationMesh) ?? []");
    expect(source).toContain("<planeGeometry args={[...pointerFloor.size]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} />");
    const floorStart = source.indexOf("    <mesh rotation={[-Math.PI / 2, 0, 0]} position={pointerFloor.center} onPointerDown={(event) => {");
    const floorEnd = source.indexOf("    </mesh>", floorStart);
    expect(floorStart).toBeGreaterThanOrEqual(0);
    expect(floorEnd).toBeGreaterThan(floorStart);
    const floor = source.slice(floorStart, floorEnd);
    expect(floor).toContain("<planeGeometry args={[...pointerFloor.size]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} />");
    expect(floor).not.toMatch(/\bvisible\s*=\s*\{\s*false\s*\}/u);
    expect(floor).toContain("if (props.replayActors !== undefined || seated || !props.active || props.paused || event.button !== 0 || document.pointerLockElement === canvas) return;");
    expect(floor).toContain('props.onControlInput?.({ action: "click", target: "precinct:floor", button: event.button });');
    expect(floor).toContain("path.current = planNavigationRoute(position.current, destination, props.manifest, props.manifest.playerNavigationMesh) ?? [];");
    const probe = readFileSync(new URL("../src/components/precinct/PrecinctPerformanceProbe.tsx", import.meta.url), "utf8");
    expect(probe).toContain("cameraPosition: camera.position.toArray(), cameraQuaternion: camera.quaternion.toArray()");
  });
});
