#!/usr/bin/env python3
"""
Write cut 9 as a Shotcut project (MLT XML) for editing by hand: `python3 e2e/promo/shotcut.py`.

V1 holds every shot of `beats.json` as an entry on its raw take in ~/.cache/cardtable-manager/trailer-clips/, so
any edge can be dragged past the cut into the rest of the take. Montage shots carry cut.py's 1.3x zoom as a
Size, Position & Rotate filter, captioned shots carry their words as a Text: Simple filter (a placeholder for
the C2 look, which ffmpeg draws), and the credits are the rendered card. A1 is the Hellfire Tango bed at
cut.BED_LEVEL. The playlist holds all 33 takes and the bed, for dragging in what this cut leaves out.

Writes ~/.cache/cardtable-manager/trailer-cut9/edit/cut9.mlt (or $TRAILER_OUT/edit/). Run cut9.py first.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

import cut
import cut9

FPS = 60
OUT = Path(os.environ.get("TRAILER_OUT", cut9.OUT))
ZOOMS = {take: zoom for take, _t, _e, zoom in cut9.MONTAGE}


def frames(seconds: float) -> int:
    return round(seconds * FPS)


def props(**kv: object) -> str:
    return "".join(f'<property name="{k.replace("__", ":").replace("_dot_", ".")}">{escape(str(v))}</property>' for k, v in kv.items())


def length_of(path: Path) -> int:
    return math.floor(cut.duration(path) * FPS)


def zoom_filter(zoom: tuple[float, float, float]) -> str:
    """The same crop render_clip makes, as the rect the whole frame is scaled into."""
    f, cx, cy = zoom
    w, h = round(1920 / f / 2) * 2, round(1080 / f / 2) * 2
    x, y = min(max(0, round(cx - w / 2)), 1920 - w), min(max(0, round(cy - h / 2)), 1080 - h)
    sx, sy = 1920 / w, 1080 / h
    rect = f"{-x * sx:.1f} {-y * sy:.1f} {1920 * sx:.1f} {1080 * sy:.1f} 1"
    return ('<filter>' + props(
        mlt_service="affine", shotcut__filter="affineSizePosition", background="color:#00000000",
        transition_dot_rect=rect, transition_dot_fill=1, transition_dot_distort=0,
        transition_dot_halign="left", transition_dot_valign="top", transition_dot_threads=0) + "</filter>")


def caption_filter(cap: dict) -> str:
    a = cut.ANCHORS[cap["anchor"]]
    x = a.x if a.align == "left" else a.x - 1100
    return ('<filter>' + props(
        mlt_service="dynamictext", shotcut__filter="dynamicText", argument=f'{cap["kicker"]}\n{cap["text"]}',
        geometry=f"{x} {a.y - 130} 1100 200 1", family="Sans", size=a.size, weight=700, style="normal",
        fgcolour="#ffffffff", bgcolour="#00000000", olcolour="#cc000000", outline=3, pad=0,
        halign=a.align, valign="bottom") + "</filter>")


def main() -> None:
    rows = json.loads((OUT / "beats.json").read_text())
    takes = sorted(cut9.CLIPS.glob("[0-9][0-9]-*.mp4"))
    end_card = next(OUT.glob("*-end.mp4"))
    bed = OUT / "bed.flac"
    sources = [*takes, end_card, bed]
    lengths = {p: length_of(p) for p in sources}
    ids = {p: f"clip{k}" for k, p in enumerate(sources)}

    def producer(cid: str, path: Path, caption: str) -> str:
        n = lengths[path]
        return (f'<producer id="{cid}" out="{n - 1}">' + props(
            length=n, eof="pause", resource=path, mlt_service="avformat-novalidate", seekable=1,
            audio_index=1 if path.suffix == ".mp4" else 0, video_index=0 if path.suffix == ".mp4" else -1,
            shotcut__caption=caption) + "</producer>")

    body: list[str] = [producer(ids[p], p, p.stem) for p in sources]
    bin_entries = "".join(f'<entry producer="{ids[p]}" in="0" out="{lengths[p] - 1}"/>' for p in sources)

    # A filter's in/out would count from the take's start, not the entry's; with neither it spans the whole
    # producer, and every timeline entry is its own producer, so a filter on one shot stays on that shot. (Producers, not MLT 7
    # chains: melt 7.41 hangs rendering a chain's audio.)
    v1: list[str] = []
    for k, r in enumerate(rows):
        path = cut9.CLIPS / r["clip"] if r["clip"] else end_card
        a, b = (frames(r["in"]), frames(r["out"]) - 1) if r["clip"] else (0, lengths[end_card] - 1)
        filters = ""
        take = path.stem
        if r.get("montage") and ZOOMS.get(take):
            filters += zoom_filter(ZOOMS[take])
        if r["caption"]:
            filters += caption_filter(r["caption"])
        cid = f"shot{k}"
        n = lengths[path]
        body.append(f'<producer id="{cid}" out="{n - 1}">' + props(
            length=n, eof="pause", resource=path, mlt_service="avformat-novalidate", seekable=1,
            audio_index=1, video_index=0, shotcut__caption=f'{r["scene"]} · {take}') + filters + "</producer>")
        v1.append(f'<entry producer="{cid}" in="{a}" out="{b}"/>')

    total = frames(rows[-1]["at"] + rows[-1]["length"])
    gain = 20 * math.log10(cut.BED_LEVEL)
    body.append(f'<producer id="bedtrack" out="{lengths[bed] - 1}">' + props(
        length=lengths[bed], eof="pause", resource=bed, mlt_service="avformat-novalidate", seekable=1,
        audio_index=0, video_index=-1, shotcut__caption="Hellfire Tango bed")
        + '<filter>' + props(mlt_service="volume", shotcut__filter="audioGain", level=f"{gain:.2f}") + "</filter>"
        + "</producer>")

    xml = f"""<?xml version="1.0" standalone="no"?>
<mlt LC_NUMERIC="C" version="7.41.0" title="Card Table trailer, cut 9" producer="main_bin">
  <profile description="HD 1080p 60 fps" width="1920" height="1080" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" frame_rate_num="60" frame_rate_den="1" colorspace="709"/>
  <playlist id="main_bin">{props(xml_retain=1)}{bin_entries}</playlist>
  <producer id="black" in="0" out="{total - 1}">{props(length=total, eof="pause", resource=0, aspect_ratio=1, mlt_service="color", mlt_image_format="rgba", set_dot_test_audio=0)}</producer>
  <playlist id="background"><entry producer="black" in="0" out="{total - 1}"/></playlist>
  {"".join(body)}
  <playlist id="playlist0">{props(shotcut__video=1, shotcut__name="V1")}{"".join(v1)}</playlist>
  <playlist id="playlist1">{props(shotcut__audio=1, shotcut__name="A1")}<entry producer="bedtrack" in="0" out="{total - 1}"/></playlist>
  <tractor id="tractor0" title="Card Table trailer, cut 9" in="0" out="{total - 1}">
    {props(shotcut=1, shotcut__projectAudioChannels=2, shotcut__projectFolder=0)}
    <track producer="background"/>
    <track producer="playlist0"/>
    <track producer="playlist1" hide="video"/>
    <transition>{props(a_track=0, b_track=1, mlt_service="mix", always_active=1, sum=1)}</transition>
    <transition>{props(a_track=0, b_track=1, version=0.1, mlt_service="frei0r.cairoblend", threads=0, disable=1)}</transition>
    <transition>{props(a_track=0, b_track=2, mlt_service="mix", always_active=1, sum=1)}</transition>
  </tractor>
</mlt>
"""
    (OUT / "edit").mkdir(parents=True, exist_ok=True)
    project = OUT / "edit" / "cut9.mlt"
    project.write_text(xml)
    print(f"shotcut: {project}  {len(v1)} shots, {total / FPS:.1f}s")


if __name__ == "__main__":
    main()
