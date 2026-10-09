import { describe, expect, it } from "vitest";

import type { ApiClient } from "./client";
import { ContractError } from "./client";
import { createArenaApi } from "./arena";
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
