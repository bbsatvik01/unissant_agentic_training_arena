/** The route mounts exactly one copy, inside its native modal or in the walking HUD. */
import type { FreshCaptureState } from "../../lib/world/freshClientCapture";
import type { CaptureSnapshot } from "../../lib/world/worldCapture";
export interface CaptureStatusProps {
  readonly fresh: Pick<FreshCaptureState, "phase" | "reason">;
  readonly local: Pick<CaptureSnapshot, "status" | "issue" | "trialId">;
  readonly modal: boolean;
}
export function CaptureStatus({ fresh, local, modal }: CaptureStatusProps) {
  const text = fresh.phase === "idle" ? "" : fresh.phase === "armed" ? "Silent-text capture armed for the next new run."
    : fresh.phase === "recording" ? "Recording client-experienced silent text and sampled world state."
      : fresh.phase === "complete" ? "Client-experienced text timeline captured. World replay is sampled; original audio is absent."
        : `Silent-text capture incomplete (${fresh.reason ?? "invalid-data"}). Only the accepted prefix is available.`;
  const world = local.trialId === null ? "" : `Local sampled world capture: ${local.status === "blocked" ? "incomplete" : local.status}${local.issue === null ? ". Offline only." : ` (${local.issue}). Earlier samples are retained.`}`;
  return <div className={`precinct-capture-status${modal ? " precinct-capture-status--modal" : ""}`} role="status" aria-label="Capture status" aria-live="polite" aria-atomic="true">{[text, world].filter(Boolean).join(" ")}</div>;
}
