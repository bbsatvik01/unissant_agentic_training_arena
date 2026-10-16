/**
 * Local, synchronous NPC seam. The wire shape is fixed, but there is no transport or model.
 * History is bounded/validated for compatibility and is deliberately never used as knowledge.
 */
import { copyBoundedArray, hasExactFields, isLocalVoiceId, isNpcId, NPC_IDENTITIES } from "./npcIdentity";
import type { LocalVoiceId, NpcId } from "./npcIdentity";
import { emptyNpcVisitMemory, parseNpcVisitMemory } from "./npcVisitMemory";
import type { NpcVisitMemory } from "./npcVisitMemory";
import { STAFF_CONVERSATIONS } from "./staffDialogue";

export interface NpcHistoryTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}
export interface NpcRequest {
  readonly npc_id: NpcId;
  readonly message: string;
  readonly history: readonly NpcHistoryTurn[];
}
export interface NpcResponse {
  readonly reply: string;
  /** A local presentation alias only. Do not send this to a remote voice provider. */
  readonly voice_id: LocalVoiceId;
}
export const NPC_REQUEST_LIMITS = { messageLength: 600, historyTurns: 12, historyTextLength: 4096 } as const;
export const NPC_REPLY_LIMIT = 1200;
export type NpcRequestValidation = { readonly ok: true; readonly value: NpcRequest }
  | { readonly ok: false; readonly error: "invalid_shape" | "unsupported_npc" | "invalid_message" | "invalid_history" };

function validText(value: unknown): value is string {
  // Tabs/newlines are allowed; control and bidi-formatting characters are not.
  return typeof value === "string" && value.trim().length > 0 && value.length <= NPC_REQUEST_LIMITS.messageLength
    && !/[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u.test(value.replace(/[\t\n\r]/g, ""));
}

/** Fail closed on extra fields (including case/session payloads), unknown roles and oversized input. */
export function validateNpcRequest(value: unknown): NpcRequestValidation {
  try {
    if (!hasExactFields(value, ["npc_id", "message", "history"])) return { ok: false, error: "invalid_shape" };
    const npcId = value["npc_id"];
    if (!isNpcId(npcId)) return { ok: false, error: "unsupported_npc" };
    const message = value["message"];
    if (!validText(message)) return { ok: false, error: "invalid_message" };
    const entries = copyBoundedArray(value["history"], NPC_REQUEST_LIMITS.historyTurns);
    if (entries === null) return { ok: false, error: "invalid_history" };
    const history: NpcHistoryTurn[] = [];
    let total = 0;
    for (const entry of entries) {
      if (!hasExactFields(entry, ["role", "text"])) return { ok: false, error: "invalid_history" };
      const role = entry["role"];
      const text = entry["text"];
      if ((role !== "user" && role !== "assistant") || !validText(text)) return { ok: false, error: "invalid_history" };
      total += text.length;
      if (total > NPC_REQUEST_LIMITS.historyTextLength) return { ok: false, error: "invalid_history" };
      history.push({ role, text });
    }
    return { ok: true, value: { npc_id: npcId, message, history } };
  } catch {
    return { ok: false, error: "invalid_shape" };
  }
}

/** Validate the exact outgoing seam too, without accepting arbitrary provider voice IDs. */
export function validateNpcResponse(value: unknown): value is NpcResponse {
  try {
    if (!hasExactFields(value, ["reply", "voice_id"])) return false;
    const reply = value["reply"];
    return typeof reply === "string" && reply.trim().length > 0 && reply.length <= NPC_REPLY_LIMIT
      && isLocalVoiceId(value["voice_id"]);
  } catch {
    return false;
  }
}

export const NPC_TECHNIQUE_REDIRECT = "I can help with directions and interviewing technique, not case-specific answers. Ask one neutral question at a time, distinguish observations from interpretations, and check claims against available evidence.";
const GREETINGS = new Set(["hi", "hello", "hey", "greet", "greeting", "hello again"]);

function normalizedPrompt(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.,]+$/u, "");
}

function greeting(npcId: NpcId, memory: NpcVisitMemory): string {
  const known = memory.colleagues.some((entry) => entry.npc_id === npcId);
  const name = memory.displayName === null ? "" : `, ${memory.displayName}`;
  const welcome = known ? `Good to see you again${name}.` : `Welcome${name}.`;
  const introduction = npcId === "receptionist" || npcId === "sergeant"
    ? STAFF_CONVERSATIONS[npcId].introduction
    : "I am a precinct colleague. Reception can help with directions, and the training sergeant can help with neutral questioning and evidence review.";
  return `${welcome} ${introduction}`;
}

function authoredReply(request: NpcRequest, memory: NpcVisitMemory): string {
  const prompt = normalizedPrompt(request.message);
  if (GREETINGS.has(prompt)) return greeting(request.npc_id, memory);
  if (request.npc_id === "receptionist" || request.npc_id === "sergeant") {
    // Only complete topic IDs or complete authored labels match; no substring intent guessing.
    const reply = STAFF_CONVERSATIONS[request.npc_id].replies.find((item) =>
      prompt === item.topic || prompt === normalizedPrompt(item.label));
    if (reply !== undefined) return reply.text;
  }
  return NPC_TECHNIQUE_REDIRECT;
}

/**
 * Optional memory is a validated, copied local snapshot, never request/session context.
 * This function and the returned adapter never read or write storage. A new visit requires
 * explicit recordNpcVisit/saveNpcVisitMemory calls by the UI, outside this seam.
 */
export function createLocalNpcAdapter(visitMemory?: unknown): (request: unknown) => NpcResponse {
  const memory = parseNpcVisitMemory(visitMemory) ?? emptyNpcVisitMemory();
  return (input: unknown): NpcResponse => {
    const parsed = validateNpcRequest(input);
    if (!parsed.ok) return { reply: NPC_TECHNIQUE_REDIRECT, voice_id: "local-guide-v1" };
    return { reply: authoredReply(parsed.value, memory), voice_id: NPC_IDENTITIES[parsed.value.npc_id].voice_id };
  };
}

/** Stateless default. Its sole input has exactly the requested wire shape. */
export const replyToLocalNpc = createLocalNpcAdapter();
