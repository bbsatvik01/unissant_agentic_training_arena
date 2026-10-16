import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrecinctLocalApi, createPrecinctLocalConnection } from "./precinctLocalApi";

const origin = () => ({ protocol: "http:", hostname: "127.0.0.1" });
afterEach(() => { vi.unstubAllGlobals(); });
describe("explicit local precinct API", () => {
  it("keeps the connection disabled until an explicit enable and blocks again after disconnect", async () => {
    const transport = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ cases: [] }), { status: 200 })));
    const connection = createPrecinctLocalConnection({ origin, transport });
    expect(connection.isEnabled()).toBe(false);
    await expect(connection.api.listCases()).rejects.toThrow("Explicit local");
    connection.enable(); expect(connection.isEnabled()).toBe(true);
    await expect(connection.api.listCases()).resolves.toEqual([]);
    connection.disable(); expect(connection.isEnabled()).toBe(false);
    await expect(connection.api.listCases()).rejects.toThrow("Explicit local");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not touch the network without explicit selection, or on a hosted origin", async () => {
    const transport = vi.fn();
    await expect(createPrecinctLocalApi({ enabled: () => false, origin, transport }).listCases()).rejects.toThrow("Explicit local");
    await expect(createPrecinctLocalApi({ enabled: () => true, origin: () => ({ protocol: "https:", hostname: "training.example.com" }), transport }).listCases()).rejects.toThrow("Explicit local");
    expect(transport).not.toHaveBeenCalled();
  });
  it("uses the existing API validator and same-origin request policy after selection", async () => {
    const transport = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ cases: [] }), { status: 200 })));
    const api = createPrecinctLocalApi({ enabled: () => true, origin, transport });
    await expect(api.listCases()).resolves.toEqual([]);
    expect(transport).toHaveBeenCalledWith("/api/cases", expect.objectContaining({ credentials: "same-origin", redirect: "error" }));
  });
  it("checks the gate for every request, including requests after disconnect", async () => {
    let enabled = true;
    const transport = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ cases: [] }), { status: 200 })));
    const api = createPrecinctLocalApi({ enabled: () => enabled, origin, transport });
    await api.listCases(); enabled = false;
    await expect(api.listCases()).rejects.toThrow("Explicit local"); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("uses browser fetch only behind the gate when no test transport is injected", async () => {
    const transport = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ cases: [] }), { status: 200 })));
    vi.stubGlobal("fetch", transport);
    await createPrecinctLocalApi({ enabled: () => true, origin }).listCases();
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
