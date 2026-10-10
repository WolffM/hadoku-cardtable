"""What the operator threw out, as feedback for the next generation batch.

The sound picker's Delete (bad) and Shift+Delete (broken) retire a take and
append a line to `<sounds dir>/retired.jsonl` with its whole catalogue entry,
the reason, and the cells it had been placed in (`apps/server/src/http/sounds.ts`).
This folds that log into what a new batch needs: per prompt, how many of its
takes are still in the catalogue and how many were retired, and why. A prompt
whose takes are mostly broken points at generation or finishing (a cap, a gate);
mostly bad points at the prompt itself.

    python3 scripts/sfx/retired.py apps/server/data/sounds [--json]
"""

import argparse
import collections
import json
import os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir', help='the sounds dir: catalogue.json, retired.jsonl')
    ap.add_argument('--json', action='store_true', help='machine-readable, for a generation script')
    args = ap.parse_args()

    open_retirements = {}
    path = os.path.join(args.dir, 'retired.jsonl')
    if os.path.exists(path):
        for text in open(path, encoding='utf-8'):
            if not text.strip():
                continue
            line = json.loads(text)
            if line['action'] == 'retire':
                open_retirements[line['file']] = line
            else:
                open_retirements.pop(line['file'], None)

    kept = collections.Counter()
    for take in json.load(open(os.path.join(args.dir, 'catalogue.json'), encoding='utf-8'))['takes']:
        kept[(take['file'].split('/')[0], take['prompt'])] += 1

    rows = collections.defaultdict(lambda: {'kept': 0, 'bad': 0, 'broken': 0, 'cells': set()})
    for (folder, prompt), n in kept.items():
        rows[(folder, prompt)]['kept'] = n
    for line in open_retirements.values():
        row = rows[(line['file'].split('/')[0], line['take']['prompt'])]
        row[line['reason']] += 1
        row['cells'].update(line.get('cells', []))

    retired = {k: v for k, v in rows.items() if v['bad'] or v['broken']}
    if args.json:
        print(json.dumps([{'folder': f, 'prompt': p, **{**v, 'cells': sorted(v['cells'])}} for (f, p), v in sorted(retired.items())], indent=1))
        return
    print(f"{sum(v['bad'] for v in retired.values())} bad, {sum(v['broken'] for v in retired.values())} broken, "
          f"from {len(retired)} prompts\n")
    for (folder, prompt), v in sorted(retired.items(), key=lambda kv: -(kv[1]['bad'] + kv[1]['broken'])):
        cells = f"  (was in {', '.join(sorted(v['cells']))})" if v['cells'] else ''
        print(f"{folder:22} bad {v['bad']}  broken {v['broken']}  kept {v['kept']}{cells}\n    {prompt}")


if __name__ == '__main__':
    main()
