#!/usr/bin/env python3
"""Import sound-builder takes into the server's data directory.

Reads a `finished/` snapshot — a per-folder `manifest.json` whose entries carry
`{file, prompt, seconds, ...}`, the shape `scripts/sfx/finish.py` writes — and
produces the three things `apps/server/src/http/sounds.ts` serves:

  <to>/catalogue.json          { takes: SoundTake[] }
  <to>/takes/<folder>/<file>   the copied .ogg bytes
  <to>/assignments.json        { cells: Record<CellId, string[]> }, from --seed

Labels, groups and sections mirror the operator-approved artifact's own
catalogue build (`docs/handoff/snapshot/stage-builder.py`, read-only
reference). Colour-identity names/families match
`packages/shared/src/sounds.ts`'s `SOUND_MATRIX` — the wave 50 "Settled"
contract. `m-*` take folders are named for the bin only: the builder's cells
are `SOUND_ROLES` ids (`g.draw|play`, …), so an `m-*|play` cell in a --seed
is dropped by the server on read. Library sound names and groups DO come from
`scripts/sfx/round3.json`, which is current and, checked against this
snapshot, covers every `lib-*` folder in it.

Usage:
    python3 scripts/sfx/import.py --from <finished dir> --seed <assignments.json> \\
        --to <sounds dir> [--force]

`--force` lets a re-run overwrite an existing `assignments.json` from `--seed`;
without it, an existing `assignments.json` is left alone (an admin's own
edits, made through the builder, must never be clobbered by a re-import).
`catalogue.json` has no such guard: it is rebuilt from `--from` every run, by
design — it describes what audio exists, not anything an admin edited.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil

# ── Colour identities and events ───────────────────────────────────────────
# Must match packages/shared/src/sounds.ts's SOUND_MATRIX. Duplicated here
# rather than imported because this is a one-off Python import tool with no
# dependency on the TypeScript workspace.
COLOUR_NAMES = {
	'W': 'White', 'U': 'Blue', 'B': 'Black', 'R': 'Red', 'G': 'Green',
	'WU': 'Azorius', 'UB': 'Dimir', 'BR': 'Rakdos', 'RG': 'Gruul', 'GW': 'Selesnya',
	'WB': 'Orzhov', 'UR': 'Izzet', 'BG': 'Golgari', 'RW': 'Boros', 'GU': 'Simic',
	'GWU': 'Bant', 'WUB': 'Esper', 'UBR': 'Grixis', 'BRG': 'Jund', 'RGW': 'Naya',
	'WBG': 'Abzan', 'URW': 'Jeskai', 'BGU': 'Sultai', 'RWB': 'Mardu', 'GUR': 'Temur',
	'WUBRG': 'Four colours or more', 'C': 'Colourless',
}
EVENT_NAMES = {
	'm-draw': 'Draw a card', 'm-shuffle': 'Shuffle', 'm-tapcard': 'Tap or untap a card',
	'm-resolve': 'Spell resolves', 'm-attack': 'Creature attacks', 'm-block': 'Block',
	'm-damage': 'Damage to a creature', 'm-damage-player': 'Damage to a player or planeswalker',
	'm-dies': 'Creature dies', 'm-phase': 'Phase change', 'm-turn': 'Your turn',
	'm-win': 'Victory', 'm-lose': 'Defeat',
}
# The mono identity letter -> this snapshot's land-take folder name -> its basic land's display
# name. A mono identity's Basic land cell is hinted with its basic land (Settled; split from Land 2026-10-10).
MONO_LAND_FOLDER = {'W': 'land-plains', 'U': 'land-island', 'B': 'land-swamp', 'R': 'land-mountain', 'G': 'land-forest'}
LAND_NAMES = {'land-plains': 'Plains', 'land-island': 'Island', 'land-swamp': 'Swamp', 'land-mountain': 'Mountain', 'land-forest': 'Forest'}

SECTION_ORDER = {'Library': 0, 'Land types': 1, 'Moments': 2, 'Colour sounds': 3, 'Music': 4}


def label_for(filename: str, name: str) -> str:
	"""Mirrors `stage-builder.py`'s `label_for`: a short suffix distinguishing takes of the same sound."""
	stem = os.path.splitext(filename)[0]
	if stem.startswith('take-synth'):
		return f'{name} · hand-rolled'
	m = re.match(r'take-v(\d+)-(\d+)$', stem)
	if m:
		# Seeds are generated in groups of up to 8 from a round number (4000-4003,
		# 11000-11007); the low three bits pick a..h within the group.
		return f"{name} · {m.group(1)}{'abcdefgh'[int(m.group(2)) % 8]}"
	if stem.startswith('take-'):
		return f'{name} · r1 {stem[5:]}'
	return f'{name} · {stem}'


def classify(folder: str, lib_names: dict) -> tuple[str, str, str, str]:
	"""(sound, name, group, section) for a manifest folder — mirrors `stage-builder.py`'s own
	dispatch. A colour identity's spell/creature/land/r2 takes all collapse onto the SAME
	sound/name/group (the bin pools them as one pill row); only the five basic lands get their
	own distinct "Land types" pool."""
	base = folder.split('.')[0]
	# Round 5 names every folder it made, colour cells included ("Boros land", in its own section).
	entry = lib_names.get(folder)
	if entry is not None and 'section' in entry:
		return folder, entry['name'], entry['group'], entry['section']
	if folder.startswith('lib-'):
		entry = lib_names.get(folder)
		if entry is not None:
			return folder, entry['name'], entry['group'], 'Library'
		# No entry in round3.json: derive a plausible label rather than fail the import.
		return folder, folder[len('lib-'):].replace('-', ' ').capitalize(), 'Objects', 'Library'
	if folder.startswith('land-'):
		return folder, LAND_NAMES.get(folder, folder), 'Land types', 'Land types'
	if folder.endswith('.land') and base in MONO_LAND_FOLDER:
		sound = MONO_LAND_FOLDER[base]
		return sound, LAND_NAMES[sound], 'Land types', 'Land types'
	if base.startswith('m-'):
		return base, EVENT_NAMES.get(base, base), 'Moments', 'Moments'
	if folder.startswith(('ui.', 'g.')):
		# Round 4: the folder is a role id, named in round4.json.
		entry = lib_names.get(folder, {'name': folder, 'group': 'Moments'})
		return folder, entry['name'], entry['group'], 'Moments'
	name = COLOUR_NAMES.get(base, base)
	return base, name, name, 'Colour sounds'


def lower_take_path(path: str) -> str:
	"""`<folder>/<file>` with the folder segment lowercased — the server's
	`TAKE_FILE_RE` (`@hadoku/shared`) is lowercase-only, but a source folder
	carries the colour code's own case (`BG.land`). The filename is left
	alone: every filename in this snapshot is already lowercase."""
	folder, _, filename = path.partition('/')
	return f'{folder.lower()}/{filename}'


def main() -> None:
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument('--from', dest='src', required=True, help='the finished/ dir (manifest.json + per-folder .ogg takes)')
	ap.add_argument('--seed', help='an assignments.json (or exported seed) to pre-populate assignments.json')
	ap.add_argument('--to', required=True, dest='dest', help='the destination sounds dir (CARDTABLE_SOUNDS_DIR)')
	ap.add_argument('--force', action='store_true', help='overwrite an existing assignments.json from --seed')
	ap.add_argument('--add', action='store_true',
		help="append --from's takes to the existing catalogue and keep every entry already there, renames included "
		     "(a new round in folders that also hold placed takes; --merge would drop those)")
	ap.add_argument('--merge', action='store_true',
		help="add --from's takes to the existing catalogue instead of rebuilding it (folders in --from replace their old entries)")
	args = ap.parse_args()

	manifest = json.load(open(os.path.join(args.src, 'manifest.json'), encoding='utf-8'))

	lib_names: dict = {}
	for spec in ('round3.json', 'round4.json', 'round5.json', 'round8.json'):
		spec_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), spec)
		if os.path.exists(spec_path):
			lib_names.update(json.load(open(spec_path, encoding='utf-8'))['sounds'])

	takes = []
	for folder, items in manifest.items():
		sound, name, group, section = classify(folder, lib_names)
		for item in items:
			filename = os.path.basename(item['file'])
			takes.append({
				'file': lower_take_path(f'{folder}/{filename}'),
				'sound': sound,
				'name': name,
				'group': group,
				'section': section,
				'label': label_for(filename, name),
				'seconds': item['seconds'],
				'prompt': item['prompt'],
			})
	if args.add:
		catalogue_path = os.path.join(args.dest, 'catalogue.json')
		existing = json.load(open(catalogue_path, encoding='utf-8'))['takes'] if os.path.exists(catalogue_path) else []
		known = {t['file'] for t in existing}
		takes = existing + [t for t in takes if t['file'] not in known]
	elif args.merge:
		catalogue_path = os.path.join(args.dest, 'catalogue.json')
		if os.path.exists(catalogue_path):
			replaced = {folder.lower() for folder in manifest}
			kept = [t for t in json.load(open(catalogue_path, encoding='utf-8'))['takes'] if t['file'].split('/')[0] not in replaced]
			takes = kept + takes
	takes.sort(key=lambda t: (SECTION_ORDER.get(t['section'], 9), t['group'], t['name'], t['file']))

	takes_dir = os.path.join(args.dest, 'takes')
	os.makedirs(takes_dir, exist_ok=True)
	copied = 0
	for folder, items in manifest.items():
		dest_folder = os.path.join(takes_dir, folder.lower())
		os.makedirs(dest_folder, exist_ok=True)
		for item in items:
			filename = os.path.basename(item['file'])
			shutil.copyfile(os.path.join(args.src, folder, filename), os.path.join(dest_folder, filename))
			copied += 1

	os.makedirs(args.dest, exist_ok=True)
	with open(os.path.join(args.dest, 'catalogue.json'), 'w', encoding='utf-8') as f:
		json.dump({'takes': takes}, f, ensure_ascii=False, indent=1)

	assignments_path = os.path.join(args.dest, 'assignments.json')
	cell_count = 0
	if args.seed and (args.force or not os.path.exists(assignments_path)):
		seed = json.load(open(args.seed, encoding='utf-8'))
		cells = {cell: [lower_take_path(f) for f in files] for cell, files in seed.get('cells', {}).items()}
		with open(assignments_path, 'w', encoding='utf-8') as f:
			json.dump({'cells': cells}, f, ensure_ascii=False, indent=1)
		cell_count = len(cells)
	elif os.path.exists(assignments_path):
		cell_count = len(json.load(open(assignments_path, encoding='utf-8')).get('cells', {}))

	print(f'{len(takes)} takes, {copied} files copied, {len(manifest)} folders, {cell_count} cells assigned -> {args.dest}')


if __name__ == '__main__':
	main()
