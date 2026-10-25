"""AI-cutoff and decision counts at a run's deadline, from its 5 s series.

Runs taken before the harness stopped recording at the deadline counted the
teardown too; the series' last sample at or before the deadline does not.
Usage: python3 -I predeadline.py <run-dir>...   (run dir = <label>-<epoch>,
duration read from the label's suite: t3 900, t7 420, t2/t9 180, ramp 420, else 600)
"""
import csv
import os
import sys

DUR = {"t3": 900, "t7": 420, "t2": 180, "t2f": 180, "t9": 180, "t9s": 180, "vsai": 420, "hvh": 420}
print("run\tdeadline_s\tt_s\tai_timeouts\tai_decisions\tthreads\tlive_after_gc_mb\tcpu_s")
for d in sys.argv[1:]:
    name = os.path.basename(d.rstrip("/"))
    dur = DUR.get(name.split("-")[0], 600)
    path = os.path.join(d, "series.tsv")
    if not os.path.exists(path):
        continue
    last = None
    for r in csv.DictReader(open(path), delimiter="\t"):
        if int(r["t_s"]) <= dur:
            last = r
    if last:
        print(f"{name}\t{dur}\t{last['t_s']}\t{last['ai_timeouts']}\t{last['ai_decisions']}\t{last['threads']}\t{last['live_after_gc_mb']}\t{last['cpu_s']}")
