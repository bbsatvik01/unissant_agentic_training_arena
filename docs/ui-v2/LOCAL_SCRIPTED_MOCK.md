# Developer-only local scripted exercise

This tool is an offline UI/transport fixture for environments where Docker and the real fake-model
stack cannot run. It is **not a training assessment, an AI interview, a substitute backend, or a
scoring service**. No model, database, TTS, microphone, cloud service, or outbound network client is
used by the tool. It never starts on import, installation, or a normal Vite launch.

The fixture label is visible in `/api/me`'s display name, the case title and objective, and each
scripted subject line. The trainee's actual typed question is stored verbatim. A finite sequence of
12 newly authored subject beats follows the fixed fictional scenario independently of arbitrary questions. No question classification,
evasion flag, coach finding, or score is invented. A fresh unscored debrief may disclose the authored
scenario resolution after the actual finding is closed. Practice emits the canonical `coach.failed` event
(`repair_failed`, the existing schema's failure representation) so its turn completes. Assessment
emits no coaching events or coaching snapshot data, including after completion.

All cases are synthetic. Evasive wording alone does not prove a violation, and a simulated score is not a finding about a real person.

## Explicit launch

Prerequisites: the repository's already-installed pinned dependencies and Node 24.21.0. No install or
version-manager download is part of this tool. Do not launch it alongside a real API on the same port.
Use a clean browser profile with no cookies for the loopback host; the tool refuses credentials and
cookies, rather than reading or issuing them.

From the repository's `web/` directory, in one terminal:

```sh
node tools/precinct-local-mock.ts
```

This binds only to `127.0.0.1:8080`. There is no host flag or environment-controlled bind address.
In a separate terminal, from `web/`, use the already-installed Vite executable:

```sh
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://127.0.0.1:5173/`. Explicitly connect the local backend in the session controls.
Vite's existing `/api` proxy rewrites Host to port 8080 while retaining the browser's Origin.
A different Vite port must be explicitly allowlisted, for example:

```sh
node tools/precinct-local-mock.ts --browser-origin http://127.0.0.1:5174
```

The API port can also be changed with `--port`; configure Vite's existing `ARENA_PROXY_TARGET` to that
same loopback port when doing so. No `.env` file is created. CLI `--port 0` is reserved for automated
loopback tests. Neither `localhost` suffixes nor arbitrary LAN hosts/origins are accepted.

Keep sound and microphone controls **off** for strict zero-audio QA. The fixture refuses all voice
and TTS endpoints; existing frontend audio fallback behavior is separate from this server and is
not exercised by these tests. There is no audio synthesis, fake WAV, or voice credential issued here.

Ctrl-C / SIGTERM stops the listener, closes active SSE streams, cancels stream timers and erases all
in-memory sessions, tickets and acknowledgements. Nothing is written to disk by the server.

## Reproduce the interactive flow

1. Connect explicitly. Verify the profile and case both say local scripted fixture. Acknowledge the
   unchanged ground rule before starting a practice or assessment session.
2. Open the dossier. Its original public documents are unchanged. Requestable record descriptions
   contain no unreleased document content. The request gates are the original completed-exchange gates:
   `rec-01` after 2; `rec-02` and `rec-03` after 3; `rec-04` after 6.
3. Type your own question. Confirm its exact spelling appears in the transcript and the response is
   visibly labeled an authored beat, independent of your question. Practice deliberately demonstrates the existing coaching-unavailable state;
   assessment displays no coaching at all. Generic technique examples below are not generated feedback.
4. Request a record too early, then after its gate. Early requests are denied; valid releases arrive
   through SSE and the snapshot. The scheduled `rec-05` is due after 5 completed exchanges, on the next
   evidence request or before question 6. The `released_at_turn` wire field means completed exchanges.
5. Stop/reconnect the event stream or reload/resume the session. A fresh, single-use ticket and
   `after=<last_seq>` replay only later persisted events. A snapshot reconstructs the same state.
6. Lock your own finding. Only answered turns and initial/released records may be cited. The snapshot
   and replay retain your finding verbatim (with the schema's null default fields). The local SHA-256
   commitment covers this run ID, transcript, releases and finding. It is an integrity marker for
   this fixture only, not a referee result or a real backend seal.
7. The existing client automatically POSTs for a debrief once the finding is finalized. Before a
   finding exists, POST returns 409 and GET is the canonical `{ "status": "scoring" }` pending shape.
   Only a valid, CSRF-protected POST after closure publishes this run's `scored:false` debrief.
   It reveals the **authored fictional resolution**, never a grade or inferred truth about your
   interview. Numeric scores, rubric, scorecards and provenance fields are absent. The user's actual
   committed label is preserved, even if it differs from the authored scenario's expected label.
8. The fresh `debrief.ready` event closes this run's own SSE stream. Repeated debrief POSTs return the
   same document without another event. Tickets then return 409 `stream_closed`; snapshot and debrief
   remain readable. No scoring service or model has run.
9. Inspect/export the fresh recording after an action: it has fresh trial/session IDs and your own
   questions/releases/finding. Its `debrief` stays null until the valid closure POST, then contains
   only this run's authored unscored document. The existing real saved recording remains the genuine
   scored/coached demonstration; no historical score, historical finding or old debrief is copied.
10. Click **Close this session view** or **Disconnect local backend** after QA, then Ctrl-C the server.
    The current unscored panel copy assumes voice practice; apply the isolated channel-neutral copy
    change described below before demonstrating the text fixture's debrief. If publication is not
    requested, GET pending does not cause automatic polling; its catch-up SSE may reconnect after
    600 seconds until the view is closed.

## Transport boundaries

- Exact known paths and GET/POST methods only; unknown routes return 404, unsupported methods 405.
  Generic admin, trust, leaderboard, tournament, NPC, instructor, Coach Lab and world-event seams
  are not fabricated by this tool. No incomplete success shapes are returned for those routes.
- Host must be `127.0.0.1:<actual port>` or `localhost:<actual port>`. Browser Origin must be the exact
  selected Vite origin or this API's own loopback origin. Cross-site requests are refused, including
  GETs with a foreign Origin. No CORS permission is returned.
- Every POST, including bodyless POSTs, requires the exact `X-Arena-CSRF` value read from `/api/me`
  and an allowed Origin. The token and stream tickets are synthetic, memory-only local capabilities.
  **This is request-contract coverage, not the production cookie double-submit mechanism**: no cookie
  is issued, read, saved or required; Authorization/Cookie headers are refused. Use the real stack
  for production authentication/CSRF integration tests.
- JSON bodies are capped at 64 KiB; schema validators reject unknown fields and invalid values. The
  additional server-only rendered text checks are mirrored for question/finding bounds, while exact
  typed text is retained. Bodyless endpoints refuse nonempty JSON. Malformed JSON is 422; media type
  other than JSON is 415; oversize is 413. No sensitive text is logged.
- Idempotency covers session start, question, evidence and finding. Identical retries return their
  stored acknowledgement without new events; key reuse with changed content or operation is 409.
  Object-key ordering and requested-record order are irrelevant; optional finding defaults normalize to null. Stale transcript versions are rejected before mutation.
- SSE frames use the generated schemas and invariants. Persisted IDs equal `seq`; reconnects use the
  query cursor, like the current client. Tickets expire after 60 seconds and are consumed once,
  including a wrong-trial redemption. Streams ping every 15 seconds and end after 600 seconds.
- Fixed memory limits: 8 runs, 64 successful idempotent actions per run, 64 outstanding tickets,
  8 simultaneous SSE streams, 32 TCP connections, 8 KiB headers. No history is silently evicted.
  Capacity returns 429; restart intentionally discards the whole fixture exercise. Up to 12 questions
  per run and at most 6 released records are allowed by the unchanged wire contracts. Slow stream
  consumers are closed on backpressure and may reconnect from their last accepted cursor.

## Authored technique examples (separate from evaluation)

These general-purpose examples are static help text, never assessments of the typed question and
never case-specific coaching:

- Open account: “Please walk me through what happened, in your own words.”
- Clarification: “What do you mean by that term?”
- Corroboration: “Which record or person could independently confirm that detail?”
- Alternatives: “What other explanation could fit those same records?”
- Supported closure: “What remains uncertain, and which evidence supports your conclusion?”

Nervousness, demeanor, accent and stress are never evidence. No mock response, character behavior
or animation uses a truth/deception label. The fixed fictional resolution is scenario content, revealed only after this run closes and requests its debrief.

## Provenance and file manifest

`web/tools/precinct-local-fixture.json` contains only `.case`, `.snapshot.requestable`, and the
`data` of `evidence.released` frames from the explicitly hand-built
`web/src/fixtures/recordings/F01-truthful.json`. Initial documents, record content and release
thresholds are unchanged. It contains no recorded questions, answers, coaching cards, historical
trial/session IDs, debrief, scores or evaluator packet. This developer-only file is never served
wholesale by an API route or imported into the browser bundle.

The new subject beats and resolution are authored in `precinct-local-model.ts`, not imported from the
old recording's transcript/outcome. Their coherent fixed account is supported by the hand-built
public packet: the B-12 radio dispatch, later B-12 work order, B-12 humidity alarm, intact seal audit,
and equipment/doorway exception in the initial policy. An off-roster room, delayed paperwork and a
door alarm do not override that authored story. Neither the user's question content nor demeanor
selects or changes its expected resolution. The debrief displays the actual committed label without
computing whether the trainee passed, failed, or earned a grade.

New files only:

- `web/tools/precinct-local-fixture.json`
- `web/tools/precinct-local-model.ts`
- `web/tools/precinct-local-mock.ts`
- `web/tools/precinct-local-mock.test.ts`
- `docs/ui-v2/LOCAL_SCRIPTED_MOCK.md`

Channel-neutral unscored presentation:

- In `web/src/components/precinct/SessionDebriefPanel.tsx`, replace only
  `Voice practice: not scored.` with `This session is not scored.`
- Add `web/src/components/precinct/SessionDebriefUnscored.test.tsx` to verify neutral text, the
  authored resolution, actual committed label, and absence of numeric grades.

These changes affect only the new precinct panel, not any legacy route. Existing panel tests remain unchanged.

No package, lockfile, root policy, generated contract, backend, database, or existing test gate changes.
No new dependency. The tool uses Node built-ins plus the existing compiled validators/invariant logic.

## Verification

Status: focused QA passed (21 tests, strict app/tools types, zero-warning lint). See `LOCAL_MOCK_QA.md`. Browser acceptance and the unchanged full integrated gate remain pending.

From `web/`, using the installed pinned toolchain:

```sh
node node_modules/vitest/vitest.mjs run tools/precinct-local-mock.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc -p tsconfig.node.json --incremental false
node node_modules/eslint/bin/eslint.js tools/precinct-local-model.ts tools/precinct-local-mock.ts tools/precinct-local-mock.test.ts --max-warnings 0
```

The normal full `pnpm check` remains mandatory for integration. The focused tests cover input refusal,
public-fixture provenance, actual API client calls, idempotency, fresh IDs, exact release gates,
assessment isolation, finding/replay retention, fresh unscored authored closure, bounded memory, hostile Host/Origin,
CSRF request headers, live SSE and reconnect/ticket replay, rendered bounds, audited runtime imports,
no network request from the model, import without a listener, explicit CLI launch, and SIGTERM close.
No skip, suppression, relaxed assertion, test policy change, or backend modification is required.

Acceptance limits: no browser screenshots/performance claims, no real models, no true coaching
classification, no numeric score/referee, no production authentication proof, no durable storage, no world-event
seam, no actual voice, no tournament/instructor/NPC simulation. Those capabilities must be verified
separately against the real stack or honest saved recordings.
