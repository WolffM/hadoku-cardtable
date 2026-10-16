"""Write round8.json (2026-10-15): siblings of the takes the operator chose, for the cells heard most often.

The operator, after harvesting round 7: *"see if you can do another set generating sounds for the things that
trigger the most often. take another look at the logs"*. Often is `played.py`'s raises per game per take. What the
picks taught: the operator chooses a sound, not a description of the event (a creature take plays on "Hover a
card", a clasp click on "Life gain", a crunch on "Your priority"), so a cell's new takes are its chosen takes
rendered again from their own sidecar (prompt, negative, length, steps, cfg) under new seeds: the same source, a
different performance. The more a take repeats, the more siblings it gets. The two cells nobody has filled yet get
fresh prompts written to round 6's rules (one literal real-world source, no bells for a quick sound).

    python3 scripts/sfx/played.py apps/server/data/sounds > played.json
    python3 scripts/sfx/make-round8.py apps/server/data/sounds played.json
"""
import json
import math
import os
import re
import sys

ROOT = os.path.expanduser('~/.local/share/cardtable-sfx')
OFTEN = 2.0  # raises per game per take before a cell gets siblings
FRESH = {
    'g.mana': ('Turn and game', 'Mana', 1.0, [
        'A short soft crackle of a small spark, one quick tick',
        'A small smooth pebble tapped once against a stone, a light dry tick',
        'A quick soft puff of breath into cupped hands']),
    'g.turn-theirs': ('Turn and game', "Their turn", 2.0, [
        'Single small brass bell struck once very softly and muffled by a hand, a short low ring',
        'One low soft knock on a thick wooden door across the room',
        'A heavy wooden chess piece set down on a board, one soft dry knock']),
}


def cell_folder(cell):
    row, col = cell.split('|')
    return row if col == 'play' else f"{row.lower()}-{col}"


def sidecar(source):
    """The raw render's settings for a catalogued file name, and whether the chosen take was it reversed."""
    folder, stem = source.split('/')
    stem = stem[:-4]
    reverse = stem.startswith('take-rev-')
    stem = re.sub(r'^take-rev-', 'take-', re.sub(r'-(first|half)$', '', stem))
    for name in os.listdir(os.path.join(ROOT, 'generated')):
        if name.lower() == folder:
            path = os.path.join(ROOT, 'generated', name, stem + '.json')
            if os.path.exists(path):
                return json.load(open(path)), reverse
    return None, reverse


def main():
    sounds_dir, played = sys.argv[1], json.load(open(sys.argv[2]))
    cells = json.load(open(os.path.join(sounds_dir, 'assignments.json')))['cells']
    sources = json.load(open(os.path.join(sounds_dir, 'sources.json')))
    names = {t['file']: t for t in json.load(open(os.path.join(sounds_dir, 'catalogue.json')))['takes']}
    sounds, missing = {}, []
    for row in played['rows']:
        role = row['role'][len('cell:'):] if row['role'].startswith('cell:') else f"{row['role']}|play"
        files = cells.get(role, [])
        if not files or row['perTake'] < OFTEN:
            continue
        total = max(4, min(8, math.ceil(row['perTake'] / 4) + 3))
        prompts = []
        for file in files:
            meta, reverse = sidecar(sources.get(file, file))
            if meta is None:
                missing.append(file)
                continue
            prompts.append({'prompt': meta['prompt'], 'negative': meta['negative'], 'seconds': meta['seconds'],
                            'steps': meta['steps'], 'cfg': meta['cfg'], 'reverse': reverse,
                            'takes': math.ceil(total / len(files))})
        if prompts:
            first = names[files[0]]['label'].rsplit(' ', 1)[0]
            section = 'Colour sounds' if not role.endswith('|play') else 'Moments'
            sounds[cell_folder(role)] = {'group': 'Round 8', 'name': first, 'section': section, 'prompts': prompts}
    for rid, (group, name, seconds, prompts) in FRESH.items():
        sounds[rid] = {'group': group, 'name': name, 'section': 'Moments', 'seconds': seconds, 'prompts': prompts}
    spec = {
        'note': 'Round 8 (2026-10-15): see make-round8.py.',
        'suffix': 'High-quality, stereo, 44.1kHz, sound effect, close-mic.',
        'negative': 'low quality, muffled, lo-fi, hiss, distortion, clipping, chime, chimes, gong, glockenspiel, '
                    'music, melody, song, speech, voice, vocals, singing, harsh, shrill',
        'seconds': 2.5,
        'sounds': sounds,
    }
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'round8.json')
    json.dump(spec, open(out, 'w'), indent=1, ensure_ascii=False)
    renders = sum(p['takes'] if isinstance(p, dict) else 2 for s in sounds.values() for p in s['prompts'])
    print(f"{len(sounds)} sounds, {renders} renders -> {out}; no sidecar for {missing}")


if __name__ == '__main__':
    main()
