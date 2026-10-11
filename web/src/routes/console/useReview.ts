/**
 * The trainer console's data (S6 4.12): the assigned items, the selected item checked against its kind's schema,
 * a draft built only from that item, and the submission. A submitted item, or the server answering a repeat
 * submission, reads "already submitted" (FE-REV-3).
 */
import { useCallback, useEffect, useState } from "react";

import type { ConsoleApi } from "../../lib/api/console";
import type { ReviewItem, ReviewListEntry } from "../../lib/contracts/generated/types";
import { blankDraft, toSubmission, type ReviewDraft } from "../../lib/console/review";
import type { SubmitState } from "../../components/console/TrainerConsole";

export function useReview(api: Pick<ConsoleApi, "reviewItems" | "reviewItem" | "submitReview">, enabled: boolean) {
  const [items, setItems] = useState<readonly ReviewListEntry[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [item, setItem] = useState<ReviewItem | null>(null);
  const [itemFailed, setItemFailed] = useState(false);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  // Each item's submission state, so a late answer for one item never shows on another.
  const [submits, setSubmits] = useState<Readonly<Record<string, SubmitState>>>({});
  const { reviewItems, reviewItem, submitReview } = api;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    reviewItems().then(
      (l) => {
        if (!cancelled) setItems(l.items);
      },
      () => {
        if (!cancelled) setListFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reviewItems, enabled]);

  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    reviewItem(selected).then(
      (i) => {
        if (cancelled) return;
        setItem(i);
        setDraft(blankDraft(i));
        setItemFailed(false);
      },
      () => {
        if (!cancelled) setItemFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reviewItem, selected]);

  const select = useCallback(
    (itemId: string) => {
      // Choosing the open item again keeps it and its answers.
      if (itemId === selected) return;
      setSelected(itemId);
      setItem(null);
      setDraft(null);
    },
    [selected],
  );

  const edit = useCallback((change: (d: ReviewDraft) => void) => {
    setDraft((d) => {
      if (d === null) return d;
      const next = structuredClone(d);
      change(next);
      return next;
    });
  }, []);

  const send = useCallback(() => {
    if (selected === null || draft === null) return;
    const body = toSubmission(draft);
    if (body === null) return;
    const itemId = selected;
    const mark = (state: SubmitState) => {
      setSubmits((m) => ({ ...m, [itemId]: state }));
    };
    mark("sending");
    submitReview(itemId, body).then(
      (answer) => {
        // training.submit_review_item answers {outcome: "recorded"} or, for a repeat, {outcome: "exists"}.
        const repeat = typeof answer === "object" && answer !== null && "outcome" in answer && answer.outcome === "exists";
        mark(repeat ? "already" : "sent");
        setItems((l) => l?.map((i) => (i.item_id === itemId ? { ...i, submitted: true } : i)) ?? l);
      },
      () => {
        mark("failed");
      },
    );
  }, [selected, draft, submitReview]);

  const submit: SubmitState = selected === null ? "idle" : (submits[selected] ?? "idle");
  return { items, listFailed, selected, item, itemFailed, draft, submit, select, edit, send };
}
