"""The 'power summer' eras, for any of the three formats: for each year, the
format in force just before that year's Standard fall rotation. Derived from
Forge's own archive, not typed.

  ST (Standard): the last Standard snapshot before THAT year's fall rotation
    — Standard's own rotation rule, unchanged from wave 34.
  MO (Modern), LE (Legacy): neither format rotates, so wave 48's rule pins
    their eras to the SAME dates Standard's own era uses for that year — the
    snapshot is the latest Archived/<Format>/ file on or before that year's
    Standard `start`, and the season window (`season_start` -> `end`) is
    copied from Standard's era too. That is what makes a year's three
    formats sit side by side.

Also holds the per-format file-naming scheme (`docs/planning/wave48-2026-10-05.md`
Settled), so `crawl.py`, `select_decks.py` and `report.py` never duplicate it.
"""
import os, re, json, sys

ROOT = os.environ.get(
    'FORGE_FORMATS_ROOT',
    '/home/hadoku/repos/hadoku-cardtable/forge/forge-gui/res/formats/Archived',
)
SUBTYPE = {'ST': 'Standard', 'MO': 'Modern', 'LE': 'Legacy'}
# Long-form infix used in every file name except Standard's (kept bare for
# back-compat with wave 34's files). `None` means "no infix".
INFIX = {'ST': None, 'MO': 'modern', 'LE': 'legacy'}
DEFAULT_RANGE = {'ST': (2003, 2016), 'MO': (2012, 2016), 'LE': (2005, 2016)}


def infix(fmt):
    return INFIX[fmt]


# On disk and outside the repo, beside `lists.py`'s deck cache: the crawl is ~35 minutes of
# polite requests, and a cache under /tmp (tmpfs here) or in the tree is lost or committed.
CACHE_DIR = os.environ.get('DECK_SELECTION_CACHE', os.path.expanduser('~/.cache/cardtable-deck-selection/candidates'))


def cache_path(fmt, year):
    i = infix(fmt)
    return f'{CACHE_DIR}/candidates-{year}.json' if i is None else f'{CACHE_DIR}/candidates-{i}-{year}.json'


def selection_path(fmt, year):
    i = infix(fmt)
    return f'selections/selection-{year}.json' if i is None else f'selections/selection-{i}-{year}.json'


def review_path(fmt, year):
    i = infix(fmt)
    return f'review/{year}.md' if i is None else f'review/{i}-{year}.md'


def style_overrides_path(fmt):
    i = infix(fmt)
    return 'style-overrides.json' if i is None else f'style-overrides-{i}.json'


def eras_path(fmt):
    i = infix(fmt)
    return 'eras.json' if i is None else f'eras-{i}.json'


def _files(fmt):
    d = f'{ROOT}/{SUBTYPE[fmt]}/'
    return sorted(f[:-4] for f in os.listdir(d) if f.endswith('.txt')), d


def _parse(path):
    txt = open(path).read()
    banned_m = re.search(r'Banned:(.*)', txt)
    return {
        'format': re.search(r'Name:(.*)', txt).group(1).strip(),
        'sets': re.search(r'Sets:(.*)', txt).group(1).strip(),
        'banned': [b.strip() for b in (banned_m.group(1).split(';') if banned_m else []) if b.strip()],
    }


def _fall_rotation(dates, y):
    """The LAST Standard snapshot dated in the second half of year `y`
    (July-December). Wave 34's original rule picked the FIRST file matching
    `{y}-09` or `{y}-10`, which is right for every year it was ever run
    against (2008-2016, one such file each) but breaks on real data outside
    that range: 2001 and 2002's fall rotations landed in November
    (`2001-11-01`, `2002-11-01`, no September/October file exists either
    year), and 2003 has TWO files in the window — `2003-09-01` (a lone
    core-set swap, 7ED out/8ED in, same shape as 2005's and 2007's — see
    AGENTS.md) and `2003-10-20` (the real block rotation, Odyssey block out,
    Mirrodin in) — where `next()` picked the wrong (earlier) one. The LATEST
    second-half-of-year snapshot is the real fall rotation in every case
    checked against the archive (`docs/planning/deck-selection/review/README.md`'s
    own eras table is the citable proof for 2008-2016; 2003's two-file case
    is the new one found extending to 2003-2007)."""
    candidates = [dt for dt in dates if dt.startswith(f'{y}-') and dt[5:7] >= '07']
    if not candidates:
        raise ValueError(f'no Standard snapshot found in the second half of {y}')
    return max(candidates)


def _standard_eras(first, last):
    dates, d = _files('ST')
    out = []
    for y in range(first, last + 1):
        fall = _fall_rotation(dates, y)
        i = dates.index(fall)
        start = dates[i - 1]
        prev_fall = _fall_rotation(dates, y - 1)
        info = _parse(d + start + '.txt')
        out.append({'year': y, 'season_start': prev_fall, 'start': start, 'end': fall, **info})
    return out


def _aligned_eras(fmt, first, last, standard_by_year):
    """MO/LE: pin to that year's Standard era's dates, snapshot from the
    latest Archived/<Format>/ file on or before the Standard `start`."""
    dates, d = _files(fmt)
    out = []
    for y in range(first, last + 1):
        std = standard_by_year.get(y)
        if std is None:
            continue  # no Standard anchor for this year (outside ST's own range)
        candidates = [dt for dt in dates if dt <= std['start']]
        if not candidates:
            continue  # format did not exist yet on this date
        snap = max(candidates)
        info = _parse(d + snap + '.txt')
        out.append({
            'year': y,
            'season_start': std['season_start'],
            'start': std['start'],
            'end': std['end'],
            'snapshot_file': snap,
            **info,
        })
    return out


def eras(fmt='ST', first=None, last=None):
    """Every era for `fmt`, oldest first. `first`/`last` default to wave 48's
    Settled ranges (ST 2003-2016, MO 2012-2016, LE 2005-2016)."""
    if fmt == 'ST':
        f, l = (first, last) if first and last else DEFAULT_RANGE['ST']
        return _standard_eras(f, l)
    # MO/LE need a Standard anchor covering their own range AND Standard's,
    # so the full Standard table (2003-2016) is always derived, then narrowed.
    std_first, std_last = DEFAULT_RANGE['ST']
    std_by_year = {e['year']: e for e in _standard_eras(std_first, std_last)}
    f, l = (first, last) if first and last else DEFAULT_RANGE[fmt]
    return _aligned_eras(fmt, f, l, std_by_year)


if __name__ == '__main__':
    argv = sys.argv[1:]
    fmt = 'ST'
    if '--format' in argv:
        fmt = argv[argv.index('--format') + 1]
    e = eras(fmt)
    json.dump(e, open(eras_path(fmt), 'w'), indent=1)
    for x in e:
        print(x['year'], x['start'], '->', x['end'], x['format'])
