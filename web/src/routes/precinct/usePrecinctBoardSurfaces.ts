import { useMemo, useState } from "react";
import { projectCaseSurfaces, projectRecognitionSurface, type BoardSurfaceContext, type RecognitionRead } from "../../lib/precinct/boardSurfaces";
import { stationCaseEntries } from "../../lib/precinct/stationSources";
import type { PrecinctSession } from "./usePrecinctSession";

export type BoardSurfaceSession = Pick<PrecinctSession, "backend" | "me" | "stationReads" | "source" | "sessionKey" | "cases" | "selectedCase" | "packetState" | "assessmentActive">;
/** Memory-only display sink. Reads remain owned by the explicitly opened connected trophy panel. */
export function usePrecinctBoardSurfaces(session: BoardSurfaceSession) {
  const connected = session.backend === "connected" && session.me !== null && session.stationReads !== null;
  const userId = connected ? session.me?.user_id ?? null : null;
  const caseId = session.selectedCase?.case_id ?? null;
  const scope = JSON.stringify([session.backend, userId, connected, session.source, session.sessionKey, caseId, session.assessmentActive]);
  const [held, setHeld] = useState<{ readonly scope: string; readonly owner: object; readonly read: RecognitionRead | null }>(() => ({ scope, owner: {}, read: null }));
  // React's guarded same-component state adjustment prevents source A -> B -> A from reviving A's old cache.
  // The owner token also rejects a late callback from a prior incarnation of the same source string.
  if (held.scope !== scope) setHeld({ scope, owner: {}, read: null });
  const owner = held.owner;
  const read = held.scope === scope ? held.read : null;
  const context = useMemo<BoardSurfaceContext>(() => ({ scope, backend: session.backend, userId, assessment: session.assessmentActive }), [scope, session.backend, userId, session.assessmentActive]);
  const recognitionSink = useMemo(() => ({ scope, onRead: (next: RecognitionRead) => {
    setHeld((current) => current.owner === owner && current.scope === next.scope ? { ...current, read: next } : current);
  } }), [scope, owner]);
  const cases = useMemo(() => projectCaseSurfaces(context, stationCaseEntries(session.cases, connected), caseId, session.packetState === "loading"), [context, session.cases, connected, caseId, session.packetState]);
  const recognition = useMemo(() => projectRecognitionSurface(context, read), [context, read]);
  return { model: useMemo(() => ({ cases, recognition }), [cases, recognition]), recognitionSink };
}
