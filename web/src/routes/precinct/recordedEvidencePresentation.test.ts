import { describe, expect, it } from "vitest";
import type { PublicEvidenceSource } from "../../lib/precinct/evidenceTable";
import { recordedEvidencePresentation } from "./recordedEvidencePresentation";
const source: PublicEvidenceSource = { ref: { kind: "document", id: "public" }, title: "Public opening source" };
describe("recorded physical evidence projection", () => {
  it("shows only one captured marker resolving to one current public source", () => {
    expect(recordedEvidencePresentation({ pinnedEvidence: new Set(["public"]) }, [source])).toBe(source);
    expect(recordedEvidencePresentation({ pinnedEvidence: new Set() }, [source])).toBeNull();
    expect(recordedEvidencePresentation({ pinnedEvidence: new Set(["public", "other"]) }, [source])).toBeNull();
    expect(recordedEvidencePresentation({ pinnedEvidence: new Set(["unreleased"]) }, [source])).toBeNull();
    expect(recordedEvidencePresentation({ pinnedEvidence: new Set(["public"]) }, [])).toBeNull();
  });
  it("does not guess between document and record sharing a raw legacy ID", () => {
    expect(recordedEvidencePresentation({ pinnedEvidence: new Set(["public"]) }, [source, { ref: { kind: "record", id: "public" }, title: "Different record" }])).toBeNull();
  });
});
