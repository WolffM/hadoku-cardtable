"""Generate candidate sound effects with Stable Audio Open on the local GPU.

Every colour identity has three sounds (operator, 2026-10-05): a spell (instant or sorcery) cast,
a creature arriving, and a land played. Game moments have one each.

Takes for every sound in prompts.json (the 26 colour identities, colourless,
and the game moments), written OUTSIDE the repo: audio bytes never enter git,
and the picked files go to the CDN like card art. Each take gets a sidecar
.json with the prompt, seed, model and licence, so any file can be traced and
regenerated exactly.

Runtime: the venv in ~/.local/opt/stable-audio (see README.md beside this).

    ~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/generate.py --takes 4
    ... --only W,UR,m-draw          # a subset, by id
    ... --vibes saved-vibes.json    # the operator's edits from the palette page win
"""
import argparse
import json
import os
import sys
import time

import soundfile as sf
import torch
from diffusers import StableAudioPipeline

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.expanduser('~/.local/share/cardtable-sfx/generated')
MODEL = 'stabilityai/stable-audio-open-1.0'

# Stable Audio Open was trained on Freesound and FMA descriptions, so a prompt
# reads best as a sound designer's description: what it is, then its texture.
NEGATIVE = 'music, melody, song, speech, voice, vocals, singing, low quality, muffled, clipping, distortion, hum, silence'


# What each colour sounds like as a creature arriving and as a land being played. Combinations join their
# colours' cues; three or more colours lean on the identity's own vibe, so the prompt does not turn to mush.
CREATURE = {
    'W': 'a knight or angel arriving, armour settling and a soft holy swell',
    'U': 'a sea or sky creature, a rush of water or wind',
    'B': 'an undead thing rising, a low growl and rattling bones',
    'R': 'a goblin or dragon bursting in, a snarl and a lick of flame',
    'G': 'a big beast landing, heavy footsteps and a deep growl',
    'C': 'a construct powering up, metal joints and a mechanical whirr',
}
TERRAIN = {
    'W': 'open plains, warm wind over grass',
    'U': 'an island shore, a single lapping wave',
    'B': 'a dark swamp, a slow bubbling bog',
    'R': 'a mountain, rumbling rock and gravel',
    'G': 'a deep forest, rustling leaves and creaking wood',
    'C': 'an ancient stone monument, a resonant hum',
}
ROLES = ('spell', 'creature', 'land')


def colours_of(sid):
    return ['C'] if sid == 'C' else list(sid)


def prompt_for(s):
    if s['kind'] == 'moment':
        return f"{s['vibe']} Short game sound effect for a card game: {s['name'].lower()}. Clean, dry, close, one shot."
    role, cols = s['role'], colours_of(s['base'])
    if role == 'spell':
        return f"{s['vibe']} Fantasy card game spell cast sound effect, one shot, crisp attack, short clean tail, high quality."
    if role == 'creature':
        cue = ' and '.join(CREATURE[c] for c in cols) if len(cols) <= 2 else s['vibe'].rstrip('.')
        return f"A creature enters the battlefield: {cue}. {s['name']} flavour. Fantasy card game sound effect, one shot, weighty arrival, short clean tail, high quality."
    terrain = ' and '.join(TERRAIN[c] for c in cols) if len(cols) <= 2 else ', '.join(TERRAIN[c].split(',')[0] for c in cols)
    return f"A land card is played: {terrain}. A short grounded thump with a brief ambience of the place. Fantasy card game sound effect, one shot, calm, high quality."


def seconds_for(s):
    return 1.0 if s['kind'] == 'moment' else (1.5 if s.get('role') == 'land' else 2.0)


def expand(sounds):
    """A colour identity becomes three sounds, <id>.spell / .creature / .land; a game moment stays one."""
    out = []
    for s in sounds:
        if s['kind'] == 'moment':
            out.append(s)
            continue
        for role in ROLES:
            out.append({**s, 'id': f"{s['id']}.{role}", 'base': s['id'], 'role': role})
    return out


def save(base, audio, rate):
    """A take as 32-bit float WAV. The model peaks well past full scale (2.29 on a mill take, 2026-10-11), and
    soundfile's default 16-bit WAV hard-clipped every sample beyond ±1: 309 of the 439 live takes carried that
    distortion into the picker (the operator: "like they're capping out something"). Float keeps the overshoot
    for finish.py, which only ever turns a take down."""
    sf.write(base + '.wav', audio.T.float().cpu().numpy(), rate, subtype='FLOAT')


def render(pipe, prompt, seed, s, args, negative, seconds=None):
    """One take. Out of memory means a neighbour on the shared GPU is busy: wait and try again."""
    for attempt in range(40):
        try:
            return pipe(
                prompt,
                negative_prompt=negative,
                num_inference_steps=args.steps,
                guidance_scale=args.cfg,
                audio_end_in_s=seconds if seconds is not None else seconds_for(s),
                num_waveforms_per_prompt=1,
                generator=torch.Generator('cpu').manual_seed(seed),
            ).audios[0]
        except torch.OutOfMemoryError:
            torch.cuda.empty_cache()
            print(f"  {s['id']} seed {seed}: GPU busy, waiting ({attempt + 1}/40)", flush=True)
            time.sleep(30)
    raise SystemExit(f"{s['id']} seed {seed}: the GPU stayed full for 20 minutes")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--takes', type=int, default=4)
    ap.add_argument('--only', default='')
    ap.add_argument('--steps', type=int, default=150)
    ap.add_argument('--cfg', type=float, default=7.0)
    ap.add_argument('--vibes', default='', help='JSON {id: vibe} that overrides prompts.json')
    ap.add_argument('--seed', type=int, default=1000, help='first seed; take k uses seed + k')
    ap.add_argument('--spec', default='', help='round3.json: named sounds, literal prompts, its own suffix, negative and length')
    ap.add_argument('--variants', default='', help='variants.json: several distinct prompts per sound; folder <id>.r2, files take-v<k>-<seed>')
    ap.add_argument('--avoid', default='', help='extra negative prompt for this run, e.g. "bells, chimes, harsh, metallic"')
    ap.add_argument('--rerender', default='', help='a sounds dir: render again, from its sidecar, every catalogued take '
                    'whose raw .wav was saved clipped, and save it as float. Same seed, same sound, without the clipping')
    ap.add_argument('--offload', choices=['none', 'model', 'sequential'], default='none',
                    help='the GPU is shared (InvokeAI, other projects): model ~4 GB of VRAM, sequential ~1 GB and slowest')
    args = ap.parse_args()

    if args.rerender:
        return rerender(args)
    if args.spec:
        return run_spec(args)
    if args.variants:
        return run_variants(args)
    sounds = json.load(open(os.path.join(HERE, 'prompts.json')))['sounds']
    if args.vibes:
        overrides = json.load(open(args.vibes))
        for s in sounds:
            if overrides.get(s['id'], '').strip():
                s['vibe'] = overrides[s['id']].strip()
    sounds = expand(sounds)
    if args.only:
        # `UB` means all three of Dimir's sounds; `UB.creature` means one
        want = set(args.only.split(','))
        sounds = [s for s in sounds if s['id'] in want or s.get('base') in want]
        missing = {w for w in want if not any(x['id'] == w or x.get('base') == w for x in sounds)}
        if missing:
            sys.exit(f'unknown ids: {sorted(missing)}')

    pipe = load_pipe(args)
    rate = pipe.vae.sampling_rate
    negative = NEGATIVE + (', ' + args.avoid if args.avoid else '')
    started = time.time()
    for s in sounds:
        folder = os.path.join(OUT, s['id'])
        os.makedirs(folder, exist_ok=True)
        prompt = prompt_for(s)
        for k in range(args.takes):
            seed = args.seed + k
            base = os.path.join(folder, f'take-{seed}')
            if os.path.exists(base + '.wav'):
                continue  # resume: a take is a pure function of (prompt, seed, steps, cfg)
            audio = render(pipe, prompt, seed, s, args, negative)
            save(base, audio, rate)
            json.dump({
                'id': s['id'], 'name': s['name'], 'role': s.get('role'), 'prompt': prompt, 'negative': negative, 'seed': seed,
                'steps': args.steps, 'cfg': args.cfg, 'seconds': seconds_for(s), 'model': MODEL,
                'licence': 'Stability AI Community License (stable-audio-open-1.0 LICENSE.md)',
            }, open(base + '.json', 'w'), indent=1)
        print(f"{s['id']:>8}  {args.takes} takes  {time.time() - started:6.1f}s", flush=True)


def rerender(args):
    import glob
    import numpy as np
    catalogued = {t['file'] for t in json.load(open(os.path.join(args.rerender, 'catalogue.json')))['takes']}
    jobs = []
    for wav in sorted(glob.glob(os.path.join(OUT, '*', 'take-*.wav'))):
        folder = os.path.basename(os.path.dirname(wav))
        if f"{folder.lower()}/{os.path.basename(wav)[:-4]}.ogg" not in catalogued or sf.info(wav).subtype == 'FLOAT':
            continue
        if (np.abs(sf.read(wav)[0]) >= 0.9999).sum() > 2:
            jobs.append(wav)
    print(f'{len(jobs)} clipped takes to render again', flush=True)
    pipe = load_pipe(args)
    rate = pipe.vae.sampling_rate
    started = time.time()
    for n, wav in enumerate(jobs, 1):
        meta = json.load(open(wav[:-4] + '.json'))
        args.steps, args.cfg = meta['steps'], meta['cfg']
        audio = render(pipe, meta['prompt'], meta['seed'], {'id': meta['id']}, args, meta['negative'], meta['seconds'])
        save(wav[:-4], audio, rate)
        print(f'{n}/{len(jobs)}  {wav}  {time.time() - started:6.1f}s', flush=True)


def load_pipe(args):
    pipe = StableAudioPipeline.from_pretrained(MODEL, torch_dtype=torch.float16)
    if args.offload == 'model':
        pipe.enable_model_cpu_offload()
    elif args.offload == 'sequential':
        pipe.enable_sequential_cpu_offload()
    else:
        pipe.to('cuda')
    return pipe


def run_variants(args):
    """Round 2: each sound gets several different prompts, `--takes` seeds each."""
    spec = json.load(open(args.variants))
    suffix = spec['suffix']
    jobs = []  # (folder, sound id, prompts, seconds, music allowed)
    for sid, prompts in spec['sounds'].items():
        jobs.append((f'{sid}.r2', sid, prompts, 2.0, False))
    for sid, prompts in spec['moments'].items():
        jobs.append((f'{sid}.r2', sid, prompts, 1.0, sid in spec.get('music_ok', [])))
    for sid, prompts in spec['lands'].items():
        jobs.append((sid, sid, prompts, 1.5, False))
    if args.only:
        want = set(args.only.split(','))
        jobs = [j for j in jobs if j[1] in want]
    pipe = load_pipe(args)
    rate = pipe.vae.sampling_rate
    started = time.time()
    for folder, sid, prompts, seconds, music_ok in jobs:
        os.makedirs(os.path.join(OUT, folder), exist_ok=True)
        negative = NEGATIVE.replace('music, melody, song, ', '') if music_ok else NEGATIVE
        if args.avoid:
            negative += ', ' + args.avoid
        for k, text in enumerate(prompts):
            prompt = f'{text} {suffix}'
            for j in range(args.takes):
                seed = args.seed + j
                base = os.path.join(OUT, folder, f'take-v{k + 1}-{seed}')
                if os.path.exists(base + '.wav'):
                    continue
                audio = render(pipe, prompt, seed, {'id': sid}, args, negative, seconds)
                save(base, audio, rate)
                json.dump({'id': sid, 'variant': k + 1, 'prompt': prompt, 'negative': negative, 'seed': seed,
                           'steps': args.steps, 'cfg': args.cfg, 'seconds': seconds, 'model': MODEL,
                           'licence': 'Stability AI Community License (stable-audio-open-1.0 LICENSE.md)'},
                          open(base + '.json', 'w'), indent=1)
        print(f'{folder:>14}  {len(prompts)} prompts x {args.takes}  {time.time() - started:6.1f}s', flush=True)


def run_spec(args):
    """Round 3: one folder per named sound, prompts written as literal source + action + recording
    descriptors, generated long (spec `seconds`) and trimmed by finish.py."""
    spec = json.load(open(args.spec))
    jobs = list(spec['sounds'].items())
    if args.only:
        want = set(args.only.split(','))
        jobs = [j for j in jobs if j[0] in want]
    pipe = load_pipe(args)
    rate = pipe.vae.sampling_rate
    started = time.time()
    for folder, sound in jobs:
        os.makedirs(os.path.join(OUT, folder), exist_ok=True)
        negative = spec['negative']
        if sound.get('music'):
            negative = negative.replace('music, melody, ', '')
        for k, text in enumerate(sound['prompts']):
            # A sibling (round 8) is a chosen take's own render settings, verbatim, under new seeds.
            sibling = text if isinstance(text, dict) else {}
            prompt = sibling.get('prompt') or f"{text}. {spec['suffix']}"
            seconds = sibling.get('seconds') or sound.get('seconds', spec['seconds'])
            steps, cfg = sibling.get('steps', args.steps), sibling.get('cfg', args.cfg)
            args.steps, args.cfg = steps, cfg
            for j in range(sibling.get('takes', args.takes)):
                seed = args.seed + j
                base = os.path.join(OUT, folder, f'take-v{k + 1}-{seed}')
                if os.path.exists(base + '.wav'):
                    continue
                audio = render(pipe, prompt, seed, {'id': folder}, args, sibling.get('negative', negative), seconds)
                if sibling.get('reverse'):
                    audio = audio.flip(-1)  # the chosen take was the reversed render (Untap is Tap backwards)
                save(base, audio, rate)
                json.dump({'id': folder, 'name': sound['name'], 'group': sound['group'], 'variant': k + 1,
                           'prompt': prompt, 'negative': sibling.get('negative', negative), 'seed': seed, 'steps': steps,
                           'cfg': cfg, 'seconds': seconds, 'model': MODEL, 'reverse': bool(sibling.get('reverse')),
                           'licence': 'Stability AI Community License (stable-audio-open-1.0 LICENSE.md)'},
                          open(base + '.json', 'w'), indent=1)
        print(f'{folder:>18}  {len(sound["prompts"])} prompts x {args.takes}  {time.time() - started:6.1f}s', flush=True)


if __name__ == '__main__':
    main()
