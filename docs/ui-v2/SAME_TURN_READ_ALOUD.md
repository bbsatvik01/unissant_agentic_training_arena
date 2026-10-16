# Bounded same-turn read-aloud presentation

A focused regression using the real `useVoice` hook and real serial voice engine demonstrated that
simultaneous accepted-question and subject-answer inputs cancelled the question before its playback
started. Its original failing output is retained at
`precinct-room-audio-lifecycle-qa/results/simultaneous-initial.log`.

The correction is presentation-only. It admits at most the current turn's accepted question and
committed answer to the existing serial engine. The answer waits for actual question completion;
repeated/equal-time render inputs cannot enlarge that pair. Partial streamed answer revisions wait
for commitment. A newer turn supersedes the previous pair once, ends its pending lip-sync entries,
and prevents late callbacks from altering current caption/pending ownership. Suggestions not yet submitted
to the engine are dropped with their superseded turn. A speaking coach retains
priority, with only the latest turn's pair held behind it. Earpiece mute releases that pair normally.
Scope, mute and rewind retain their existing cancellation behavior. Assessment still excludes coaching.

No backend/mock delays, canonical SSE/reducer changes, timestamp rebasing, generated contract change,
new animation owner, hidden facts or content-derived behavior are introduced. Captions still change
only on actual engine start/end. The browser recorder's native-speech and lip gates remain unchanged.

## Verification

On 2026-10-15, the combined focused gate passed **8 suites / 80 tests**, including 16 simultaneous-arrival
cases, against the separately green committed-lifecycle overlay. Strict app TypeScript, strict tools
TypeScript and touched-file ESLint with zero warnings also exited 0. The logs are retained in
`precinct-room-audio-lifecycle-qa/results/queue-{focused,app-types,tools-types,owned-lint}-initial.log`.
The preserved original regression expects the question to start first and then the answer.
Additional tests cover repeated/equal-time arrivals and a 100-update queue bound, partial answer
commitment, newer-turn supersession, scope/mute/rewind, late callbacks from a non-cooperative engine,
production browserEngine and Gemini-to-browser fallback with modeled native completion/error callbacks, coach priority and replacement of older held turns,
earpiece mute with fresh-generation held starts and stale-coach completion, assessment withholding and unchanged canonical timestamps.

All cases are synthetic. Evasive wording alone does not prove a violation, and a simulated score is not a finding about a real person.

Serial completion is owned by `createGeminiEngine` for clip/fallback playback and by the browser's
[Web Speech queue](https://webaudio.github.io/web-speech-api/#dom-speechsynthesis-speak) for direct
`browserEngine` playback. Its end/error handlers complete once. The unit harness models native
queue events; it does not establish actual browser audio or lip-sync acceptance.
