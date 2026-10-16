# Isolated local recognition proof — 2026-10-15

Actual Chromium 154.0.8037.57 on the dot cloud computer, isolated ephemeral origin/profile. Original neutral eSpeak NG synthetic phrases only. No real person or user's microphone was captured. This does not establish human-speech accuracy or integrated-app acceptance.

## Measured result

- Official small English Vosk model loaded in 12.82s.
- Five file phrases: 1/5 exact after case/punctuation normalization, 12/44 word edits (27.27% weighted word error rate).
- Sum inference/audio duration ratio: 2.273; this run was slower than real time.
- Synthetic microphone: 145 chunks and 145 responses; 9.28s input, RMS 0.0942. 8/15 word edits (53.33%).
- No external requests, console errors or page errors. One worker created and closed. Microphone tracks ended, AudioContext closed, explicit model release and browser/profile/server close completed.

| Phrase | Reference | Actual transcript | Word edits | Inference |
|---|---|---|---|---|
| 1 | Please describe what happened before the meeting. | please describe what happened before the meeting | 0/7 | 8.94s |
| 2 | Which records could help us check that timeline? | for lord god help us check that time line | 5/8 | 7.75s |
| 3 | Is there another explanation we should consider? | there are no other explanation we should consider | 4/7 | 6.23s |
| 4 | I do not have enough evidence to reach a conclusion. | do not have enough evidence to reach a conclusion | 1/10 | 16.75s |
| 5 | What did you observe directly, and what did someone else tell you? | what did you observe them actually and what did someone else tell you | 2/12 | 17.51s |

Synthetic microphone actual transcript: “describe what happened before the meeting wait for it or god help us check that time line”.

## Recommendation and limits

Optional editable-draft experiment only; typed questions remain available, and recognition must never automatically Send. This small synthetic phrase set is not representative of people, dialects or noisy rooms. The fake microphone fixture began immediately at device start, so startup alignment can contribute to its missing first word; the file metric is independent of that alignment. No grammar bias, reference-text hinting, or transcript repair was applied. The pronounced formant quality and cloud CPU can affect these results; no inference about human accuracy is justified.

## Packaging and security findings

- Official model source ZIP 41,205,931 bytes, SHA256 30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498. Official model listing identifies Apache-2.0.
- Repacked standard USTAR/gzip retained exact model-file bytes and explicit 0755 directory headers. Result 41,855,832 bytes, SHA256 f263eed83a8a144c839eee333587a2835590823e87a67583708673a6a9d0e9fa. Initial file-only tar caused an IDBFS sync error; corrected source is preserved. No FS check was bypassed.
- npm vosk-browser 0.0.8 verified against registry integrity. Wrapper is Apache-2.0; complete bundled licenses/notices remain under review. The full 5.8MB wrapper exceeds the repository blob ceiling and is not committed.
- Legacy Emscripten requires JavaScript dynamic evaluation; initial wasm-unsafe-eval-only proof failed. Only this isolated proof page allowed unsafe-eval; genuine application CSP/config was untouched. A separately served worker policy or a pinned no-dynamic-execution rebuild needs security/license/build review before distribution.
- Model is outside Git. Disposable browser cache was closed with the profile. No external model hosting, paid services or speech transfer.

Official sources: https://alphacephei.com/vosk/models ; https://registry.npmjs.org/vosk-browser/0.0.8 ; https://github.com/ccoreilly/vosk-browser/tree/v0.0.8 ; https://emscripten.org/docs/tools_reference/settings_reference.html#dynamic-execution .
