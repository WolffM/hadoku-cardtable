#!/usr/bin/env python3
"""Render docs/planning/playtest-ledger.md as the single-file HTML page the
tracker publishes as an Artifact. The markdown is the source of truth; this only
reads it. Usage: python3 docs/planning/playtest-ledger-html.py <ledger.md> <out.html>"""
import html, re, sys
from collections import Counter

STATUS_ORDER = ['open', 'planned', 'partly', 'reopened', 'shipped']
STATUS_LABEL = {'open': 'Open', 'planned': 'Planned', 'partly': 'Partly', 'reopened': 'Reopened', 'shipped': 'Shipped'}


def inline(text):
    t = html.escape(text, quote=False)
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'(?<![\w*])\*([^*\n]+)\*(?![\w*])', r'<em>\1</em>', t)
    return t


def status_key(cell):
    c = cell.strip().lower()
    for k in STATUS_ORDER:
        if c.startswith(k):
            return k
    return 'open'


def parse(md):
    lines = md.splitlines()
    title = lines[0].lstrip('# ').strip()
    blocks, i = [], 1
    while i < len(lines):
        ln = lines[i]
        if ln.startswith('## '):
            blocks.append(('h2', ln[3:].strip())); i += 1
        elif ln.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                rows.append(cells); i += 1
            blocks.append(('table', rows))
        elif re.match(r'^\d+\. ', ln):
            items = []
            while i < len(lines) and (re.match(r'^\d+\. ', lines[i]) or lines[i].startswith('   ')):
                if re.match(r'^\d+\. ', lines[i]):
                    items.append(re.sub(r'^\d+\. ', '', lines[i]))
                else:
                    items[-1] += ' ' + lines[i].strip()
                i += 1
            blocks.append(('ol', items))
        elif ln.startswith('- '):
            items = []
            while i < len(lines) and (lines[i].startswith('- ') or lines[i].startswith('  ')):
                if lines[i].startswith('- '):
                    items.append(lines[i][2:])
                else:
                    items[-1] += ' ' + lines[i].strip()
                i += 1
            blocks.append(('ul', items))
        elif ln.strip() in ('', '---'):
            i += 1
        else:
            para = [ln]; i += 1
            while i < len(lines) and lines[i].strip() and not lines[i].startswith(('|', '#', '- ')) and not re.match(r'^\d+\. ', lines[i]) and lines[i].strip() != '---':
                para.append(lines[i]); i += 1
            blocks.append(('p', ' '.join(para)))
    return title, blocks


def render_table(rows):
    head, body = rows[0], [r for r in rows[2:]]
    cols = [c.lower() for c in head]
    has_status = 'status' in cols and 'id' in cols
    out = ['<div class="tablewrap"><table><thead><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in head) + '</tr></thead><tbody>']
    for r in body:
        if not any(r):
            continue
        attrs, tds = '', []
        for c, cell in zip(head, r):
            cl = c.lower()
            if cl == 'status':
                k = status_key(cell)
                if has_status:
                    attrs = f' data-status="{k}"'
                rest = re.sub(r'^(open|planned|partly|reopened|shipped)\b', '', cell.strip(), flags=re.I).strip()
                tds.append(f'<td data-label="{html.escape(c)}"><span class="pill {k}">{STATUS_LABEL[k]}</span>' + (f'<span class="stext">{inline(rest)}</span>' if rest else '') + '</td>')
            elif cl == 'id':
                tds.append(f'<td data-label="ID" class="idc"><span class="idtag">{inline(cell)}</span></td>')
            elif cl == 'asked':
                m = re.match(r'(\d+|≥\d+)', cell)
                n = int(re.sub(r'\D', '', m.group(1))) if m else 1
                cls = 'asked hot' if n >= 2 else 'asked'
                tds.append(f'<td data-label="Asked"><span class="{cls}">{inline(cell)}</span></td>')
            elif cl == 'your check':
                tds.append('<td data-label="Your check" class="yc">' + (inline(cell) if cell else '<span class="blank">to check</span>') + '</td>')
            else:
                tds.append(f'<td data-label="{html.escape(c)}">{inline(cell)}</td>')
        out.append(f'<tr{attrs}>' + ''.join(tds) + '</tr>')
    out.append('</tbody></table></div>')
    return ''.join(out), has_status


def main(src, dst):
    md = open(src, encoding='utf-8').read()
    title, blocks = parse(md)
    counts, body, section = Counter(), [], None
    updated = re.search(r'\*Last updated: ([^*]+)\*', md)
    for kind, val in blocks:
        if kind == 'h2':
            if section is not None:
                body.append('</section>')
            section = val
            sid = re.sub(r'[^a-z0-9]+', '-', val.lower()).strip('-')[:40]
            body.append(f'<section id="{sid}"><h2>{inline(val)}</h2>')
        elif kind == 'p':
            body.append(f'<p>{inline(val)}</p>')
        elif kind == 'ol':
            body.append('<ol class="next">' + ''.join(f'<li>{inline(x)}</li>' for x in val) + '</ol>')
        elif kind == 'ul':
            body.append('<ul>' + ''.join(f'<li>{inline(x)}</li>' for x in val) + '</ul>')
        elif kind == 'table':
            t, has = render_table(val)
            if has:
                si = [c.lower() for c in val[0]].index('status')
                for r in val[2:]:
                    if any(r):
                        counts[status_key(r[si])] += 1
            body.append(t)
    if section is not None:
        body.append('</section>')
    intro = ''
    filters = ''.join(f'<button type="button" class="filter {k}" data-f="{k}" aria-pressed="false"><span class="n">{counts[k]}</span> {STATUS_LABEL[k]}</button>' for k in STATUS_ORDER if counts[k])
    page = PAGE.replace('@@TITLE@@', html.escape(title)).replace('@@FILTERS@@', filters).replace('@@UPDATED@@', html.escape(updated.group(1) if updated else '')).replace('@@BODY@@', '\n'.join(body))
    open(dst, 'w', encoding='utf-8').write(page)


PAGE = r'''<title>@@TITLE@@</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
/* Layout: a calm reference sheet. Sticky filter bar, one section per playtest, tables that stack to cards on a phone. */
:root {
  --bg: #f4f6f8; --surface: #ffffff; --ink: #1c2530; --ink-dim: #566272; --line: #d9dfe6;
  --accent: #0f6b66; --accent-bg: #e1f1ef;
  --open: #a3262a; --open-bg: #fbe7e7;
  --planned: #1f5fa8; --planned-bg: #e4eefb;
  --partly: #8a5a00; --partly-bg: #fdf0d3;
  --reopened: #8a1f6d; --reopened-bg: #f8e4f1;
  --shipped: #1d6b3a; --shipped-bg: #e2f3e8;
  --font: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #12171d; --surface: #1a212a; --ink: #e5eaf0; --ink-dim: #9aa6b4; --line: #2c3541;
  --accent: #5fc4bc; --accent-bg: #173532;
  --open: #ff8f92; --open-bg: #3a1c1e; --planned: #8fbcf2; --planned-bg: #172a43;
  --partly: #f2c25b; --partly-bg: #3a2d0e; --reopened: #f0a0d6; --reopened-bg: #3a1a30;
  --shipped: #7fd69c; --shipped-bg: #163325; color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #12171d; --surface: #1a212a; --ink: #e5eaf0; --ink-dim: #9aa6b4; --line: #2c3541;
  --accent: #5fc4bc; --accent-bg: #173532;
  --open: #ff8f92; --open-bg: #3a1c1e; --planned: #8fbcf2; --planned-bg: #172a43;
  --partly: #f2c25b; --partly-bg: #3a2d0e; --reopened: #f0a0d6; --reopened-bg: #3a1a30;
  --shipped: #7fd69c; --shipped-bg: #163325; color-scheme: dark; }
body { background: var(--bg); color: var(--ink); font: 14px/1.5 var(--font); padding-inline: 16px; }
.wrap { max-width: 1180px; margin-inline: auto; padding-block: 24px 64px; }
header h1 { font-size: 26px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; text-wrap: balance; }
header .updated { color: var(--ink-dim); font-size: 12px; font-family: var(--mono); }
.rule { background: var(--accent-bg); border-left: 3px solid var(--accent); padding: 10px 14px; margin: 16px 0; border-radius: 0 6px 6px 0; max-width: 78ch; }
.rule strong { color: var(--accent); }
.bar { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; background: var(--bg); padding-block: 10px; border-bottom: 1px solid var(--line); margin-block: 12px; }
.bar .lbl { color: var(--ink-dim); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; margin-right: 4px; }
.filter { font: inherit; font-size: 13px; cursor: pointer; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 999px; padding: 4px 12px; }
.filter .n { font-family: var(--mono); font-weight: 500; margin-right: 2px; }
.filter[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--accent-bg); }
.filter:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.filter.clear { color: var(--ink-dim); }
section { margin-block: 28px; }
h2 { font-size: 17px; font-weight: 600; margin: 0 0 10px; text-wrap: balance; }
p, li { max-width: 80ch; }
code { font-family: var(--mono); font-size: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
ol.next { padding-left: 22px; display: grid; gap: 6px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 18px 14px 36px; max-width: none; }
ol.next li { max-width: 100ch; }
.tablewrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; min-width: 880px; }
th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-dim); font-weight: 600; padding: 9px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; min-width: 0; }
tr:last-child td { border-bottom: 0; }
tr[hidden] { display: none; }
td.idc { white-space: nowrap; }
.idtag { font-family: var(--mono); font-weight: 500; font-size: 12px; color: var(--accent); }
.pill { display: inline-block; font-size: 11px; font-weight: 600; letter-spacing: 0.03em; padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
.pill.open { color: var(--open); background: var(--open-bg); }
.pill.planned { color: var(--planned); background: var(--planned-bg); }
.pill.partly { color: var(--partly); background: var(--partly-bg); }
.pill.reopened { color: var(--reopened); background: var(--reopened-bg); }
.pill.shipped { color: var(--shipped); background: var(--shipped-bg); }
.stext { display: block; margin-top: 4px; color: var(--ink-dim); font-size: 12px; }
.asked { font-family: var(--mono); font-size: 12px; color: var(--ink-dim); }
.asked.hot { color: var(--open); font-weight: 600; }
.yc .blank { color: var(--ink-dim); border: 1px dashed var(--line); border-radius: 4px; padding: 1px 7px; font-size: 12px; white-space: nowrap; }
.filter.open[aria-pressed="true"] { border-color: var(--open); box-shadow: inset 0 0 0 1px var(--open); background: var(--open-bg); }
.filter.planned[aria-pressed="true"] { border-color: var(--planned); box-shadow: inset 0 0 0 1px var(--planned); background: var(--planned-bg); }
.filter.partly[aria-pressed="true"] { border-color: var(--partly); box-shadow: inset 0 0 0 1px var(--partly); background: var(--partly-bg); }
.filter.reopened[aria-pressed="true"] { border-color: var(--reopened); box-shadow: inset 0 0 0 1px var(--reopened); background: var(--reopened-bg); }
.filter.shipped[aria-pressed="true"] { border-color: var(--shipped); box-shadow: inset 0 0 0 1px var(--shipped); background: var(--shipped-bg); }
@media (max-width: 720px) {
  table, thead, tbody, tr, td { display: block; min-width: 0; }
  table { min-width: 0; }
  thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  tr { padding: 10px 12px; border-bottom: 1px solid var(--line); }
  tr:last-child { border-bottom: 0; }
  td { border: 0; padding: 3px 0; overflow-wrap: anywhere; }
  td::before { content: attr(data-label); display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-dim); }
  td.idc::before { display: none; }
}
@media (prefers-reduced-motion: no-preference) { .filter { transition: background .12s, border-color .12s; } }
</style>
<div class="wrap">
<header>
  <h1>@@TITLE@@</h1>
  <div class="updated">Last updated: @@UPDATED@@</div>
</header>
<div class="bar" role="group" aria-label="Filter by status"><span class="lbl">Filter</span>@@FILTERS@@<button type="button" class="filter clear" id="clear" hidden>Show all</button></div>
@@BODY@@
</div>
<script>
(function () {
  var active = null;
  var btns = Array.prototype.slice.call(document.querySelectorAll('.filter[data-f]'));
  var clear = document.getElementById('clear');
  function apply() {
    var rows = document.querySelectorAll('tr[data-status]');
    for (var i = 0; i < rows.length; i++) rows[i].hidden = active !== null && rows[i].getAttribute('data-status') !== active;
    btns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-f') === active)); });
    clear.hidden = active === null;
  }
  btns.forEach(function (b) { b.addEventListener('click', function () { var f = b.getAttribute('data-f'); active = active === f ? null : f; apply(); }); });
  clear.addEventListener('click', function () { active = null; apply(); });
})();
</script>
'''

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
