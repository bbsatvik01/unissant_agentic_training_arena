// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fixture } from "../../test/wire-fixtures";
import type { ReviewItem, ReviewList } from "../../lib/contracts/generated/types";
import { useReview } from "./useReview";

afterEach(() => {
  cleanup();
});

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LIST: ReviewList = { items: [{ item_id: A, task: "T-FLAG", submitted: false }, { item_id: B, task: "T-FLAG", submitted: false }] };

function api(submitReview: (id: string) => Promise<unknown> = () => Promise.resolve({ outcome: "recorded" })) {
  return { reviewItems: () => Promise.resolve(LIST), reviewItem: vi.fn(() => Promise.resolve(fixture("review-item:T-FLAG") as ReviewItem)), submitReview: vi.fn(submitReview) };
}

describe("useReview", () => {
  it("keeps the open item and its answers when it is chosen again", async () => {
    const deps = api();
    const { result } = renderHook(() => useReview(deps, true));
    await waitFor(() => {
      expect(result.current.items).not.toBeNull();
    });
    act(() => {
      result.current.select(A);
    });
    await waitFor(() => {
      expect(result.current.draft).not.toBeNull();
    });
    act(() => {
      result.current.edit((d) => {
        if (d.task === "T-FLAG" && d.flags[0] !== undefined) d.flags[0].claim_holds = true;
      });
    });
    act(() => {
      result.current.select(A);
    });
    const d = result.current.draft;
    expect(d?.task === "T-FLAG" ? d.flags[0]?.claim_holds : undefined).toBe(true);
    expect(deps.reviewItem).toHaveBeenCalledTimes(1);
  });

  it("keeps each item's submission state to that item", async () => {
    let answer: (v: unknown) => void = () => undefined;
    const deps = api(() => new Promise((r) => (answer = r)));
    const { result } = renderHook(() => useReview(deps, true));
    await waitFor(() => {
      expect(result.current.items).not.toBeNull();
    });
    act(() => {
      result.current.select(A);
    });
    await waitFor(() => {
      expect(result.current.draft).not.toBeNull();
    });
    act(() => {
      result.current.edit((d) => {
        if (d.task === "T-FLAG") for (const f of d.flags) Object.assign(f, { quote_relevant: true, claim_holds: true, content_based: true, no_outside_facts: true });
      });
    });
    act(() => {
      result.current.send();
    });
    expect(result.current.submit).toBe("sending");
    act(() => {
      result.current.select(B);
    });
    expect(result.current.submit).toBe("idle");
    await act(async () => {
      answer({ outcome: "recorded" });
      await Promise.resolve();
    });
    expect(result.current.submit).toBe("idle");
    expect(result.current.items?.find((i) => i.item_id === A)?.submitted).toBe(true);
    expect(result.current.items?.find((i) => i.item_id === B)?.submitted).toBe(false);
    act(() => {
      result.current.select(A);
    });
    expect(result.current.submit).toBe("sent");
  });
});
