# Native offline Whisper: completed synthetic proof

Status: actual CPU build and five-file recognition completed on the dot cloud computer on 2026-10-15. All children exited 0 and were reaped. CPU lane released at 20:03 UTC and cleanup rechecked at 20:06 UTC. No product integration or real microphone test is included.

**Result: 3/5 normalized exact phrases; 3 word edits / 44 reference words = 6.82% weighted WER.** Total measured wall time was 15.215 seconds for 25.154 seconds of supplied audio, a 0.605 wall/audio ratio including a fresh process and model load for each phrase. Maximum per-child resident memory was 148,260 KiB (144.8 MiB). This supports a small optional stop-then-review experiment, not a human-speech quality claim.

## Exact input and output

Five unchanged original eSpeak NG synthetic WAV fixtures were reused from the Vosk experiment: mono PCM16 at 16 kHz. No reference text, initial prompt, grammar, hidden case data or previous answer entered recognition. Actual output below preserves wording, case and punctuation; its trailing newline is retained in the raw JSON evidence.

1. Reference: Please describe what happened before the meeting.
   Actual: Please describe what happened before in the meeting.
   Word edits: 1/7.

2. Reference: Which records could help us check that timeline?
   Actual: which records could help us check that timeline.
   Word edits: 0/8.

3. Reference: Is there another explanation we should consider?
   Actual: is the rubber explanation we should consider.
   Word edits: 2/7.

4. Reference: I do not have enough evidence to reach a conclusion.
   Actual: I do not have enough evidence to reach a conclusion.
   Word edits: 0/10.

5. Reference: What did you observe directly, and what did someone else tell you?
   Actual: What did you observe directly? And what did someone else tell you?
   Word edits: 0/12.

Normalization lowercases, replaces characters outside ASCII letters/digits/apostrophe/space with spaces, then splits words. Word edits use Levenshtein distance; punctuation and case differences do not count as word errors. The recognizer's actual words were not repaired.

## Per-phrase measurements

| Phrase | Audio seconds | Wall ms, including load | Native load ms | Native total ms | Child peak RSS KiB | Exit/reaped |
|---|---:|---:|---:|---:|---:|---|
| 1 | 4.6818750 | 2338.054 | 590.94 | 2243.19 | 148020 | 0 / yes |
| 2 | 4.9601250 | 3777.153 | 328.48 | 3712.75 | 148212 | 0 / yes |
| 3 | 4.6679375 | 2647.074 | 307.13 | 2575.03 | 148012 | 0 / yes |
| 4 | 4.8276875 | 2866.448 | 345.49 | 2734.26 | 148136 | 0 / yes |
| 5 | 6.0165625 | 3586.489 | 659.08 | 3471.37 | 148260 | 0 / yes |

Wall times use the proof harness clock; native load/total values come from upstream stderr diagnostics. The full report also retains mel/encode/decode/sample timings, process CPU times, byte counts and unaltered stdout/stderr. Per-child RSS comes from kernel wait4.ru_maxrss; it excludes the Python harness and its model-integrity read. The 1 GiB address-space limit is a cap, not measured usage. Host-native x86-64 SIMD, two inference threads and warm OS caches limit portability of these numbers.

## Exact provenance and runtime

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| whisper.cpp pinned source archive | 9,631,456 | `645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4` |
| GGML tiny.en model | 77,704,715 | `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f` |
| Kitware CMake 4.4.4 Linux x86-64 archive | 64,865,570 | `e5bb807f7728cb60cd8b27ebc97a2edb469b68655f21e844a600c3575b76f5bb` |
| Locally built whisper-cli | 3,389,400 | `35214953081555275eed3b3cd8eab3393b1ca88f14869ddf218813f72d86558e` |

- [whisper.cpp v1.9.5 source](https://github.com/ggml-org/whisper.cpp/tree/d1be6fde11ac6e0407606b4e42fe72d34add8037), commit `d1be6fde11ac6e0407606b4e42fe72d34add8037`. All 2,039 regular archive files matched the official pinned Git tree. The release tag was unsigned; this is integrity/provenance evidence, not a signature claim.
- [Pinned project-linked tiny.en conversion](https://huggingface.co/ggerganov/whisper.cpp/resolve/80da2d8bfee42b0e836fc3a9890373e5defc00a6/ggml-tiny.en.bin), revision `80da2d8bfee42b0e836fc3a9890373e5defc00a6`. Published LFS SHA-256 and independent project SHA-1 `c78c86eb1a8faa21b369bcd33207cc90d64ae9df` both match. This is the project maintainer's GGML conversion of OpenAI weights, not an OpenAI-hosted GGML file.
- [Official CMake 4.4.4 release](https://github.com/Kitware/CMake/releases/tag/v4.4.4), source commit `2e0b3aec14fe2e3e555faac4698e281749aae4b5`. Archive matches release digest and checksum list. The three principal downloads total 152,201,741 bytes, plus 2,015 bytes for the checksum list.
- Existing compiler: Debian C++ 14.2.0-19; GNU Make 4.4.1. Configured in 2.013 seconds and built in 260.798 seconds with two Make jobs. Full configure flags and step exits are retained in the isolated build-report.json; the portable summary records build times.
- Release build, in-tree ggml 0.26.0, CPU only, host-native instructions. CURL, server, SDL, FFmpeg, OpenMP, BLAS, dynamic backends, GPU/accelerators and optional downloads were disabled. No npm dependency or lockfile changed.
- ELF NEEDED entries: libstdc++.so.6, libm.so.6, libgcc_s.so.1 and libc.so.6. The CLI is not a portable self-contained static binary. System runtime libraries do not inherit the project's MIT license; any future binary redistribution needs a separate complete runtime/toolchain inventory.

Fixed recognition arguments (MODEL and CLI denote verified local paths):

```text
CLI --model MODEL --file - --output-txt --output-file - --no-timestamps \
  --language en --threads 2 --processors 1 --max-context 0 --no-gpu \
  --beam-size 1 --best-of 1 --temperature 0 --no-fallback
```

WAV bytes were piped from memory to stdin. Explicit text output goes to stdout; no named transcript/audio output file was requested. The proof leaves stderr diagnostics enabled for measurement. A future adapter must suppress transcript logging, cap output, and return text only to an explicit review step.

## Resource, cleanup and scope boundaries

Each native child had a 1 GiB address-space limit, 90 CPU-second limit, 120 wall-second timeout, 8 KiB stdout limit and 64 KiB stderr limit. Only one inference child ran at a time. Each fixture's full bytes were written, all five children were reaped, and the designated empty runtime directory remained empty. A subsequent process check found no owned Whisper/CMake/proof process. The initial setup also checked at least 2 GiB free RAM and disk and used bounded archive extraction outside Git. Models, source/tool archives and executables remain outside the genuine repository.

The setup initially stopped before extraction on inert ancestor .git markers. A reviewed correction now uses fixed /usr/bin/git, minimal environment, five-second timeout and an exact exit-128/not-a-repository allowlist, while rejecting discovered worktrees, other errors, caches inside the genuine repository, and .git markers inside the proof cache. No security/discovery setting was changed. Historical preparation hash records are retained; results have their own hash manifest.

No external inference endpoint, real microphone, paid call, live provider voice contract, browser rendering or browser CSP change was used. No model/binary is proposed as a Git blob. The proof observed owned process/directory behavior, not a complete filesystem/network syscall trace, so it does not establish that every possible write/request was observed.

## Interpretation and remaining gates

- Five short formant-synthesized phrases are a narrow reproducibility check, not validation of human accents, noisy rooms, names, long clips, silence or accessibility. Phrase 3 produced a material word substitution, so editing and explicit Send remain mandatory.
- The Vosk browser file proof on the same fixtures had 12/44 word edits (27.27%) and a 2.273 inference/audio ratio excluding its initial model load. Its synthetic fake-microphone proof had 8/15 edits, but device/worklet startup alignment could affect the first word. Do not generalize either mic metric to people or equate unlike timing definitions.
- Native Whisper avoids the legacy browser eval/CSP obstacle. It does not make a cloud-hosted endpoint local to a person's browser: browser and loopback sidecar must run on the same computer, or separate speech-transfer approval is required.
- Optional integration remains unimplemented and unavailable by default. Microphone/worklet/resampling, origin/CSRF guards, abort/reaping, busy/timeout/overflow handling, review ownership, capture interaction and no-auto-Send all need focused tests before any app acceptance. See WHISPER-LOCAL-DICTATION-PROPOSAL.md.

## Evidence and license texts

The adjacent whisper-proof-evidence directory contains a machine-readable summary with exact synthetic outputs, fixture hashes, per-phrase measurements, artifact provenance, raw evidence digests, source integrity summary and full retained notice texts. The summary omits stderr and absolute cache paths; complete raw reports remain in the isolated proof cache. The separately retained staged-package SHA256SUMS pins the reviewed documentation package; the isolated proof's RESULTS-SHA256SUMS hashes the actual scripts/results. License notice wording is preserved; surplus final blank lines in three text copies were normalized for the unchanged whitespace gate. No vendored executable, model, audio or upstream implementation is included.

The attribution addendum identifies MIT whisper.cpp/ggml and OpenAI weights, MIT-0/public-domain miniaudio 0.11.24, MIT/public-domain stb_vorbis 1.22 and Kitware BSD-3-Clause. In-tree ggml CPU YaRN attribution must remain with any future redistribution. Full CMake bundled notices remain in its original archive/extraction; the retained cmzlib 1.3.1 notice is only that component. This proof approves no binary distribution.
