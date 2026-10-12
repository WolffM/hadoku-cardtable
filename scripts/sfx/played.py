"""How often each sound is raised in real games, from the server's log, against the takes it has to choose from.

Every match screen logs the sounds it raises (`kind: 'sound'`: one line per board change, decision and button,
and every half minute a `tally` of interface sounds). Raised, not heard: a role with no take assigned still
counts, and shows as `pool: 0`. Counted per player screen, over screens that reached turn 3.

    python3 scripts/sfx/played.py apps/server/data/sounds > played.json
"""
import collections
import glob
import json
import os
import re
import sys


def main():
    sounds_dir = sys.argv[1]
    events = []
    for path in sorted(glob.glob(os.path.expanduser('~/.pm2/logs/cardtable-out*.log'))):
        for line in open(path, errors='replace'):
            if '"kind":"sound"' in line:
                events.append(json.loads(line[line.index('{'):]))
    per_screen = collections.defaultdict(collections.Counter)
    turns = collections.defaultdict(int)
    for e in events:
        screen = (e['matchId'], e['seat'])
        turns[screen] = max(turns[screen], e.get('turn', 0))
        if e['why'] == 'tally':
            for role, n in e.items():
                if role.startswith('ui.'):
                    per_screen[screen][(role, 'me')] += n
            continue
        for role in e['roles'].split(','):
            role = re.sub(r' \+\d+$', '', role)
            if role and not role.startswith('+'):
                per_screen[screen][(role.removesuffix('@opp'), 'opp' if role.endswith('@opp') else 'me')] += 1
        for cell in e.get('cells', '').split(','):
            cell = re.sub(r' \+\d+$', '', cell)
            if cell and not cell.startswith('+'):
                per_screen[screen][('cell:' + cell, 'me')] += 1
    screens = [s for s in per_screen if turns[s] >= 3]
    games, all_turns = len(screens), sum(turns[s] for s in screens)
    cells = json.load(open(os.path.join(sounds_dir, 'assignments.json')))['cells']
    totals = collections.defaultdict(lambda: {'me': 0, 'opp': 0})
    for s in screens:
        for (role, seat), n in per_screen[s].items():
            totals[role][seat] += n
    rows = []
    for role, n in totals.items():
        pool = len(cells.get(role[5:] if role.startswith('cell:') else f'{role}|play', []))
        per_game = (n['me'] + n['opp']) / max(games, 1)
        rows.append({'role': role, 'me': n['me'], 'opp': n['opp'], 'perGame': round(per_game, 1),
                     'perTurn': round((n['me'] + n['opp']) / max(all_turns, 1), 2), 'pool': pool,
                     'perTake': round(per_game / pool, 1) if pool else None})
    rows.sort(key=lambda r: -r['perGame'])
    json.dump({'games': games, 'turns': all_turns, 'events': len(events),
               'from': events[0]['t'] if events else None, 'to': events[-1]['t'] if events else None,
               'interfaceCounted': any(e['why'] == 'tally' for e in events), 'rows': rows}, sys.stdout, indent=1)


if __name__ == '__main__':
    main()
