/**
 * The referee origin's console routes (S5 5.5, S6 4.12-4.13): the trainer's review queue and the admin routes.
 * Review payloads are checked against the shared per-kind schemas before anything renders them (FE-REV-1: those
 * schemas carry no identity, phase, date or mode field, and refuse one); a submission is checked before it is
 * sent. Admin bodies are read by `lib/console/admin`.
 */
import type { ReviewItem, ReviewList, ReviewSubmission } from "../contracts/generated/types";
import { isWire } from "../contracts/validate";
import type { AdminAction, VerdictBody } from "../console/admin";
import { ContractError, type ApiClient, type Me } from "./client";

export interface ConsoleApi {
  readonly me: () => Promise<Me>;
  readonly reviewItems: () => Promise<ReviewList>;
  readonly reviewItem: (itemId: string) => Promise<ReviewItem>;
  readonly submitReview: (itemId: string, body: ReviewSubmission) => Promise<unknown>;
  readonly adminTournaments: () => Promise<unknown>;
  readonly adminTournament: (tournamentId: string) => Promise<unknown>;
  readonly adminBudget: () => Promise<unknown>;
  readonly adminAction: (tournamentId: string, action: AdminAction) => Promise<unknown>;
  readonly adminReviews: () => Promise<unknown>;
  readonly adminVerdict: (trialId: string, body: VerdictBody) => Promise<unknown>;
}

function id(value: string): string {
  return encodeURIComponent(value);
}

export function createConsoleApi(client: ApiClient): ConsoleApi {
  return {
    me: () => client.me(),
    async reviewItems() {
      const path = "/api/review/items";
      const body = await client.get(path);
      if (!isWire("review-list", body)) throw new ContractError(path, "review-list");
      return body;
    },
    async reviewItem(itemId) {
      const path = `/api/review/items/${id(itemId)}`;
      const body = await client.get(path);
      if (!isWire("review-item", body)) throw new ContractError(path, "review-item");
      return body;
    },
    async submitReview(itemId, body) {
      const path = `/api/review/items/${id(itemId)}`;
      if (!isWire("review-submission", body)) throw new ContractError(path, "review-submission");
      return client.post(path, body);
    },
    adminTournaments: () => client.get("/api/admin/tournaments"),
    adminTournament: (tournamentId) => client.get(`/api/admin/tournaments/${id(tournamentId)}`),
    adminBudget: () => client.get("/api/admin/budget"),
    adminAction: (tournamentId, action) => client.post(`/api/admin/tournaments/${id(tournamentId)}/${action}`),
    adminReviews: () => client.get("/api/admin/reviews"),
    adminVerdict: (trialId, body) => client.post(`/api/admin/reviews/${id(trialId)}`, body),
  };
}
