import type { RefObject } from "react";
import type { WorkFrame } from "../../lib/agent-work/model";
import type { InterviewCastState } from "../../lib/precinct/interviewStage";
import type { PublicEvidenceSource } from "../../lib/precinct/evidenceTable";
import type { CameraMode, Vec3 } from "../../lib/precinct/types";

/** The route projects the session once. No trial, recording, case role or debrief enters the scene. */
export interface PrecinctInterviewScene {
  readonly cast: InterviewCastState | null;
  readonly subjectName: string;
  readonly clock: RefObject<number>;
  readonly work: WorkFrame;
  readonly present: boolean;
  readonly seated: boolean;
  readonly location: "interview" | "observation";
  /** Already-presented, currently public source only. V1 recordings have no table history. */
  readonly evidence?: PublicEvidenceSource | null;
}

/** Actual rendered camera data. The caller stamps time from its own canonical capture clock. */
export interface PrecinctCameraSample {
  readonly mode: CameraMode;
  readonly position: Vec3;
  readonly quaternion: readonly [number, number, number, number];
  readonly fov: number;
}
