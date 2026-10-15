/**
 * The recorded War Room stream for the gold run, built once per server process from the fixtures.
 * Server-only: the fixture route handlers stream or serve it; the browser never imports the
 * evidence ledger to rebuild it.
 */
import type { RunEventEnvelope } from "@/lib/contracts/run-events";
import { RUN_ID, warRoomScriptInput } from "@/lib/data/nccs";

import { buildScript, offsetsOf } from "./script";

let cached: { events: RunEventEnvelope[]; offsets: number[] } | null = null;

export function recording(runId: string): { events: RunEventEnvelope[]; offsets: number[] } | null {
  if (runId !== RUN_ID) return null;
  if (!cached) {
    const events = buildScript(warRoomScriptInput());
    cached = { events, offsets: offsetsOf(events) };
  }
  return cached;
}
