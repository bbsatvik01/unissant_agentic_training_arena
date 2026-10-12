import { describe, expect, it } from "vitest";

import type { ApiClient } from "./client";
import { ContractError } from "./client";
import { createArenaApi, parseBrief, parseCaseCard } from "./arena";
import { fixture } from "../../test/wire-fixtures";

const TRIAL = "3f2b8c1e-5a4d-4e8f-9b2a-1c0d7e6f5a41";

interface Call {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly keepalive?: boolean;
}

function fakeClient(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const client: ApiClient = {
    me: () => Promise.reject(new Error("not used")),
    get: (path) => {
      const call: Call = { method: "GET", path };
      calls.push(call);
      return Promise.resolve(answer(call));
    },
    postAudio: (path, body) => {
      calls.push({ method: "POST", path, body, keepalive: false });
      return Promise.resolve({ audio: new ArrayBuffer(4), silent: false });
    },
    post: (path, body, options) => {
      const call: Call = { method: "POST", path, body, keepalive: options?.keepalive === true };
      calls.push(call);
      return Promise.resolve(answer(call));
    },
  };
  return { client, calls };
}

describe("typed arena routes (S5 5.5; S6 5.2: every REST payload validated)", () => {
  it("reads and validates the snapshot", async () => {
    const snapshot = fixture("snapshot:text");
    const { client, calls } = fakeClient(() => snapshot);
    await expect(createArenaApi(client).trialSnapshot(TRIAL)).resolves.toEqual(snapshot);
    expect(calls).toEqual([{ method: "GET", path: `/api/trials/${TRIAL}/snapshot` }]);
  });

  it("refuses a snapshot that fails the schema or an invariant", async () => {
    const bad = { ...(fixture("snapshot:text") as object), exchanges_used: 5 };
    const { client } = fakeClient(() => bad);
    await expect(createArenaApi(client).trialSnapshot(TRIAL)).rejects.toBeInstanceOf(ContractError);
    const { client: c2 } = fakeClient(() => ({ ...(fixture("snapshot:text") as object), role: "deceptive" }));
    await expect(createArenaApi(c2).trialSnapshot(TRIAL)).rejects.toBeInstanceOf(ContractError);
  });

  it("encodes path ids", async () => {
    const { client, calls } = fakeClient(() => ({ ticket: "t" }));
    await createArenaApi(client).mintStreamTicket("a/b?c");
    expect(calls[0]?.path).toBe("/api/trials/a%2Fb%3Fc/stream-tickets");
  });

  it("mints a stream ticket with a bodyless POST", async () => {
    const { client, calls } = fakeClient(() => ({ ticket: "tk" }));
    await expect(createArenaApi(client).mintStreamTicket(TRIAL)).resolves.toBe("tk");
    expect(calls).toEqual([{ method: "POST", path: `/api/trials/${TRIAL}/stream-tickets`, body: undefined, keepalive: false }]);
  });

  it.each([[null], [{}], [{ ticket: "" }], [{ ticket: 3 }]])("refuses a ticket answer %j", async (body) => {
    const { client } = fakeClient(() => body);
    await expect(createArenaApi(client).mintStreamTicket(TRIAL)).rejects.toBeInstanceOf(ContractError);
  });

  it("submits a turn after checking the body, and returns last_seq", async () => {
    const body = fixture("turn-submit");
    const { client, calls } = fakeClient(() => ({ turn_no: 2, version: 5, last_seq: 9 }));
    await expect(createArenaApi(client).submitTurn(TRIAL, body as never)).resolves.toEqual({ last_seq: 9 });
    expect(calls[0]).toEqual({ method: "POST", path: `/api/trials/${TRIAL}/turns`, body, keepalive: false });
  });

  it("never sends a body that fails its request schema", async () => {
    const { client, calls } = fakeClient(() => ({}));
    const api = createArenaApi(client);
    const turn = { ...(fixture("turn-submit") as object), presented_record_ids: ["rec-01"] };
    await expect(api.submitTurn(TRIAL, turn as never)).rejects.toBeInstanceOf(ContractError);
    await expect(api.requestEvidence(TRIAL, { record_ids: [], idem_key: 3 } as never)).rejects.toBeInstanceOf(ContractError);
    await expect(api.commitFinding(TRIAL, { finding: {}, idem_key: "k" } as never)).rejects.toBeInstanceOf(ContractError);
    await expect(api.ackCard({ trial_id: TRIAL, turn_no: 0, client_valid: true })).rejects.toBeInstanceOf(ContractError);
    expect(calls).toEqual([]);
  });

  it.each([[{ turn_no: 2 }], [{ last_seq: -1 }], [{ last_seq: 1.5 }], [{ last_seq: "3" }], [null], [[3]]])(
    "refuses a POST success answer without a valid last_seq (%j): a contract error, never a silent null",
    async (answer) => {
      for (const call of [
        (api: ReturnType<typeof createArenaApi>) => api.commitFinding(TRIAL, fixture("finding-commit") as never),
        (api: ReturnType<typeof createArenaApi>) => api.submitTurn(TRIAL, fixture("turn-submit") as never),
      ]) {
        const { client } = fakeClient(() => answer);
        await expect(call(createArenaApi(client))).rejects.toBeInstanceOf(ContractError);
      }
    },
  );

  it("requests evidence and validates the result", async () => {
    const result = fixture("evidence-result");
    const { client, calls } = fakeClient(() => result);
    const body = fixture("evidence-request");
    await expect(createArenaApi(client).requestEvidence(TRIAL, body as never)).resolves.toEqual(result);
    expect(calls[0]?.path).toBe(`/api/trials/${TRIAL}/evidence-requests`);
    const { client: c2 } = fakeClient(() => ({ released: [] }));
    await expect(createArenaApi(c2).requestEvidence(TRIAL, body as never)).rejects.toBeInstanceOf(ContractError);
  });

  it("commits a finding", async () => {
    const { client, calls } = fakeClient(() => ({ last_seq: 30 }));
    const body = fixture("finding-commit");
    await expect(createArenaApi(client).commitFinding(TRIAL, body as never)).resolves.toEqual({ last_seq: 30 });
    expect(calls[0]?.path).toBe(`/api/trials/${TRIAL}/finding`);
  });

  it("runs and reads the debrief, validating each document", async () => {
    const debrief = fixture("debrief:scored");
    const { client, calls } = fakeClient((call) => (call.method === "POST" ? debrief : { status: "scoring" }));
    const api = createArenaApi(client);
    await expect(api.requestDebrief("s-1")).resolves.toEqual(debrief);
    await expect(api.readDebrief("s-1")).resolves.toEqual({ status: "scoring" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/sessions/s-1/debrief", "GET /api/sessions/s-1/debrief"]);
    const { client: c2 } = fakeClient(() => ({ status: "done" }));
    await expect(createArenaApi(c2).readDebrief("s-1")).rejects.toBeInstanceOf(ContractError);
    await expect(createArenaApi(c2).requestDebrief("s-1")).rejects.toBeInstanceOf(ContractError);
  });

  it("acknowledges a card with exactly {trial_id, turn_no, client_valid} and keepalive", async () => {
    const { client, calls } = fakeClient(() => null);
    await createArenaApi(client).ackCard({ trial_id: TRIAL, turn_no: 3, client_valid: false });
    expect(calls).toEqual([
      { method: "POST", path: "/api/telemetry/kpi4", body: { trial_id: TRIAL, turn_no: 3, client_valid: false }, keepalive: true },
    ]);
  });

  it("reports a contract violation", async () => {
    const { client, calls } = fakeClient(() => null);
    await createArenaApi(client).reportContractViolation({ trial_id: TRIAL, frame_type: "coach.card", seq: 4, reason: "assessment" });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/telemetry/contract-violation",
        body: { trial_id: TRIAL, frame_type: "coach.card", seq: 4, reason: "assessment" },
        keepalive: true,
      },
    ]);
  });
});

describe("case and session routes (S6 4.2; S5 5.5)", () => {
  const card = {
    case_id: "C-7Q2MXK4D",
    title: "Records vault entry during a busy shift",
    objective: "Establish why.",
    domain: "facility_access",
    difficulty_level: 2,
    subject: { display_name: "Jordan Pell", position: "Facilities Technician II" },
    facility: "Halvern Street Annex",
    initial_documents: 1,
    requestable_records: 4,
  };
  const doc = { doc_id: "doc-01", kind: "access_exception_report", title: "Report", content: { body: "b", table: { columns: ["a", "b"], rows: [["1", "2"]] } } };

  it("lists the offered cases and refuses a card carrying a role, style, family or variant (FE-LIB-1)", async () => {
    const { client, calls } = fakeClient(() => ({ cases: [card] }));
    await expect(createArenaApi(client).listCases()).resolves.toEqual([card]);
    expect(calls[0]).toEqual({ method: "GET", path: "/api/cases" });
    for (const extra of ["role", "style", "family_id", "variant"]) {
      const { client: c } = fakeClient(() => ({ cases: [{ ...card, [extra]: "x" }] }));
      await expect(createArenaApi(c).listCases()).rejects.toBeInstanceOf(ContractError);
    }
    const { client: none } = fakeClient(() => ({ cases: "no" }));
    await expect(createArenaApi(none).listCases()).rejects.toBeInstanceOf(ContractError);
    expect(parseCaseCard({ ...card, subject: null })).toBe(null);
    expect(parseCaseCard("x")).toBe(null);
  });

  it("reads the brief's initial documents whole and refuses a short table row", async () => {
    const { client, calls } = fakeClient(() => ({ case: card, brief: { initial_documents: [doc] } }));
    await expect(createArenaApi(client).caseBrief("C-7Q2MXK4D")).resolves.toEqual({ case: card, initialDocuments: [doc] });
    expect(calls[0]?.path).toBe("/api/cases/C-7Q2MXK4D");
    const short = { ...doc, content: { body: "b", table: { columns: ["a", "b"], rows: [["1"]] } } };
    expect(parseBrief({ case: card, brief: { initial_documents: [short] } })).toBe(null);
    expect(parseBrief({ case: card, brief: { initial_documents: [{ ...doc, content: { body: "only" } }] } })?.initialDocuments).toHaveLength(1);
    expect(parseBrief({ case: card })).toBe(null);
    const { client: bad } = fakeClient(() => ({ case: card, brief: {} }));
    await expect(createArenaApi(bad).caseBrief("x")).rejects.toBeInstanceOf(ContractError);
  });

  it("starts a session with a checked body and reads the started ids", async () => {
    const started = { session_id: "s1", trial_id: "t1", phase: "practice", mode: "practice", case_id: "C-7Q2MXK4D" };
    const { client, calls } = fakeClient(() => started);
    const body = { case_id: "C-7Q2MXK4D", mode: "practice" as const, voice: false, idem_key: "6f9619ff-8b86-4011-b42d-00c04fc964ff" };
    await expect(createArenaApi(client).startSession(body)).resolves.toEqual({ session_id: "s1", trial_id: "t1", mode: "practice", case_id: "C-7Q2MXK4D" });
    expect(calls[0]).toEqual({ method: "POST", path: "/api/sessions", body, keepalive: false });
    const { client: bad } = fakeClient(() => ({ ...started, mode: "free" }));
    await expect(createArenaApi(bad).startSession(body)).rejects.toBeInstanceOf(ContractError);
  });

  it("reads a tournament's published board by its id and board name", async () => {
    const { client, calls } = fakeClient(() => ({ board: "subject", status: "unranked", rows: [] }));
    await expect(createArenaApi(client).leaderboard("7a1c2e3d-4b5f-4a6e-8d9c-0b1a2c3d4e5f", "subject")).resolves.toMatchObject({ board: "subject" });
    expect(calls[0]).toEqual({ method: "GET", path: "/api/leaderboards/7a1c2e3d-4b5f-4a6e-8d9c-0b1a2c3d4e5f?board=subject" });
    await createArenaApi(client).leaderboard("7a1c2e3d-4b5f-4a6e-8d9c-0b1a2c3d4e5f", "assistant", "original");
    expect(calls[1]?.path).toBe("/api/leaderboards/7a1c2e3d-4b5f-4a6e-8d9c-0b1a2c3d4e5f?board=assistant&label=original");
  });

  it("reads progress, a trial's recording, and stores the EX-4 acknowledgement", async () => {
    const { client, calls } = fakeClient((call) => (call.method === "POST" ? { ex4_acknowledged: "2026-10-24T14:00:00Z" } : { sessions: [] }));
    const api = createArenaApi(client);
    await api.progress();
    await api.recording("22222222-2222-4222-8222-222222222222");
    await expect(api.ackEx4()).resolves.toBe("2026-10-24T14:00:00Z");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/progress", "GET /api/trials/22222222-2222-4222-8222-222222222222/recording", "POST /api/me/ack-ex4"]);
    const { client: bad } = fakeClient(() => ({}));
    await expect(createArenaApi(bad).ackEx4()).rejects.toBeInstanceOf(ContractError);
  });

  it("asks the speech route for a line in a voice", async () => {
    const { client, calls } = fakeClient(() => null);
    const spoken = await createArenaApi(client).speak("Kore", "Hello.");
    expect(spoken.audio.byteLength).toBe(4);
    expect(calls).toEqual([{ method: "POST", path: "/api/tts", body: { voice: "Kore", text: "Hello." }, keepalive: false }]);
  });
});
