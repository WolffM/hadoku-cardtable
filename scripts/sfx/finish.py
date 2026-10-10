"""The finishing pass: raw takes -> trimmed, faded, level-matched Opus files.

Reads ~/.local/share/cardtable-sfx/generated/<id>/take-<seed>.wav (generate.py) and writes
~/.local/share/cardtable-sfx/finished/<id>/take-<seed>.ogg plus finished/manifest.json, which
lists every take with its prompt and measurements. Outside the repo, like every audio byte.

Level matching is by the RMS of the part that sounds, not the peak: a short sparkle and a long
roar should feel equally loud. The gain is then capped so the peak stays at or under -1 dBFS.
"""
import argparse
import glob
import json
import os
import subprocess
import tempfile

import numpy as np
import soundfile as sf

ROOT = os.path.expanduser('~/.local/share/cardtable-sfx')
TARGET_RMS_DB = -20.0
PEAK_CEILING_DB = -1.0
GATE_DB = -45.0          # relative to the take's own peak: quieter than this is silence
FADE_IN_S, FADE_OUT_S = 0.004, 0.04
TAIL_PAD_S = 0.03

# The longest each kind of sound may run (operator, 2026-10-05: "most of the sounds you created are too long").
# Card games keep effects short so one finishes before the next action: Hearthstone's interface pokes are
# 0.5-0.8 s and its card-play sounds 0.6-3.7 s with the voice line included (Hearthstone wiki audio files).
# A take longer than its cap is cut there with a fade-out, so an ambience (waves, wind) becomes a gesture.
MOMENT_CAP = {'m-tap': 0.4, 'm-phase': 0.4, 'm-draw': 0.6, 'm-shuffle': 0.6, 'm-attack': 0.8, 'm-block': 0.8,
              'm-damage': 0.8, 'm-dies': 0.8, 'm-resolve': 0.8, 'm-turn': 1.0, 'm-win': 3.0, 'm-lose': 3.0}
# Round 4's role folders are named by role id. Interface sounds fire constantly, so they stay shortest.
ROLE_CAP = {'ui.prompt': 0.8, 'ui.target': 0.5, 'ui.inspect': 0.5, 'g.tap': 0.4, 'g.untap': 0.4, 'g.mana': 0.5,
            'g.turn-mine': 1.2, 'g.turn-theirs': 1.0, 'g.game-start': 1.5, 'g.untap-all': 0.7}
LIB_IMPACT = ('lib-sword', 'lib-shield', 'lib-punch', 'lib-arrow', 'lib-branch', 'lib-glass', 'lib-coins', 'lib-paper', 'lib-zap')


def cap_for(folder):
    base = folder.split('.')[0]
    if base in MOMENT_CAP:
        return MOMENT_CAP[base]
    if folder in ROLE_CAP:
        return ROLE_CAP[folder]
    if folder.startswith('ui.'):
        return 0.35
    if folder.startswith('g.'):
        return 0.8
    if folder.startswith('land-') or folder.endswith('.land'):
        return 1.0
    if folder.startswith(LIB_IMPACT):
        return 0.8
    return 1.5


def db(x):
    return 20 * np.log10(max(x, 1e-9))


def finish(path, cap):
    audio, rate = sf.read(path, always_2d=True)
    mono = np.abs(audio).max(axis=1)
    peak = mono.max()
    if peak <= 0:
        return None
    sounding = np.where(mono > peak * 10 ** (GATE_DB / 20))[0]
    start = max(0, sounding[0] - int(0.002 * rate))
    end = min(len(audio), sounding[-1] + int(TAIL_PAD_S * rate), start + int(cap * rate))
    capped = end == start + int(cap * rate)
    clip = audio[start:end].copy()
    active = clip[np.abs(clip).max(axis=1) > peak * 10 ** (-30 / 20)]
    rms = np.sqrt((active ** 2).mean()) if len(active) else np.sqrt((clip ** 2).mean())
    gain = 10 ** ((TARGET_RMS_DB - db(rms)) / 20)
    gain = min(gain, 10 ** (PEAK_CEILING_DB / 20) / np.abs(clip).max())
    clip *= gain
    # a capped take gets a long fade (a quarter of it) so the cut reads as a decay, not a chop
    fade_out = max(FADE_OUT_S, cap * 0.25) if capped else FADE_OUT_S
    n_in, n_out = int(FADE_IN_S * rate), min(int(fade_out * rate), len(clip) // 2)
    clip[:n_in] *= np.linspace(0, 1, n_in)[:, None]
    clip[-n_out:] *= np.linspace(1, 0, n_out)[:, None]
    return clip, rate, {
        'seconds': round(len(clip) / rate, 3),
        'gainDb': round(db(gain), 1),
        'peakDb': round(db(np.abs(clip).max()), 1),
        'rmsDb': round(db(np.sqrt((clip ** 2).mean())), 1),
        'capped': bool(capped),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='', help='comma-separated folder prefixes, e.g. "ui.,g." for round 4')
    ap.add_argument('--out', default='finished', help='output dir under ~/.local/share/cardtable-sfx')
    args = ap.parse_args()
    prefixes = tuple(p for p in args.only.split(',') if p)
    out_root = os.path.join(ROOT, args.out)
    manifest = {}
    for wav in sorted(glob.glob(os.path.join(ROOT, 'generated', '*', 'take-*.wav'))):
        sid = os.path.basename(os.path.dirname(wav))
        if prefixes and not sid.startswith(prefixes):
            continue
        stem = os.path.splitext(os.path.basename(wav))[0]
        meta = json.load(open(wav[:-4] + '.json'))
        done = finish(wav, cap_for(sid))
        if done is None:
            continue
        clip, rate, measured = done
        os.makedirs(os.path.join(out_root, sid), exist_ok=True)
        ogg = os.path.join(out_root, sid, stem + '.ogg')
        with tempfile.NamedTemporaryFile(suffix='.wav') as tmp:
            sf.write(tmp.name, clip, rate)
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp.name, '-ac', '1', '-c:a', 'libopus', '-b:a', '64k', ogg], check=True)
        manifest.setdefault(sid, []).append({'file': f'{sid}/{stem}.ogg', 'seed': meta['seed'], 'prompt': meta['prompt'], **measured})
    json.dump(manifest, open(os.path.join(out_root, 'manifest.json'), 'w'), indent=1)
    print(f"{sum(len(v) for v in manifest.values())} takes over {len(manifest)} sounds -> {out_root}")


if __name__ == '__main__':
    main()
