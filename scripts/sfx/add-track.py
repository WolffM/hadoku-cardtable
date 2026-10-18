#!/usr/bin/env python3
"""Add a music track to the sound builder's catalogue.

    python3 scripts/sfx/add-track.py <file> --name "Tavern loop" \\
        --credit "Tavern loop by Someone, CC-BY 4.0, https://…" --to <sounds dir>

Transcodes the file to Opus (stereo, 128 kbit/s) at
`<sounds dir>/takes/music-<slug>/take-1.ogg` (served at `/api/sounds/audio/…`) and merges one catalogue entry in
the Music section, so it shows up in `#/sounds` ready to place on
`music.lobby`, `music.match`, a colour's `music.match.<W|U|B|R|G>` or a pair's `music.match.<WU|UB|…>` (spelled
as `COLOUR_PAIRS` in `packages/shared/src/sounds.ts`), or either one's 16-bit role `music.match.<code>.16bit`. The credit is stored as the entry's prompt (the
builder shows it on hover) and MUST also go in `NOTICE.md`: a track is only
usable under a licence that allows it (CC0, CC-BY or similar), with its
attribution. Audio never enters this repo: the sounds dir is the server's data
directory, outside git.
"""
import argparse
import json
import os
import re
import subprocess


def main() -> None:
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument('file', help='the source audio file (any format ffmpeg reads)')
	ap.add_argument('--name', required=True, help='the name the builder shows')
	ap.add_argument('--credit', required=True, help='title, author, licence and source URL')
	ap.add_argument('--to', required=True, dest='dest', help='the sounds dir (CARDTABLE_SOUNDS_DIR)')
	args = ap.parse_args()

	slug = re.sub(r'[^a-z0-9]+', '-', args.name.lower()).strip('-')
	if slug == '':
		raise SystemExit('--name needs at least one letter or digit')
	folder = f'music-{slug}'
	rel = f'{folder}/take-1.ogg'
	out = os.path.join(args.dest, 'takes', folder, 'take-1.ogg')
	os.makedirs(os.path.dirname(out), exist_ok=True)
	subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', args.file, '-ac', '2', '-c:a', 'libopus', '-b:a', '128k', out], check=True)
	seconds = float(subprocess.run(
		['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out],
		check=True, capture_output=True, text=True,
	).stdout.strip())

	catalogue_path = os.path.join(args.dest, 'catalogue.json')
	catalogue = json.load(open(catalogue_path, encoding='utf-8')) if os.path.exists(catalogue_path) else {'takes': []}
	takes = [t for t in catalogue['takes'] if t['file'] != rel]
	takes.append({
		'file': rel,
		'sound': folder,
		'name': args.name,
		'group': 'Music',
		'section': 'Music',
		'label': args.name,
		'seconds': round(seconds, 3),
		'prompt': args.credit,
	})
	tmp = catalogue_path + '.add-track.tmp'
	with open(tmp, 'w', encoding='utf-8') as f:
		json.dump({'takes': takes}, f, ensure_ascii=False, indent=1)
	os.replace(tmp, catalogue_path)
	print(f'{rel}: {seconds:.1f}s added. Put this credit in NOTICE.md: {args.credit}')


if __name__ == '__main__':
	main()
