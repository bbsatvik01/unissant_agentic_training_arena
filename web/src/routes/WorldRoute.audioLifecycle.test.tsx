// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CASES } from "../lib/world/cases";
import { WorldRoute } from "./WorldRoute";

// The real route/hooks/audio lifecycle run; only the GPU canvas is replaced in this unit test.
vi.mock("../components/world/WorldCanvas", () => ({ default: () => <div data-testid="world-canvas" /> }));
const contexts: { resume: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
const transport = vi.fn<(input: string) => Promise<Response>>();
beforeEach(() => {
  contexts.length = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("AudioContext", vi.fn(function makeContext() {
    const context = { state: "suspended", resume: vi.fn(() => { context.state = "running"; return Promise.resolve(); }), close: vi.fn(() => { context.state = "closed"; return Promise.resolve(); }) };
    contexts.push(context); return context;
  }));
  transport.mockImplementation((path) => {
    if (path === "/api/cases") return Promise.resolve(new Response(JSON.stringify({ cases: CASES }), { status: 200 }));
    if (path === "/api/me") return Promise.resolve(new Response(JSON.stringify({ user_id: "local-user", display_name: "Local trainee", roles: [], csrf_token: "test-token", ex4_acknowledged: "2026-10-15T09:00:00Z" }), { status: 200 }));
    return Promise.reject(new Error(`Unexpected test request: ${path}`));
  });
  vi.stubGlobal("fetch", transport);
});
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it("the actual legacy WorldRoute activates only its committed StrictMode engine and releases it on exit", async () => {
  const { unmount } = render(<StrictMode><WorldRoute /></StrictMode>);
  await screen.findByRole("button", { name: "Progress" });
  expect(contexts).toHaveLength(0);
  act(() => { window.dispatchEvent(new Event("keydown")); window.dispatchEvent(new Event("pointerdown")); });
  expect(contexts).toHaveLength(1); expect(contexts[0]?.resume).toHaveBeenCalledOnce();
  unmount(); expect(contexts[0]?.close).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("pointerdown")); window.dispatchEvent(new Event("keydown")); expect(contexts).toHaveLength(1);
});
