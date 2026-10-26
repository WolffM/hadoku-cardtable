#!/usr/bin/env python3
"""B1 soak verdict from a ForgeScale series.tsv (scripts/stress/soak.sh collect).

Prints one row per hour: the heap floor (live_after_gc_mb, the forced full GC's
reading), threads, AI eval threads, metaspace and loaded classes, each as the
hour's median, and the cutoffs and decisions in that hour. Then the drift from
the first hour after warm-up to the last: the soak passes when the floor,
threads, metaspace and classes are flat (each within 10 % or a small absolute
margin).

Usage: soak-summary.py <series.tsv> [warmup_hours=1]
"""
import csv
import statistics
import sys


def main() -> None:
    path = sys.argv[1]
    warm = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    rows = list(csv.DictReader(open(path), delimiter="\t"))
    if not rows:
        sys.exit(f"{path}: no rows")
    hours: dict[int, list[dict[str, str]]] = {}
    for r in rows:
        hours.setdefault(int(r["t_s"]) // 3600, []).append(r)
    cols = ["live_after_gc_mb", "threads", "eval_threads", "metaspace_mb", "classes", "rss_mb"]
    print("hour\t" + "\t".join(cols) + "\tcutoffs\tdecisions")
    summary: dict[int, dict[str, float]] = {}
    prev_cut = prev_dec = 0
    for h in sorted(hours):
        rs = hours[h]
        med = {}
        for c in cols:
            vals = [float(r[c]) for r in rs if r.get(c) not in (None, "", "-1")]
            med[c] = statistics.median(vals) if vals else float("nan")
        cut, dec = int(rs[-1]["ai_timeouts"]), int(rs[-1]["ai_decisions"])
        summary[h] = med
        print(f"{h}\t" + "\t".join(f"{med[c]:.0f}" for c in cols) + f"\t{cut - prev_cut}\t{dec - prev_dec}")
        prev_cut, prev_dec = cut, dec
    first = min(h for h in summary if h >= warm) if any(h >= warm for h in summary) else min(summary)
    last = max(summary)
    margin = {"live_after_gc_mb": 20, "threads": 10, "metaspace_mb": 5, "classes": 200}
    ok = True
    for c, m in margin.items():
        a, b = summary[first][c], summary[last][c]
        flat = abs(b - a) <= max(m, 0.1 * a)
        ok &= flat
        print(f"{c}: hour {first} {a:.0f} -> hour {last} {b:.0f} ({'flat' if flat else 'GROWS'})")
    print("PASS" if ok else "FAIL")


if __name__ == "__main__":
    main()
