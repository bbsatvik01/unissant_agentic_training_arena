/** Read-only capabilities from the existing guarded session API. Creates no client or connection. */
import type { ArenaApi } from "./arena";
import { ContractError } from "./client";

export type PrecinctStationReads = Pick<ArenaApi, "progress" | "readDebrief" | "tournaments" | "tournament" | "tournamentEvents" | "leaderboard">;

export function createPrecinctStationReads(api: PrecinctStationReads): PrecinctStationReads {
  return {
    progress: api.progress,
    async readDebrief(sessionId) {
      const answer = await api.readDebrief(sessionId);
      // Schema validation alone cannot bind a valid response to the participant's requested session.
      if (!("status" in answer) && answer.session_id !== sessionId) throw new ContractError("station debrief", "the requested session's published debrief");
      return answer;
    },
    tournaments: api.tournaments,
    tournament: api.tournament,
    tournamentEvents: api.tournamentEvents,
    leaderboard: api.leaderboard,
  };
}
