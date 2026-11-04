#!/usr/bin/env python3
"""Every promo take as raw material for another editor (the operator, 2026-11-04: "just make sure all the clips
land as media files so i can give them to another agent to make trailer with").

One uncut file per take, 1080p60 with the game's sound, no zoom and no captions: each scene from a second before
its first mark to the take's own `end` (the driver's tail beat), and each finale clip exactly as `finale.py`
cuts it. Beside them `manifest.json` and `manifest.md` give each file's scene, card, duration, what it shows,
the key moment's in/out, its peak (a life change when there is one, else the frame where the screen changes
most), every mark as a timecode into the file, and the build sha the take was filmed on.

Reads the takes `shoot.sh` leaves under e2e/.run/promo/<clip>/; writes ~/.cache/cardtable-manager/trailer-clips/
(or the first argument). Video bytes never enter git.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import finale
from cut import FOOTAGE, duration, marks, run
from finale import Mark, at, peak, tc

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / ".cache/cardtable-manager/trailer-clips"
LEAD = 1.0  # seconds of lead-in before a scene's first mark

# (clip, scene, what it shows, key in, key out). A scene runs from LEAD before its first mark to its `end`.
SCENES: list[tuple[str, str, str, Mark, Mark]] = [
    ("gauntlet", "Gauntlet", "Two friends ready; the decks are revealed; the pick/ban snake; then the glide from pick/ban into choose-deck (AF506) and the board coming up.", ("revealed", -0.5), ("board", 1.5)),
    ("constructed", "Deck picker", "A Classic room made through the form; the Legacy tab; the year slider dragged across 2008, 2014 and 2025 (AF509); real decklists hovered; both pick, ready, and the match board comes up.", ("legacy", -0.3), ("pick", 0.0)),
    ("valakut", "Valakut", "Scapeshift for Valakut: the land search and the tempo-quickened chain of Valakut triggers to lethal.", ("cast", -0.3), ("lethal", 1.5)),
    ("breakfast", "Cephalid Breakfast", "Nomads en-Kor at Cephalid Illusionist four deep (ability chips stay off the clickable cards, AF505/528), the whole library milled, Dread Return for Sutured Ghoul, the swing for the win.", ("loop", -0.3), ("win", 1.0)),
    ("thopter", "Thopter/Sword", "Thopter Foundry and Sword of the Meek looping six times, each loop faster (AF512).", ("loop-1", -0.3), ("done", 0.0)),
    ("draft", "Draft", "A draft pod from the lobby: the fan, picks, the grid and the fan sharing one page (AF502), a double-faced card's flip.", ("fan", -0.3), ("flip", 2.0)),
    ("tournament", "Tournament: pairing", "A Swiss tournament from a non-leader seat: eight entrants fill in, ready, the hero is paired and carried to their table, the face-off, the round's bracket.", ("ready", -0.3), ("bracket", 4.0)),
    ("podium", "Tournament: podium", "A finished eight-player Swiss tournament (AF516/517): the podium rises, the bracket down to the FINAL, the winner's path lit, the standings.", ("podium", -0.3), ("path", 3.0)),
    ("tug", "Shared stack drag", "Both players take hold of the same stack chip and pull opposite ways; it stands between the two hands, then is free again (AF518).", ("rival-grab", -0.3), ("let-go", 1.0)),
    ("counterwar", "Counter war", "Legacy counter war: Oko, Counterspell, Swan Song, Force of Will, Pierce, Daze — six deep — and Oko countered.", ("counterspell", -0.3), ("oko-countered", 2.0)),
    ("sideboard", "Sideboarding", "After game 1: the result, a rematch, sideboarding cards in and out, ready for game 2.", ("sideboard", -0.3), ("game2", 1.0)),
    ("bolt", "Lightning Bolt", "Lightning Bolt to the face for the win.", ("cast", -0.3), ("win", 1.0)),
    ("walkers", "Planeswalkers", "Oko, an Elk, Jace brainstorming, Elspeth's emblem.", ("oko", -0.3), ("emblem", 2.0)),
]

def take_build(clip: str) -> str:
    """The build sha a take was filmed on: the `build` mark field `rig.ts` records, else the commit that was HEAD
    when the take's marks were written (the tree's own history, read by the take's mtime)."""
    data = json.loads((FOOTAGE / clip / f"{clip}.marks.json").read_text())
    if isinstance(data.get("build"), str):
        return data["build"]
    when = int((FOOTAGE / clip / f"{clip}.marks.json").stat().st_mtime)
    sha = subprocess.run(["git", "log", "-1", f"--before={when}", "--format=%H", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    return sha[:12]


def app_build(sha: str) -> str:
    """The main commit under a take's build: every app file the take shows comes from it (the promo branch adds
    only `e2e/promo/` and a probe-only start option on top)."""
    return subprocess.run(["git", "merge-base", sha.removesuffix("+dirty"), "origin/main"], capture_output=True, text=True, check=True).stdout.strip()[:12]


def export(src: Path, start: float, end: float, dst: Path) -> None:
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return
    run(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", str(src),
         "-vf", "fps=60", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(dst)])


def row(n: int, clip: str, scene: str, shows: str, start: float, end: float, a: float, b: float, kind: str) -> dict:
    src = FOOTAGE / clip / f"{clip}.mkv"
    m = marks(clip)
    lives = [t for k, t in m.items() if k.startswith("life:") and not k.endswith(":*") and a <= t <= b]
    hit, by = (min(lives), "life") if lives else (peak(src, a, b), "frame")
    name = f"{n:02d}-{clip}.mp4"
    export(src, start, end, OUT / name)
    file_marks = {k: round(t - start, 3) for k, t in m.items() if start <= t <= end and not k.endswith(":*")}
    return {"file": name, "kind": kind, "scene": scene, "shows": shows, "source": clip, "build": take_build(clip), "main": app_build(take_build(clip)),
            "duration": round(duration(OUT / name), 3), "key_in": round(a - start, 3), "key_out": round(b - start, 3),
            "peak": round(hit - start, 3), "peak_by": by, "marks": file_marks}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    n = 0
    for clip, scene, shows, key_in, key_out in SCENES:
        if not (FOOTAGE / clip / f"{clip}.mkv").exists():
            sys.exit(f"clips: no take for {clip}")
        m = marks(clip)
        src = FOOTAGE / clip / f"{clip}.mkv"
        start = max(0.0, min(m.values()) - LEAD)
        end = min(m["end"], duration(src))
        a, b = at(m, key_in, clip), min(at(m, key_out, clip), end)
        if not start <= a < b <= end:
            sys.exit(f"clips: {clip} marks out of order: start {start:.2f}, in {a:.2f}, out {b:.2f}, end {end:.2f}")
        n += 1
        rows.append(row(n, clip, scene, shows, start, end, a, b, "scene"))
        print(f"clips: {rows[-1]['file']}  {rows[-1]['duration']:6.2f}s  {scene}")
    for clip, card, lead, key_in, key_out in finale.CLIPS:
        m = marks(clip)
        src = FOOTAGE / clip / f"{clip}.mkv"
        start = max(0.0, at(m, lead, clip) - finale.LEAD)
        end = min(m["end"], duration(src))
        a, b = at(m, key_in, clip), min(at(m, key_out, clip), end)
        if not start < a < b <= end:
            sys.exit(f"clips: {clip} marks out of order: start {start:.2f}, in {a:.2f}, out {b:.2f}, end {end:.2f}")
        n += 1
        rows.append(row(n, clip, "Finale" if clip.startswith("m-") else card, f"{card}: from just before the play to the take's settled tail.", start, end, a, b, "finale"))
        rows[-1]["card"] = card
        print(f"clips: {rows[-1]['file']}  {rows[-1]['duration']:6.2f}s  {card}")
    builds = sorted({r["build"] for r in rows})
    mains = sorted({r["main"] for r in rows})
    (OUT / "manifest.json").write_text(json.dumps({"fps": 60, "size": [1920, 1080], "audio": "game sound, AAC 192k", "main": mains, "builds": builds, "clips": rows}, indent=2) + "\n")
    lines = ["# Cardtable trailer clips", "",
             "Uncut takes, 1080p60 with the game's own sound (no music bed), no zoom, no captions. Each scene runs from a",
             "second before its first beat to the driver's tail; each finale clip from about a second before the play to",
             "its settled tail. Timecodes are m:ss.sss into each file. `key in`→`key out` is the moment to use; `peak` is",
             "where a life total first changes (`life`) or else the frame where the screen changes most (`frame`).",
             "`manifest.json` also lists every driver mark as a timecode into the file.", "",
             f"Filmed on hadoku-cardtable main {', '.join(mains)} (the app, plus the promo branch's probe-only seat-avatar option for scenario matches). `build` is the promo-branch commit each take",
             f"was driven from ({', '.join(builds)}); they differ only in `e2e/promo/` drivers, never in the app.",
             "The podium is the seeded admin testing room \"Tournament — finished (8 players)\": its entrants are the seed and seven AI.", "",
             "| # | File | Kind | Scene / card | Duration | Key in | Key out | Peak | Build | What it shows |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for i, r in enumerate(rows, 1):
        lines.append(f"| {i} | `{r['file']}` | {r['kind']} | {r.get('card', r['scene'])} | {r['duration']:.2f} s | {tc(r['key_in'])} | {tc(r['key_out'])} | {tc(r['peak'])} ({r['peak_by']}) | `{r['build']}` | {r['shows']} |")
    (OUT / "manifest.md").write_text("\n".join(lines) + "\n")
    print(f"clips: {len(rows)} files → {OUT}")


if __name__ == "__main__":
    main()
