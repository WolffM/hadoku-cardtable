"""Markdown tables from forge-scale TSVs (docs/spikes/forge-scale/*.tsv).

Usage: python3 -I tables.py <tsv>... -- <col>,<col>,...
Rows from every file, in file order; a column a file lacks prints as '·'.
"""
import csv
import sys

i = sys.argv.index("--")
files, cols = sys.argv[1:i], sys.argv[i + 1].split(",")
print("| " + " | ".join(cols) + " |")
print("|" + "|".join(" --- " for _ in cols) + "|")
for f in files:
    for r in csv.DictReader(open(f), delimiter="\t"):
        print("| " + " | ".join(r.get(c, "·") or "·" for c in cols) + " |")
