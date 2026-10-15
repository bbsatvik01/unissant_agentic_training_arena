/**
 * A fixed, authored staff directory. Topic selection is its entire input surface.
 * It cannot inspect a case, answer an accusation, evaluate a subject, or invent an investigation fact.
 */
import type { Vec3 } from "./types";

export type StaffSpeaker = "receptionist" | "sergeant";
export interface StaffReply {
  readonly topic: string;
  readonly label: string;
  readonly text: string;
  /** Optional existing hotspot ID for a separate user-triggered navigation action. */
  readonly destination?: string;
}
export interface StaffConversation {
  readonly id: StaffSpeaker;
  readonly name: string;
  readonly introduction: string;
  readonly replies: readonly StaffReply[];
}

export const STAFF_CONVERSATIONS: Readonly<Record<StaffSpeaker, StaffConversation>> = {
  receptionist: {
    id: "receptionist",
    name: "Reception officer",
    introduction: "Welcome to the training precinct. I can help you find a room or explain how to get started.",
    replies: [
      { topic: "cases", label: "Where do I begin?", text: "The case board is on the east side of the lobby, opposite reception. Choose a training case there, then review the public dossier at your desk.", destination: "case_board" },
      { topic: "desk", label: "Where is my desk?", text: "Head north along the central corridor. Your dossier desk is the second room on the left, after the open office.", destination: "personal_dossier" },
      { topic: "briefing", label: "Where is the sergeant?", text: "The training sergeant is inside Briefing, toward the north end of the corridor on the left.", destination: "briefing" },
      { topic: "interview", label: "Where is the interview room?", text: "The interview room is the first room on the right as you enter the central corridor. Review your briefing and the public material before starting.", destination: "interview" },
      { topic: "replay", label: "Where can I review a session?", text: "Debrief and replay is the third room on the right. Use your recorded session and the available evidence when you review it.", destination: "debrief_replay" },
      { topic: "leaderboard", label: "Where are the leaderboards?", text: "The recognition wall is at the north end of the central corridor. Check eligibility gates before reading a tournament rank. A rank is not certification for real investigations.", destination: "trophies" },
      { topic: "archive", label: "Where is the archive?", text: "The records office is at the north end on your right. It is the place for past recordings, training resources and methodology.", destination: "archive" },
      { topic: "access", label: "Can I use the station menu?", text: "Yes. The station menu is another way to reach the same rooms. Use the pause and reduced-motion controls whenever they make the training more comfortable." },
    ],
  },
  sergeant: {
    id: "sergeant",
    name: "Training sergeant",
    introduction: "We practice clear questions and careful evidence review here. I can discuss technique, but I do not know the answers to your case.",
    replies: [
      { topic: "opening", label: "How should I open?", text: "Start with an invitation such as, “Please walk me through what you remember, from the beginning.” Give the person room to answer before narrowing the question." },
      { topic: "clarify", label: "How do I clarify an answer?", text: "Ask one neutral question at a time. Separate what the person directly observed from what they heard, inferred, or do not remember. Do not fill in missing details for them." },
      { topic: "evidence", label: "What counts as support?", text: "Keep observations, statements, and your interpretations separate. Check a claim against the available records or corroborating information, and record uncertainty when support is incomplete." },
      { topic: "demeanor", label: "How should I handle demeanor?", text: "Do not treat accent, pauses, stress, nervousness, eye contact, or appearance as evidence of truth or deception. Use the content of statements and independently checkable information." },
      { topic: "disagreement", label: "What if accounts differ?", text: "Describe the specific difference without assuming why it happened. Ask for clarification, check the source, and keep alternative explanations open until evidence supports a conclusion." },
      { topic: "limits", label: "What are the ground rules?", text: "This is a synthetic training exercise. Use the public briefing and authorized material, respect the exercise limits, and avoid pressure or promises. I cannot identify a culprit, reveal hidden facts, or evaluate your case." },
      { topic: "review", label: "How should I debrief?", text: "Review the questions you asked, what each answer actually supported, and what remains uncertain. Use the replay room to find specific moments you can improve.", destination: "debrief_replay" },
    ],
  },
};

/** Unsupported topics always get the same safe directory response; user text is never echoed. */
export function staffReply(speaker: StaffSpeaker, topic: string): StaffReply {
  return STAFF_CONVERSATIONS[speaker].replies.find((reply) => reply.topic === topic)
    ?? { topic: "help", label: "Available topics", text: STAFF_CONVERSATIONS[speaker].introduction };
}

export interface StaffInteraction {
  readonly speaker: StaffSpeaker;
  readonly label: string;
  /** Existing hotspot whose station panel can expose this conversation. */
  readonly hotspotId: "reception" | "briefing";
  /** A clear player-foot position, not the staff's occupied floor position. */
  readonly position: Vec3;
  readonly lookAt: Vec3;
  readonly radius: number;
}

export const STAFF_INTERACTIONS: readonly StaffInteraction[] = [
  { speaker: "receptionist", label: "Talk to reception", hotspotId: "reception", position: [-6.2, 0, -5.7], lookAt: [-6.3, 1.58, -8.42], radius: 2.5 },
  { speaker: "sergeant", label: "Talk to the training sergeant", hotspotId: "briefing", position: [-4.3, 0, -29.1], lookAt: [-4.3, 1.58, -27.2], radius: 2.5 },
];
