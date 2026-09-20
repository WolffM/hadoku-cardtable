#!/usr/bin/env python3
"""Attribute each of TeaVM's missing-API reports to the client call that reaches it.

TeaVM prints one [ERROR] per unresolved reference followed by the call stack
that reached it, deepest frame first. The frame immediately above the
clientspike entry point is the Forge method that pulls the API in; the
clientspike frame's own line number says which protocol method that was.

Usage:  ./attribute.py ~/.cache/w14a-spike/link-GuiSurfaceMain.WEBASSEMBLY_GC.log
        ./attribute.py <log> --by-entry     group by the entry-point call site
"""
import re
import sys
from collections import OrderedDict, defaultdict

ENTRY_RE = re.compile(r"^clientspike\.(\w+)\.(\w+)\((\w+\.java):(\d+)\)$")


def parse(path):
    """-> OrderedDict[missing api] = list of stack frames (deepest first)."""
    blocks = OrderedDict()
    cur = None
    for line in open(path, encoding="utf-8", errors="replace").read().splitlines():
        m = re.match(r"^\[ERROR\] (.*)$", line)
        if m:
            cur = m.group(1)
            if "was not found" in cur or "which is missing in the classpath" in cur:
                blocks.setdefault(cur, [])
            else:
                cur = None
            continue
        if cur is not None and line.startswith("    at "):
            blocks[cur].append(line.strip()[3:])
    return blocks


def entry_of(frames, source_lines):
    """The clientspike call site that reached this API, plus the forge frame above it."""
    for i, f in enumerate(frames):
        m = ENTRY_RE.match(f)
        if m:
            _, _, src, lineno = m.groups()
            call = source_lines.get((src, int(lineno)), "?")
            above = frames[i - 1] if i > 0 else "(direct)"
            return call, above
    return "(no entry frame)", frames[0] if frames else "?"


def source_index(root):
    out = {}
    import os
    for dirpath, _, names in os.walk(root):
        for n in names:
            if not n.endswith(".java"):
                continue
            with open(os.path.join(dirpath, n), encoding="utf-8") as fh:
                for i, line in enumerate(fh, 1):
                    out[(n, i)] = line.strip()
    return out


def main():
    log = sys.argv[1]
    by_entry = "--by-entry" in sys.argv
    here = __file__.rsplit("/", 1)[0]
    src = source_index(here + "/src/main/java/clientspike")
    blocks = parse(log)

    if by_entry:
        groups = defaultdict(list)
        for api, frames in blocks.items():
            call, _ = entry_of(frames, src)
            groups[call].append(api)
        for call in sorted(groups, key=lambda c: -len(groups[c])):
            print(f"{len(groups[call]):3d}  {call}")
        print(f"--- {len(blocks)} distinct missing APIs, "
              f"{len(groups)} distinct entry-point call sites")
        return

    for api, frames in blocks.items():
        call, above = entry_of(frames, src)
        forge = [f for f in frames if f.startswith("forge.")]
        print(f"### {api}")
        print(f"    via: {call}")
        print(f"    chain: {' <- '.join(forge[:8]) or '(no forge frames)'}")
    print(f"--- {len(blocks)} distinct missing APIs")


if __name__ == "__main__":
    main()
