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
  SessionCreate,
  TurnSubmit,
  WireTypes,
} from "../contracts/generated/types";
import type { CaseCard } from "../world/cases";
import type { CaseDocument } from "../world/recording";
import { ContractError, type ApiClient } from "./client";

/** `POST /api/sessions` answers (S5 5.5): the new session and its trial. */
export interface StartedSession {
  readonly session_id: string;
  readonly trial_id: string;
  readonly mode: "practice" | "assessment";
  readonly case_id: string;
}

/** `GET /api/cases/{id}`: the case card and the public packet fields the room shows. */
export interface CaseBrief {
  readonly case: CaseCard;
  readonly initialDocuments: readonly CaseDocument[];
}

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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** A case card exactly as S6 4.2 lists it: public fields only (FE-LIB-1 refuses role, style, family or variant). */
export function parseCaseCard(value: unknown): CaseCard | null {
  if (!isRecord(value)) return null;
  if (["role", "style", "family_id", "variant"].some((k) => k in value)) return null;
  const subject = value["subject"];
  const ok =
    isText(value["case_id"]) &&
    isText(value["title"]) &&
    isText(value["objective"]) &&
    typeof value["domain"] === "string" &&
    typeof value["difficulty_level"] === "number" &&
    isRecord(subject) &&
    isText(subject["display_name"]) &&
    typeof subject["position"] === "string" &&
    typeof value["facility"] === "string" &&
    typeof value["initial_documents"] === "number" &&
    typeof value["requestable_records"] === "number";
  if (!ok) return null;
  return {
    case_id: value["case_id"] as string,
    title: value["title"] as string,
    objective: value["objective"] as string,
    domain: value["domain"] as string,
    difficulty_level: value["difficulty_level"] as number,
    subject: { display_name: subject["display_name"] as string, position: subject["position"] as string },
    facility: value["facility"] as string,
    initial_documents: value["initial_documents"] as number,
    requestable_records: value["requestable_records"] as number,
  };
}

/** S1's Content: a body and, when present, a table whose every row has one text cell per column. */
function contentOk(value: unknown): boolean {
  if (!isRecord(value) || !isText(value["body"])) return false;
  const table = value["table"];
  if (table === undefined || table === null) return true;
  if (!isRecord(table) || !Array.isArray(table["columns"]) || !Array.isArray(table["rows"])) return false;
  const columns = table["columns"] as unknown[];
  return columns.every((c) => typeof c === "string") && (table["rows"] as unknown[]).every((r) => Array.isArray(r) && r.length === columns.length && r.every((cell) => typeof cell === "string"));
}

/** The brief's initial documents, each checked whole (S1 6.1). */
export function parseBrief(value: unknown): CaseBrief | null {
  if (!isRecord(value) || !isRecord(value["brief"])) return null;
  const card = parseCaseCard(value["case"]);
  const docs = value["brief"]["initial_documents"];
  if (card === null || !Array.isArray(docs)) return null;
  const initialDocuments: CaseDocument[] = [];
  for (const doc of docs as unknown[]) {
    if (!isRecord(doc) || !isText(doc["doc_id"]) || !isText(doc["kind"]) || !isText(doc["title"]) || !contentOk(doc["content"])) return null;
    initialDocuments.push({ doc_id: doc["doc_id"], kind: doc["kind"], title: doc["title"], content: doc["content"] as CaseDocument["content"] });
  }
  return { case: card, initialDocuments };
}

export function parseStarted(value: unknown): StartedSession | null {
  if (!isRecord(value)) return null;
  const { session_id: sessionId, trial_id: trialId, mode, case_id: caseId } = value;
  if (!isText(sessionId) || !isText(trialId) || !isText(caseId) || (mode !== "practice" && mode !== "assessment")) return null;
  return { session_id: sessionId, trial_id: trialId, mode, case_id: caseId };
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
  /** `GET /api/cases`: the cases offered to this user (one variant per family, C-37). */
  listCases(): Promise<readonly CaseCard[]>;
  /** `GET /api/cases/{id}`: its card and initial documents. */
  caseBrief(caseId: string): Promise<CaseBrief>;
  /** `POST /api/sessions` (the body is checked against its wire schema first). */
  startSession(body: SessionCreate): Promise<StartedSession>;
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
    async listCases() {
      const path = "/api/cases";
      const answer = await client.get(path);
      const list = isRecord(answer) && Array.isArray(answer["cases"]) ? (answer["cases"] as unknown[]) : null;
      const cards = list?.map(parseCaseCard) ?? null;
      if (cards === null || cards.some((c) => c === null)) throw new ContractError(path, "the case list");
      return cards as CaseCard[];
    },
    async caseBrief(caseId) {
      const path = `/api/cases/${id(caseId)}`;
      const brief = parseBrief(await client.get(path));
      if (brief === null) throw new ContractError(path, "the case brief");
      return brief;
    },
    async startSession(body) {
      const path = "/api/sessions";
      const started = parseStarted(await send("session-create", path, body));
      if (started === null) throw new ContractError(path, "the started session");
      return started;
    },
  };
}
