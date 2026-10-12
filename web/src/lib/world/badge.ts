/**
 * The room's mode badge: a tournament trial (a harness recording, D-021) plays back like practice, every card as it
 * arrives, but it is not the viewer's practice session, so it says what it is.
 */
export function modeBadge(roomMode: "practice" | "assessment", recordingMode: string | null): string {
  if (recordingMode === "harness") return "Tournament trial";
  return roomMode === "practice" ? "Practice" : "Assessment: coaching is saved for your debrief";
}
