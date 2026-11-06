#!/usr/bin/env python3
"""
Trailer cut 9, edited from the exported takes in ~/.cache/cardtable-manager/trailer-clips/ (`clips.py`'s output,
filmed on main 81bb83743) rather than from the rig's run directory. Run it without `-I` (numpy is in the user
site): `python3 e2e/promo/cut9.py [--stills | --strips]`.

It reuses `cut.py` for everything that is not the edit itself: the C2 captions, the beat grid, the credits card,
the bed and the loudness pass. What is here is the edit: SCENES (each a run of jump-cut pieces from one take,
every piece at 1x, the first piece carrying the scene's caption) and MONTAGE (the finale moments, each a whole
number of the bed's eighths from an in-point picked off a frame strip). Times are seconds into the exported file,
which is what `manifest.md` gives; the mark each one was read from is in the comment beside it.

Writes ~/.cache/cardtable-manager/trailer-cut9/ (or $TRAILER_OUT): the parts, `beats.json`, `trailer.mp4`.
--stills writes one captioned still per caption to `stills/` for checking the anchors on this footage;
--strips writes a six-frame strip of every montage shot to `strips/` for checking the in-points.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import cut
from cut import Caption, check_captions, duration, run

CLIPS = Path.home() / ".cache/cardtable-manager/trailer-clips"
OUT = Path(os.environ.get("TRAILER_OUT", Path.home() / ".cache/cardtable-manager/trailer-cut9"))
BED_COPIES = 2  # the tango is 2:04; this cut is a little longer

# (scene, take, [(in, out), ...], caption). The pieces are jump cuts within one take.
SCENES: list[tuple[str, str, list[tuple[float, float]], Caption | None]] = [
    # Two friends, the reveal and the first bans (revealed-0.5 → act-4), then the glide into the board.
    ("Gauntlet", "01-gauntlet", [(9.07, 15.0), (33.0, 38.6)],
     Caption("Play the decks that made history.", "GAUNTLET · AGAINST YOUR FRIENDS", "gauntlet-reveal", "rise")),
    # The Legacy tab and the year slider across 2008, 2014 and 2025 (legacy-0.3 → before the decklist hovers).
    ("Deck picker", "02-constructed", [(6.41, 17.2)],
     Caption("Any format. Any year.", "HISTORICAL CONSTRUCTED", "gauntlet-reveal", "wipe")),
    # Oko, Counterspell; Swan Song and Force; Pierce and Daze; the unwind to Oko countered.
    ("Counter war", "10-counterwar", [(1.5, 7.6), (9.3, 12.1), (21.5, 23.6), (29.7, 34.4)],
     Caption("Watch the stack unfold.", "COUNTER WARS", "board-right", "slide")),
    # Both players pull the same stack chip (rival-grab → just past the tug).
    ("Shared stack", "09-tug", [(6.9, 12.2)], None),
    # Scapeshift and the search; then the ten triggers, the arrows and lethal.
    ("Valakut", "03-valakut", [(1.84, 7.0), (29.6, 38.2)],
     Caption("Execute fun combos with no fuss.", "COMBOS", "board-left", "rise")),
    # Nomads loops four deep; the mill; Dread Return's Ghoul swings for the win.
    ("Cephalid Breakfast", "04-breakfast", [(3.62, 8.5), (14.2, 16.8), (34.5, 40.4)], None),
    # Loops five and six, the fastest.
    ("Thopter/Sword", "05-thopter", [(16.2, 23.4)], None),
    # The fan and picks; the grid beside the fan; the double-faced flip.
    ("Draft", "06-draft", [(4.62, 9.0), (14.7, 17.5), (19.5, 22.0)],
     Caption("Organize custom draft tournaments.", "ANY SET IN MAGIC · ANY CUSTOM CUBE", "draft-pool", "drop")),
    # Ready, paired, carried to the table, the face-off, the round's bracket.
    ("Tournament", "07-tournament", [(5.48, 12.6)],
     Caption("Run the whole tournament.", "SWISS ROUNDS · BRACKETS · STANDINGS", "faceoff", "wipe")),
    # The podium rises.
    ("Podium", "08-podium", [(3.31, 8.9)], None),
]

# The montage: (take, in-point, eighths of the bed's beat grid, zoom). Shortest is 6 eighths (cut 5: "some
# clips are cut too short"); the big ones get 8 and 10. Emrakul's landing last, then Progenitus whole.
Z = (1.3, 760, 560)
MONTAGE: list[tuple[str, float, int, tuple[float, float, float] | None]] = [
    ("16-m-thoughtseize", 13.1, 6, Z),   # stack:0 13.61, life 14.41
    ("15-m-swords", 9.0, 6, Z),          # stack:0 9.29, life 10.09
    ("14-m-bolt-bob", 8.95, 6, Z),       # stack:0 9.56, peak 9.09
    ("23-m-gary", 5.2, 6, Z),            # stack:0 5.36, life 6.16
    ("19-m-pyroclasm", 5.9, 6, Z),       # stack:0 6.23, peak 6.20
    ("20-m-wrath", 6.9, 6, Z),           # stack:0 7.24, peak 7.27
    ("26-m-tremors", 7.0, 8, Z),         # first drain 7.46, chain to 10.15
    ("28-storm", 32.9, 8, Z),            # copies 30.04, drains 33.38 → 34.28
    ("29-craterhoof", 16.9, 8, Z),       # declared 17.36, hits to 18.98
    ("31-blasphemous", 8.9, 6, Z),       # stack:0 8.66, wiped 8.80, the wipe peaks 9.98
    ("25-m-worldfire", 7.0, 6, Z),       # life 7.56, settled 8.47
    ("30-emrakul", 6.0, 10, Z),          # landed 6.99
]
# Anchors this footage needs (measured on `--stills`): the Classic room's title row now holds the year
# slider and Room settings, so the deck picker's caption sits in the seating panel's empty right half, where
# the Gauntlet's does (entering differently); the draft headline is smaller to clear the fan/grid toggle.
cut.ANCHORS["draft-pool"] = cut.Anchor(156, 900, "left", 50)

FINAL = ("Progenitus", "33-progenitus", (7.2, 11.9))  # declared-0.4 → win+1.5


def src(take: str) -> Path:
    return CLIPS / f"{take}.mp4"


def stills() -> None:
    (OUT / "stills").mkdir(parents=True, exist_ok=True)
    for n, (scene, take, pieces, cap) in enumerate(SCENES):
        if cap is None:
            continue
        a, b = pieces[0]
        part = cut.render_clip(n, take, a, b, cap, "still", source=src(take))
        run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "2.0", "-i", str(part), "-frames:v", "1", "-q:v", "3", str(OUT / "stills" / f"{n:02d}-{take}.jpg")])


def strips() -> None:
    (OUT / "strips").mkdir(parents=True, exist_ok=True)
    for take, t, eighths, _ in MONTAGE:
        length = eighths * 0.234
        run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.3f}", "-t", f"{length:.3f}", "-i", str(src(take)),
             "-vf", f"fps={6 / length:.4f},scale=480:-1,tile=6x1", "-frames:v", "1", "-q:v", "4", str(OUT / "strips" / f"{take}.jpg")])


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    cut.OUT = OUT
    cut.MUSIC = OUT / "bed.flac"
    # A copy of cut.py's TANGO: prod's data directory is moving out of the code tree, taking the take with it.
    cut.TANGO = OUT / "hellfire-tango-take-1.ogg"
    if not cut.TANGO.exists():
        sys.exit(f"cut9: no bed source at {cut.TANGO}; copy Hellfire Tango's take-1.ogg there")
    check_captions([(s[1], None, None, s[3]) for s in SCENES])
    if "--stills" in sys.argv:
        return stills()
    if "--strips" in sys.argv:
        return strips()
    cut.make_bed(BED_COPIES)
    beats = cut.onsets(cut.MUSIC)
    parts: list[Path] = []
    rows: list[dict] = []
    at = 0.0
    n = 0
    for scene, take, pieces, cap in SCENES:
        for k, (a, b) in enumerate(pieces):
            part = cut.render_clip(n, take, a, b, cap if k == 0 else None, f"p{k}", source=src(take))
            length = duration(part)
            rows.append({"at": round(at, 3), "length": round(length, 3), "scene": scene, "clip": f"{take}.mp4", "in": a, "out": b,
                         "caption": None if cap is None or k else {"text": cap.text, "kicker": cap.kicker, "anchor": cap.anchor, "entrance": cap.entrance}})
            parts.append(part)
            at += length
            n += 1
    # The montage starts on the beat: the last scene piece is lengthened to the grid's next line.
    grid = cut.beat_grid(beats, at - 1, at + 30)
    cuts = cut.montage_cuts(grid, at, [m[2] for m in MONTAGE])
    if cuts[0] > at + 0.01:
        last = rows[-1]
        extra = cuts[0] - at
        take = last["clip"][:-4]
        last["out"] = round(last["out"] + extra, 3)
        parts[-1] = cut.render_clip(n - 1, take, last["in"], last["out"], None, f"p{len(SCENES[-1][2]) - 1}", source=src(take))
        last["length"] = round(duration(parts[-1]), 3)
        at = last["at"] + last["length"]
    for k, (take, t, _eighths, zoom) in enumerate(MONTAGE):
        length = cuts[k + 1] - cuts[k]
        part = cut.render_clip(n, take, t, t + length, None, f"m{k:02d}", zoom, source=src(take))
        rows.append({"at": round(at, 3), "length": round(duration(part), 3), "scene": "Finale", "clip": f"{take}.mp4", "in": t, "out": round(t + length, 3), "caption": None, "montage": True})
        parts.append(part)
        at += duration(part)
        n += 1
    scene, take, (a, b) = FINAL
    part = cut.render_clip(n, take, a, b, None, "final", source=src(take))
    rows.append({"at": round(at, 3), "length": round(duration(part), 3), "scene": scene, "clip": f"{take}.mp4", "in": a, "out": b, "caption": None})
    parts.append(part)
    at += duration(part)
    n += 1
    part = cut.render_card(n, "END")
    rows.append({"at": round(at, 3), "length": round(duration(part), 3), "scene": "Credits", "clip": None, "caption": None})
    parts.append(part)
    (OUT / "beats.json").write_text(json.dumps(rows, indent=2))
    listing = OUT / "parts.txt"
    listing.write_text("".join(f"file '{p}'\n" for p in parts))
    joined = OUT / "joined.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(joined)])
    total = duration(joined)
    mix = (
        f"[1:a]atrim=0:{total:.2f},asetpts=PTS-STARTPTS,volume={cut.BED_LEVEL},afade=t=in:d=0.8,afade=t=out:st={total - 3:.2f}:d=3[bed];"
        f"[0:a]volume=1.0[game];[game][bed]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-15:TP=-1.5:LRA=11,aresample=48000[a]"
    )
    trailer = OUT / "trailer.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(joined), "-i", str(cut.MUSIC), "-filter_complex", mix,
         "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", str(trailer)])
    print(f"cut9: {trailer}  {total:.1f}s")


if __name__ == "__main__":
    main()
