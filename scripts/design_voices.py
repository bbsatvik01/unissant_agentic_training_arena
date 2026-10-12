"""`python -m scripts.design_voices` (stage 8): design and store one voice per catalogue persona that has none yet.

Runs as `arena-api` would (its boot checks, the `arena_public` credential for the spend guard, the arena project only):
each persona's description in ``packages/core/src/arena_core/voice/personas.json`` goes through the Voices API
(prompted, stored in the project), reserved and settled on the guard (call kind ``voice_design``), and its new voice
id is written back to the catalogue at once. ``--dry-run`` prints what would be designed and each request's measured
bytes, with no call. Samples go to ``.run/voice-samples`` for an audition. Synthetic characters only: this never
replicates a real voice.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

from arena_core.config import ArenaRole, boot
from arena_core.db.pool import dsn_connector
from arena_core.providers.mode import FAKE, MODE_VAR
from arena_core.providers.vertex import vertex_voice_designer, voice_design_bytes
from arena_core.spend.guard import DbSpendGuard
from arena_core.voice.catalogue import CATALOGUE_PATH, load
from arena_core.voice.design import Designed, Tools, design_missing, display_name, write_voice_id
from arena_core.voice.tts import wav_bytes

SAMPLES = Path(".run/voice-samples")
PCM_RATE = 24_000


def sample_wav(sample: bytes, mime: str) -> bytes:
    """The sample as a playable WAV: as returned when it is one, else headerless 16-bit PCM at its stated rate."""
    if sample[:4] == b"RIFF" or "wav" in mime.lower():
        return sample
    match = re.search(r"rate=(\d+)", mime)
    return wav_bytes(sample, int(match.group(1)) if match else PCM_RATE)


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", nargs="*", default=None, help="persona keys to design (default: every one without)")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and measured bytes; call nothing")
    args = parser.parse_args(argv)
    personas = load()
    only = None if args.only is None else frozenset(args.only)
    todo = [p for k, p in personas.items() if p.voice_id is None and (only is None or k in only)]
    for p in todo:
        size = voice_design_bytes(p.description, display_name(p), p.gender, p.language_code)
        sys.stdout.write(f"design_voices: {p.key}: {size} bytes: {p.description}\n")
    if args.dry_run or not todo:
        sys.stdout.write(f"design_voices: {len(todo)} to design{' (dry run)' if args.dry_run else ''}\n")
        return 0
    resolved = dict(os.environ if env is None else env)
    if resolved.get(MODE_VAR, "").strip() == FAKE:
        sys.stderr.write("design_voices: ARENA_MODEL_MODE=fake; designing a voice is a real, paid call\n")
        return 2
    settings = boot(ArenaRole.API, resolved)
    path = CATALOGUE_PATH

    def keep(key: str, out: Designed) -> None:
        write_voice_id(path, key, out.voice_id)
        if out.sample:
            SAMPLES.mkdir(parents=True, exist_ok=True)
            (SAMPLES / f"{key.replace(':', '_').replace(' ', '_')}.wav").write_bytes(
                sample_wav(out.sample, out.sample_mime)
            )
        sys.stdout.write(f"design_voices: {key} -> {out.voice_id}\n")

    tools = Tools(vertex_voice_designer(resolved), DbSpendGuard(dsn_connector(settings.dsn)), voice_design_bytes)
    outcomes = asyncio.run(design_missing(personas, tools, on_designed=keep, only=only))
    failed = [o for o in outcomes if o.error is not None]
    for o in failed:
        sys.stderr.write(f"design_voices: {o.key} failed: {o.error}\n")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
