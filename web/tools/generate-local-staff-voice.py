#!/usr/bin/env python3
"""Generate finite, original formant-voice WAVs. Run only with an approved CPU slot.

python web/tools/generate-local-staff-voice.py --tool-root /path/to/verified/espeak-ng/root
The separate tool's packages must be authenticated before use. No network or install here.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import wave


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tool-root', required=True, type=Path)
    parser.add_argument('--only', help='Generate one inventory ID for initial listening QA')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    inventory = json.loads((repo / 'assets-src/local-staff-voice/dialogue.json').read_text())
    root = args.tool_root.resolve()
    binary = root / 'usr/bin/espeak-ng'
    data_parent = root / 'usr/lib/x86_64-linux-gnu'
    env = dict(os.environ, LD_LIBRARY_PATH=f'{data_parent}:{root}/lib/x86_64-linux-gnu', ESPEAK_DATA_PATH=str(data_parent))
    version = subprocess.run([str(binary), f'--path={data_parent}', '--version'], env=env, check=True, capture_output=True, text=True, timeout=10).stdout.strip()
    if '1.52.0' not in version:
        raise ValueError(f'Unexpected generator version: {version}')
    selected = [line for line in inventory['lines'] if args.only is None or line['id'] == args.only]
    if not selected:
        raise ValueError('Unknown inventory ID')
    output = repo / 'web/public/audio/staff-v1'
    output.mkdir(parents=True, exist_ok=True)
    manifest = []
    for line in selected:
        if line['voice'] not in ('en-us', 'en-gb') or not 1 <= len(line['text']) <= 1200:
            raise ValueError('Only bounded original native-formant inventory lines are allowed')
        target = output / f"{line['id']}.wav"
        if target.parent != output or not line['id'].replace('-', '').isalnum():
            raise ValueError('Unsafe inventory ID')
        with tempfile.TemporaryDirectory() as temp:
            text = Path(temp) / 'line.txt'
            wav = Path(temp) / 'line.wav'
            text.write_text(line['text'], encoding='utf-8')
            argv = [str(binary), f'--path={data_parent}', '-v', line['voice'], '-s', str(line['words_per_minute']), '-p', str(line['pitch']), '-a', '135', '-w', str(wav), '-f', str(text)]
            subprocess.run(argv, env=env, check=True, capture_output=True, timeout=30)
            raw = wav.read_bytes()
        if not 44 < len(raw) < 5 * 1024 * 1024:
            raise ValueError('WAV size outside bounded asset range')
        target.write_bytes(raw)
        with wave.open(str(target), 'rb') as reader:
            if reader.getnchannels() != 1 or reader.getsampwidth() != 2:
                raise ValueError('Expected mono PCM16 WAV')
            frames = reader.getnframes()
            sample_rate = reader.getframerate()
            samples = struct.unpack(f'<{frames}h', reader.readframes(frames))
        duration = frames / sample_rate
        peak = max(abs(value) for value in samples) / 32768
        rms = math.sqrt(sum((value / 32768) ** 2 for value in samples) / frames)
        if not 0 < duration < 60 or peak <= 0.01 or rms <= 0.001:
            raise ValueError('Silent, invalid or oversized clip')
        manifest.append(dict(id=line['id'], voice_id=line['voice_id'], text=line['text'], url=f"/audio/staff-v1/{line['id']}.wav", sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw), duration_seconds=duration, sample_rate=sample_rate, peak=peak, rms=rms, settings=dict(voice=line['voice'], words_per_minute=line['words_per_minute'], pitch=line['pitch'], amplitude=135)))
        print(f"{line['id']}: {duration:.3f} s, {len(raw)} bytes, RMS {rms:.5f}", flush=True)
    result = dict(schema_version=1, generator=dict(name='eSpeak NG', version='1.52.0', debian_version='1.52.0+dfsg-5', method='native formant synthesis', license='GPL-3.0-or-later', source_url='https://github.com/espeak-ng/espeak-ng', runtime_bundled=False), clips=manifest)
    filename = 'localStaffVoiceManifest.json' if args.only is None else 'localStaffVoicePreview.json'
    path = repo / 'web/src/lib/precinct' / filename
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(f'Wrote {len(manifest)} exact clips to {path}')


if __name__ == '__main__':
    main()
