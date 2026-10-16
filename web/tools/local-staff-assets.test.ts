import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "../src/lib/precinct/localStaffVoiceManifest.json";
import type { LocalStaffClip } from "../src/lib/precinct/localStaffVoice";
const clips: readonly (LocalStaffClip & { readonly sample_rate: number; readonly rms: number; readonly peak: number })[] = manifest.clips;
const root = new URL("../public/audio/staff-v1/", import.meta.url);
describe("genuine generated local staff assets", () => {
  it("contains 23 original exact clips with matching bytes, SHA-256, nonzero PCM and bounded duration", () => {
    expect(clips).toHaveLength(23);
    expect(readdirSync(root).filter((name) => name.endsWith(".wav"))).toHaveLength(23);
    for (const clip of clips) {
      const file = new URL(`${clip.id}.wav`, root);
      const bytes = readFileSync(fileURLToPath(file));
      expect(statSync(file).size).toBe(clip.bytes); expect(bytes.length).toBeLessThan(5 * 1024 * 1024);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(clip.sha256);
      expect(bytes.toString("ascii", 0, 4)).toBe("RIFF"); expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
      let offset = 12; let format = 0; let channels = 0; let rate = 0; let bits = 0; let pcm: Buffer | null = null;
      while (offset + 8 <= bytes.length) {
        const name = bytes.toString("ascii", offset, offset + 4); const length = bytes.readUInt32LE(offset + 4); const start = offset + 8;
        expect(start + length).toBeLessThanOrEqual(bytes.length);
        if (name === "fmt ") { format = bytes.readUInt16LE(start); channels = bytes.readUInt16LE(start + 2); rate = bytes.readUInt32LE(start + 4); bits = bytes.readUInt16LE(start + 14); }
        if (name === "data") pcm = bytes.subarray(start, start + length);
        offset = start + length + length % 2;
      }
      expect(format).toBe(1); expect(channels).toBe(1); expect(bits).toBe(16); expect(rate).toBe(clip.sample_rate); expect(pcm).not.toBeNull();
      if (pcm === null) throw new Error("PCM data missing");
      let energy = 0; let peak = 0; let silence = 0;
      for (let i = 0; i < pcm.length; i += 2) { const sample = pcm.readInt16LE(i) / 32768; energy += sample * sample; peak = Math.max(peak, Math.abs(sample)); if (sample === 0) silence += 1; }
      const frames = pcm.length / 2;
      expect(Math.sqrt(energy / frames)).toBeCloseTo(clip.rms, 8); expect(peak).toBeCloseTo(clip.peak, 8); expect(peak).toBeGreaterThan(0.01); expect(silence).toBeGreaterThan(0);
      expect(frames / rate).toBeCloseTo(clip.duration_seconds, 8); expect(clip.duration_seconds).toBeLessThan(60);
    }
  });
});
