/** Reflects only the mounted trophy panel's canonical reads. No request, timer, store or subscription. */
import { useLayoutEffect } from "react";
import type { RecognitionRead } from "../../lib/precinct/boardSurfaces";

export interface RecognitionSink {
  readonly scope: string;
  readonly onRead: (read: RecognitionRead) => void;
}
export function clearRecognitionRead(sink: RecognitionSink | undefined, tournamentId: string | null, label: RecognitionRead["label"]): void {
  sink?.onRead({ scope: sink.scope, tournamentId, label, ledger: "pending", state: null, assistant: null });
}
export function useRecognitionReadBridge(sink: RecognitionSink | undefined, read: Omit<RecognitionRead, "scope">): void {
  const scope = sink?.scope, onRead = sink?.onRead;
  const { tournamentId, label, ledger, state, assistant } = read;
  const kind = state?.kind ?? null;
  const publishedId = state?.kind === "published" ? state.tournamentId : null;
  const publishedLabel = state?.kind === "published" ? state.label : null;
  // Primitive state dependencies avoid an effect loop when the panel builds a fresh sealed/error object.
  // Layout timing replaces the visible material before the browser paints a new source/selection.
  useLayoutEffect(() => {
    if (onRead === undefined || scope === undefined) return;
    onRead({ scope, tournamentId, label, ledger,
      state: kind === null ? null : kind === "published" ? publishedId === null ? null : { kind, tournamentId: publishedId, label: publishedLabel } : { kind },
      assistant: kind === "published" && ledger === "revealed" ? assistant : null,
    });
  }, [onRead, scope, tournamentId, label, ledger, kind, publishedId, publishedLabel, assistant]);
  // Closing the dialog retains an explicitly labeled snapshot. The route's identity/source guards still apply.
}
