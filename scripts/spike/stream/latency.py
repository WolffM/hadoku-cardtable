#!/usr/bin/env python3
"""Click-to-pixel latency for an X11 app, measured at the capture tap.

This measures ONE hop: synthetic click (XTEST) -> the pixel change showing up
in an `ffmpeg -f x11grab` capture of the X server. That is the app-render hop a
streaming stack would sit on top of; it does NOT include VNC encode, network,
browser decode or browser paint. `rfb-latency.py` measures the wire hop.

Method
------
1. `ffmpeg -f x11grab` captures a small region of the display as 8-bit grey raw
   frames at a fixed framerate, straight to a pipe. Small region = ffmpeg keeps
   up, so a frame's arrival time on the pipe is a good proxy for its capture
   time. The script prints the observed inter-frame jitter so you can check
   that for yourself.
2. A single long-lived `xdotool -` reads commands on stdin, so no process spawn
   sits between the timestamp and the XTEST event.
3. Per rep: move the pointer, let the UI settle, take the last frame as the
   baseline, press the button, hold it `--hold` seconds, release, then read
   frames until one differs from the baseline by more than `--threshold` mean
   absolute grey levels. The clock starts at the press.

Resolution is one frame interval (1/fps), and the reported number is therefore
quantised upward by up to that much. Run it with --fps 200 (5 ms) or better.

Usage:
  latency.py --display :90 --region 420,50,520,30 \
             --clicks 68,253 --clicks 71,285 --reps 20 --fps 200
"""

from __future__ import annotations

import argparse
import statistics
import subprocess
import sys
import time

import numpy as np


def parse_region(s: str) -> tuple[int, int, int, int]:
    x, y, w, h = (int(v) for v in s.split(','))
    return x, y, w, h


def parse_point(s: str) -> tuple[int, int]:
    x, y = (int(v) for v in s.split(','))
    return x, y


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--display', default=':90')
    ap.add_argument('--region', required=True, help='x,y,w,h of the watched rectangle')
    ap.add_argument('--clicks', action='append', required=True,
                    help='x,y of a click target; give it twice to alternate')
    ap.add_argument('--reps', type=int, default=20)
    ap.add_argument('--fps', type=int, default=200)
    ap.add_argument('--threshold', type=float, default=2.0,
                    help='mean absolute grey-level difference that counts as "changed"')
    ap.add_argument('--hold', type=float, default=0.05,
                    help='seconds the button is held; inside the reported latency')
    ap.add_argument('--settle', type=float, default=0.6, help='seconds to let the UI settle')
    ap.add_argument('--timeout', type=float, default=3.0, help='seconds to wait for a change')
    args = ap.parse_args()

    rx, ry, rw, rh = parse_region(args.region)
    targets = [parse_point(c) for c in args.clicks]
    nbytes = rw * rh

    ff = subprocess.Popen(
        ['ffmpeg', '-loglevel', 'error', '-f', 'x11grab',
         '-framerate', str(args.fps), '-video_size', f'{rw}x{rh}',
         '-i', f'{args.display}+{rx},{ry}',
         # passthrough or ffmpeg conforms x11grab's wallclock PTS to a CFR
         # timeline, decides it owes millions of duplicate frames, and floods
         # the pipe with stale ones - every measurement then reads history.
         '-fps_mode', 'passthrough',
         '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
        stdout=subprocess.PIPE, stderr=sys.stderr, bufsize=0)
    xd = subprocess.Popen(['xdotool', '-'], stdin=subprocess.PIPE,
                          env={'DISPLAY': args.display, 'PATH': '/usr/bin:/bin'},
                          text=True, bufsize=1)
    assert ff.stdout is not None and xd.stdin is not None

    def frame() -> tuple[float, np.ndarray]:
        buf = bytearray(nbytes)
        view = memoryview(buf)
        got = 0
        while got < nbytes:
            n = ff.stdout.readinto(view[got:])
            if not n:
                raise SystemExit('ffmpeg ended early - is the display still there?')
            got += n
        return time.monotonic(), np.frombuffer(bytes(buf), dtype=np.uint8).astype(np.int16)

    latencies: list[float] = []
    arrivals: list[float] = []
    try:
        frame()  # discard the first frame: ffmpeg start-up is in it
        for rep in range(args.reps):
            tx, ty = targets[rep % len(targets)]
            xd.stdin.write(f'mousemove {tx} {ty}\n')
            xd.stdin.flush()

            deadline = time.monotonic() + args.settle
            prev_t, base = frame()
            while time.monotonic() < deadline:
                t, base = frame()
                arrivals.append(t - prev_t)
                prev_t = t

            # Same click shape as rfb-latency.py: press, hold, release, with
            # the clock starting at the press. Forge's menu acts on the RELEASE,
            # so the hold passes straight through into the number - both hops
            # must use the same hold or the comparison is meaningless.
            xd.stdin.write('mousedown 1\n')
            xd.stdin.flush()
            t_click = time.monotonic()
            time.sleep(args.hold)
            xd.stdin.write('mouseup 1\n')
            xd.stdin.flush()

            hit = None
            while time.monotonic() - t_click < args.timeout:
                t, f = frame()
                if float(np.abs(f - base).mean()) > args.threshold:
                    hit = (t - t_click) * 1000.0
                    break
            if hit is None:
                print(f'rep {rep}: NO CHANGE within {args.timeout}s at {tx},{ty}', file=sys.stderr)
                continue
            latencies.append(hit)
            print(f'rep {rep:3d} click {tx},{ty}  {hit:7.1f} ms')
    finally:
        for pipe in (xd.stdin, ff.stdout):
            try:
                pipe.close()
            except OSError:
                pass
        for proc in (xd, ff):
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)

    if not latencies:
        print('no measurements', file=sys.stderr)
        return 1
    latencies.sort()
    def pct(p: float) -> float:
        return latencies[min(len(latencies) - 1, int(round(p / 100 * (len(latencies) - 1))))]
    print()
    print(f'n            = {len(latencies)}')
    print(f'frame period = {1000.0 / args.fps:.1f} ms (measurement quantum)')
    if arrivals:
        print(f'capture arrival interval: median {statistics.median(arrivals) * 1000:.1f} ms, '
              f'p95 {sorted(arrivals)[int(0.95 * (len(arrivals) - 1))] * 1000:.1f} ms, '
              f'max {max(arrivals) * 1000:.1f} ms  (n={len(arrivals)})')
    print(f'min          = {latencies[0]:.1f} ms')
    print(f'median       = {statistics.median(latencies):.1f} ms')
    print(f'p95          = {pct(95):.1f} ms')
    print(f'max          = {latencies[-1]:.1f} ms')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
