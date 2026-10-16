import { LeaderboardContent, NOT_CERTIFICATION } from "../overlay/ArenaView";
import type { Board, BoardsState } from "../../lib/arena/leaderboard";
import { TrainingGroundRule } from "./TrainingStations";

export function TrophyWallPanel({ state, assistant, subject, motionOff }: {
  readonly state: BoardsState;
  readonly assistant: Board | null;
  readonly subject: Board | null;
  readonly motionOff: boolean;
}) {
  return <div className="training-station trophy-wall-panel"><div className="training-intro"><span className="station-tag">THE TROPHY WALL</span><p>Good coaching protects the truthful.</p></div>
    <section className="trophy-gate-intro"><h3>Eligibility comes before rank</h3><ol><li>Pass isolation and leakage checks.</li><li>Meet the sponsor’s false-positive gate: at or below 5%.</li><li>Only then compare deceptive-role recall and questioning quality.</li></ol><p>{NOT_CERTIFICATION}</p></section>
    <div className="training-board-content"><LeaderboardContent state={state} assistant={assistant} subject={subject} motionOff={motionOff} /></div><TrainingGroundRule />
  </div>;
}
