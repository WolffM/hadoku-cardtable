#!/usr/bin/env python3
"""
The trailer's edit: `python3 -I e2e/promo/cut.py` after every clip is shot (`shoot.sh <clip>`).

Each segment names a clip, two of its marks (`<clip>.marks.json`, seconds from the first frame) with
offsets, a speed, and an optional caption. Segments are rendered one by one to 1080p60, the title and end
cards are drawn by ffmpeg itself, they are joined in order, and one music bed from the game's own library
runs under the whole cut. Output: e2e/.run/promo/trailer/trailer.mp4 (and each segment beside it, so a
re-edit in another editor can start from them). Nothing here is committed footage.
"""

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FOOTAGE = HERE.parent / ".run" / "promo"
OUT = FOOTAGE / "trailer"
MUSIC = Path("/home/hadoku/srv/hadoku-cardtable/apps/server/data/sounds/takes/music-br-hellfire-tango/take-1.ogg")
BOLD = "/usr/share/fonts/truetype/noto/NotoSans-Black.ttf"
REGULAR = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
FPS = 60
ACCENT = "0xB497FF"  # the site's own purple, close enough for a caption bar

# (clip, from (mark, offset), to (mark, offset), speed, caption, subcaption)
# Every join is a hard cut. Two segments that share a mark are one continuous shot at two speeds.
SEGMENTS = [
    ("emrakul", ("cast", -0.2), ("landed", 2.2), 1.0, None, None),
    "TITLE",
    ("constructed", ("front", 0.2), ("front", 3.3), 1.0, "Play the decks that made history", "with your friends"),
    ("constructed", ("legacy", 0.0), ("decks", 0.0), 1.2, "30 years of real tournament decks", "1,459 decklists  ·  Standard  ·  Modern  ·  Legacy"),
    ("constructed", ("ready", -0.4), ("board", 1.8), 1.4, "Pick a deck. Sit down. Play.", None),
    ("counterwar", ("counterspell", -0.3), ("daze", 4.6), 2.4, "Watch the stack unfold", None),
    ("counterwar", ("daze", 4.6), ("oko-countered", 1.6), 0.7, None, None),
    ("valakut", ("cast", -0.2), ("search", 0.0), 2.5, None, None),
    ("valakut", ("search", 0.0), ("triggers", -1.5), 2.0, None, None),
    ("valakut", ("triggers", -1.5), ("targeted", 1.0), 1.0, None, None),
    ("valakut", ("targeted", 1.0), ("lethal", 1.5), 1.6, None, None),
    ("breakfast", ("loop", -0.3), ("milled", 0.5), 2.0, "Combos go off at full speed", None),
    ("breakfast", ("dread-return", -0.2), ("ghoul", 1.0), 1.8, None, None),
    ("breakfast", ("attack", -0.3), ("win", 2.2), 1.2, None, None),
    ("blasphemous", ("cast", 0.0), ("wiped", 5.5), 1.25, None, None),
    ("gauntlet", ("ready", 0.0), ("choose", 2.0), 2.2, "Gauntlet", "Ten decks from one era. Ban, pick, battle."),
    ("tournament", ("seats", 0.0), ("bracket", 3.6), 1.8, "Tournaments", "Swiss rounds for the whole group"),
    ("draft", ("lobby", 0.2), ("fan", 0.0), 1.7, None, None),
    ("draft", ("fan", 0.0), ("grid", 1.5), 1.4, "Draft", "100+ cubes  ·  fan or grid  ·  every face of every card"),
    ("draft", ("flip", -0.3), ("end", 0.0), 1.0, None, None),
    "END",
]

# The end card follows D24: free forever, members only, and anyone can be a member.
END_LINES = {
    "title": "CARD TABLE",
    "line": "Free to play  ·  members only",
    "cta": "Join us on Discord",
    "url": "discord.gg/VvntUGQVwm",
}


def run(args: list[str]) -> None:
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"cut: ffmpeg failed: {' '.join(args[:6])}…\n{proc.stderr[-2000:]}")


def esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace("%", "\\%")


def marks(clip: str) -> dict[str, float]:
    data = json.loads((FOOTAGE / clip / f"{clip}.marks.json").read_text())
    return {m["label"]: m["t"] for m in data["marks"]}


def caption_filter(caption: str | None, sub: str | None, length: float) -> str:
    """A lower-left caption: an accent bar, a bold line and an optional quieter one, faded in and out."""
    if caption is None:
        return ""
    fade = f"if(lt(t,0.35),t/0.35,if(gt(t,{length - 0.35:.2f}),({length:.2f}-t)/0.35,1))"
    y = 870 if sub is None else 830
    parts = [
        f"drawbox=x=96:y={y - 6}:w=8:h={78 if sub is None else 134}:color={ACCENT}@0.95:t=fill:enable='between(t,0.15,{length - 0.15:.2f})'",
        f"drawtext=fontfile={BOLD}:text='{esc(caption)}':x=128:y={y}:fontsize=62:fontcolor=white:alpha='{fade}':shadowcolor=black@0.85:shadowx=0:shadowy=3:borderw=0",
    ]
    if sub is not None:
        parts.append(f"drawtext=fontfile={REGULAR}:text='{esc(sub)}':x=130:y={y + 84}:fontsize=34:fontcolor=0xE8E3F7:alpha='{fade}':shadowcolor=black@0.85:shadowx=0:shadowy=2")
    return "," + ",".join(parts)


def render_clip(n: int, seg: tuple) -> Path:
    clip, (a, da), (b, db), speed, caption, sub = seg
    m = marks(clip)
    start, end = m[a] + da, m[b] + db
    length = (end - start) / speed
    out = OUT / f"{n:02d}-{clip}-{a}.mp4"
    # A soft vignette at the foot so a caption reads over any board; cards stay untouched above it.
    shade = "drawbox=x=0:y=740:w=1920:h=340:color=black@0.30:t=fill,drawbox=x=0:y=800:w=1920:h=280:color=black@0.35:t=fill" if caption else "null"
    vf = f"trim=start={start:.3f}:end={end:.3f},setpts=(PTS-STARTPTS)/{speed},fps={FPS},{shade}{caption_filter(caption, sub, length)}"
    af = f"atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS,atempo={speed},afade=t=in:d=0.01,afade=t=out:st={max(0, length - 0.01):.3f}:d=0.01"
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(FOOTAGE / clip / f"{clip}.mkv"), "-vf", vf, "-af", af,
         "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-r", str(FPS), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", str(out)])
    print(f"cut: {out.name}  {length:5.1f}s  ({clip} {a}{da:+} → {b}{db:+} at {speed}x)")
    return out


def render_card(n: int, kind: str) -> Path:
    """The title card after the cold open, and the end card: drawn, not filmed."""
    out = OUT / f"{n:02d}-{kind.lower()}.mp4"
    if kind == "TITLE":
        length = 2.6
        texts = [(BOLD, END_LINES["title"], 150, "(h-text_h)/2-30", "white"),
                 (REGULAR, "Historical constructed  ·  Draft  ·  Tournaments", 40, "(h)/2+80", "0xD8D0F0")]
    else:
        length = 6.5
        texts = [(BOLD, END_LINES["title"], 130, "300", "white"),
                 (REGULAR, END_LINES["line"], 52, "490", "0xE8E3F7"),
                 (BOLD, END_LINES["cta"], 60, "650", ACCENT),
                 (REGULAR, END_LINES["url"], 44, "735", "0xE8E3F7")]
    draw = ",".join(
        f"drawtext=fontfile={font}:text='{esc(text)}':fontsize={size}:fontcolor={color}:x=(w-text_w)/2:y={y}"
        for font, text, size, y, color in texts
    )
    vf = f"{draw},vignette=PI/4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c=0x141218:s=1920x1080:r={FPS}:d={length}",
         "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo:d={length}", "-vf", vf, "-shortest",
         "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", str(out)])
    print(f"cut: {out.name}  {length:5.1f}s  (card)")
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    parts = [render_card(n, s) if isinstance(s, str) else render_clip(n, s) for n, s in enumerate(SEGMENTS)]
    # The beat list, for the review page: where each part starts in the cut and what it shows.
    beats, at = [], 0.0
    for seg, part in zip(SEGMENTS, parts):
        length = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(part)], capture_output=True, text=True).stdout)
        clip, caption = (seg.lower(), None) if isinstance(seg, str) else (seg[0], seg[4])
        beats.append({"at": round(at, 2), "length": round(length, 2), "clip": clip, "caption": caption})
        at += length
    (OUT / "beats.json").write_text(json.dumps(beats, indent=2))
    listing = OUT / "parts.txt"
    listing.write_text("".join(f"file '{p}'\n" for p in parts))
    joined = OUT / "joined.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(joined)])
    total = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(joined)], capture_output=True, text=True).stdout)
    # Loudness: -15 LUFS integrated, where online video players expect it.
    # The bed starts with the title card (after the cold open's own sound), sits under the game's sounds,
    # and fades out with the end card.
    cold = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(parts[0])], capture_output=True, text=True).stdout)
    mix = (
        f"[1:a]atrim=0:{total - cold:.2f},asetpts=PTS-STARTPTS,volume=0.42,afade=t=in:d=0.8,afade=t=out:st={total - cold - 3:.2f}:d=3,adelay={int(cold * 1000)}|{int(cold * 1000)}[bed];"
        f"[0:a]volume=1.0[game];[game][bed]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-15:TP=-1.5:LRA=11,aresample=48000[a]"
    )
    trailer = OUT / "trailer.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(joined), "-i", str(MUSIC), "-filter_complex", mix,
         "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", str(trailer)])
    print(f"cut: {trailer}  {total:.1f}s")


if __name__ == "__main__":
    main()
