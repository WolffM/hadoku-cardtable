"""T0 summary: per sampled JVM, CPU-seconds per wall-minute and old-gen/heap range.

Usage: python3 -I t0-summary.py t0.tsv
CPU per minute is the utime+stime delta over the wall-time delta between the
first and last sample of one pid; it includes the JVM's own idle cost.
"""
import csv
import sys
from collections import defaultdict

rows = defaultdict(list)
for r in csv.DictReader(open(sys.argv[1]), delimiter="\t"):
    rows[(r["pid"], r["kind"], r["match"])].append(r)
print("pid\tkind\tmatch\tsamples\twall_min\tcpu_s\tcpu_s_per_min\trss_mb_max\tpss_mb_max\told_mb_min\told_mb_max\theap_mb_max\tthreads_max\tgc_s")
for (pid, kind, match), rs in rows.items():
    a, b = rs[0], rs[-1]
    wall = (int(b["age_s"]) - int(a["age_s"])) / 60
    cpu = float(b["cpu_s"]) - float(a["cpu_s"])
    mx = lambda k: max(float(x[k] or 0) for x in rs)
    mn = lambda k: min(float(x[k] or 0) for x in rs)
    print(f"{pid}\t{kind}\t{match}\t{len(rs)}\t{wall:.1f}\t{cpu:.1f}\t{cpu / wall if wall else float('nan'):.2f}\t"
          f"{mx('rss_kb') / 1024:.0f}\t{mx('pss_kb') / 1024:.0f}\t{mn('old_used_kb') / 1024:.0f}\t{mx('old_used_kb') / 1024:.0f}\t"
          f"{mx('heap_used_kb') / 1024:.0f}\t{mx('threads'):.0f}\t{float(b['gct'] or 0) - float(a['gct'] or 0):.1f}")
