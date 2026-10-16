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
DEFAULT_RANGE = {'ST': (1995, 2025), 'MO': (2011, 2025), 'LE': (2005, 2025)}


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
    def names(key):
        m = re.search(rf'^{key}:(.*)', txt, re.M)
        return [b.strip() for b in (m.group(1).split(';') if m else []) if b.strip()]
    out = {
        'format': re.search(r'Name:(.*)', txt).group(1).strip(),
        'sets': re.search(r'Sets:(.*)', txt).group(1).strip(),
        'banned': names('Banned'),
    }
    # Type 2's restricted list (1995-1996): one copy each. Only written when the
    # snapshot has one, so the eras that never had it keep their files as they were.
    if names('Restricted'):
        out['restricted'] = names('Restricted')
    # Type 2 until 1995-11: one copy of each legendary card, whatever it is.
    if re.search(r'^RestrictedLegendary:\s*true', txt, re.M | re.I):
        out['restricted_legendary'] = True
    return out


def _sets(d, date):
    return {x.strip() for x in _parse(d + date + '.txt')['sets'].split(',')}


def _drops_a_set(dates, d, date):
    i = dates.index(date)
    return i > 0 and bool(_sets(d, dates[i - 1]) - _sets(d, date))


def _fall_rotation(dates, d, y):
    """The LAST Standard snapshot dated in the second half of year `y`
    (July-December) that drops a set its predecessor had, or None when no
    snapshot that half-year drops one.

    Wave 34's original rule picked the FIRST file matching `{y}-09` or
    `{y}-10`, right for 2008-2016 (one such file each) but wrong outside it:
    2001 and 2002's rotations landed in November, and 2003 has two files in
    the window — `2003-09-01` (a core-set swap, 7ED out/8ED in) and
    `2003-10-20` (the block rotation), where the first was the wrong one.

    The rule after that took the LATEST second-half snapshot of any kind,
    which held while the only files after a rotation were the next year's.
    From 2018 on Forge records bans and Arena-era set additions in October to
    December too (`2018-11-16`, `2019-10-25`, `2020-10-12`, ...), and those
    won, so every year from 2018 read as having no rotation. A rotation is a
    snapshot that drops a set, so that is what is asked: the set-dropping
    rotations are 2017-09-29, 2018-10-05, 2019-10-04, 2020-09-25, 2021-09-24,
    2022-09-09, 2024-08-02 and 2025-08-01. 2023 has none — WotC's move to a
    three-year rotation meant Wilds of Eldraine (`2023-09-08`) dropped
    nothing — and 1995 and 1996 have none either."""
    candidates = [dt for dt in dates if dt.startswith(f'{y}-') and dt[5:7] >= '07' and _drops_a_set(dates, d, dt)]
    return max(candidates) if candidates else None


def _era_bounds(dates, d, y):
    """(start, end, rotated) of year `y`'s Standard era: the snapshot in force
    over the summer, the snapshot that ended it, and whether that was a rotation.

    In a year with a fall rotation (`_fall_rotation`) the end is that rotation
    and the era is the snapshot just before it. Three years have none. Type 2 in
    1995 and 1996: no snapshot in the second half of either year drops a set
    (`1995-11-13` and `1996-11-07` only add Homelands and Mirage), and both years
    changed the restricted list between Worlds in August and the autumn set:
    `1995-11-01` restricted Zuran Orb, `1996-10-01` Hymn to Tourach and Strip
    Mine. Pinning those years to the file before the autumn set would judge
    Worlds decks by a list made after Worlds and reject all of them. And 2023,
    when WotC moved Standard to a three-year rotation and Wilds of Eldraine
    (`2023-09-08`) dropped nothing. So a year with no set-dropping rotation takes
    the format in force on August 1st and ends at the next snapshot."""
    fall = _fall_rotation(dates, d, y)
    if fall is not None:
        return dates[dates.index(fall) - 1], fall, True
    start = max(dt for dt in dates if dt <= f'{y}-08-01')
    return start, dates[dates.index(start) + 1], False


def _standard_eras(first, last):
    dates, d = _files('ST')
    out = []
    for y in range(first, last + 1):
        start, end, rotated = _era_bounds(dates, d, y)
        # Standard's first year has no era before it: its season opens on the
        # first Type 2 snapshot Forge has (1995-01-10).
        season_start = _era_bounds(dates, d, y - 1)[1] if y > int(dates[0][:4]) else dates[0]
        info = _parse(d + start + '.txt')
        era = {'year': y, 'season_start': season_start, 'start': start, 'end': end, **info}
        if not rotated:
            era['no_fall_rotation'] = True
        out.append(era)
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
    """Every era for `fmt`, oldest first. `first`/`last` default to
    `DEFAULT_RANGE`: ST 1995-2025, MO 2011-2025, LE 2005-2025 — back as far as
    mtgtop8 has decks (no Legacy before 2005), forward to Pro Tour 2025's summer."""
    if fmt == 'ST':
        f, l = (first, last) if first and last else DEFAULT_RANGE['ST']
        return _standard_eras(f, l)
    # MO/LE need a Standard anchor covering their own range AND Standard's,
    # so the full Standard table is always derived, then narrowed.
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
