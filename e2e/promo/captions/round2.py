"""Trailer cut 3 text options C2 and D2: anchored layouts with a staggered entrance and exit.

`python3 -I e2e/promo/captions/round2.py` renders c2-kicker.mp4 and d2-rail.mp4 (720p) into
e2e/.run/promo/captions/. C2 is the operator's pick (2026-10-30), to be varied per page. Each element is
its own drawtext/overlay with an ease-out cubic on its offset and alpha: the accent rule wipes in,
the kicker's letters follow, then each word (C) or line (D) rises 22 px into place, 70 ms apart.
Everything leaves together, lifting 10 px as it fades."""
import subprocess
from pathlib import Path
from PIL import ImageFont

HERE = Path(__file__).resolve().parents[2] / ".run" / "promo" / "captions"
HERE.mkdir(parents=True, exist_ok=True)
SRC = "/home/hadoku/repos/hadoku-cardtable/.claude/worktrees/promo/e2e/.run/promo/counterwar/counterwar.mkv"
BOLD = "/usr/share/fonts/truetype/noto/NotoSans-Black.ttf"
REG = "/usr/share/fonts/truetype/noto/NotoSans-SemiBold.ttf"
ACC = "0xB497FF"
START, SPEED, LEN = 6.0, 2.4, 5.0
IN, OUT = 0.25, 3.7          # when the entrance starts, when the exit starts
BASE = f"trim=start={START}:end={START + LEN * SPEED},setpts=(PTS-STARTPTS)/{SPEED},fps=60"


def ease(t0: float, d: float) -> str:
    return f"(1-pow(1-clip((t-{t0})/{d},0,1),3))"


def gone() -> str:
    return f"clip((t-{OUT})/0.3,0,1)"


def alpha(t0: float, d: float = 0.35) -> str:
    return f"{ease(t0, d)}*(1-{gone()})"


def lift(t0: float, rise: int = 22, d: float = 0.45) -> str:
    return f"({rise}*(1-{ease(t0, d)})-10*{gone()})"


def width(font: str, size: int, text: str) -> float:
    return ImageFont.truetype(font, size).getlength(text)


def tracked(x: float, y: float, text: str, size: int, t0: float, spacing: float) -> list[str]:
    """Letter-spaced small caps, each letter a beat behind the last."""
    out, cx = [], x
    for i, ch in enumerate(text):
        if ch != " ":
            out.append(f"drawtext=fontfile={REG}:text='{ch}':fontsize={size}:fontcolor={ACC}:x={cx:.1f}:y='{y}+{lift(t0 + i * 0.018, 10, 0.3)}':alpha='{alpha(t0 + i * 0.018, 0.3)}'")
        cx += width(REG, size, ch) + spacing
    return out


def tracked_width(text: str, size: int, spacing: float) -> float:
    return sum(width(REG, size, ch) + spacing for ch in text) - spacing


def rule(x: float, y: float, w: int, t0: float) -> tuple[str, str]:
    """An accent rule, `x` its resting left edge: it slides in from the left as it fades in."""
    src = f"color=c={ACC}:s={w}x5:r=60:d={LEN},format=rgba,fade=t=in:st={t0}:d=0.2:alpha=1,fade=t=out:st={OUT}:d=0.3:alpha=1[bar]"
    ov = f"[bar]overlay=x='{x}-{w}*(1-{ease(t0, 0.4)})':y={y}:shortest=1"
    return src, ov


def render(name: str, layout: list[str], bar: tuple[str, str], panel: str = "") -> None:
    src, ov = bar
    graph = f"[0:v]{BASE}{panel}[v];{src};[v]{ov}[r];[r]" + ",".join(layout) + ",scale=1280:720:flags=lanczos[o]"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", SRC, "-filter_complex", graph, "-map", "[o]", "-an",
                    "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                    str(HERE / f"{name}.mp4")], check=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", "1.6", "-i", str(HERE / f"{name}.mp4"), "-frames:v", "1", "-q:v", "3",
                    str(HERE / f"{name}.jpg")], check=True)
    print(name)


KICK, KSIZE, KSP = "THE STACK", 22, 4.0
WORDS = ["Watch", "the", "stack", "unfold"]

# C2: right-aligned to the opponent band's right edge (the battlefield's, x=1560 at 1080p), so the
# hand stays left and the title sits against the phase rail's column, the same place in every clip.
RIGHT, HSIZE = 1560, 60
space = width(BOLD, HSIZE, " ")
total = sum(width(BOLD, HSIZE, w) for w in WORDS) + space * (len(WORDS) - 1)
x = RIGHT - total
words = []
for i, w in enumerate(WORDS):
    t0 = IN + 0.32 + i * 0.07
    words.append(f"drawtext=fontfile={BOLD}:text='{w}':fontsize={HSIZE}:fontcolor=white:x={x:.1f}:y='128+{lift(t0)}':alpha='{alpha(t0)}':shadowcolor=black@0.7:shadowy=3")
    x += width(BOLD, HSIZE, w) + space
kw = tracked_width(KICK, KSIZE, KSP)
# The kicker row: the rule, then the label, right-aligned; the rule sits on the label's mid-line.
render("c2-kicker", tracked(RIGHT - kw, 100, KICK, KSIZE, IN + 0.18, KSP) + words, rule(RIGHT - kw - 14 - 44, 110, 44, IN))

# D2: the chat rail, covered by a panel in the board's own surface colour, the text on the chat's own
# left margin (x=1626) and centred on the rail's height.
LEFT, DSIZE, LINE = 1630, 44, 52
lines = ["Watch the", "stack", "unfold"]
block = 26 + 14 + LINE * len(lines)
top = 82 + (948 - block) / 2
d = tracked(LEFT, top + 14, KICK, KSIZE, IN + 0.18, KSP)
for i, ln in enumerate(lines):
    t0 = IN + 0.32 + i * 0.09
    d.append(f"drawtext=fontfile={BOLD}:text='{ln}':fontsize={DSIZE}:fontcolor=white:x={LEFT}:y='{top + 40 + i * LINE:.0f}+{lift(t0)}':alpha='{alpha(t0)}'")
panel = f",drawbox=x=1601:y=82:w=319:h=948:color=0x17151c@0.96:t=fill:enable='between(t,{IN - 0.05},{OUT + 0.35})'"
render("d2-rail", d, rule(LEFT, top, 56, IN), panel)
