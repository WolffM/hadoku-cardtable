#!/usr/bin/env python3
"""Build long, seamless ambience loops from Stable Audio Open beds and scattered events, with an optional music layer.

    ~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/music-soundscape.py --spec scripts/sfx/music-round2.json [--only g-,wu-hall]

The operator on round 1: "tavern had too much music, not enough ambiance", "tidewatch had too much repetitive
water". Stable Audio Open renders 47 s at most, so a soundscape is assembled rather than rendered:

- A bed is a chain of different renders of one prompt (different seeds), overlapped with equal-power fades and
  wrapped circularly onto the loop length, so the end flows into the start and no stretch of it repeats inside one
  loop. Several beds (forest air, a stream) run as independent chains.
- An event (a blackbird phrase, an owl, a door far off in a hall) has four renders, each trimmed to its active
  part; a near-empty render is dropped, and a call is levelled by loudness but its peak
  never stands more than 14 dB over that level (round 2's first dusk came out at -35 LUFS around one spike).
  Everything is high-passed at 70 Hz. Occurrences land at random intervals (exponential, mean `every` seconds, never closer than 40 % of it),
  each a random variant (never the same one twice running) with ±3 dB of level and a random pan, wrapped
  circularly too. The pattern is fixed per soundscape id, so a rebuild is identical.
- `music` lays a finished, already looping take (`music-finish.py`, `finished/<colour>/<take>.wav`) on top; the
  soundscape then takes the music's length so the two wrap together.

Levels are relative: every bed render, event and the music is set to its `db` over a common reference (by
integrated loudness, each bed render on its own, with the peak cap above; beds may peak 18 dB over); the sum is then levelled like every music take (−18 LUFS, −1 dBTP, never
limited) and measured by `music-finish.py`. Renders are cached under `~/.local/share/cardtable-sfx/music/elements/`
with a sidecar each; output goes to `finished/<colour>/<id>.wav` with a `.json` (every prompt, seed and gain) and a
spectrogram. Stable Audio Open weights: Stability AI Community Licence (free below $1M revenue; this app has none).
"""
import argparse
import hashlib
import importlib.util
import json
import os
import random

# music-finish.py caps the BLAS threads before numpy loads, so it is loaded first.
HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('music_finish', os.path.join(HERE, 'music-finish.py'))
finish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(finish)

import numpy as np
import pyloudnorm
import soundfile as sf
import torch
from scipy import signal

ROOT = finish.ROOT
RATE = finish.RATE
ELEMENTS = os.path.join(ROOT, 'elements')
COLOUR_DIR = {'W': 'white', 'U': 'blue', 'B': 'black', 'R': 'red', 'G': 'green'}
NEGATIVE = 'music, melody, song, speech, singing, low quality, muffled, clipping, distortion, hum, silence, bells, chimes'
BED_SECONDS = 47.0
EVENT_SECONDS = 10.0
VARIANTS = 4
BED_OVERLAP = 4.0
HIGH_PASS_HZ = 70
EVENT_CREST_DB = 14
BED_CREST_DB = 18
REF_LUFS = -30.0


class Renderer:
	def __init__(self, steps: int, cfg: float):
		self.steps, self.cfg, self.pipe = steps, cfg, None

	def __call__(self, prompt: str, seed: int, seconds: float, negative: str) -> np.ndarray:
		key = hashlib.sha1(json.dumps([prompt, seed, seconds, negative, self.steps, self.cfg]).encode()).hexdigest()[:16]
		path = os.path.join(ELEMENTS, key + '.wav')
		if not os.path.exists(path):
			if self.pipe is None:
				from diffusers import StableAudioPipeline
				self.pipe = StableAudioPipeline.from_pretrained('stabilityai/stable-audio-open-1.0', torch_dtype=torch.float16)
				self.pipe.enable_model_cpu_offload()
			audio = self.pipe(prompt, negative_prompt=negative, num_inference_steps=self.steps, guidance_scale=self.cfg,
				audio_end_in_s=seconds, num_waveforms_per_prompt=1, generator=torch.Generator('cpu').manual_seed(seed)).audios[0]
			os.makedirs(ELEMENTS, exist_ok=True)
			wave = audio.T.float().cpu().numpy()
			sf.write(path, wave, self.pipe.vae.sampling_rate, subtype='FLOAT')
			json.dump({'model': 'stabilityai/stable-audio-open-1.0', 'prompt': prompt, 'negative': negative, 'seed': seed,
				'seconds': seconds, 'steps': self.steps, 'cfg': self.cfg, 'peak': float(np.abs(wave).max())},
				open(path[:-4] + '.json', 'w', encoding='utf-8'), indent=1)
			print(f'  rendered {key}: {prompt[:60]}… seed {seed}', flush=True)
		x, rate = sf.read(path, dtype='float64', always_2d=True)
		x = signal.resample_poly(x, RATE // 100, rate // 100, axis=0) if rate != RATE else x
		# Stable Audio's field recordings carry wind rumble: round 2's first forest had 67 % of its energy under 60 Hz.
		return signal.sosfiltfilt(signal.butter(4, HIGH_PASS_HZ, 'highpass', fs=RATE, output='sos'), x, axis=0)


def loudness(x: np.ndarray, meter: pyloudnorm.Meter) -> float:
	lufs = meter.integrated_loudness(x)
	return lufs if np.isfinite(lufs) else -70.0


def peak_db(x: np.ndarray) -> float:
	return float(20 * np.log10(np.abs(x).max() + 1e-12))


def levelled(x: np.ndarray, target: float, crest: float, meter: pyloudnorm.Meter) -> np.ndarray:
	"""`x` at `target` LUFS, unless that would put its peak more than `crest` dB over the target."""
	return x * 10 ** (min(target - loudness(x, meter), target + crest - peak_db(x)) / 20)


def bed_chain(segments: list[np.ndarray], length: int) -> np.ndarray:
	"""Segments laid end to end with equal-power overlaps, wrapped onto `length` samples so the end meets the start."""
	seg = min(len(s) for s in segments)
	n = max(1, int(np.ceil(length / (seg - BED_OVERLAP * RATE))))
	period = length / n
	overlap = int(seg - period)
	t = np.linspace(0, np.pi / 2, overlap)[:, None]
	out = np.zeros((length, 2))
	for k in range(n):
		piece = segments[k % len(segments)][:seg].copy()
		piece[:overlap] *= np.sin(t)
		piece[-overlap:] *= np.cos(t)
		idx = (int(round(k * period)) + np.arange(seg)) % length
		np.add.at(out, idx, piece)
	return out


def trim_event(x: np.ndarray) -> np.ndarray:
	"""The active part of a render: from 0.2 s before the first 50 ms window within 30 dB of the loudest to 0.5 s
	after the last, at most 8 s, with short fades."""
	m = x.mean(axis=1)
	hop = int(0.05 * RATE)
	blocks = len(m) // hop
	rms = 20 * np.log10(np.sqrt((m[:blocks * hop] ** 2).reshape(blocks, hop).mean(axis=1)) + 1e-12)
	active = np.flatnonzero(rms > rms.max() - 30)
	a = max(0, active[0] * hop - int(0.2 * RATE))
	b = min(len(x), (active[-1] + 1) * hop + int(0.5 * RATE), a + 8 * RATE)
	y = x[a:b].copy()
	fade_in, fade_out = min(int(0.05 * RATE), len(y) // 4), min(int(0.4 * RATE), len(y) // 3)
	y[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
	y[-fade_out:] *= np.linspace(1, 0, fade_out)[:, None]
	return y


def place_events(rng: random.Random, every: float, length: int) -> list[int]:
	times, t = [], rng.uniform(0, every)
	while t < length / RATE:
		times.append(int(t * RATE))
		t += max(every * 0.4, rng.expovariate(1 / every))
	return times


def build(sc: dict, index: int, args, render: Renderer, meter: pyloudnorm.Meter) -> dict:
	rng = random.Random(sc['id'])
	base = args.seed + 1000 * index
	music = None
	if sc.get('music'):
		path = os.path.join(ROOT, 'finished', COLOUR_DIR.get(sc['colour'], sc['colour'].lower()), sc['music']['take'] + '.wav')
		music, _ = sf.read(path, dtype='float64', always_2d=True)
	length = len(music) if music is not None else int(sc['seconds'] * RATE)
	mix = np.zeros((length, 2))
	layers = []
	for b, bed in enumerate(sc['beds']):
		seeds = [base + 100 * b + k for k in range(int(np.ceil(length / RATE / (BED_SECONDS - BED_OVERLAP))) + 1)]
		# Each render on its own: one prompt's renders spanned -40 to -15 LUFS (round 2's dusk crickets), and
		# a chain levelled as a whole turned the quiet ones into holes.
		segments = [levelled(render(bed['prompt'], s, BED_SECONDS, NEGATIVE), REF_LUFS + bed['db'], BED_CREST_DB, meter)
			for s in seeds]
		mix += bed_chain(segments, length)
		layers.append({'kind': 'bed', 'prompt': bed['prompt'], 'seeds': seeds, 'db': bed['db']})
	for e, ev in enumerate(sc['events']):
		negative = NEGATIVE.replace(', bells, chimes', '') if ev.get('bell') else NEGATIVE
		seeds = [base + 500 + 10 * e + k for k in range(VARIANTS)]
		variants, levels, peaks, used = [], [], [], []
		for s in seeds:
			v = trim_event(render(ev['prompt'], s, EVENT_SECONDS, negative))
			lufs, peak = loudness(v, meter), peak_db(v)
			# A near-empty render is dropped; a spiky one (a rustle at -26 LUFS peaking at +2 dBFS, footsteps) stays,
			# held down by the peak cap below.
			if lufs > -45:
				variants.append(v)
				levels.append(lufs)
				peaks.append(peak)
				used.append(s)
		if not variants:
			raise SystemExit(f"{sc['id']}: every render of {ev['prompt']!r} was empty")
		times = place_events(rng, ev['every'], length)
		last = -1
		for t in times:
			v = rng.choice([i for i in range(len(variants)) if i != last] or [0])
			last = v
			pan = rng.uniform(-0.6, 0.6)
			gains = np.array([np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)]) * np.sqrt(2)
			target = REF_LUFS + ev['db'] + rng.uniform(-3, 3)
			# Level by loudness, but never let the call's peak stand more than EVENT_CREST_DB over that level.
			g = 10 ** (min(target - levels[v], target + EVENT_CREST_DB - peaks[v]) / 20)
			idx = (t + np.arange(len(variants[v]))) % length
			np.add.at(mix, idx, variants[v] * g * gains)
		layers.append({'kind': 'event', 'prompt': ev['prompt'], 'seeds': used, 'db': ev['db'], 'every': ev['every'],
			'count': len(times), 'negative': negative})
	if music is not None:
		mix += music * 10 ** ((REF_LUFS + sc['music']['db'] - loudness(music, meter)) / 20)
		layers.append({'kind': 'music', 'take': sc['music']['take'], 'db': sc['music']['db']})
	y, lufs, tp = finish.level(mix, meter)
	row = {'file': sc['id'], 'id': sc['id'], 'colour': sc['colour'], 'name': sc['name'], 'lufs': round(lufs, 2),
		'true_peak_dbtp': round(tp, 2), **finish.measure(y, None), 'layers': layers,
		'licence': 'Stable Audio Open 1.0: Stability AI Community Licence; music layer: ACE-Step 1.5 (MIT)'}
	out_dir = os.path.join(ROOT, 'finished', COLOUR_DIR.get(sc['colour'], sc['colour'].lower()))
	os.makedirs(out_dir, exist_ok=True)
	sf.write(os.path.join(out_dir, sc['id'] + '.wav'), y.astype(np.float32), RATE, subtype='FLOAT')
	finish.spectrogram(y, os.path.join(out_dir, sc['id'] + '.png'), f"{sc['name']} — {row['seconds']} s loop")
	json.dump(row, open(os.path.join(out_dir, sc['id'] + '.json'), 'w', encoding='utf-8'), indent=1)
	return row


def main() -> None:
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument('--spec', required=True)
	ap.add_argument('--only', default='', help='comma-separated soundscape-id prefixes')
	ap.add_argument('--seed', type=int, default=40000)
	ap.add_argument('--steps', type=int, default=150)
	ap.add_argument('--cfg', type=float, default=7.0)
	ap.add_argument('--report', default='')
	args = ap.parse_args()
	spec = json.load(open(args.spec, encoding='utf-8'))
	only = [o for o in args.only.split(',') if o]
	render = Renderer(args.steps, args.cfg)
	meter = pyloudnorm.Meter(RATE)
	rows = []
	for i, sc in enumerate(spec['soundscapes']):
		if only and not any(sc['id'].startswith(o) for o in only):
			continue
		row = build(sc, i, args, render, meter)
		print(json.dumps({k: v for k, v in row.items() if k != 'layers'}), flush=True)
		rows.append(row)
	if args.report:
		json.dump(rows, open(args.report, 'w', encoding='utf-8'), indent=1)


if __name__ == '__main__':
	main()
