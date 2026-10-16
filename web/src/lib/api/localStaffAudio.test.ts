import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLocalStaffAudio } from "./localStaffAudio";
const bytes = new Uint8Array(100).fill(7);
const fetcher = vi.fn();
const clip = async () => ({ url: "/audio/staff-v1/receptionist-welcome.wav", bytes: bytes.length, sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("") });
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { vi.unstubAllGlobals(); });
describe("bounded same-origin staff asset reader", () => {
  it("loads exact bytes and validates integrity without credentials or redirects", async () => {
    fetcher.mockResolvedValue(new Response(bytes)); const signal = new AbortController().signal;
    expect(new Uint8Array(await readLocalStaffAudio(await clip(), signal))).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledWith("/audio/staff-v1/receptionist-welcome.wav", { signal, credentials: "omit", mode: "same-origin", redirect: "error" });
  });
  it.each(["https://example.com/voice.wav", "/api/tts", "/audio/staff-v1/../../private.wav"])("refuses %s without network", async (url) => {
    await expect(readLocalStaffAudio({ ...await clip(), url }, new AbortController().signal)).rejects.toThrow("Invalid"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects missing, oversized, truncated, corrupted and cancelled audio", async () => {
    const asset = await clip(); const signal = new AbortController().signal;
    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 })); await expect(readLocalStaffAudio(asset, signal)).rejects.toThrow("unavailable");
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array(101))); await expect(readLocalStaffAudio(asset, signal)).rejects.toThrow("size");
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array(99))); await expect(readLocalStaffAudio(asset, signal)).rejects.toThrow("Incomplete");
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array(100))); await expect(readLocalStaffAudio(asset, signal)).rejects.toThrow("integrity");
    const controller = new AbortController(); controller.abort(); fetcher.mockResolvedValueOnce(new Response(bytes)); await expect(readLocalStaffAudio(asset, controller.signal)).rejects.toThrow("Incomplete");
  });
});
