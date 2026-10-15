# Committed room audio ownership

## Demonstrated failure and source cause

Native rehearsal capture attempt `native-20261015T212816Z-5fa76a56` reached the seated interview,
then correctly refused two constructed AudioContexts before Send. It recorded zero source starts,
zero TTS requests, no forbidden requests and no cleanup errors. Original attempt artifacts are retained.
Its old probe did not record per-context creator stacks or state, so that report alone cannot classify
the two contexts. The source explains the leak: React StrictMode invokes `useMemo(roomEngine)` twice;
`webAudioPort` previously registered global unlock listeners during construction, including for the
abandoned memo value. The next gesture constructed both contexts. No disposal operation existed.

This patch makes constructors pure. The committed `useEffect` in both `usePrecinctSession` and
legacy `WorldRoute` activates its engine and returns that activation's cleanup. No listener, context,
request, source or fallback speech is created by mere construction. The first pointer/key gesture
removes both unlock listeners and resumes only its committed owner.

Cleanup invalidates the owner before cancelling hooks; removes both gesture listeners; invalidates
pending fetch/decode/resume work by generation; clears activation-local clip cache; stops playing
sources; detaches mouth ownership and audio nodes; and closes the owned context. Cleanup is
idempotent and an obsolete cleanup cannot release a newer activation. A stale decoded clip cannot
play after release/re-activation. Normal native completion releases its graph; a later `stop()` is a
no-op. The existing one-failure fallback policy remains unchanged for the lifetime of an engine.

No reducer, session wire contract, generated source, backend, score or voice-consent behavior changes.
The recorder's exactly-one-context guard and every audio/lip/time limit remain unchanged.

## Verification

The lifecycle patch passed its final gate on 2026-10-15 at 21:53 UTC: 6 focused suites / 56 tests,
strict app TypeScript, strict tools TypeScript and zero-warning owned-file lint. Both real callers and
StrictMode replay are included. Earlier static failures are preserved: one unsupported test option and
a type-aware linter's stale narrowing across await. The latter was corrected with an `isCurrent()` helper
that rereads actual ownership/generation after each await; no guard was removed.

A separate simultaneous-arrival regression then established an existing presentation defect: the
subject can cancel the question before its source starts. That failure is preserved in
`precinct-room-audio-lifecycle-qa/results/simultaneous-initial.log`; it is not a passing lifecycle test
and is addressed by the separately staged same-turn presentation package.

Regression sources cover:

- Abandoned/pure construction and inactive speech/fetch refusal
- StrictMode setup, cleanup and re-setup; pointer-first and keyboard-first gestures
- Removal of both unconsumed listeners; duplicate activation and duplicate/obsolete cleanup
- Late fetch and decode completion after release/re-activation; stale decoded clip refusal
- Native source, mouth and graph release; engine hook completion without late fallback
- Actual precinct hook explicit audio enable/mute/unmount under StrictMode
- Actual legacy WorldRoute commit/unmount under StrictMode, with only its GPU canvas replaced

Existing voice-engine tests now explicitly activate/release their ports/engines. The old assertion
that `stop()` redundantly stops an already-ended source is replaced with an idempotency assertion;
a new active-source cleanup test separately requires exactly one real source-stop invocation.

The shared precinct hook baseline is SHA-256
`635286bbbf4e34acccff8fd658f6782b4a561f3acc8b113a41f278b90a074c93`.
Coach Lab's independently staged return-object-only `coachLabReads` hunk must be composed separately.

All cases are synthetic. Evasive wording alone does not prove a violation, and a simulated score is not a finding about a real person.
