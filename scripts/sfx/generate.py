"""Generate candidate sound effects with Stable Audio Open on the local GPU.

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


def prompt_for(s):
    if s['kind'] == 'moment':
        return f"{s['vibe']} Short game sound effect for a card game: {s['name'].lower()}. Clean, dry, close, one shot."
    return f"{s['vibe']} Fantasy card game spell cast sound effect, one shot, crisp attack, short clean tail, high quality."


def seconds_for(s):
    return 1.0 if s['kind'] == 'moment' else 2.0


def render(pipe, prompt, seed, s, args, negative):
    """One take. Out of memory means a neighbour on the shared GPU is busy: wait and try again."""
    for attempt in range(40):
        try:
            return pipe(
                prompt,
                negative_prompt=negative,
                num_inference_steps=args.steps,
                guidance_scale=args.cfg,
                audio_end_in_s=seconds_for(s),
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
    ap.add_argument('--avoid', default='', help='extra negative prompt for this run, e.g. "bells, chimes, harsh, metallic"')
    ap.add_argument('--offload', choices=['none', 'model', 'sequential'], default='none',
                    help='the GPU is shared (InvokeAI, other projects): model ~4 GB of VRAM, sequential ~1 GB and slowest')
    args = ap.parse_args()

    sounds = json.load(open(os.path.join(HERE, 'prompts.json')))['sounds']
    if args.vibes:
        overrides = json.load(open(args.vibes))
        for s in sounds:
            if overrides.get(s['id'], '').strip():
                s['vibe'] = overrides[s['id']].strip()
    if args.only:
        want = set(args.only.split(','))
        sounds = [s for s in sounds if s['id'] in want]
        missing = want - {s['id'] for s in sounds}
        if missing:
            sys.exit(f'unknown ids: {sorted(missing)}')

    pipe = StableAudioPipeline.from_pretrained(MODEL, torch_dtype=torch.float16)
    if args.offload == 'model':
        pipe.enable_model_cpu_offload()
    elif args.offload == 'sequential':
        pipe.enable_sequential_cpu_offload()
    else:
        pipe.to('cuda')
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
            sf.write(base + '.wav', audio.T.float().cpu().numpy(), rate)
            json.dump({
                'id': s['id'], 'name': s['name'], 'prompt': prompt, 'negative': negative, 'seed': seed,
                'steps': args.steps, 'cfg': args.cfg, 'seconds': seconds_for(s), 'model': MODEL,
                'licence': 'Stability AI Community License (stable-audio-open-1.0 LICENSE.md)',
            }, open(base + '.json', 'w'), indent=1)
        print(f"{s['id']:>8}  {args.takes} takes  {time.time() - started:6.1f}s", flush=True)


if __name__ == '__main__':
    main()
