#!/usr/bin/env python3
"""The finale as raw material (cut 7, the operator: "instead of pre-cutting them yourself, just create the
clips of the spells/abilities resolving. i'll have another agent edit and cut it together").

One clean, uncut clip per spell or ability resolving: from a little before the hero starts the play to the
take's own tail after it settles, full frame 1080p60 with the game's sound, no zoom, no captions. Beside them
`manifest.json` and `manifest.md` give each clip's card, file, duration and the key moment's in/out (and the
frame where the screen changes most inside it), as timecodes into that clip file.

Reads the takes `shoot.sh` leaves under e2e/.run/promo/<clip>/; writes to ~/.cache/cardtable-manager/
trailer-finale-clips/ (or the first argument). Video bytes never enter git.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from cut import FOOTAGE, duration, marks, run

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / ".cache/cardtable-manager/trailer-finale-clips"
LEAD = 1.0  # seconds before the lead mark

# (clip, what resolves, lead mark, key in, key out). A mark is a label from the take's marks (`cut.marks`),
# optionally with an offset in seconds; the clip runs from lead − LEAD to the take's `end` mark.
Mark = tuple[str, float]
CLIPS: list[tuple[str, str, Mark, Mark, Mark]] = [
    ("m-bolt-bob", "Lightning Bolt on Dark Confidant", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("m-swords", "Swords to Plowshares on Griselbrand", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("m-thoughtseize", "Thoughtseize, taking Show and Tell", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("m-lava-axe", "Lava Axe to the face", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("m-helix", "Lightning Helix to the face", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("m-pyroclasm", "Pyroclasm", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("m-wrath", "Wrath of God", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("m-griselbrand", "Griselbrand lands", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("m-tokens", "Hordeling Outburst", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("m-gary", "Gray Merchant of Asphodel drains", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("m-time-spiral", "Time Spiral", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("m-worldfire", "Worldfire", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("m-tremors", "Secure the Wastes (X=6) into Impact Tremors", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("m-emrakul-swing", "Emrakul attacks (annihilator 6)", ("cast", 0), ("play", -0.3), ("settled", 0)),
    ("storm", "Rituals into Grapeshot and its copies", ("chain", 0), ("grapeshot", -0.5), ("win", 0)),
    ("craterhoof", "Craterhoof Behemoth, then the attack", ("cast", 0), ("stack:1", -0.3), ("win", 0)),
    ("emrakul", "Emrakul, the Aeons Torn lands", ("cast", 0), ("stack:1", -0.3), ("landed", 2.0)),
    ("blasphemous", "Blasphemous Act", ("cast", 0), ("on-stack", -0.5), ("wiped", 2.0)),
    ("bigattack", "Twelve creatures attack", ("attack", 0), ("declared", -0.5), ("win", 0)),
    ("progenitus", "Progenitus attacks for the win", ("attack", 0), ("declared", -0.5), ("win", 0)),
]


def at(m: dict[str, float], mark: Mark, clip: str) -> float:
    """A mark's time plus its offset. `play` is the moment the play lands: the first stack entry after `cast`, or
    `go` if that is earlier. The montage marks `go` once the cast call returns, which for an untargeted spell is
    after it has already resolved (Worldfire's dissolve was over a second before its `go`)."""
    label, off = mark
    if label == "play":
        cast = at(m, ("cast", 0), clip)
        stacked = [t for k, t in m.items() if k.startswith("stack:") and not k.startswith("stack:0") and t >= cast]
        return min([at(m, ("go", 0), clip), *stacked]) + off
    if label not in m:
        sys.exit(f"finale: {clip} has no '{label}' mark (has: {', '.join(m)})")
    return m[label] + off


def peak(src: Path, a: float, b: float) -> float:
    """The time in [a, b] (seconds into `src`) of the biggest change from one frame to the next."""
    proc = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", str(src), "-vf",
                           "scale=480:-1,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=-", "-an", "-f", "null", "-"],
                          capture_output=True, text=True, check=True)
    best, best_t, t = -1.0, a, a
    for line in proc.stdout.splitlines():
        if "pts_time:" in line:
            t = a + float(line.rsplit("pts_time:", 1)[1])
        elif "scene_score=" in line:
            score = float(line.split("=", 1)[1])
            if score > best:
                best, best_t = score, t
    return best_t


def tc(s: float) -> str:
    return f"{int(s // 60)}:{s % 60:06.3f}"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for n, (clip, card, lead, key_in, key_out) in enumerate(CLIPS, 1):
        src = FOOTAGE / clip / f"{clip}.mkv"
        m = marks(clip)
        start = max(0.0, at(m, lead, clip) - LEAD)
        end = min(m["end"], duration(src))
        a, b = at(m, key_in, clip), min(at(m, key_out, clip), end)
        if not start < a < b <= end:
            sys.exit(f"finale: {clip} marks out of order: start {start:.2f}, in {a:.2f}, out {b:.2f}, end {end:.2f}")
        # The hit: the first life change inside the play when there is one (a frame-change peak there would be
        # the result screen dimming the board), else the frame where the screen changes most.
        lives = [t for k, t in m.items() if k.startswith("life:") and not k.endswith(":*") and a <= t <= b]
        hit, by = (min(lives), "life") if lives else (peak(src, a, b), "frame")
        name = f"{n:02d}-{clip}.mp4"
        if not (OUT / name).exists() or (OUT / name).stat().st_mtime < src.stat().st_mtime:
            run(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", str(src),
                 "-vf", "fps=60", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
                 "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(OUT / name)])
        rows.append({"card": card, "file": name, "source": clip, "duration": round(duration(OUT / name), 3),
                     "key_in": round(a - start, 3), "key_out": round(b - start, 3), "peak": round(hit - start, 3), "peak_by": by})
        r = rows[-1]
        print(f"finale: {name}  {r['duration']:5.2f}s  key {tc(r['key_in'])}→{tc(r['key_out'])}  peak {tc(r['peak'])}")
    (OUT / "manifest.json").write_text(json.dumps({"fps": 60, "size": [1920, 1080], "clips": rows}, indent=2) + "\n")
    lines = ["# Finale clips", "",
             "One uncut take per spell or ability resolving, 1080p60 with the game's sound. Timecodes are m:ss.sss into",
             "each file: `key in`→`key out` is the play from commit to settled; `peak` is the frame where the screen",
             "changes most inside it, or where a life total first changes (`life`). Each file starts about a second before the hero starts the play.", "",
             "| # | Card | File | Duration | Key in | Key out | Peak | Peak by |", "|---|---|---|---|---|---|---|---|"]
    for n, r in enumerate(rows, 1):
        lines.append(f"| {n} | {r['card']} | `{r['file']}` | {r['duration']:.2f} s | {tc(r['key_in'])} | {tc(r['key_out'])} | {tc(r['peak'])} | {r['peak_by']} |")
    (OUT / "manifest.md").write_text("\n".join(lines) + "\n")
    print(f"finale: {len(rows)} clips → {OUT}")


if __name__ == "__main__":
    main()
