import { navigationStatusText, type WorldNavigationStatus } from "../../lib/precinct/worldNavigation";

/** Accessible planner disclosure; no frame loop, renderer, timers or navigation owner. */
export function PrecinctNavigationStatus({ status }: { readonly status: WorldNavigationStatus }) {
  return <p className="precinct-note" role="status" aria-label="Navigation status">{navigationStatusText(status)}</p>;
}
