#!/usr/bin/env python3
"""Render the ambience beds a music spec asks for (`"bed"` on a prompt) with Stable Audio Open 1.0.

    ~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/music-beds.py --spec scripts/sfx/music-round1.json

One 47 s field recording per prompt, saved as 32-bit float at
`~/.local/share/cardtable-sfx/music/generated/<colour>/<id>-bed.wav` with a sidecar. `music-finish.py` tiles it
under the take, seamlessly, as a second candidate. Stable Audio Open's weights are under the Stability AI
Community Licence (free below $1M revenue; this app has none).
"""
import argparse
import json
import os

import soundfile as sf
import torch

OUT_ROOT = os.path.expanduser('~/.local/share/cardtable-sfx/music/generated')
COLOUR_DIR = {'W': 'white', 'U': 'blue', 'B': 'black', 'R': 'red', 'G': 'green'}
NEGATIVE = 'music, melody, song, speech, voice, vocals, singing, low quality, muffled, clipping, distortion, hum, silence, bells, chimes'


def main() -> None:
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument('--spec', required=True)
	ap.add_argument('--seed', type=int, default=21000)
	ap.add_argument('--steps', type=int, default=150)
	ap.add_argument('--cfg', type=float, default=7.0)
	args = ap.parse_args()
	from diffusers import StableAudioPipeline

	spec = json.load(open(args.spec, encoding='utf-8'))
	todo = []
	for i, p in enumerate(spec['prompts']):
		if p.get('bed'):
			out = os.path.join(OUT_ROOT, COLOUR_DIR[p['colour']], f"{p['id']}-bed.wav")
			if not os.path.exists(out):
				todo.append((p, args.seed + i, out))
	if not todo:
		print('nothing to do')
		return
	pipe = StableAudioPipeline.from_pretrained('stabilityai/stable-audio-open-1.0', torch_dtype=torch.float16)
	pipe.enable_model_cpu_offload()
	for p, seed, out in todo:
		os.makedirs(os.path.dirname(out), exist_ok=True)
		audio = pipe(p['bed'], negative_prompt=NEGATIVE, num_inference_steps=args.steps, guidance_scale=args.cfg,
			audio_end_in_s=47.0, num_waveforms_per_prompt=1, generator=torch.Generator('cpu').manual_seed(seed)).audios[0]
		wave = audio.T.float().cpu().numpy()
		sf.write(out, wave, pipe.vae.sampling_rate, subtype='FLOAT')
		json.dump({'model': 'stabilityai/stable-audio-open-1.0', 'licence': 'Stability AI Community Licence',
			'id': p['id'], 'prompt': p['bed'], 'negative': NEGATIVE, 'seed': seed, 'steps': args.steps, 'cfg': args.cfg,
			'seconds': 47.0, 'peak': float(abs(wave).max())}, open(out[:-4] + '.json', 'w', encoding='utf-8'), indent=1)
		print(f'{out}: peak {abs(wave).max():.3f}', flush=True)


if __name__ == '__main__':
	main()
