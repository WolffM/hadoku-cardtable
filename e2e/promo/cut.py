#!/usr/bin/env python3
"""
The trailer's edit: `python3 e2e/promo/cut.py` (not `-I`: numpy is in the user site) after every clip is shot (`shoot.sh <clip>`).

Each segment names a clip, two of its marks (`<clip>.marks.json`, seconds from the first frame) with
offsets, and an optional caption. Every shot plays at real speed (the operator, cut 3: "please avoid speeding up
any clips, keep it natural"); length is controlled by cutting. Segments are rendered one by one to 1080p60 and joined with hard
cuts; the title and end cards are drawn by ffmpeg itself, and one music bed from the game's own library
runs under the whole cut. Output: e2e/.run/promo/trailer/trailer.mp4 (each part and `beats.json` beside
it, so a re-edit in another editor can start from them). Nothing here is committed footage.

Captions are C2, varied per page (the operator, 2026-10-30). One family: Noto Sans Black headline, a
letter-spaced SemiBold kicker, the accent purple, a rule, ease-out timing, and one exit (everything lifts
away together). What varies is the ANCHOR, fixed to something on that page (`ANCHORS`, measured from a
still of each clip), and the ENTRANCE (`rise`, `wipe`, `slide`, `drop`). No two consecutive captions share
both; `check_captions` refuses an edit that does.

The ending is a montage cut on the bed's beat grid (`onsets`, a spectral-flux detector, then `beat_grid`,
the local eighth-note grid those onsets sit on), each shot a whole number of beats long enough to read,
into Progenitus at full length and real speed, then the credits (`credits.mjs`).
"""

import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import ImageFont

HERE = Path(__file__).resolve().parent
FOOTAGE = HERE.parent / ".run" / "promo"
OUT = FOOTAGE / "trailer"
TANGO = Path("/home/hadoku/srv/hadoku-cardtable/apps/server/data/sounds/takes/music-br-hellfire-tango/take-1.ogg")
# The bed: the tango BED_COPIES times, crossfaded over BED_XFADE s. Cut 5 runs every clip at full length (the operator:
# "i'll be cutting it later … i need to see the raw clip performing properly first"), past one 2:04 take.
MUSIC = OUT_BED = Path(__file__).resolve().parent.parent / ".run" / "promo" / "trailer" / "bed.flac"
BED_XFADE = 4.0
BED_COPIES = 4  # ~8 minutes: cut 5 with every clip whole runs about 6½
BLACK = "/usr/share/fonts/truetype/noto/NotoSans-Black.ttf"
SEMI = "/usr/share/fonts/truetype/noto/NotoSans-SemiBold.ttf"
REGULAR = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
FPS = 60
ACCENT = "0xB497FF"  # the site's own purple
BED_LEVEL = 0.42


@dataclass(frozen=True)
class Caption:
    text: str
    kicker: str
    anchor: str
    entrance: str  # rise | wipe | slide | drop


@dataclass(frozen=True)
class Anchor:
    """Where a caption sits: `x` is the edge it hangs from (`align` says which), `y` the kicker's top."""
    x: float
    y: float
    align: str  # left | right | centre
    size: int = 60


# Measured from a still of each clip at 1920×1080 (`python3 e2e/promo/cut.py --stills` writes them).
ANCHORS = {
    # The game board's top band, against the battlefield's right edge (C2 as approved).
    "board-right": Anchor(1560, 100, "right"),
    # The same band from the left, where the opponent's hand is empty.
    "board-left": Anchor(164, 120, "left"),
    # A lobby's page-title row: the room name's line, right-aligned short of the room's Close (x 1440).
    "lobby-title": Anchor(1416, 86, "right", 42),
    # The draft: under the pool, on the pack's left edge (x 156). The band above the pack is 40 px; the
    # rows under the pool stay empty in both fan and grid.
    "draft-pool": Anchor(156, 900, "left", 56),
    # Gauntlet: right-aligned in the seating panel's empty half, directly over the reveal row (panel 300–508).
    "gauntlet-reveal": Anchor(1466, 336, "right", 52),
    # Tournament: centred on the face-off (x 803). The band above it is 80 px under the room panel, too
    # little for two lines, so the caption hangs under the two seats' ready pills instead.
    "faceoff": Anchor(803, 622, "centre", 60),
}

# (clip, from (mark, offset), to (mark, offset), caption). Every join is a hard cut; every shot is at 1×.
SEGMENTS = [
    # Cut 5's structure, the operator's (2026-11-01). Every clip whole and continuous: they cut it later.
    # 1. Gauntlet: two people ban and pick. (The caption is a draft: their sentence ended at "from".)
    # Cut 6 (the operator: "cut off a bit of the beginning and the end so it's tighter"): from the Ready press to
    # just after game 1's board is up.
    ("gauntlet", ("ready", -0.3), ("board", 1.5), Caption("Play the decks that made history.", "GAUNTLET · AGAINST YOUR FRIENDS", "gauntlet-reveal", "rise")),
    # 2. The deck picker, flipping through the years and formats. Cut 6: "we don't need that much of it", so the
    # Legacy tab and the first year changes only.
    ("constructed", ("legacy", -0.5), ("decks", 3.0), Caption("Any format. Any year.", "HISTORICAL CONSTRUCTED", "lobby-title", "wipe")),
    # 3. Combos, each one take, every click shown.
    ("valakut", ("board", 0.0), ("end", 0.0), Caption("Execute fun combos with no fuss.", "COMBOS", "board-right", "slide")),
    ("breakfast", ("board", 0.0), ("end", 0.0), None),
    ("thopter", ("board", 0.0), ("end", 0.0), None),
    # 4. The draft.
    ("draft", ("lobby", 0.0), ("end", 0.0), Caption("Organize custom draft tournaments.", "ANY SET IN MAGIC · ANY CUSTOM CUBE", "draft-pool", "drop")),
    # 5. The finale: rapid-fire, hard cuts, no captions, Emrakul's landing last, then Progenitus.
    "MONTAGE",
    ("progenitus", ("declared", -0.4), ("end", 0.0), None),
    # 6. Credits.
    "END",
]

# Raw clips outside the structure, filmed whole for the operator to place (cut 5).
EXTRAS = [
    ("counterwar", ("board", 0.0), ("end", 0.0)),
    ("tournament", ("lobby", 0.0), ("end", 0.0)),
    ("sideboard", ("board", 0.0), ("end", 0.0)),
    ("bigattack", ("board", 0.0), ("end", 0.0)),
    ("blasphemous", ("board", 0.0), ("end", 0.0)),
    ("craterhoof", ("board", 0.0), ("end", 0.0)),
    ("storm", ("board", 0.0), ("end", 0.0)),
]

# The montage: one in-point per shot, in order. Each runs from (mark + offset), for as long as the beat grid
# allows. Offsets are picked from a frame strip of each moment, not from a mark alone: a game's marks are when
# the driver acted, and the hit lands a beat later.
# One zoom for every montage shot: 1.3×, which drops the chat rail and the header and keeps the board.
Z = (1.3, 760, 560)
MONTAGE = [
    # (clip, mark, offset, length in eighths of the bed's beat grid (~0.23 s each), *zoom). Each board looks
    # different: early and late game, empty and crowded, every colour; the strong spells last.
    # Cut 6 (the operator: "some clips are cut too short"): every shot two eighths longer.
    ("m-thoughtseize", "stack:0", -1.0, 6, *Z),
    ("m-griselbrand", "stack:0", -0.05, 6, *Z),
    ("m-swords", "life:theirs:*", -0.35, 6, *Z),
    ("m-gary", "life:mine:*", -0.15, 6, *Z),
    ("storm", "hit", -0.3, 6, *Z),
    ("m-pyroclasm", "stack:0", 0.1, 6, *Z),
    ("m-wrath", "stack:0", 0.05, 6, *Z),
    ("craterhoof", "life:theirs:*", -0.4, 6, *Z),
    ("m-time-spiral", "stack:0", 0.0, 8, *Z),
    ("m-tremors", "life:theirs:*", -0.4, 8, *Z),
    ("m-worldfire", "stack:0", 0.0, 8, *Z),
    ("emrakul", "landed", 0.1, 10, *Z),
]

# The end card follows D24: free forever, members only, and anyone can be a member.


def run(args: list[str]) -> None:
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"cut: ffmpeg failed: {' '.join(args[:6])}…\n{proc.stderr[-2000:]}")


def duration(path: Path) -> float:
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout)


def esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace("%", "\\%").replace(",", "\\,")


def marks(clip: str) -> dict[str, float]:
    """A clip's marks by label. A label that recurs (the rig's `stack:1`, say) is its first occurrence, and
    `label#2`, `label#3`… are the later ones. `life:mine:*` / `life:theirs:*` is that side's first life change,
    whatever total it lands on: since AF489 a drain or a hit moves the total in one step, so the totals in
    between are never marked."""
    data = json.loads((FOOTAGE / clip / f"{clip}.marks.json").read_text())
    out: dict[str, float] = {}
    seen: dict[str, int] = {}
    for m in data["marks"]:
        seen[m["label"]] = seen.get(m["label"], 0) + 1
        out[m["label"] if seen[m["label"]] == 1 else f"{m['label']}#{seen[m['label']]}"] = m["t"]
        if m["label"].startswith("life:"):
            out.setdefault(m["label"].rsplit(":", 1)[0] + ":*", m["t"])
    return out


def gauntlet_acts() -> list[tuple[float, float]]:
    """Every ban and pick of the Gauntlet clip as its own shot, at real speed, with only the waits cut: the
    hero's acts from the hover (the decklist opens) through the press, the rival's from just before its
    tile turns. Shots that touch are merged."""
    windows = []
    for label, t in marks("gauntlet").items():
        if label.startswith("act-"):
            windows.append((t, t + 2.0) if label.endswith("-hero") else (t - 0.1, t + 1.3))
    merged: list[tuple[float, float]] = []
    for a, b in sorted(windows):
        if merged and a <= merged[-1][1] + 0.15:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


# ── captions ──────────────────────────────────────────────────────────────────────────────────────────

KSIZE, KSP = 22, 4.0  # the kicker's size and letter spacing
IN = 0.25  # the entrance starts this long into the segment
EXIT = 0.3  # and everything lifts away over this long, ending EXIT before the cut
CAPTION_HOLD = 5.0  # and leaves at most this long after it came in


def width(font: str, size: int, text: str) -> float:
    return ImageFont.truetype(font, size).getlength(text)


def ease(t0: float, d: float) -> str:
    return f"(1-pow(1-clip((t-{t0:.3f})/{d:.3f},0,1),3))"


def settle(t0: float, d: float) -> str:
    """Ease-out-back: overshoots a little, then settles."""
    p = f"clip((t-{t0:.3f})/{d:.3f},0,1)"
    return f"(1+2.2*pow({p}-1,3)+1.2*pow({p}-1,2))"


def check_captions(segments: list) -> None:
    last = None
    for seg in segments:
        if isinstance(seg, str) or seg[3] is None:
            continue
        cap: Caption = seg[3]
        if cap.anchor not in ANCHORS or cap.entrance not in ("rise", "wipe", "slide", "drop"):
            sys.exit(f"cut: caption {cap.text!r}: unknown anchor or entrance")
        if last is not None and (last.anchor, last.entrance) == (cap.anchor, cap.entrance):
            sys.exit(f"cut: {last.text!r} and {cap.text!r} share both anchor and entrance")
        last = cap


def caption_graph(cap: Caption, length: float) -> tuple[list[str], list[str]]:
    """drawtext filters for the headline and kicker, plus the rule as an overlay source and its placement."""
    a = ANCHORS[cap.anchor]
    # Up for CAPTION_HOLD at most: a section is now a whole, continuous clip, a minute or more long.
    out = min(length - EXIT - 0.05, IN + CAPTION_HOLD)
    gone = f"clip((t-{out:.3f})/{EXIT},0,1)"
    alpha = lambda t0, d=0.35: f"{ease(t0, d)}*(1-{gone})"  # noqa: E731
    lift = f"(-10*{gone})"
    size = a.size
    space = width(BLACK, size, " ")
    words = cap.text.split(" ")
    total = sum(width(BLACK, size, w) for w in words) + space * (len(words) - 1)
    left = a.x - total if a.align == "right" else a.x - total / 2 if a.align == "centre" else a.x
    head_y = a.y + 28
    kw = sum(width(SEMI, KSIZE, ch) + KSP for ch in cap.kicker) - KSP
    rule_w = 44
    if a.align == "right":
        kx, rx = a.x - kw, a.x - kw - 14 - rule_w
    elif a.align == "centre":
        kx = a.x - kw / 2 + (rule_w + 14) / 2
        rx = kx - 14 - rule_w
    else:
        rx, kx = a.x, a.x + rule_w + 14
    shadow = "shadowcolor=black@0.7:shadowy=3"
    draws: list[str] = []
    # The kicker: letters cascade in, from the anchored side.
    letters, cx = [], kx
    for ch in cap.kicker:
        letters.append((ch, cx))
        cx += width(SEMI, KSIZE, ch) + KSP
    order = letters[::-1] if a.align == "right" else letters
    for i, (ch, x) in enumerate(order):
        if ch == " ":
            continue
        t0 = IN + 0.18 + i * 0.018
        draws.append(f"drawtext=y_align=font:fontfile={SEMI}:text='{esc(ch)}':fontsize={KSIZE}:fontcolor={ACCENT}:x={x:.1f}:y='{a.y}+10*(1-{ease(t0, 0.3)})+{lift}':alpha='{alpha(t0, 0.3)}'")
    # The headline, by entrance.
    h0 = IN + 0.32
    if cap.entrance in ("rise", "drop"):
        x = left
        for i, w in enumerate(words):
            if cap.entrance == "rise":
                t0 = h0 + i * 0.07
                y = f"{head_y}+22*(1-{ease(t0, 0.45)})+{lift}"
            else:
                t0 = h0
                y = f"{head_y}-46*(1-{settle(t0, 0.55)})+{lift}"
            draws.append(f"drawtext=y_align=font:fontfile={BLACK}:text='{esc(w)}':fontsize={size}:fontcolor=white:x={x:.1f}:y='{y}':alpha='{alpha(t0)}':{shadow}")
            x += width(BLACK, size, w) + space
    else:
        # wipe: a soft front sweeps left to right; slide: letters slide in from the anchored edge.
        chars, x = [], left
        for ch in cap.text:
            chars.append((ch, x))
            x += width(BLACK, size, ch)
        sweep = 0.55
        for i, (ch, cx) in enumerate(chars):
            if ch == " ":
                continue
            if cap.entrance == "wipe":
                t0 = h0 + sweep * (cx - left) / max(total, 1)
                draws.append(f"drawtext=y_align=font:fontfile={BLACK}:text='{esc(ch)}':fontsize={size}:fontcolor=white:x={cx:.1f}:y='{head_y}+{lift}':alpha='{alpha(t0, 0.12)}':{shadow}")
            else:
                rank = (len(chars) - 1 - i) if a.align == "right" else i
                t0 = h0 + rank * 0.016
                d = 30 if a.align == "right" else -30
                draws.append(f"drawtext=y_align=font:fontfile={BLACK}:text='{esc(ch)}':fontsize={size}:fontcolor=white:x='{cx:.1f}+{d}*(1-{ease(t0, 0.4)})':y='{head_y}+{lift}':alpha='{alpha(t0, 0.3)}':{shadow}")
    # The rule leads, from the anchored side.
    src = f"color=c={ACCENT}:s={rule_w}x5:r={FPS}:d={length:.3f},format=rgba,fade=t=in:st={IN}:d=0.2:alpha=1,fade=t=out:st={out:.3f}:d={EXIT}:alpha=1"
    sign = "+" if a.align == "right" else "-"
    place = f"x='{rx:.1f}{sign}{rule_w}*(1-{ease(IN, 0.4)})':y={a.y + 10}"
    return draws, [src, place]


# ── segments ──────────────────────────────────────────────────────────────────────────────────────────

def encode(out: Path, inputs: list[str], graph: str, length: float, maps: list[str]) -> None:
    run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", graph, *maps,
         "-t", f"{length:.3f}", "-c:v", "h264_nvenc", "-preset", "p6", "-rc", "constqp", "-qp", "17", "-pix_fmt", "yuv420p", "-r", str(FPS),
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", str(out)])


def render_clip(n: int, clip: str, start: float, end: float, cap: Caption | None, label: str, zoom: tuple[float, float, float] | None = None, source: Path | None = None) -> Path:
    """One shot at real speed. `zoom` is (factor, cx, cy): a crop of the 1080p frame centred on (cx, cy),
    scaled back to 1080p, for a montage shot whose moment is small on the full board. `source` overrides the
    take (`<clip>/<clip>.mkv` under FOOTAGE), for an edit cut from exported clips (`cut9.py`)."""
    length = end - start
    out = OUT / f"{n:02d}-{clip}-{label}.mp4"
    crop = ""
    if zoom is not None:
        f, cx, cy = zoom
        w, h = round(1920 / f / 2) * 2, round(1080 / f / 2) * 2
        x, y = min(max(0, round(cx - w / 2)), 1920 - w), min(max(0, round(cy - h / 2)), 1080 - h)
        crop = f",crop={w}:{h}:{x}:{y},scale=1920:1080:flags=lanczos"
    base = f"[0:v]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS,fps={FPS}{crop}"
    if cap is None:
        graph = f"{base}[v]"
    else:
        draws, (src, place) = caption_graph(cap, length)
        graph = f"{base}[b];{src}[bar];[b][bar]overlay={place}:shortest=1[r];[r]{','.join(draws)}[v]"
    graph += f";[0:a]atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st={max(0, length - 0.01):.3f}:d=0.01[a]"
    encode(out, ["-i", str(source or FOOTAGE / clip / f"{clip}.mkv")], graph, length, ["-map", "[v]", "-map", "[a]"])
    print(f"cut: {out.name}  {length:5.2f}s  ({clip} {start:.2f}→{end:.2f}{'' if cap is None else ', ' + cap.entrance + '@' + cap.anchor})")
    return out


def render_segment(n: int, seg: tuple) -> Path:
    clip, (a, da), (b, db), cap = seg
    m = marks(clip)
    return render_clip(n, clip, m[a] + da, m[b] + db, cap, a)


def render_card(n: int, kind: str) -> Path:
    """The closing credits, drawn by `credits.mjs` (a page photographed in Chromium) and held as the last shot."""
    out = OUT / f"{n:02d}-{kind.lower()}.mp4"
    still = OUT / "credits.png"
    subprocess.run(["node", str(HERE / "credits.mjs"), str(still)], check=True, cwd=HERE.parent, capture_output=True)
    length = 8.0
    run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-framerate", str(FPS), "-t", f"{length}", "-i", str(still),
         "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo:d={length}", "-shortest", "-vf", "format=yuv420p",
         "-c:v", "h264_nvenc", "-preset", "p6", "-rc", "constqp", "-qp", "17", "-pix_fmt", "yuv420p", "-r", str(FPS), "-c:a", "aac", "-b:a", "192k", str(out)])
    print(f"cut: {out.name}  {length:5.1f}s  (credits)")
    return out


# ── the montage, on the beat ──────────────────────────────────────────────────────────────────────────

def onsets(path: Path, sr: int = 22050, hop: int = 256, win: int = 1024) -> np.ndarray:
    """Onset times in seconds: half-wave-rectified spectral flux on a log magnitude, peak-picked against a
    moving median. The same idea as `aubio onset`'s default, in numpy."""
    pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    x = np.frombuffer(pcm, dtype=np.float32)
    frames = np.lib.stride_tricks.sliding_window_view(x, win)[::hop] * np.hanning(win)
    mag = np.log1p(10 * np.abs(np.fft.rfft(frames, axis=1)))
    flux = np.maximum(0, np.diff(mag, axis=0)).sum(axis=1)
    flux = (flux - flux.mean()) / (flux.std() + 1e-9)
    k = 16
    pad = np.pad(flux, k, mode="edge")
    median = np.array([np.median(pad[i:i + 2 * k + 1]) for i in range(len(flux))])
    peaks = [i for i in range(1, len(flux) - 1) if flux[i] > flux[i - 1] and flux[i] >= flux[i + 1] and flux[i] > median[i] + 0.6]
    times = (np.array(peaks) + 1) * hop / sr
    # One onset per 120 ms at most: the strongest wins.
    kept: list[float] = []
    for t, i in zip(times, peaks):
        if kept and t - kept[-1] < 0.12:
            if flux[i] > flux[int(kept[-1] * sr / hop) - 1]:
                kept[-1] = t
            continue
        kept.append(t)
    return np.array(kept)


def beat_grid(beats: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """The eighth-note grid over [lo, hi]: the period and phase that put the most onsets in that window
    within 25 ms of a grid line. The detector misses quieter beats, so cutting on raw onsets alone leaves
    holes; the tempo drifts over the whole bed, so the fit is local."""
    x = beats[(beats > lo - 2) & (beats < hi + 2)]
    best = (-1.0, 0.0, 0.0)
    for period in np.arange(0.20, 0.27, 0.0002):
        phase = np.angle(np.mean(np.exp(2j * np.pi * x / period))) * period / (2 * np.pi)
        r = x - phase - np.round((x - phase) / period) * period
        score = float(np.mean(np.abs(r) < 0.025))
        if score > best[0]:
            best = (score, period, phase)
    _, period, phase = best
    k = np.arange(np.ceil((lo - phase) / period), np.floor((hi - phase) / period) + 1)
    print(f"cut: beat grid {period * 1000:.1f} ms an eighth over bed {lo:.1f}–{hi:.1f}s, {best[0]:.0%} of onsets on it")
    return phase + k * period


def montage_cuts(grid: np.ndarray, start: float, eighths: list[int]) -> list[float]:
    """Cut points on the beat grid from `start` (a bed time): shot k lasts `eighths[k]` grid steps, so every
    cut is on the beat and no shot is shorter than it needs to read (cut 4: "some of them go too fast")."""
    first = grid[grid >= start - 0.02]
    i = int(np.searchsorted(grid, first[0])) if len(first) else 0
    cuts = [float(grid[i])]
    for n in eighths:
        i += n
        cuts.append(float(grid[i]) if i < len(grid) else cuts[-1] + n * float(np.median(np.diff(grid))))
    return cuts


# ── main ──────────────────────────────────────────────────────────────────────────────────────────────

def stills() -> None:
    """One still per captioned segment at its caption's resting moment, captioned, for measuring anchors."""
    (OUT / "stills").mkdir(parents=True, exist_ok=True)
    for n, seg in enumerate(SEGMENTS):
        if isinstance(seg, str) or seg[3] is None:
            continue
        part = render_segment(n, seg)
        run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "1.6", "-i", str(part), "-frames:v", "1", "-q:v", "2", str(OUT / "stills" / f"{n:02d}-{seg[0]}.jpg")])


def make_bed(copies: int = BED_COPIES) -> None:
    """The tango `copies` times over, each join crossfaded over BED_XFADE s."""
    inputs = [arg for _ in range(copies) for arg in ("-i", str(TANGO))]
    chain, last = [], "[0:a]"
    for k in range(1, copies):
        out = f"[x{k}]" if k < copies - 1 else "[a]"
        chain.append(f"{last}[{k}:a]acrossfade=d={BED_XFADE}:c1=tri:c2=tri{out}")
        last = out
    run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(chain), "-map", "[a]", "-c:a", "flac", str(MUSIC)])


def extras() -> None:
    """The raw clips outside the main cut, each whole, for the operator to slot in (`trailer/extras/`)."""
    (OUT / "extras").mkdir(parents=True, exist_ok=True)
    for clip, (a, da), (b, db) in EXTRAS:
        if not (FOOTAGE / clip / f"{clip}.mkv").exists():
            print(f"cut: extra {clip} not filmed yet")
            continue
        m = marks(clip)
        start, end = m[a] + da, m[b] + db
        out = OUT / "extras" / f"{clip}.mp4"
        run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(FOOTAGE / clip / f"{clip}.mkv"),
             "-c:v", "h264_nvenc", "-preset", "p6", "-rc", "constqp", "-qp", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", str(out)])
        print(f"cut: extra {out.name}  {end - start:5.1f}s")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    make_bed()
    extras()
    check_captions(SEGMENTS)
    if "--stills" in sys.argv:
        stills()
        return
    beats = onsets(MUSIC)
    print(f"cut: {len(beats)} onsets in the bed")
    parts: list[Path] = []
    rows: list[dict] = []
    at = 0.0
    cold = 0.0
    for n, seg in enumerate(SEGMENTS):
        if seg == "MONTAGE":
            # The bed starts after the cold open: its clock is the cut's, less `cold`.
            grid = beat_grid(beats, at - cold - 1, at - cold + 30)
            cuts = montage_cuts(grid, at - cold, [shot[3] for shot in MONTAGE])
            print(f"cut: montage at bed {cuts[0]:.2f}s, shots {[round(b - a, 2) for a, b in zip(cuts, cuts[1:])]}")
            # Shift the montage so its first cut lands on the first onset: lengthen the part before it.
            if parts and cuts[0] > at - cold + 0.01:
                prev = SEGMENTS[n - 1]
                m = marks(prev[0])
                extra = cuts[0] - (at - cold)
                parts[-1] = render_clip(n - 1, prev[0], m[prev[1][0]] + prev[1][1], m[prev[2][0]] + prev[2][1] + extra, prev[3], prev[1][0])
                at = cuts[0] + cold
                rows[-1]["length"] = round(at - rows[-1]["at"], 2)
            for k, (clip, mark, off, _eighths, *zoom) in enumerate(MONTAGE):
                length = cuts[k + 1] - cuts[k]
                t = marks(clip)[mark] + off
                part = render_clip(n * 100 + k, clip, t, t + length, None, f"m{k:02d}-{mark}", tuple(zoom) if zoom else None)
                parts.append(part)
                rows.append({"at": round(at, 2), "length": round(duration(part), 2), "clip": clip, "caption": None, "montage": True})
                at += duration(part)
            continue
        if seg == "GAUNTLET_ACTS":
            for k, (a, b) in enumerate(gauntlet_acts()):
                part = render_clip(n * 100 + k, "gauntlet", a, b, None, f"act{k:02d}")
                parts.append(part)
                rows.append({"at": round(at, 2), "length": round(duration(part), 2), "clip": "gauntlet", "caption": None})
                at += duration(part)
            continue
        if seg == "TITLE":
            # Everything before the title card is the cold open: the bed starts with the title.
            cold = at
        part = render_card(n, seg) if isinstance(seg, str) else render_segment(n, seg)
        length = duration(part)
        cap = None if isinstance(seg, str) else seg[3]
        rows.append({"at": round(at, 2), "length": round(length, 2), "clip": seg.lower() if isinstance(seg, str) else seg[0],
                     "caption": None if cap is None else {"text": cap.text, "kicker": cap.kicker, "anchor": cap.anchor, "entrance": cap.entrance}})
        parts.append(part)
        at += length
    (OUT / "beats.json").write_text(json.dumps(rows, indent=2))
    listing = OUT / "parts.txt"
    listing.write_text("".join(f"file '{p}'\n" for p in parts))
    joined = OUT / "joined.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(joined)])
    total = duration(joined)
    bed = duration(MUSIC)
    if total - cold > bed:
        print(f"cut: warning: the cut runs {total - cold - bed:.1f}s past the bed's end")
    # Loudness: -15 LUFS integrated. The bed starts with the title card (after the cold open's own sound),
    # sits under the game's sounds, and fades out with the end card.
    mix = (
        f"[1:a]atrim=0:{total - cold:.2f},asetpts=PTS-STARTPTS,volume={BED_LEVEL},afade=t=in:d=0.8,afade=t=out:st={total - cold - 3:.2f}:d=3,adelay={int(cold * 1000)}|{int(cold * 1000)}[bed];"
        f"[0:a]volume=1.0[game];[game][bed]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-15:TP=-1.5:LRA=11,aresample=48000[a]"
    )
    trailer = OUT / "trailer.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(joined), "-i", str(MUSIC), "-filter_complex", mix,
         "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", str(trailer)])
    print(f"cut: {trailer}  {total:.1f}s")


if __name__ == "__main__":
    main()
