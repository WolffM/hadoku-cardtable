"""The nine 'power summer' eras: for each year, the Standard format in force just
before the fall rotation. Derived from Forge's own archive, not typed."""
import os, re, json
FORGE = os.environ.get('FORGE_FORMATS', '/home/hadoku/repos/hadoku-cardtable/forge/forge-gui/res/formats/Archived/Standard/')

def eras(first=2008, last=2016):
    dates = sorted(f[:-4] for f in os.listdir(FORGE) if f.endswith('.txt'))
    out = []
    for y in range(first, last + 1):
        fall = next(d for d in dates if d.startswith(f'{y}-09') or d.startswith(f'{y}-10'))
        i = dates.index(fall)
        start = dates[i - 1]
        txt = open(FORGE + start + '.txt').read()
        prev_fall = next(d for d in dates if d.startswith(f'{y-1}-09') or d.startswith(f'{y-1}-10'))
        out.append({'year': y, 'season_start': prev_fall, 'start': start, 'end': fall,
                    'format': re.search(r'Name:(.*)', txt).group(1).strip(),
                    'sets': re.search(r'Sets:(.*)', txt).group(1).strip(),
                    'banned': [b.strip() for b in (re.search(r'Banned:(.*)', txt).group(1).split(';') if re.search(r'Banned:(.*)', txt) else []) if b.strip()]})
    return out

if __name__ == '__main__':
    e = eras()
    json.dump(e, open('eras.json', 'w'), indent=1)
    for x in e: print(x['year'], x['start'], '->', x['end'], x['format'])
