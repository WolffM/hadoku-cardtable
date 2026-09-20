// Wave 15, lane D -- resident memory of a browser process TREE, from /proc.
//
// Why this and not performance.measureUserAgentSpecificMemory(): that API needs
// cross-origin isolation (COOP/COEP), the spike's static server does not send
// those headers, and serve.mjs is not this lane's file to change. Why not the
// JS heap (performance.memory / CDP Performance.getMetrics): CheerpJ's Java heap
// lives in WebAssembly linear memory, which is NOT in the JS heap, so every
// JS-heap number would understate it by roughly the entire measurement.
//
// Rooted at OUR OWN pid with excludeRoot: Playwright's Browser has no
// .process() (that is BrowserServer, from launchServer), and the browser is a
// child of this node process, so its whole tree is exactly our descendants.
//
// Process-tree RSS is also the figure that is actually comparable to the other
// side of this wave's decision: streaming.md's 1.26 GiB is `docker stats` RSS
// for a container. This is RSS for a browser. Same kind of number.
//
// Caveat carried into the doc: RSS over a process tree double-counts shared
// pages (the Chrome binary, fonts, shared libs), so the ABSOLUTE figure is an
// over-estimate. The DELTA against a blank-page baseline in the same browser is
// the honest part, and that is what gets reported.

import fs from 'node:fs';

export function treeRssKb(rootPid, { excludeRoot = false } = {}) {
  let parents;
  try {
    parents = new Map();
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        // /proc/<pid>/stat field 4 is ppid, but comm (field 2) may contain
        // spaces and parentheses, so split after the last ')'.
        const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        parents.set(Number(name), Number(tail[1]));
      } catch { /* process exited between readdir and read */ }
    }
  } catch { return null; }

  const wanted = new Set([rootPid]);
  // Repeat until no new descendants appear: /proc order is not topological.
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, ppid] of parents) {
      if (!wanted.has(pid) && wanted.has(ppid)) { wanted.add(pid); changed = true; }
    }
  }

  if (excludeRoot) wanted.delete(rootPid);
  let kb = 0, counted = 0;
  for (const pid of wanted) {
    try {
      const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /^VmRSS:\s+(\d+) kB$/m.exec(s);
      if (m) { kb += Number(m[1]); counted += 1; }
    } catch { /* gone */ }
  }
  return { rssKb: kb, processes: counted, rootPid };
}
