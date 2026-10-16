"""Close a picking pass: name what the operator chose, archive it, retire the rest.

A take the operator placed in a cell (or marked keep) is chosen. Each chosen
take moves to a folder named after the cell it plays in (`g.phase/`,
`u-basic/`, `rw-land/`) as `take-<n>.ogg`, and its label becomes the cell's
name ("Phase change 2", "Island 1"). Every catalogue reference follows:
assignments, marks. `sources.json` keeps new name -> generated name, so
`finish.py --into` still finds a renamed take's raw render. A copy of every
chosen take goes to ~/.local/share/cardtable-sfx/chosen/ under its new name.

Everything else in the catalogue is retired as `unused` (moved to `retired/`,
logged in `retired.jsonl`), which `retired.py` counts but does not treat as
feedback on the prompt.

    python3 scripts/sfx/harvest.py apps/server/data/sounds [--dry-run]
"""

import argparse
import datetime
import json
import os
import re
import shutil

ROOT = os.path.expanduser('~/.local/share/cardtable-sfx')
SHARED = os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'shared', 'src', 'sounds.ts')


def names():
    """Role names, colour names, paradigm names and basic land names, read from the shared module."""
    src = open(SHARED, encoding='utf-8').read()
    roles = dict(re.findall(r"\b(?:ui|game|music)\('([^']+)', '([^']+)'", src))
    colours = dict(re.findall(r"\{ id: '([A-Z]+)', name: '([^']+)', sub:", src))
    colours['WUBRG'] = 'Four colours or more'
    paradigms = dict(re.findall(r"\{ id: '([a-z-]+)', name: '([^']+)' \}", src))
    lands = dict(re.findall(r"([WUBRG]): '([A-Z][a-z]+)'", src.split('landNames: {')[1].split('}')[0]))
    return roles, colours, paradigms, lands


def cell_name(cell, roles, colours, paradigms, lands):
    row, col = cell.split('|')
    if col == 'play':
        return roles.get(row, row)
    if col == 'basic':
        return lands[row]
    return f"{colours[row]} {paradigms[col].lower()}"


def cell_folder(cell):
    """`g.phase` for a role, `u-basic` for a colour cell: a role id always has a dot, so the two never meet."""
    row, col = cell.split('|')
    return row if col == 'play' else f"{row.lower()}-{col}"


def json_write(path, value):
    part = path + '.tmp'
    json.dump(value, open(part, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    os.replace(part, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir', help='the sounds dir: catalogue.json, assignments.json, takes/')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    d = args.dir
    tables = names()

    catalogue = json.load(open(os.path.join(d, 'catalogue.json'), encoding='utf-8'))
    assignments = json.load(open(os.path.join(d, 'assignments.json'), encoding='utf-8'))
    marks_path = os.path.join(d, 'marks.json')
    marks = json.load(open(marks_path, encoding='utf-8')) if os.path.exists(marks_path) else {'marks': {}}
    sources_path = os.path.join(d, 'sources.json')
    sources = json.load(open(sources_path, encoding='utf-8')) if os.path.exists(sources_path) else {}

    home = {}  # chosen file -> (folder, label stem): its first cell, or its own folder when only marked keep
    for cell, files in assignments['cells'].items():
        for file in files:
            home.setdefault(file, (cell_folder(cell), cell_name(cell, *tables)))
    for file, mark in marks['marks'].items():
        if mark == 'keep' and file not in home:
            take = next((t for t in catalogue['takes'] if t['file'] == file), None)
            if take:
                home[file] = (file.split('/')[0], take['name'])

    used = set()  # every name ever handed out, in takes/ or retired/, so a later pass never collides
    for sub in ('takes', 'retired'):
        for folder, _, files in os.walk(os.path.join(d, sub)):
            used.update(f"{os.path.relpath(folder, os.path.join(d, sub))}/{f}" for f in files)

    def fresh(folder):
        n = 1
        while f"{folder}/take-{n}.ogg" in used:
            n += 1
        used.add(f"{folder}/take-{n}.ogg")
        return f"{folder}/take-{n}.ogg", n

    renamed, kept, retired = {}, [], []
    for take in catalogue['takes']:
        file = take['file']
        if file not in home:
            retired.append(take)
            continue
        folder, stem = home[file]
        if re.fullmatch(r'take-\d+\.ogg', file.split('/')[1]) and file.split('/')[0] == folder:
            new = file  # already harvested by an earlier pass
        else:
            new, n = fresh(folder)
            renamed[file] = new
            take = {**take, 'file': new, 'label': f"{stem} {n}"}
        kept.append(take)

    print(f"{len(kept)} chosen ({len(renamed)} renamed), {len(retired)} retired")
    if args.dry_run:
        for old, new in list(renamed.items())[:12]:
            print(f"  {old} -> {new}")
        return

    for old, new in renamed.items():
        target = os.path.join(d, 'takes', new)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.move(os.path.join(d, 'takes', old), target)
        sources[new] = sources.pop(old, old)
    at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with open(os.path.join(d, 'retired.jsonl'), 'a', encoding='utf-8') as log:
        for take in retired:
            target = os.path.join(d, 'retired', take['file'])
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.move(os.path.join(d, 'takes', take['file']), target)
            log.write(json.dumps({'at': at, 'action': 'retire', 'file': take['file'], 'reason': 'unused', 'take': take, 'cells': []}) + '\n')

    assignments['cells'] = {cell: [renamed.get(f, f) for f in files] for cell, files in assignments['cells'].items()}
    marks['marks'] = {renamed.get(f, f): m for f, m in marks['marks'].items() if renamed.get(f, f) in {t['file'] for t in kept}}
    json_write(sources_path, sources)
    json_write(marks_path, marks)
    json_write(os.path.join(d, 'assignments.json'), assignments)
    catalogue['takes'] = kept
    json_write(os.path.join(d, 'catalogue.json'), catalogue)
    for folder, _, files in os.walk(os.path.join(d, 'takes'), topdown=False):
        if not files and not os.listdir(folder):
            os.rmdir(folder)

    chosen = os.path.join(ROOT, 'chosen')
    for take in kept:
        target = os.path.join(chosen, take['file'])
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(os.path.join(d, 'takes', take['file']), target)
    json_write(os.path.join(chosen, 'catalogue.json'), {'takes': kept, 'sources': {t['file']: sources.get(t['file'], t['file']) for t in kept}})
    print(f"archived to {chosen}")


if __name__ == '__main__':
    main()
