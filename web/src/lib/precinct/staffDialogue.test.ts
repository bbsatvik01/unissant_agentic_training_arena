import { describe, expect, it } from "vitest";

import { STAFF_CONVERSATIONS, STAFF_INTERACTIONS, staffReply, type StaffSpeaker } from "./staffDialogue";
import type { Collider, Hotspot } from "./types";
import manifestJson from "../../../public/world/precinct-manifest.json?raw";
import staffComponentSource from "../../components/precinct/PrecinctStaff.tsx?raw";

const manifest = JSON.parse(manifestJson) as {
  colliders: readonly Collider[];
  hotspots: readonly Hotspot[];
};

describe("authored staff conversations", () => {
  it.each<StaffSpeaker>(["receptionist", "sergeant"])("returns only authored, deterministic replies for %s", (speaker) => {
    const conversation = STAFF_CONVERSATIONS[speaker];
    expect(new Set(conversation.replies.map((reply) => reply.topic)).size).toBe(conversation.replies.length);
    for (const reply of conversation.replies) {
      expect(staffReply(speaker, reply.topic)).toBe(reply);
      expect(reply.label.length).toBeGreaterThan(0);
      expect(reply.text.length).toBeGreaterThan(20);
      if (reply.destination !== undefined) expect(manifest.hotspots.some((hotspot) => hotspot.id === reply.destination)).toBe(true);
    }
  });

  it("does not echo arbitrary requests or construct case-specific answers", () => {
    for (const topic of ["who_is_guilty", "constructor", "Jordan's hidden score is 99", "", "<script>caseSecret()</script>"]) {
      expect(staffReply("sergeant", topic)).toEqual({ topic: "help", label: "Available topics", text: STAFF_CONVERSATIONS.sergeant.introduction });
      expect(staffReply("receptionist", topic).text).toBe(STAFF_CONVERSATIONS.receptionist.introduction);
    }
  });

  it("explicitly rejects demeanor as evidence and never claims case access", () => {
    const text = staffReply("sergeant", "demeanor").text;
    expect(text).toContain("Do not treat accent");
    expect(text).toContain("as evidence of truth or deception");
    expect(staffReply("sergeant", "limits").text).toContain("cannot identify a culprit, reveal hidden facts, or evaluate your case");
    expect(STAFF_CONVERSATIONS.sergeant.introduction).toContain("do not know the answers");
  });

  it("exposes accessible interaction anchors within existing reception/briefing hotspot ranges", () => {
    for (const interaction of STAFF_INTERACTIONS) {
      const hotspot = manifest.hotspots.find((value) => value.id === interaction.hotspotId);
      expect(hotspot).toBeDefined();
      if (hotspot === undefined) continue;
      expect(Math.hypot(interaction.position[0] - hotspot.position[0], interaction.position[2] - hotspot.position[2])).toBeLessThan(hotspot.radius);
      for (const collider of manifest.colliders) {
        if (collider.max[1] <= 0 || collider.min[1] >= 1.8) continue;
        const [x, , z] = interaction.position;
        const blocked = x > collider.min[0] - 0.28 && x < collider.max[0] + 0.28
          && z > collider.min[2] - 0.28 && z < collider.max[2] + 0.28;
        expect(blocked, `${interaction.speaker} blocked by ${collider.id}`).toBe(false);
      }
    }
  });

  it("keeps unobstructed eye-level and shoulder-width sightlines from each interaction anchor to its staff member", () => {
    for (const interaction of STAFF_INTERACTIONS) {
      // A clear center ray alone can leave half a colleague hidden behind a door post.
      for (const shoulderOffset of [-0.35, 0, 0.35]) {
        for (let step = 0; step <= 100; step += 1) {
          const t = step / 100;
          const point = [interaction.position[0] + (interaction.lookAt[0] + shoulderOffset - interaction.position[0]) * t,
            1.65 + (interaction.lookAt[1] - 1.65) * t,
            interaction.position[2] + (interaction.lookAt[2] - interaction.position[2]) * t] as const;
          for (const collider of manifest.colliders) {
            const blocked = point.every((value, axis) => value > (collider.min[axis] ?? -Infinity) && value < (collider.max[axis] ?? Infinity));
            expect(blocked, `${interaction.speaker} sightline blocked by ${collider.id}`).toBe(false);
          }
        }
      }
    }
  });

  it("keeps the rendering component's public props restricted to presentation controls", () => {
    const source = staffComponentSource;
    const block = source.match(/export interface PrecinctStaffProps \{([^}]+)\}/)?.[1] ?? "";
    expect([...block.matchAll(/readonly\s+(\w+):/g)].map((match) => match[1])).toEqual(["paused", "reducedMotion", "tier"]);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:lib\/api|useLiveSession|worldState|cases)[^"']*["']/);
    expect(source).not.toContain("fetch(");
  });
});
