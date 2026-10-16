import { sceneChangeReason, selectPrecinctWorld, type PrecinctWorldId, type SceneChangeState } from "../../lib/precinct/sceneSelection";

interface Props {
  readonly value: PrecinctWorldId;
  readonly state: SceneChangeState;
  readonly onChange: (value: PrecinctWorldId) => void;
}

export function PrecinctWorldSelector({ value, state, onChange }: Props) {
  const reason = sceneChangeReason(state);
  return <div className="precinct-world-choice">
    <label htmlFor="precinct-architecture"><span>Architecture<small>Both layouts keep the same training stations</small></span>
      <select id="precinct-architecture" value={value} disabled={reason !== null} aria-describedby="precinct-architecture-note" onChange={(event) => {
        const next = selectPrecinctWorld(value, event.target.value, state);
        if (next !== value) onChange(next);
      }}><option value="office">Office</option><option value="courtyard">Courtyard</option></select>
    </label>
    <p id="precinct-architecture-note" className="precinct-note">{reason ?? (value === "courtyard"
      ? "Original compact courtyard adaptation inspired by the Old Patent Office HABS survey. Training rooms retain their original coordinates."
      : "Original Northstar office precinct. You can switch back to this layout at any time outside an active run or recording.")}</p>
  </div>;
}
