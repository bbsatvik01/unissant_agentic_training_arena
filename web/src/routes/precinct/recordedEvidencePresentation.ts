import type { PublicEvidenceSource } from "../../lib/precinct/evidenceTable";
import type { WorldReplayState } from "../../lib/world/worldEvents";
/** Physical paper is a read-only projection of one actual marker and currently public source. */
export function recordedEvidencePresentation(world: Pick<WorldReplayState, "pinnedEvidence">, sources: readonly PublicEvidenceSource[]): PublicEvidenceSource | null {
  if (world.pinnedEvidence.size !== 1) return null;
  const [id] = world.pinnedEvidence;
  const matches = sources.filter((source) => source.ref.id === id);
  return matches.length === 1 ? matches[0] ?? null : null;
}
