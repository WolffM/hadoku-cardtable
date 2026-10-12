"""The finishing pass: raw takes -> trimmed, faded, level-matched Opus files.

Reads ~/.local/share/cardtable-sfx/generated/<id>/take-<seed>.wav (generate.py) and writes
~/.local/share/cardtable-sfx/finished/<id>/take-<seed>.ogg plus finished/manifest.json, which
lists every take with its prompt and measurements. Outside the repo, like every audio byte.

Level matching is by perceived loudness: the loudest 400 ms of the take, K-weighted as in ITU-R
BS.1770 (momentary loudness, LUFS). Plain RMS left a 17 dB spread between takes that measured "equal"
(the operator, 2026-10-11: "the bant creature sounds are just maxing out my speakers"), because a dense
low roar and a thin sparkle with the same RMS do not sound the same. Each kind of sound has its own
target, and the gain is then capped so the peak stays at or under -1 dBFS.
"""
import argparse
import glob
import json
import os
import subprocess
import tempfile

import numpy as np
import pyloudnorm
import soundfile as sf

ROOT = os.path.expanduser('~/.local/share/cardtable-sfx')
# Momentary-max loudness per kind of sound, in LUFS. Moments a player should notice sit highest; a hover,
# which fires constantly, sits far under everything.
LOUDNESS = {'moment': -20.0, 'game': -23.0, 'ui': -28.0, 'hover': -34.0}
MOMENT_ROLES = ('g.turn-mine', 'g.turn-theirs', 'g.win', 'g.lose', 'g.game-start', 'g.match-start')
PEAK_CEILING_DB = -1.0
GATE_DB = -45.0          # relative to the take's own peak: quieter than this is silence
FADE_IN_S, FADE_OUT_S = 0.004, 0.04
TAIL_PAD_S = 0.03

# The longest each kind of sound may run. First set short (operator, 2026-10-05: "most of the sounds you created
# are too long"), then measured too short (2026-10-10: "playing the sounds seems a bit cutoff"): at 0.8 s, 82% of
# the game takes were cut mid-ring, when their median rings 1.7 s to -45 dB and their main hit is over by 0.7 s.
# So a limit now only stops a runaway take, and a sound keeps its own tail: card games let a tail ring under the
# next sound rather than chop it (the mixer collapses repeats and caps voices). Interface sounds rarely reach theirs.
MOMENT_CAP = {'m-turn': 2.5, 'm-win': 4.0, 'm-lose': 4.0}
ROLE_CAP = {'ui.prompt': 1.0, 'g.turn-mine': 2.5, 'g.turn-theirs': 2.5, 'g.game-start': 2.5}
UI_CAP, GAME_CAP = 0.6, 2.0


def cap_for(folder):
    base = folder.split('.')[0]
    if base in MOMENT_CAP:
        return MOMENT_CAP[base]
    if folder in ROLE_CAP:
        return ROLE_CAP[folder]
    if folder.startswith('ui.'):
        return UI_CAP
    return GAME_CAP


def loudness_for(folder):
    if folder.split('.')[0] in MOMENT_CAP or folder in MOMENT_ROLES:
        return LOUDNESS['moment']
    if folder.startswith('ui.hover'):
        return LOUDNESS['hover']
    if folder.startswith('ui.'):
        return LOUDNESS['ui']
    return LOUDNESS['game']


def momentary_max(audio, rate):
    """The loudest 400 ms window, K-weighted (BS.1770), in LUFS. A take shorter than a window counts as one."""
    weighted = audio
    for stage in pyloudnorm.Meter(rate)._filters.values():
        weighted = stage.apply_filter(weighted)
    power = (weighted ** 2).sum(axis=1)
    window = int(0.4 * rate)
    if len(power) < window:
        power = np.pad(power, (0, window - len(power)))
    means = np.convolve(power, np.ones(window) / window, 'valid')[::int(0.05 * rate)]
    return -0.691 + 10 * np.log10(max(means.max(), 1e-12))


def db(x):
    return 20 * np.log10(max(x, 1e-9))


def finish(path, cap, target):
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
    gain = 10 ** ((target - momentary_max(clip, rate)) / 20)
    gain = min(gain, 10 ** (PEAK_CEILING_DB / 20) / np.abs(clip).max())
    clip *= gain
    # a capped take fades over its last 30%, so the cut reads as a decay, not a chop
    fade_out = max(FADE_OUT_S, cap * 0.3) if capped else FADE_OUT_S
    n_in, n_out = int(FADE_IN_S * rate), min(int(fade_out * rate), len(clip) // 2)
    clip[:n_in] *= np.linspace(0, 1, n_in)[:, None]
    clip[-n_out:] *= np.linspace(1, 0, n_out)[:, None]
    return clip, rate, {
        'seconds': round(len(clip) / rate, 3),
        'gainDb': round(db(gain), 1),
        'peakDb': round(db(np.abs(clip).max()), 1),
        'loudness': round(momentary_max(clip, rate), 1),
        'capped': bool(capped),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='', help='comma-separated folder prefixes, e.g. "ui.,g." for round 4')
    ap.add_argument('--out', default='finished', help='output dir under ~/.local/share/cardtable-sfx')
    ap.add_argument('--min-seed', type=int, default=None,
                    help='only takes whose seed (the stem\'s last number) is at least this: one round\'s files in folders older rounds share')
    ap.add_argument('--into', default='', help='re-cut in place: a sounds dir (catalogue.json + takes/); overwrites each '
                    'take that has a raw source and updates only its seconds, so names, groups and placements stay')
    args = ap.parse_args()
    if args.into:
        return recut_in_place(args.into)
    prefixes = tuple(p for p in args.only.split(',') if p)
    out_root = os.path.join(ROOT, args.out)
    manifest = {}
    for wav in sorted(glob.glob(os.path.join(ROOT, 'generated', '*', 'take-*.wav'))):
        sid = os.path.basename(os.path.dirname(wav))
        if prefixes and not sid.startswith(prefixes):
            continue
        stem = os.path.splitext(os.path.basename(wav))[0]
        if args.min_seed is not None and int(stem.rsplit('-', 1)[-1]) < args.min_seed:
            continue
        meta = json.load(open(wav[:-4] + '.json'))
        done = finish(wav, cap_for(sid), loudness_for(sid))
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


def recut_in_place(sounds_dir):
    """Re-finish every catalogued take from its raw .wav, under the same file name."""
    raw = {}
    for wav in glob.glob(os.path.join(ROOT, 'generated', '*', 'take-*.wav')):
        sid = os.path.basename(os.path.dirname(wav))
        raw[f"{sid.lower()}/{os.path.splitext(os.path.basename(wav))[0]}.ogg"] = (wav, sid)
    cat_path = os.path.join(sounds_dir, 'catalogue.json')
    catalogue = json.load(open(cat_path, encoding='utf-8'))
    done = skipped = longer = 0
    for take in catalogue['takes']:
        source = raw.get(take['file'])
        if source is None:
            skipped += 1
            continue
        wav, sid = source
        result = finish(wav, cap_for(sid), loudness_for(sid))
        if result is None:
            skipped += 1
            continue
        clip, rate, measured = result
        target = os.path.join(sounds_dir, 'takes', take['file'])
        with tempfile.NamedTemporaryFile(suffix='.wav') as tmp:
            sf.write(tmp.name, clip, rate)
            part = target + '.recut.ogg'
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp.name, '-ac', '1', '-c:a', 'libopus', '-b:a', '64k', part], check=True)
            os.replace(part, target)
        longer += measured['seconds'] > take['seconds'] + 0.01
        take['seconds'] = measured['seconds']
        done += 1
    part = cat_path + '.recut.tmp'
    json.dump(catalogue, open(part, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    os.replace(part, cat_path)
    print(f"re-cut {done} takes in place ({longer} now longer), {skipped} with no raw source left as they were")


if __name__ == '__main__':
    main()
