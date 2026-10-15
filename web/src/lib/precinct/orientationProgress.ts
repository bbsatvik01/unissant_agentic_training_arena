/** Local orientation display only, never training credit or a replacement for server progress. */
export interface OrientationInput {
  readonly checkedIn: boolean;
  readonly briefed: boolean;
  readonly fileReviewed: boolean;
  readonly source: "idle" | "live" | "recording";
  readonly running: boolean;
  readonly hasView: boolean;
  readonly atInterviewCap: boolean;
  readonly findingCommitted: boolean;
  readonly debriefPublished: boolean;
}
export function orientationProgress(input: OrientationInput) {
  const prepared = input.checkedIn ? input.briefed ? input.fileReviewed ? 3 : 2 : 1 : 0;
  const live = input.source === "live" && input.running && input.hasView;
  const interviewComplete = live && (input.atInterviewCap || input.findingCommitted);
  const findingComplete = live && input.findingCommitted;
  const debriefComplete = findingComplete && input.debriefPublished;
  const completed = prepared + Number(interviewComplete) + Number(findingComplete) + Number(debriefComplete);
  if (input.source === "recording" && input.hasView) return { completed: prepared, title: "Review the saved interview", description: "Read-only playback. This run’s finding and published scores do not add new training completion." };
  if (debriefComplete) return { completed, title: "Review your published debrief", description: "Your current run’s published review is ready in the replay theater." };
  if (findingComplete) return { completed, title: "Finding committed", description: "The finding is closed. Wait for this run’s published debrief before reviewing its score." };
  if (interviewComplete) return { completed, title: "Make a supported finding", description: "The interview has reached its exchange limit. Review your citations before confirming a finding." };
  if (live) return { completed, title: "Conduct your interview", description: "Ask clear, neutral questions. Work from the public transcript and released records." };
  return { completed,
    title: !input.checkedIn ? "Check in at reception" : !input.briefed ? "Meet your training sergeant" : !input.fileReviewed ? "Read your case file" : "Prepare your interview",
    description: !input.checkedIn ? "Get your assignment. Meet your colleagues." : !input.briefed ? "Review the objective and evidence-first ground rule." : !input.fileReviewed ? "Your desk is the next stop. Follow the records." : "Your file is reviewed. Decide which neutral question to ask first.",
  };
}
