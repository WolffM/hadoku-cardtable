import { chromium } from '/home/hadoku/repos/hadoku-cardtable/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs';

const W = Number(process.argv[3] ?? 960);
const H = Number(process.argv[4] ?? 705);
const file = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: W, height: H } });
await p.goto('file:///tmp/claude-1000/w27/A/' + file);
await p.evaluate(() => {
  for (const zone of document.querySelectorAll('[data-zone="battlefield"]')) {
    const rows = zone.querySelector(':scope > ul.zone__rows');
    if (!rows) continue;
    let total = 0;
    for (const lane of rows.querySelectorAll(':scope > li.zone__row')) {
      const n = lane.querySelectorAll(':scope > ul.zone__cards > li.board-card').length;
      lane.style.setProperty('--cols', String(n)); lane.style.flexGrow = '';
      total += n;
    }
    rows.style.setProperty('--cols', String(total));
  }
  for (const zone of document.querySelectorAll('[data-zone="hand"]')) {
    const list = zone.querySelector(':scope > ul.zone__cards');
    if (list) list.style.setProperty('--cols', String(list.querySelectorAll(':scope > li.board-card').length));
  }
});
await p.waitForTimeout(250);
const out = await p.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const res = [];
  for (const zone of document.querySelectorAll('[data-zone]')) {
    const seat = zone.closest('.seat');
    const viewer = seat?.hasAttribute('data-viewer') ?? false;
    const box = r(zone);
    const entry = { zone: zone.dataset.zone, viewer, box, scroll: { sw: zone.scrollWidth, cw: zone.clientWidth, sh: zone.scrollHeight, ch: zone.clientHeight }, lanes: [] };
    for (const lane of zone.querySelectorAll('[data-board-row]')) {
      const list = lane.querySelector(':scope > ul.zone__cards');
      const cards = [...(list?.querySelectorAll(':scope > li.board-card') ?? [])];
      const cs = getComputedStyle(list ?? lane);
      entry.lanes.push({
        row: lane.dataset.board_row ?? lane.getAttribute('data-board-row'),
        box: r(lane), grow: lane.style.flexGrow,
        rows: cs.getPropertyValue('--rows').trim(), cardW: cs.getPropertyValue('--card-w').trim(),
        cols: cards.length,
        widths: cards.map((c) => Math.round(c.getBoundingClientRect().width)),
        heights: cards.map((c) => Math.round(c.getBoundingClientRect().height)),
        laneScroll: { sw: lane.scrollWidth, cw: lane.clientWidth, sh: lane.scrollHeight, ch: lane.clientHeight },
        listScroll: list ? { sw: list.scrollWidth, cw: list.clientWidth, sh: list.scrollHeight, ch: list.clientHeight } : null,
        nameOverflow: cards.slice(0, 40).map((c) => { const n = c.querySelector('.card__name'); return n ? [n.textContent.slice(0, 14), Math.round(n.getBoundingClientRect().width), n.scrollWidth, Math.round(n.getBoundingClientRect().height)] : null; }),
      });
    }
    if (entry.lanes.length === 0) {
      const list = zone.querySelector(':scope > ul.zone__cards');
      const cards = [...(list?.querySelectorAll(':scope > li.board-card') ?? [])];
      if (list) { const cs = getComputedStyle(list);
        entry.lanes.push({ row: '(zone)', box: r(zone), rows: cs.getPropertyValue('--rows').trim(), cardW: cs.getPropertyValue('--card-w').trim(), cols: cards.length,
          widths: cards.map((c) => Math.round(c.getBoundingClientRect().width)), heights: cards.map((c) => Math.round(c.getBoundingClientRect().height)),
          listScroll: { sw: list.scrollWidth, cw: list.clientWidth, sh: list.scrollHeight, ch: list.clientHeight },
          nameOverflow: cards.slice(0, 40).map((c) => { const n = c.querySelector('.card__name'); return n ? [n.textContent.slice(0, 14), Math.round(n.getBoundingClientRect().width), n.scrollWidth, Math.round(n.getBoundingClientRect().height)] : null; }) }); }
    }
    res.push(entry);
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await p.screenshot({ path: '/tmp/claude-1000/w27/A/shot-' + file.replace('.html', '') + '-' + W + 'x' + H + '.png' });
await b.close();
