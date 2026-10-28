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
import io
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
# Measured on the mono take this writes (2026-10-12; before, on the stereo source, 3 dB higher for the same output).
LOUDNESS = {'moment': -23.0, 'game': -26.0, 'ui': -31.0, 'hover': -37.0}
# A short hit is levelled on its loudest 400 ms like everything else, which let a click's first 50 ms land up to
# 9.5 dB over the rest (the operator, 2026-10-12: "make sure there aren't too many crazy outliers"). Its loudest
# 50 ms may sit this far over the target, no further.
TRANSIENT_HEADROOM_DB = 4.0
# The hovers fire constantly and were "a bit harsh" (2026-10-12): a slow attack, a long fade, no top end.
SOFT_FADE_IN_S, SOFT_LOWPASS_HZ = 0.02, 5000
MOMENT_ROLES = ('g.turn-mine', 'g.win', 'g.lose', 'g.game-start', 'g.match-start')
PEAK_CEILING_DB = -1.0
GATE_DB = -45.0          # relative to the take's own peak: quieter than this is silence
FADE_IN_S, FADE_OUT_S = 0.004, 0.04
TAIL_PAD_S = 0.03

# The longest each kind of sound may run. First set short (operator, 2026-10-05: "most of the sounds you created
# are too long"), then measured too short (2026-10-10: "playing the sounds seems a bit cutoff"): at 0.8 s, 82% of
# the game takes were cut mid-ring, when their median rings 1.7 s to -45 dB and their main hit is over by 0.7 s.
# So a limit now only stops a runaway take, and a sound keeps its own tail: card games let a tail ring under the
# next sound rather than chop it (the mixer collapses repeats and caps voices). Interface sounds rarely reach theirs.
# Then too long again for the quick ones (2026-10-11: "many sounds like hovering, tapping, destroying should be
# shorter and simpler"), so the roles that answer a gesture or tick by often get their own short limit.
MOMENT_CAP = {'m-turn': 2.5, 'm-win': 4.0, 'm-lose': 4.0}
ROLE_CAP = {'ui.prompt': 1.0, 'g.turn-mine': 2.5, 'g.combat': 2.6, 'g.spell-hit': 1.0, 'g.walker-hit': 1.6,
            'g.die-roll': 1.6, 'g.coin-flip': 2.4,
            'g.landing.3': 1.0, 'g.landing.5': 1.4, 'g.landing.7': 1.8, 'g.landing.10': 2.4, 'g.game-start': 2.5, 'g.match-start': 3.0,
            'ui.hover-card': 0.25, 'ui.select': 0.3, 'ui.pass': 0.4, 'ui.lift': 0.35,
            'ui.place': 0.35, 'ui.deny': 0.4, 'ui.target': 0.4, 'ui.inspect': 0.4, 'ui.draft-pick': 0.4,
            'g.tap': 0.35, 'g.untap': 0.35, 'g.counter-on': 0.4, 'g.counter-off': 0.4,
            'g.phase': 0.4, 'g.draw': 0.5, 'g.discard': 0.6, 'g.mill': 0.8, 'g.attach': 0.6,
            'g.destroy': 0.9, 'g.dies': 1.0, 'g.exile': 0.9, 'g.bounce': 0.8, 'g.counter': 0.9, 'g.damage': 0.8}
UI_CAP, GAME_CAP = 0.6, 2.0
# A blow to a player sounds as big as its damage (2026-10-20, round 11): each tier rings longer and sits louder than
# the one below, from a body blow to a castle coming down, and the crowd over the heaviest ones swells longer still.
# Past GAME_CAP from tier 5 up, which would have cut the big tails; the small tiers sit under `game` on purpose.
TIER_CAP = {'g.impact.1': 1.0, 'g.impact.2': 1.2, 'g.impact.3': 1.5, 'g.impact.4': 1.8, 'g.impact.5': 2.2,
            'g.impact.7': 2.8, 'g.impact.10': 3.5, 'g.cheer.5': 3.0, 'g.cheer.7': 4.0, 'g.cheer.10': 4.5}
TIER_LOUDNESS = {'g.impact.1': -28.0, 'g.impact.2': -27.0, 'g.impact.3': -26.0, 'g.impact.4': -25.0,
                 'g.impact.5': -24.0, 'g.impact.7': -23.0, 'g.impact.10': -22.0,
                 'g.cheer.5': -29.0, 'g.cheer.7': -28.0, 'g.cheer.10': -27.0}


def cap_for(folder):
    base = folder.split('.')[0]
    if base in MOMENT_CAP:
        return MOMENT_CAP[base]
    if folder in TIER_CAP:
        return TIER_CAP[folder]
    if folder in ROLE_CAP:
        return ROLE_CAP[folder]
    if folder.startswith('ui.'):
        return UI_CAP
    return GAME_CAP


def loudness_for(folder):
    if folder in TIER_LOUDNESS:
        return TIER_LOUDNESS[folder]
    if folder.split('.')[0] in MOMENT_CAP or folder in MOMENT_ROLES:
        return LOUDNESS['moment']
    if folder.startswith('ui.hover'):
        return LOUDNESS['hover']
    if folder.startswith('ui.'):
        return LOUDNESS['ui']
    return LOUDNESS['game']


def to_mono(audio):
    """One channel. The model's stereo is sometimes near opposite in phase, and a plain average then cancels to
    almost nothing (round 6: takes 20 dB under target, peaking at -42 dBFS); then the louder channel alone."""
    if audio.shape[1] == 1:
        return audio
    mid = audio.mean(axis=1, keepdims=True)
    channel_rms = np.sqrt((audio ** 2).mean(axis=0))
    if np.sqrt((mid ** 2).mean()) < 0.5 * channel_rms.mean():
        return audio[:, [int(channel_rms.argmax())]]
    return mid


def short_max(audio, rate):
    """The loudest 50 ms, K-weighted, in LUFS: what a click or a hit feels like."""
    weighted = audio
    for stage in pyloudnorm.Meter(rate)._filters.values():
        weighted = stage.apply_filter(weighted)
    power = (weighted ** 2).sum(axis=1)
    window = int(0.05 * rate)
    if len(power) < window:
        power = np.pad(power, (0, window - len(power)))
    return -0.691 + 10 * np.log10(max(window_means(power, window).max(), 1e-12))


def momentary_max(audio, rate):
    """The loudest 400 ms window, K-weighted (BS.1770), in LUFS. A take shorter than a window counts as one."""
    weighted = audio
    for stage in pyloudnorm.Meter(rate)._filters.values():
        weighted = stage.apply_filter(weighted)
    power = (weighted ** 2).sum(axis=1)
    window = int(0.4 * rate)
    if len(power) < window:
        power = np.pad(power, (0, window - len(power)))
    return -0.691 + 10 * np.log10(max(window_means(power, window).max(), 1e-12))


def window_means(power, window):
    """The mean of every `window`-long run of `power`, in linear time (a full convolution took minutes per take)."""
    total = np.concatenate([[0.0], np.cumsum(power)])
    return (total[window:] - total[:-window]) / window


def db(x):
    return 20 * np.log10(max(x, 1e-9))


def finish(path, cap, target, soft=False):
    audio, rate = sf.read(path, always_2d=True)
    audio = to_mono(audio)
    if soft:
        from scipy.signal import butter, sosfilt
        audio = sosfilt(butter(2, SOFT_LOWPASS_HZ, 'low', fs=rate, output='sos'), audio, axis=0)
    mono = np.abs(audio).max(axis=1)
    peak = mono.max()
    if peak <= 0:
        return None
    sounding = np.where(mono > peak * 10 ** (GATE_DB / 20))[0]
    start = max(0, sounding[0] - int(0.002 * rate))
    end = min(len(audio), sounding[-1] + int(TAIL_PAD_S * rate), start + int(cap * rate))
    capped = end == start + int(cap * rate)
    clip = audio[start:end].copy()
    # a capped take fades over its last 30%, so the cut reads as a decay, not a chop. Fades come before the
    # level is measured: on an 80 ms tick, a soft fade applied after it took most of the sound away again.
    fade_out = max(FADE_OUT_S, cap * 0.3) if capped else FADE_OUT_S
    fade_in = FADE_IN_S
    if soft:
        seconds = len(clip) / rate
        fade_in, fade_out = min(SOFT_FADE_IN_S, seconds * 0.15), seconds * 0.5
    n_in, n_out = min(int(fade_in * rate), len(clip) // 3), min(int(fade_out * rate), len(clip) // 2)
    ramp = lambda n: (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, n)))[:, None] if soft else np.linspace(0, 1, n)[:, None]
    clip[:n_in] *= ramp(n_in)
    clip[-n_out:] *= ramp(n_out)[::-1]
    gain_db = min(target - momentary_max(clip, rate), target + TRANSIENT_HEADROOM_DB - short_max(clip, rate))
    gain = 10 ** (gain_db / 20)
    gain = min(gain, 10 ** (PEAK_CEILING_DB / 20) / np.abs(clip).max())
    clip *= gain
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
        done = finish(wav, cap_for(sid), loudness_for(sid), soft=sid.startswith('ui.hover'))
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
    # harvest.py renames a chosen take after its cell; sources.json keeps the name it was generated under.
    sources_path = os.path.join(sounds_dir, 'sources.json')
    sources = json.load(open(sources_path, encoding='utf-8')) if os.path.exists(sources_path) else {}
    # A placed take is cut for the role it plays, not the folder it came from: "Hover a card" plays a creature take.
    placed = {}
    assignments = os.path.join(sounds_dir, 'assignments.json')
    if os.path.exists(assignments):
        for cell, files in json.load(open(assignments, encoding='utf-8')).get('cells', {}).items():
            row = cell.split('|')[0]
            for file in files:
                placed.setdefault(file, []).append(row)
    done = levelled = longer = 0
    for take in catalogue['takes']:
        source = raw.get(sources.get(take['file'], take['file']))
        roles = placed.get(take['file'], [])
        target = os.path.join(sounds_dir, 'takes', take['file'])
        if source is None:
            # A hand edit (a first hit cut out, a take reversed) has no raw source: level the take itself, gain only.
            sid = sources.get(take['file'], take['file']).split('/')[0]
            loudness = min([loudness_for(r) for r in roles] + ([] if roles else [loudness_for(sid)]))
            relevel(target, loudness)
            levelled += 1
            continue
        wav, sid = source
        cap = min([cap_for(r) for r in roles] + ([] if roles else [cap_for(sid)]))
        loudness = min([loudness_for(r) for r in roles] + ([] if roles else [loudness_for(sid)]))
        soft = any(r.startswith('ui.hover') for r in roles) or (not roles and sid.startswith('ui.hover'))
        result = finish(wav, cap, loudness, soft)
        if result is None:
            continue
        clip, rate, measured = result
        write_ogg(clip, rate, target)
        longer += measured['seconds'] > take['seconds'] + 0.01
        take['seconds'] = measured['seconds']
        done += 1
    part = cat_path + '.recut.tmp'
    json.dump(catalogue, open(part, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    os.replace(part, cat_path)
    print(f"re-cut {done} takes in place ({longer} now longer), {levelled} with no raw source levelled as they are")


def write_ogg(clip, rate, target):
    with tempfile.NamedTemporaryFile(suffix='.wav') as tmp:
        sf.write(tmp.name, clip, rate)
        part = target + '.recut.ogg'
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp.name, '-ac', '1', '-c:a', 'libopus', '-b:a', '64k', part], check=True)
        os.replace(part, target)


def relevel(target, loudness):
    decoded = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', target, '-f', 'wav', '-'], capture_output=True, check=True).stdout
    clip, rate = sf.read(io.BytesIO(decoded), always_2d=True)
    gain_db = min(loudness - momentary_max(clip, rate), loudness + TRANSIENT_HEADROOM_DB - short_max(clip, rate))
    gain = min(10 ** (gain_db / 20), 10 ** (PEAK_CEILING_DB / 20) / np.abs(clip).max())
    write_ogg(clip * gain, rate, target)


if __name__ == '__main__':
    main()
