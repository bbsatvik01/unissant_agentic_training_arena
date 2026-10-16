// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { Scene, Texture, type WebGLRenderer } from "three";
import { installPrecinctEnvironment, PrecinctEnvironment } from "./PrecinctEnvironment";

const fixture = vi.hoisted(() => ({
  state: undefined as { gl: WebGLRenderer; scene: Scene } | undefined,
  generators: [] as { dispose: ReturnType<typeof vi.fn>; fromScene: ReturnType<typeof vi.fn> }[],
  rooms: [] as { dispose: ReturnType<typeof vi.fn> }[],
  targets: [] as { texture: Texture; dispose: ReturnType<typeof vi.fn> }[],
  fail: false,
}));
vi.mock("@react-three/fiber", () => {
  const get = () => fixture.state;
  return { useThree: (select: (state: { get: typeof get }) => unknown) => select({ get }) };
});
vi.mock("three", async (original) => {
  const actual = await original<typeof import("three")>();
  return { ...actual, PMREMGenerator: class {
    dispose = vi.fn();
    fromScene = vi.fn(() => {
      if (fixture.fail) throw new Error("Synthetic PMREM failure");
      const target = { texture: new actual.Texture(), dispose: vi.fn() }; fixture.targets.push(target); return target;
    });
    constructor() { fixture.generators.push(this); }
  } };
});
vi.mock("three/examples/jsm/environments/RoomEnvironment.js", () => ({ RoomEnvironment: class {
  dispose = vi.fn();
  constructor() { fixture.rooms.push(this); }
} }));

beforeEach(() => {
  fixture.state = { gl: {} as WebGLRenderer, scene: new Scene() };
  fixture.generators.length = 0; fixture.rooms.length = 0; fixture.targets.length = 0; fixture.fail = false;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function state() { if (fixture.state === undefined) throw new Error("Fixture missing"); return fixture.state; }

describe("owned precinct environment", () => {
  it("constructs nothing while omitted", () => {
    render(<PrecinctEnvironment enabled={false} />);
    expect(fixture.generators).toHaveLength(0); expect(fixture.rooms).toHaveLength(0); expect(state().scene.environment).toBeNull();
  });
  it("retains original PMREM settings, restores previous state and releases only its resources once", () => {
    const previous = new Texture(), otherDispose = vi.spyOn(previous, "dispose");
    state().scene.environment = previous; state().scene.environmentIntensity = 0.7;
    const release = installPrecinctEnvironment(state().gl, state().scene);
    expect(fixture.generators[0]?.fromScene).toHaveBeenCalledWith(fixture.rooms[0], 0.04);
    expect(state().scene.environment).toBe(fixture.targets[0]?.texture); expect(state().scene.environmentIntensity).toBe(0.45);
    release(); release();
    expect(state().scene.environment).toBe(previous); expect(state().scene.environmentIntensity).toBe(0.7);
    expect(fixture.targets[0]?.dispose).toHaveBeenCalledTimes(1); expect(fixture.rooms[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(fixture.generators[0]?.dispose).toHaveBeenCalledTimes(1); expect(otherDispose).not.toHaveBeenCalled();
  });
  it("cleans repeated enabled/omitted transitions and StrictMode setup replay", () => {
    const view = render(<StrictMode><PrecinctEnvironment enabled /></StrictMode>);
    view.rerender(<StrictMode><PrecinctEnvironment enabled={false} /></StrictMode>);
    expect(state().scene.environment).toBeNull();
    view.rerender(<StrictMode><PrecinctEnvironment enabled /></StrictMode>);
    expect(state().scene.environment).not.toBeNull(); view.unmount();
    expect(state().scene.environment).toBeNull(); expect(fixture.targets.length).toBeGreaterThanOrEqual(2);
    for (const resource of [...fixture.targets, ...fixture.rooms, ...fixture.generators]) expect(resource.dispose).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite another owner's replacement or dispose its map", () => {
    const release = installPrecinctEnvironment(state().gl, state().scene), other = new Texture();
    const otherDispose = vi.spyOn(other, "dispose"); state().scene.environment = other; state().scene.environmentIntensity = 0.9;
    release(); expect(state().scene.environment).toBe(other); expect(state().scene.environmentIntensity).toBe(0.9);
    expect(otherDispose).not.toHaveBeenCalled(); expect(fixture.targets[0]?.dispose).toHaveBeenCalledTimes(1);
  });
  it("preserves an independently updated intensity while restoring its owned map", () => {
    const release = installPrecinctEnvironment(state().gl, state().scene); state().scene.environmentIntensity = 0.8;
    release(); expect(state().scene.environment).toBeNull(); expect(state().scene.environmentIntensity).toBe(0.8);
  });
  it("disposes partial setup and retains scene state when generation fails", () => {
    fixture.fail = true; const previous = new Texture(); state().scene.environment = previous;
    expect(() => installPrecinctEnvironment(state().gl, state().scene)).toThrow("Synthetic PMREM failure");
    expect(state().scene.environment).toBe(previous); expect(state().scene.environmentIntensity).toBe(1);
    expect(fixture.rooms[0]?.dispose).toHaveBeenCalledTimes(1); expect(fixture.generators[0]?.dispose).toHaveBeenCalledTimes(1);
  });
});
