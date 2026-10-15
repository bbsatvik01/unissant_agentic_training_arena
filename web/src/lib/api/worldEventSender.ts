/** Transport adapter only: never creates a client, reads /me, or enables a backend by itself. */
import type { ApiClient } from "./client";
import type { WorldEventSender } from "../world/worldCapture";
import { MAX_WORLD_BATCH_BYTES, splitWorldEventBatches, worldEventBatchBytes } from "../world/worldEvents";

export interface WorldWriteGate {
  readonly localSessionEnabled: () => boolean;
  readonly activeTrialId: () => string | null;
  readonly origin: () => { readonly protocol: string; readonly hostname: string };
}
export function createWorldEventSender(client: Pick<ApiClient, "post">, gate: WorldWriteGate): WorldEventSender {
  return async (trialId, batch) => {
    const { protocol, hostname } = gate.origin();
    if (!gate.localSessionEnabled() || gate.activeTrialId() !== trialId || !/^[A-Za-z0-9_-]{1,160}$/.test(trialId)
      || !["http:", "https:"].includes(protocol) || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) {
      throw new Error("Explicit matching local session required for world-event writes");
    }
    if (worldEventBatchBytes(batch) > MAX_WORLD_BATCH_BYTES) throw new RangeError("World-event batch exceeds 64 KB");
    const batches = splitWorldEventBatches(batch.events);
    // Local finding transitions are a recording extension, never backend world-event writes.
    if (batches.some((part) => part.events.some((event) => event.kind === "input" && event.data.action === "finding"))) {
      throw new TypeError("UI-local finding actions cannot be posted as world events");
    }
    if (batches.length === 0) return;
    await client.post(`/api/trials/${encodeURIComponent(trialId)}/world-events`, batches[0]);
  };
}
