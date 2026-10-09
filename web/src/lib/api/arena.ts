/**
 * The arena routes the room uses (S5 5.5, S6 5.5), typed and checked at both ends: every request body is
 * checked against its wire schema before it is sent, and every response with a wire schema is validated before
 * the caller sees it (S6 5.2; SG4-05). A payload that fails is a `ContractError`: dropped, never rendered.
 *
 * Shapes S5 does not export a schema for are read narrowly: a stream ticket is `{ticket}` (the donor's mint,
 * TechnoMile `app/api/runs/[runId]/ticket/route.ts`), and a POST that produces events answers `last_seq`
 * (S5 5.2): a success answer without a non-negative integer `last_seq` is a `ContractError` (the caller keeps
 * the request's idempotency key, so a retry resumes it, S5 5.2).
 */

import { isWire, type WireSchemaName } from "../contracts/validate";
import type {
  CardAck,
  Debrief,
  DebriefRead,
  EvidenceRequest,
  EvidenceResult,
  FindingCommit,
  TrialSnapshot,
  TurnSubmit,
  WireTypes,
} from "../contracts/generated/types";
import { ContractError, type ApiClient } from "./client";

/** What a POST that produces events answers, for the catch-up check (S6 5.1). */
export interface PostAck {
  readonly last_seq: number;
}

/** The client-side projection re-check failed (S6 5.4); the server writes a log line, never state. */
export interface ContractViolationReport {
  readonly trial_id: string;
  readonly frame_type: string;
  readonly seq: number | null;
  readonly reason: string;
}

export interface ArenaApi {
  trialSnapshot(trialId: string): Promise<TrialSnapshot>;
  mintStreamTicket(trialId: string): Promise<string>;
  submitTurn(trialId: string, body: TurnSubmit): Promise<PostAck>;
  requestEvidence(trialId: string, body: EvidenceRequest): Promise<EvidenceResult>;
  commitFinding(trialId: string, body: FindingCommit): Promise<PostAck>;
  requestDebrief(sessionId: string): Promise<Debrief>;
  readDebrief(sessionId: string): Promise<DebriefRead>;
  ackCard(body: CardAck): Promise<void>;
  reportContractViolation(body: ContractViolationReport): Promise<void>;
}

const id = encodeURIComponent;

function checked<K extends WireSchemaName>(name: K, path: string, value: unknown): WireTypes[K] {
  if (!isWire(name, value)) throw new ContractError(path, name);
  return value;
}

function postAck(path: string, value: unknown): PostAck {
  const seq = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { last_seq?: unknown }).last_seq : undefined;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) throw new ContractError(path, "a POST answer with last_seq");
  return { last_seq: seq };
}

export function createArenaApi(client: ApiClient): ArenaApi {
  const send = async (name: WireSchemaName, path: string, body: unknown, keepalive = false) =>
    client.post(path, checked(name, path, body), { keepalive });

  return {
    async trialSnapshot(trialId) {
      const path = `/api/trials/${id(trialId)}/snapshot`;
      return checked("snapshot", path, await client.get(path));
    },
    async mintStreamTicket(trialId) {
      const path = `/api/trials/${id(trialId)}/stream-tickets`;
      const answer = await client.post(path);
      const ticket = typeof answer === "object" && answer !== null ? (answer as { ticket?: unknown }).ticket : undefined;
      if (typeof ticket !== "string" || ticket === "") throw new ContractError(path, "a stream ticket");
      return ticket;
    },
    async submitTurn(trialId, body) {
      const path = `/api/trials/${id(trialId)}/turns`;
      return postAck(path, await send("turn-submit", path, body));
    },
    async requestEvidence(trialId, body) {
      const path = `/api/trials/${id(trialId)}/evidence-requests`;
      return checked("evidence-result", path, await send("evidence-request", path, body));
    },
    async commitFinding(trialId, body) {
      const path = `/api/trials/${id(trialId)}/finding`;
      return postAck(path, await send("finding-commit", path, body));
    },
    async requestDebrief(sessionId) {
      const path = `/api/sessions/${id(sessionId)}/debrief`;
      return checked("debrief.v1", path, await client.post(path));
    },
    async readDebrief(sessionId) {
      const path = `/api/sessions/${id(sessionId)}/debrief`;
      return checked("debrief-read", path, await client.get(path));
    },
    async ackCard(body) {
      await send("card-ack", "/api/telemetry/kpi4", body, true);
    },
    async reportContractViolation(body) {
      await client.post("/api/telemetry/contract-violation", body, { keepalive: true });
    },
  };
}
