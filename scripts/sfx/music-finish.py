#!/usr/bin/env python3
"""Cut generated match music into seamless loops, level it, and measure it.

    ~/.local/opt/ace-step-1.5/.venv/bin/python scripts/sfx/music-finish.py [--only g-,b-crypt] [--report out.json]

Reads `~/.local/share/cardtable-sfx/music/generated/<colour>/<id>-<n>.wav` (32-bit float, as rendered) and writes
`~/.local/share/cardtable-sfx/music/finished/<colour>/<id>-<n>.wav` (float), a spectrogram `.png` beside it and
a `.json` of measurements. When `<id>-bed.wav` exists, a second cut `<id>-<n>-bed.wav` lays it underneath.

The loop. The builder's player loops a whole file sample-accurately (an `AudioBufferSourceNode` with `loop`), so
each file is a loop body that plays straight back into its own start. A loop start S is looked for 4–40 s in
(after the intro) and a loop end E in the last 40 %, at least 8 s before the end (before any outro fade).
Candidates are the pairs whose following 6 s sound most alike (cosine similarity of log-mel frames, 85 ms hop,
summed along the diagonal); for each of the best 30, S is snapped to the strongest onset within a beat and E
refined to the onset-envelope lag that best matches S's (±150 ms), then to the waveform lag (±5 ms). The pick is
the best-matching candidate whose seam is a smaller jump than 70 % of the take's own moments. The body is x[S:E], its
first 0.75 s crossfaded with x[E:E+0.75 s]: it ends on x[E-1] and wraps into x[E] in all but name. The intro and
the outro are cut off.

The level: −18 LUFS integrated (BS.1770, pyloudnorm), then turned down, never limited, until the 4× oversampled
true peak is at most −1 dBTP. Raw clipping is counted before anything else (samples at |x| ≥ 0.9999 in the render).
"""
import argparse
import glob
import json
import os

# Two BLAS threads: on a loaded host (CI's vitest beside the GPU job) a thread per core spun a 10 s take to 5 min.
for _var in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
	os.environ.setdefault(_var, '2')

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pyloudnorm
import soundfile as sf
from scipy import signal

ROOT = os.path.expanduser('~/.local/share/cardtable-sfx/music')
RATE = 48000
TARGET_LUFS = -18.0
CEILING_DBTP = -1.0
XFADE = 0.75
HOP = 4096
BED_UNDER_DB = 14.0


def mono(x: np.ndarray) -> np.ndarray:
	return x.mean(axis=1) if x.ndim == 2 else x


def stft_mag(m: np.ndarray, hop: int, n: int) -> np.ndarray:
	_, _, z = signal.stft(m, fs=RATE, nperseg=n, noverlap=n - hop, boundary=None, padded=False)
	return np.abs(z)


def mel_bank(n_fft: int, bands: int = 64) -> np.ndarray:
	def hz2mel(f):
		return 2595 * np.log10(1 + f / 700)
	edges = 700 * (10 ** (np.linspace(hz2mel(30), hz2mel(16000), bands + 2) / 2595) - 1)
	freqs = np.linspace(0, RATE / 2, n_fft // 2 + 1)
	bank = np.zeros((bands, len(freqs)))
	for b in range(bands):
		lo, mid, hi = edges[b:b + 3]
		bank[b] = np.clip(np.minimum((freqs - lo) / (mid - lo), (hi - freqs) / (hi - mid)), 0, None)
	return bank


def onset_env(m: np.ndarray, hop: int = 512) -> np.ndarray:
	mag = stft_mag(m, hop, 2048)
	logm = np.log1p(100 * (mel_bank(2048) @ mag))
	flux = np.maximum(np.diff(logm, axis=1), 0).sum(axis=0)
	return np.concatenate([[0], flux])


def tempo(env: np.ndarray, hop: int = 512, hint: float | None = None) -> float:
	"""Beats per minute from the onset envelope's autocorrelation, 50–220 BPM, weighted toward 120 (or the hint)."""
	e = env - env.mean()
	ac = np.correlate(e, e, 'full')[len(e) - 1:]
	fps = RATE / hop
	lags = np.arange(int(fps * 60 / 220), int(fps * 60 / 50))
	bpm = 60 * fps / lags
	centre = hint or 120
	weight = np.exp(-0.5 * (np.log2(bpm / centre) / 0.9) ** 2)
	return float(bpm[np.argmax(ac[lags] * weight)])


def find_loop(x: np.ndarray, bpm_hint: float | None) -> tuple[int, int, float]:
	m = mono(x)
	n = len(m)
	mag = stft_mag(m, HOP, 8192)
	feats = np.log1p(100 * (mel_bank(8192) @ mag)).T
	feats = feats - feats.mean(axis=0)
	feats /= np.linalg.norm(feats, axis=1, keepdims=True) + 1e-9
	fr = RATE / HOP
	win = int(6 * fr)
	s0, s1 = int(4 * fr), int(40 * fr)
	e0, e1 = int((n / RATE) * 0.6 * fr), int((n / RATE - 8 - XFADE) * fr) - win
	e0 = max(e0, s1 + int(90 * fr))
	if e1 <= e0:
		raise ValueError('too short to loop')
	a = feats[s0:s1 + win]
	b = feats[e0:e1 + win]
	sim = a @ b.T
	score = np.zeros((s1 - s0, e1 - e0))
	for k in range(win):
		score += sim[k:k + s1 - s0, k:k + e1 - e0]
	score /= win
	# The 30 best-matching (S, E) pairs at least 2 s apart, each refined; keep the best-matching one whose seam
	# is no bigger a jump than 70 % of the take's own moments (the bare best match put 6 of the first 14 pair
	# takes' seams above their 90th percentile), else the smallest seam.
	env = onset_env(m)
	beat = 60 / (bpm_hint or tempo(env)) * RATE
	music_novelty = novelty(m)
	order = np.argsort(score, axis=None)[::-1]
	taken: list[tuple[int, int]] = []
	candidates = []
	for flat in order:
		i, j = np.unravel_index(flat, score.shape)
		if any(abs(i - ti) < 2 * fr and abs(j - tj) < 2 * fr for ti, tj in taken):
			continue
		taken.append((i, j))
		s, e = refine(m, env, beat, (s0 + i) * HOP, (e0 + j) * HOP)
		candidates.append((float(score[i, j]), seam_percentile(m, s, e, music_novelty), s, e))
		if len(taken) == 30:
			break
	smooth = [c for c in candidates if c[1] < 70]
	sim, _, s, e = max(smooth) if smooth else min(candidates, key=lambda c: c[1])
	return s, e, sim


def refine(m: np.ndarray, env: np.ndarray, beat: float, s: int, e: int) -> tuple[int, int]:
	"""Snap S to the strongest onset within a beat (E keeps its offset), then refine E on the onset envelope
	(±150 ms over 4 s) and on the waveform (±5 ms over 200 ms)."""
	lo, hi = int((s - beat / 2) / 512), int((s + beat / 2) / 512)
	snapped = (lo + int(np.argmax(env[lo:hi]))) * 512
	e += snapped - s
	s = snapped
	span = int(4 * RATE / 512)
	ref = env[s // 512:s // 512 + span]
	best, lag = -np.inf, 0
	for d in range(-int(0.15 * RATE / 512), int(0.15 * RATE / 512) + 1):
		cand = env[e // 512 + d:e // 512 + d + span]
		c = float(np.dot(ref - ref.mean(), cand - cand.mean()))
		if c > best:
			best, lag = c, d
	e += lag * 512
	w = int(0.2 * RATE)
	ref = m[s:s + w]
	best, lag = -np.inf, 0
	for d in range(-int(0.005 * RATE), int(0.005 * RATE) + 1):
		c = float(np.dot(ref, m[e + d:e + d + w]))
		if c > best:
			best, lag = c, d
	return s, e + lag


NOVELTY_K = int(0.5 * RATE / 2048)


def novelty(m: np.ndarray) -> np.ndarray:
	"""Log-mel distance between the 0.5 s before and the 0.5 s after each point (2048-sample hop)."""
	mel = np.log1p(100 * (mel_bank(4096) @ stft_mag(m, 2048, 4096))).T
	return np.linalg.norm(mel[2 * NOVELTY_K:] - mel[:-2 * NOVELTY_K], axis=1)


def seam_percentile(m: np.ndarray, s: int, e: int, music_novelty: np.ndarray) -> float:
	"""The novelty across the wrap of the loop x[S:E], as a percentile of the take's own."""
	xf = int(XFADE * RATE)
	ramp = np.linspace(0, 1, xf)
	head = m[s:s + RATE].copy()
	head[:xf] = m[s:s + xf] * ramp + m[e:e + xf] * (1 - ramp)
	wrap = novelty(np.concatenate([m[e - RATE:e], head]))
	return float((music_novelty < wrap[RATE // 2048 - NOVELTY_K]).mean() * 100)


def loop_body(x: np.ndarray, s: int, e: int) -> np.ndarray:
	xf = int(XFADE * RATE)
	body = x[s:e].copy()
	ramp = np.linspace(0, 1, xf)[:, None]
	body[:xf] = x[s:s + xf] * ramp + x[e:e + xf] * (1 - ramp)
	return body


def circular_bed(bed: np.ndarray, length: int) -> np.ndarray:
	"""The bed tiled to `length`, crossfading each repeat, and its tail crossfaded into its head so it wraps too."""
	xf = int(2.0 * RATE)
	ramp = np.linspace(0, 1, xf)[:, None]
	period = len(bed) - xf
	window = np.ones((len(bed), 1))
	window[:xf] = ramp
	window[-xf:] = 1 - ramp
	first = window.copy()
	first[:xf] = 1
	out = np.zeros((length + xf + len(bed), bed.shape[1]))
	for start in range(0, length + xf, period):
		out[start:start + len(bed)] += bed * (window if start else first)
	head = out[:xf] * ramp + out[length:length + xf] * (1 - ramp)
	return np.concatenate([head, out[xf:length]])


def true_peak_db(x: np.ndarray) -> float:
	up = signal.resample_poly(x, 4, 1, axis=0)
	return float(20 * np.log10(np.abs(up).max() + 1e-12))


def level(x: np.ndarray, meter: pyloudnorm.Meter) -> tuple[np.ndarray, float, float]:
	lufs = meter.integrated_loudness(x)
	y = x * 10 ** ((TARGET_LUFS - lufs) / 20)
	tp = true_peak_db(y)
	if tp > CEILING_DBTP:
		y = y * 10 ** ((CEILING_DBTP - tp) / 20)
	return y, meter.integrated_loudness(y), true_peak_db(y)


def measure(y: np.ndarray, bpm_hint: float | None) -> dict:
	m = mono(y)
	mag = stft_mag(m, 1024, 4096)
	freqs = np.linspace(0, RATE / 2, mag.shape[0])
	power = mag ** 2
	total = power.sum() + 1e-12
	# A gap is where everything above 150 Hz drops 20 dB under the take's median: a drone underneath hides it
	# from broadband RMS (g-hurdy-1: 11 dB down broadband, silent above the drone).
	above_db = 10 * np.log10(power[freqs >= 150].sum(axis=0) + 1e-12)
	centroid = float((freqs[:, None] * power).sum() / total)
	env = onset_env(m)
	peaks, _ = signal.find_peaks(env, height=np.median(env) + 2 * env.std(), distance=int(0.07 * RATE / 512))
	blocks = len(m) // 4800
	rms = np.sqrt((m[:blocks * 4800] ** 2).reshape(blocks, 4800).mean(axis=1))
	rms_db = 20 * np.log10(rms + 1e-12)
	l, r = (y[:, 0], y[:, 1]) if y.ndim == 2 else (m, m)
	# How new the sound is across the seam, as a percentile of the same measure at every point of the loop:
	# log-mel distance between the 0.5 s before and the 0.5 s after. A seam that sits in the body's own range
	# (≲ 95) is no more of a jump than the music makes by itself.
	wrapped = novelty(np.concatenate([m, m[:RATE]]))
	seam_pct = float((wrapped < wrapped[len(m) // 2048 - NOVELTY_K]).mean() * 100)
	return {
		'seconds': round(len(m) / RATE, 2),
		'tempo_bpm': round(tempo(env, hint=bpm_hint), 1),
		'tempo_bpm_free': round(tempo(env), 1),
		'centroid_hz': round(centroid),
		'onsets_per_s': round(len(peaks) / (len(m) / RATE), 2),
		'sub_bass_pct': round(100 * float(power[freqs < 60].sum() / total), 2),
		'low_pct': round(100 * float(power[(freqs >= 60) & (freqs < 250)].sum() / total), 1),
		'mid_pct': round(100 * float(power[(freqs >= 250) & (freqs < 4000)].sum() / total), 1),
		'high_pct': round(100 * float(power[freqs >= 4000].sum() / total), 2),
		'dropouts_100ms': int((rms_db < -60).sum()),
		'gap_s': round(float((above_db < np.median(above_db) - 20).sum() * 1024 / RATE), 2),
		'dc_offset': round(float(abs(m.mean())), 5),
		'quiet_pct': round(100 * float((rms_db < -40).mean()), 1),
		'dynamic_range_db': round(float(np.percentile(rms_db, 95) - np.percentile(rms_db, 10)), 1),
		'stereo_corr': round(float(np.corrcoef(l, r)[0, 1]), 3) if l.std() > 0 and r.std() > 0 else 1.0,
		'seam_jump': round(float(abs(m[0] - m[-1])), 4),
		'seam_novelty_pct': round(seam_pct, 1),
	}


def spectrogram(y: np.ndarray, path: str, title: str) -> None:
	m = mono(y)
	f, t, z = signal.stft(m[::2], fs=RATE // 2, nperseg=2048, noverlap=1024)
	db = 20 * np.log10(np.abs(z) + 1e-7)
	fig, ax = plt.subplots(2, 1, figsize=(14, 6), gridspec_kw={'height_ratios': [3, 1]})
	ax[0].pcolormesh(t, f, db, vmin=db.max() - 90, vmax=db.max(), shading='auto', cmap='magma')
	ax[0].set_yscale('symlog', linthresh=200)
	ax[0].set_ylim(30, RATE // 4)
	ax[0].set_title(title)
	seam = np.concatenate([m[-RATE * 3:], m[:RATE * 3]])
	ax[1].plot(np.linspace(-3, 3, len(seam)), seam, lw=0.3)
	ax[1].axvline(0, color='r', lw=0.8)
	ax[1].set_title('loop seam (end → start)')
	fig.tight_layout()
	fig.savefig(path, dpi=70)
	plt.close(fig)


def finish(src: str, meter: pyloudnorm.Meter) -> list[dict]:
	meta = json.load(open(src[:-4] + '.json', encoding='utf-8'))
	x, rate = sf.read(src, dtype='float64', always_2d=True)
	assert rate == RATE, f'{src}: {rate} Hz'
	raw = {'raw_peak': round(float(np.abs(x).max()), 4), 'raw_clipped_samples': int((np.abs(x) >= 0.9999).sum()),
		'raw_seconds': round(len(x) / RATE, 1)}
	s, e, sim = find_loop(x, meta.get('bpm'))
	body = loop_body(x, s, e)
	colour_dir = os.path.basename(os.path.dirname(src))
	out_dir = os.path.join(ROOT, 'finished', colour_dir)
	os.makedirs(out_dir, exist_ok=True)
	stem = os.path.basename(src)[:-4]
	cuts = [(stem, body, None)]
	bed_path = os.path.join(os.path.dirname(src), f"{meta['id']}-bed.wav")
	if os.path.exists(bed_path):
		bed, bed_rate = sf.read(bed_path, dtype='float64', always_2d=True)
		bed = signal.resample_poly(bed, RATE // 100, bed_rate // 100, axis=0) if bed_rate != RATE else bed
		bed = circular_bed(bed, len(body))
		gain = 10 ** ((meter.integrated_loudness(body) - BED_UNDER_DB - meter.integrated_loudness(bed)) / 20)
		cuts.append((stem + '-bed', body + bed * gain, bed_path))
	rows = []
	for name, cut, bed in cuts:
		y, lufs, tp = level(cut, meter)
		row = {'file': name, 'id': meta['id'], 'colour': meta['colour'], 'direction': meta.get('direction'),
			'name': meta['name'] + (' + ambience' if bed else ''), 'loop_start_s': round(s / RATE, 2),
			'loop_end_s': round(e / RATE, 2), 'loop_similarity': round(sim, 3), **raw,
			'lufs': round(lufs, 2), 'true_peak_dbtp': round(tp, 2), **measure(y, meta.get('bpm')), 'bed': bed}
		sf.write(os.path.join(out_dir, name + '.wav'), y.astype(np.float32), RATE, subtype='FLOAT')
		spectrogram(y, os.path.join(out_dir, name + '.png'), f"{row['name']} — {row['seconds']} s loop")
		json.dump(row, open(os.path.join(out_dir, name + '.json'), 'w', encoding='utf-8'), indent=1)
		rows.append(row)
		print(json.dumps(row), flush=True)
	return rows


def main() -> None:
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument('--only', default='', help='comma-separated id prefixes')
	ap.add_argument('--report', default='', help='also write every row to this JSON file')
	args = ap.parse_args()
	only = [o for o in args.only.split(',') if o]
	meter = pyloudnorm.Meter(RATE)
	rows = []
	for src in sorted(glob.glob(os.path.join(ROOT, 'generated', '*', '*.wav'))):
		stem = os.path.basename(src)[:-4]
		if stem.endswith('-bed') or (only and not any(stem.startswith(o) for o in only)):
			continue
		rows += finish(src, meter)
	if args.report:
		json.dump(rows, open(args.report, 'w', encoding='utf-8'), indent=1)


if __name__ == '__main__':
	main()
