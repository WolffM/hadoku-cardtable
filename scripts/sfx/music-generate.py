#!/usr/bin/env python3
"""Generate match-music candidates with ACE-Step 1.5 (local, MIT weights).

    ACESTEP_CHECKPOINTS_DIR=~/.cache/ace-step/checkpoints \\
    ~/.local/opt/ace-step-1.5/.venv/bin/python scripts/sfx/music-generate.py \\
        --spec scripts/sfx/music-round1.json [--only g-,w-flutes] [--seed 20000] [--model acestep-v15-xl-sft]

Each take is written as 32-bit float WAV (never 16-bit: a raw take that overshoots full scale must not be
hard-clipped on save) with ACE-Step's own loudness normalisation off, so `music-finish.py` sees the raw
render, plus a `.json` sidecar holding everything needed to render it again: model, version, prompt, seed,
steps, cfg, shift, duration, licence. Output: `~/.local/share/cardtable-sfx/music/generated/<colour>/`.
A rerun resumes (existing takes are skipped). The GPU is shared: an out-of-memory take waits 30 s and retries.
"""
import argparse
import json
import os
import subprocess
import sys
import time

import soundfile as sf
import torch

ACE_ROOT = os.path.expanduser('~/.local/opt/ace-step-1.5')
OUT_ROOT = os.path.expanduser('~/.local/share/cardtable-sfx/music/generated')
LICENCE = 'ACE-Step 1.5 code MIT, weights MIT (huggingface.co/ACE-Step); output is ours, no attribution required'
COLOUR_DIR = {'W': 'white', 'U': 'blue', 'B': 'black', 'R': 'red', 'G': 'green'}


def colour_dir(colour: str) -> str:
	return COLOUR_DIR.get(colour, colour.lower())


def ace_version() -> str:
	return subprocess.run(['git', '-C', ACE_ROOT, 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()


def main() -> None:
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument('--spec', required=True)
	ap.add_argument('--only', default='', help='comma-separated prompt-id prefixes')
	ap.add_argument('--seed', type=int, default=20000, help='seed of the first take of the first prompt')
	ap.add_argument('--takes', type=int, default=0, help='override every prompt\'s take count')
	ap.add_argument('--model', default='acestep-v15-xl-sft')
	ap.add_argument('--lm', default='acestep-5Hz-lm-1.7B')
	ap.add_argument('--offload', action='store_true', help='keep idle components on the CPU')
	args = ap.parse_args()

	sys.path.insert(0, ACE_ROOT)
	from acestep.handler import AceStepHandler
	from acestep.inference import GenerationConfig, GenerationParams, generate_music
	from acestep.llm_inference import LLMHandler

	spec = json.load(open(args.spec, encoding='utf-8'))
	defaults = spec['defaults']
	only = [p for p in args.only.split(',') if p]
	prompts = [p for p in spec['prompts'] if not only or any(p['id'].startswith(o) for o in only)]
	# Seeds are fixed by position in the whole spec, so --only does not move them.
	seed_of = {}
	n = args.seed
	for p in spec['prompts']:
		seed_of[p['id']] = n
		n += 100

	todo = []
	for p in prompts:
		for t in range(args.takes or p.get('takes', 1)):
			out = os.path.join(OUT_ROOT, colour_dir(p['colour']), f"{p['id']}-{t + 1}.wav")
			if not os.path.exists(out):
				todo.append((p, t, out))
	if not todo:
		print('nothing to do')
		return

	ckpt = os.environ.get('ACESTEP_CHECKPOINTS_DIR') or os.path.expanduser('~/.cache/ace-step/checkpoints')
	os.environ['ACESTEP_CHECKPOINTS_DIR'] = ckpt
	dit = AceStepHandler()
	status, ok = dit.initialize_service(project_root=ACE_ROOT, config_path=args.model, device='cuda',
		offload_to_cpu=args.offload, offload_dit_to_cpu=False)
	if not ok:
		raise SystemExit(f'DiT init failed: {status}')
	llm = LLMHandler()
	status, ok = llm.initialize(checkpoint_dir=ckpt, lm_model_path=args.lm, backend='pt', device='cuda', offload_to_cpu=args.offload)
	if not ok:
		raise SystemExit(f'LM init failed: {status}')
	version = ace_version()

	for p, t, out in todo:
		os.makedirs(os.path.dirname(out), exist_ok=True)
		seed = seed_of[p['id']] + t
		duration = p.get('duration', defaults['duration'])
		steps = p.get('steps', defaults['steps'])
		cfg = p.get('cfg', defaults['cfg'])
		shift = p.get('shift', defaults['shift'])
		params = GenerationParams(
			task_type='text2music', caption=p['caption'], lyrics=p.get('structure', '[Instrumental]'), instrumental=True,
			bpm=p.get('bpm'), keyscale=p.get('key', ''), timesignature=p.get('meter', ''), duration=duration,
			inference_steps=steps, guidance_scale=cfg, shift=shift, seed=seed, thinking=True,
			use_cot_metas=False, use_cot_caption=False, use_cot_language=False, enable_normalization=False,
		)
		config = GenerationConfig(batch_size=1, use_random_seed=False, seeds=[seed], audio_format='wav32')
		for attempt in range(6):
			started = time.time()
			try:
				result = generate_music(dit, llm, params, config, save_dir=os.path.join(os.path.dirname(out), '.ace'))
			except torch.cuda.OutOfMemoryError:
				torch.cuda.empty_cache()
				print(f'{p["id"]}-{t + 1}: out of memory, retrying in 30 s', flush=True)
				time.sleep(30)
				continue
			if result.success:
				break
			if 'out of memory' in str(result.error).lower():
				torch.cuda.empty_cache()
				print(f'{p["id"]}-{t + 1}: out of memory, retrying in 30 s', flush=True)
				time.sleep(30)
				continue
			raise SystemExit(f'{p["id"]}-{t + 1}: {result.error}')
		else:
			raise SystemExit(f'{p["id"]}-{t + 1}: out of memory six times')
		audio = result.audios[0]
		wave = audio['tensor'].numpy().T
		sf.write(out, wave, audio.get('sample_rate', 48000), subtype='FLOAT')
		if audio.get('path') and os.path.exists(audio['path']):
			os.remove(audio['path'])
		sidecar = {
			'model': f'ACE-Step 1.5 {args.model} + {args.lm}', 'version': version, 'licence': LICENCE,
			'id': p['id'], 'colour': p['colour'], 'direction': p.get('direction'), 'name': p['name'],
			'caption': p['caption'], 'structure': p.get('structure'), 'bpm': p.get('bpm'), 'key': p.get('key'),
			'meter': p.get('meter'), 'seed': seed, 'steps': steps, 'cfg': cfg, 'shift': shift, 'duration': duration,
			'seconds_to_render': round(time.time() - started, 1), 'peak': float(abs(wave).max()),
		}
		json.dump(sidecar, open(out[:-4] + '.json', 'w', encoding='utf-8'), indent=1)
		print(f'{out}: {len(wave) / 48000:.0f}s peak {sidecar["peak"]:.3f} in {sidecar["seconds_to_render"]}s', flush=True)


if __name__ == '__main__':
	main()
