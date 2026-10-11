/**
 * The live session in hand, remembered per case for this tab (S6 5.1 fresh-load recovery): a reload or a trip back
 * to the precinct keeps the session's ids, so the room can attach to it again (snapshot, then the stream or the
 * published debrief) instead of starting another one. Only the ids are kept, in session storage; anything
 * unreadable reads as nothing remembered, and the room works without storage.
 */
import { parseStarted, type StartedSession } from "../api/arena";

const PREFIX = "arena.session.";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function store(): Store | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Storage blocked (private mode, sandboxed frame): nothing is remembered.
    return null;
  }
}

export function rememberSession(started: StartedSession, s: Store | null = store()): void {
  try {
    s?.setItem(PREFIX + started.case_id, JSON.stringify(started));
  } catch {
    // Full or blocked storage: the session simply is not remembered.
  }
}

export function recallSession(caseId: string, s: Store | null = store()): StartedSession | null {
  try {
    const raw = s?.getItem(PREFIX + caseId) ?? null;
    const started = raw === null ? null : parseStarted(JSON.parse(raw));
    return started !== null && started.case_id === caseId ? started : null;
  } catch {
    // Unreadable or malformed: nothing remembered.
    return null;
  }
}

export function forgetSession(caseId: string, s: Store | null = store()): void {
  try {
    s?.removeItem(PREFIX + caseId);
  } catch {
    // Blocked storage holds nothing to forget.
  }
}
