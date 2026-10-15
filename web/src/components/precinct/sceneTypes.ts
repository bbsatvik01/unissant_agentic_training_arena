import type { Collider, Hotspot, NavigationNode, Vec3 } from "../../lib/precinct/types";

export interface PrecinctRoom {
  readonly id: string;
  readonly label: string;
  readonly anchor: Vec3;
  readonly min?: Vec3;
  readonly max?: Vec3;
}

export interface PrecinctManifest {
  readonly colliders: readonly Collider[];
  readonly hotspots: readonly Hotspot[];
  readonly navigationNodes: readonly NavigationNode[];
}

export interface PlayerPose {
  readonly position: Vec3;
  readonly yaw: number;
  readonly speed: number;
  readonly hotspot: string | null;
}

export interface TravelCommand {
  readonly position: Vec3;
  readonly yaw: number;
  readonly instant: boolean;
}

export const STATIONS = [
  { id: "lobby", label: "Reception", short: "Reception", key: "1", anchor: [0, 0, -3.3], yaw: 0, description: "Check in, meet your desk officer, and begin your shift." },
  { id: "board_wall", label: "Case board", short: "Cases", key: "2", anchor: [8.2, 0, -7.4], yaw: -Math.PI / 2, description: "Choose a synthetic case and review the investigation objective." },
  { id: "open_office", label: "Open office", short: "Office", key: "3", anchor: [-5.4, 0, -13.1], yaw: Math.PI / 2, description: "Talk technique with colleagues. They never know the case answers." },
  { id: "dossier", label: "Your desk", short: "Desk", key: "4", anchor: [-5.2, 0, -22], yaw: Math.PI / 2, description: "Read the public case dossier and keep an evidence-based notebook." },
  { id: "briefing", label: "Sergeant briefing", short: "Briefing", key: "5", anchor: [-5.2, 0, -28], yaw: 0, description: "Review your objective, interview limits, and the ground rule." },
  { id: "interview", label: "Interview room", short: "Interview", key: "6", anchor: [5.7, 0, -12.5], yaw: -Math.PI / 2, description: "Practice neutral questions with a simulated subject." },
  { id: "observation", label: "Observation room", short: "Observation", key: "7", anchor: [4.8, 0, -18], yaw: 0, description: "Watch the coaches and review panel work behind the glass." },
  { id: "debrief", label: "Replay theater", short: "Replay", key: "8", anchor: [5, 0, -22], yaw: -Math.PI / 2, description: "Review recorded interviews and the evidence behind each finding." },
  { id: "coach_lab", label: "Coach Lab", short: "Coach Lab", key: "9", anchor: [4.3, 0, -28.8], yaw: -Math.PI / 2, description: "Inspect coach versions, playbooks, and tournament history." },
  { id: "records", label: "Records & methodology", short: "Records", key: "0", anchor: [7.9, 0, -33.3], yaw: 0, description: "Visit the archive, training resources, and trust center." },
] as const;

/** Authored navigation data, independent of cases or subject roles. */
