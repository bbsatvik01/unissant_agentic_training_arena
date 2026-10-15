/**
 * Office styles beside Classic (the default, drawn by AgentOffice). Each entry is one line, loaded only when a viewer
 * picks it (its own client chunk); the Office view's style switcher lists Classic first, then these.
 */
import type { ComponentType } from "react";

import type { RunEventEnvelope } from "@/lib/contracts/run-events";
import type { Approvals } from "@/lib/pipeline/rail";
import type { OfficeRecord } from "@/lib/war-room/office";
import type { SwarmView } from "@/lib/war-room/swarm";
import type { Focus } from "@/lib/war-room/swarm-graph";

import type { OfficeDrive, OfficeLive, OfficeReplay } from "./agent-office";

/** What every office style is drawn from: AgentOffice's props, the run's kept frames and its approvals (H1, H2). */
export interface OfficeStyleProps {
  view: SwarmView;
  record: OfficeRecord;
  live: OfficeLive | null;
  focus: Focus;
  onFocus: (f: Focus) => void;
  onReplay: (r: OfficeReplay | null) => void;
  recordError: string | null;
  /** The run's own frames the office feed kept (OfficeFeed.envs). */
  envs: readonly RunEventEnvelope[];
  /** The run's approvals (approvalsOf of the run row); null outside a run page. */
  approvals: Approvals | null;
  /** The run page's full-run replay drives the style at its cursor (its clock, cursor and whole record). */
  driven: OfficeDrive | null;
  /** Start the run page's full-run replay. */
  onReplayRun?: (() => void) | undefined;
}

export interface OfficeStyle {
  id: string;
  label: string;
  load: () => Promise<{ default: ComponentType<OfficeStyleProps> }>;
}

export const OFFICE_STYLES: readonly OfficeStyle[] = [
  { id: "command-case-board", label: "Case Board", load: () => import("./office-styles/case-board") },
  { id: "wild-playhouse", label: "Playhouse", load: () => import("./office-styles/playhouse") },
  { id: "game-bid-tower", label: "Bid Tower", load: () => import("./office-styles/bid-tower") },
];
