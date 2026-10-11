import { describe, expect, it } from "vitest";

import { fixture } from "../../test/wire-fixtures";
import type { ReviewSubmission } from "../contracts/generated/types";
import { type ApiClient, ContractError } from "./client";
import { createConsoleApi } from "./console";

function fake(answer: (path: string) => unknown) {
  const calls: string[] = [];
  const client: ApiClient = {
    me: () => Promise.reject(new Error("not used")),
    get: (path) => {
      calls.push(`GET ${path}`);
      return Promise.resolve(answer(path));
    },
    post: (path) => {
      calls.push(`POST ${path}`);
      return Promise.resolve({ ok: true });
    },
  };
  return { client, calls };
}

describe("console routes (S6 4.12, 4.13)", () => {
  it("reads the review queue and items checked against their schemas", async () => {
    const { client, calls } = fake((p) => (p.endsWith("/items") ? fixture("review-list") : fixture("review-item:T-FLAG")));
    const api = createConsoleApi(client);
    await expect(api.reviewItems()).resolves.toMatchObject({ items: expect.any(Array) as unknown });
    await expect(api.reviewItem("abc")).resolves.toMatchObject({ task: "T-FLAG" });
    await api.submitReview("abc", fixture("review-submission:T-FLAG") as ReviewSubmission);
    await api.adminAction("t1", "freeze");
    await api.adminBudget();
    await api.adminTournaments();
    await api.adminTournament("t1");
    expect(calls).toEqual([
      "GET /api/review/items",
      "GET /api/review/items/abc",
      "POST /api/review/items/abc",
      "POST /api/admin/tournaments/t1/freeze",
      "GET /api/admin/budget",
      "GET /api/admin/tournaments",
      "GET /api/admin/tournaments/t1",
    ]);
  });

  it.each(["participant", "user", "candidate", "phase", "pre", "post", "date", "created_at", "mode"])("refuses a review item carrying %s (FE-REV-1)", async (key) => {
    const item = { ...(fixture("review-item:T-FLAG") as object), [key]: "x" };
    const { client } = fake(() => item);
    await expect(createConsoleApi(client).reviewItem("abc")).rejects.toBeInstanceOf(ContractError);
  });

  it.each(["role", "private", "ledger"])("refuses a T-RUB or T-FLAG item carrying %s (FE-REV-1)", async (key) => {
    for (const kind of ["review-item:T-RUB", "review-item:T-FLAG"]) {
      const { client } = fake(() => ({ ...(fixture(kind) as object), [key]: "x" }));
      await expect(createConsoleApi(client).reviewItem("abc")).rejects.toBeInstanceOf(ContractError);
    }
  });

  it("refuses to send a submission carrying a dimension score (FE-REV-3)", async () => {
    const { client, calls } = fake(() => null);
    const body = { ...(fixture("review-submission:T-RUB") as object), D1: 3 } as unknown as ReviewSubmission;
    await expect(createConsoleApi(client).submitReview("abc", body)).rejects.toBeInstanceOf(ContractError);
    expect(calls).toEqual([]);
  });
});
