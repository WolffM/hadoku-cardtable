#!/usr/bin/env python3
"""End-to-end click-to-pixel latency over the RFB (VNC) wire.

Unlike `latency.py`, which stops at the X server, this speaks RFB 3.8 to
x11vnc itself: it injects the click as an RFB PointerEvent, exactly as a real
viewer would, and stops the clock when the pixels of the changed region arrive
back over the same socket. So it covers:

    click -> RFB PointerEvent -> XTEST -> Swing repaint -> x11vnc poll
          -> RFB rect encode -> socket -> this client decodes it

What it still does NOT cover, and what you must add to quote a number for a
real player:

  * websockify's WebSocket framing (localhost hop, small)
  * the browser's noVNC decode and canvas paint (~a frame, 8-16 ms)
  * the network between the player and hokon (the big one - a friend on a
    50 ms RTT link pays that twice, once for the click and once for the pixels)

Raw encoding only, deliberately: it is the one encoding every server must
support and it does no compression, so the number is not flattered by a codec
that happens to like this screen. Tight/ZRLE would trade CPU for bytes.

Usage:
  rfb-latency.py --host 127.0.0.1 --port 5990 \
                 --watch 420,50,520,30 --clicks 68,253 --clicks 71,285 --reps 30
"""

from __future__ import annotations

import argparse
import select
import socket
import statistics
import struct
import sys
import time

import numpy as np

DEBUG = False


class Rfb:
    def __init__(self, host: str, port: int, timeout: float = 15.0) -> None:
        self.rx = 0  # bytes read off the RFB socket, for the bandwidth figure
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

        version = self.recv(12)
        if not version.startswith(b'RFB 003.'):
            raise SystemExit(f'not an RFB server: {version!r}')
        self.sock.sendall(b'RFB 003.008\n')

        types = self.recv(self.recv(1)[0])
        if 1 not in types:
            raise SystemExit(f'server wants auth (types {list(types)}); this spike runs -nopw')
        self.sock.sendall(bytes([1]))
        (result,) = struct.unpack('>I', self.recv(4))
        if result != 0:
            raise SystemExit(f'RFB SecurityResult {result}')

        self.sock.sendall(bytes([1]))  # ClientInit, shared
        head = self.recv(24)
        # Endianness and the colour masks are deliberately ignored: change
        # detection compares raw bytes, so the pixels never need interpreting.
        self.w, self.h, self.bpp = struct.unpack('>HHB', head[:5])
        self.bypp = self.bpp // 8
        (namelen,) = struct.unpack('>I', head[20:24])
        self.name = self.recv(namelen).decode('latin-1')

        self.sock.sendall(struct.pack('>BxHi', 2, 1, 0))  # SetEncodings: Raw only
        self.fb = np.zeros((self.h, self.w, self.bypp), dtype=np.uint8)

    def recv(self, n: int) -> bytes:
        out = bytearray()
        while len(out) < n:
            chunk = self.sock.recv(n - len(out))
            if not chunk:
                raise SystemExit('server closed the connection')
            out += chunk
        self.rx += n
        return bytes(out)

    def request(self, incremental: bool) -> None:
        self.sock.sendall(struct.pack('>BBHHHH', 3, int(incremental), 0, 0, self.w, self.h))

    def pointer(self, x: int, y: int, mask: int) -> None:
        self.sock.sendall(struct.pack('>BBHH', 5, mask, x, y))

    def click(self, x: int, y: int, hold: float) -> float:
        """Move, press, hold, release. Returns the moment of the press.

        The hold is not cosmetic. x11vnc batches pointer events between polls
        (-wait/-defer), and a press and release that land in the same batch can
        collapse into nothing: the app never sees a click. Holding the button
        for `hold` puts them in different batches. It also matches what a human
        hand does. The clock starts at the press, so the hold is INSIDE the
        reported latency - the number is press-to-pixel, not release-to-pixel."""
        self.pointer(x, y, 0)
        self.pointer(x, y, 1)
        t = time.monotonic()
        time.sleep(hold)
        self.pointer(x, y, 0)
        return t

    def readable(self, timeout: float) -> bool:
        """An incremental request is answered only when something changed, so we
        wait on the socket rather than letting recv() time out mid-message and
        desynchronise the stream."""
        return bool(select.select([self.sock], [], [], max(0.0, timeout))[0])

    def pump(self) -> list[tuple[int, int, int, int]]:
        """Read one server message. Returns the rectangles it painted, if any."""
        msg = self.recv(1)[0]
        if msg == 0:  # FramebufferUpdate
            (count,) = struct.unpack('>xH', self.recv(3))
            rects = []
            for _ in range(count):
                x, y, w, h, enc = struct.unpack('>HHHHi', self.recv(12))
                if enc != 0:
                    raise SystemExit(f'server used encoding {enc}; only Raw was requested')
                data = self.recv(w * h * self.bypp)
                if w and h:
                    self.fb[y:y + h, x:x + w] = np.frombuffer(data, dtype=np.uint8).reshape(h, w, self.bypp)
                    rects.append((x, y, w, h))
            return rects
        if msg == 1:  # SetColourMapEntries
            _first, count = struct.unpack('>xHH', self.recv(5))
            self.recv(count * 6)
        elif msg == 2:  # Bell
            pass
        elif msg == 3:  # ServerCutText
            (length,) = struct.unpack('>3xI', self.recv(7))
            self.recv(length)
        else:
            raise SystemExit(f'unexpected server message type {msg}')
        return []


def drain(r: Rfb, quiet: float, limit: float, tag: str = '') -> None:
    """Read updates until the screen has been still for `quiet` seconds.

    A fixed sleep is not enough. A full-screen Raw update is 4 MB, and with
    several clients on one host the backlog can take seconds to come through;
    a baseline taken mid-backlog charges the app for this client's own queue.
    Waiting for quiet instead means the baseline is always a settled screen."""
    start = time.monotonic()
    end = start + limit
    r.request(incremental=True)
    rx0 = r.rx
    while time.monotonic() < end:
        if not r.readable(min(quiet, end - time.monotonic())):
            break
        r.pump()
        r.request(incremental=True)
    if DEBUG:
        print(f'  drain{tag}: {(time.monotonic() - start) * 1000:.0f} ms, '
              f'{(r.rx - rx0) / 1024:.0f} KiB', file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, required=True)
    ap.add_argument('--watch', required=True, help='x,y,w,h that must change')
    ap.add_argument('--clicks', action='append', required=True, help='x,y; give twice to alternate')
    ap.add_argument('--reps', type=int, default=30)
    ap.add_argument('--threshold', type=float, default=2.0)
    ap.add_argument('--settle', type=float, default=2.0,
                    help='upper bound on the pre-click drain')
    ap.add_argument('--quiet', type=float, default=0.15,
                    help='no update for this long means the screen has settled')
    ap.add_argument('--timeout', type=float, default=5.0)
    ap.add_argument('--drop-over', type=float, default=1.0,
                    help='a "latency" above this many seconds is a dropped click, not a slow app')
    ap.add_argument('--hold', type=float, default=0.05,
                    help='seconds the mouse button is held down; inside the reported latency')
    ap.add_argument('--debug', action='store_true', help='print drain time and bytes per rep')
    args = ap.parse_args()
    global DEBUG
    DEBUG = args.debug

    wx, wy, ww, wh = (int(v) for v in args.watch.split(','))
    targets = [tuple(int(v) for v in c.split(',')) for c in args.clicks]

    r = Rfb(args.host, args.port)
    print(f'connected: {r.w}x{r.h} {r.bpp}bpp "{r.name}"')
    t_start = time.monotonic()
    r.request(incremental=False)
    while not r.pump():
        pass
    print(f'first full framebuffer received ({r.w * r.h * r.bypp} bytes of Raw)')

    def watched() -> np.ndarray:
        return r.fb[wy:wy + wh, wx:wx + ww].astype(np.int16)

    # One unmeasured warm-up click on targets[-1], so rep 0 (targets[0]) is a
    # real change rather than a click on whatever is already showing. It has to
    # be the same move-press-release burst a measured rep sends: a press with
    # no motion in front of it does not reach Swing.
    r.click(*targets[-1], args.hold)
    drain(r, quiet=args.quiet, limit=10.0, tag=' warm-up')

    latencies: list[float] = []
    dropped = 0
    for rep in range(args.reps):
        tx, ty = targets[rep % len(targets)]
        drain(r, quiet=args.quiet, limit=args.settle)
        base = watched()

        t_click = r.click(tx, ty, args.hold)
        r.request(incremental=True)

        hit = None
        while time.monotonic() - t_click < args.timeout:
            if not r.readable(args.timeout - (time.monotonic() - t_click)):
                break
            r.pump()
            if float(np.abs(watched() - base).mean()) > args.threshold:
                hit = (time.monotonic() - t_click) * 1000.0
                break
            r.request(incremental=True)
        if hit is None or hit > args.drop_over * 1000:
            # x11vnc drops the occasional pointer event (see Rfb.click). When it
            # does, either nothing changes or some unrelated repaint trips the
            # threshold seconds later. Neither is this app's latency, so it is
            # counted as a dropped click and reported, not averaged in.
            dropped += 1
            print(f'rep {rep:3d} click {tx},{ty}  CLICK NOT DELIVERED', file=sys.stderr)
            continue
        latencies.append(hit)
        print(f'rep {rep:3d} click {tx},{ty}  {hit:7.1f} ms')

    if not latencies:
        print('no measurements', file=sys.stderr)
        return 1
    ordered = sorted(latencies)
    elapsed = time.monotonic() - t_start
    rx_after_first = r.rx - r.w * r.h * r.bypp
    print()
    print(f'RFB bytes read = {r.rx} in {elapsed:.1f}s '
          f'({rx_after_first / elapsed / 1024:.0f} KiB/s after the first full frame, Raw encoding)')
    print(f'n      = {len(ordered)}  (dropped clicks: {dropped})')
    print(f'min    = {ordered[0]:.1f} ms')
    print(f'median = {statistics.median(ordered):.1f} ms')
    print(f'p95    = {ordered[int(round(0.95 * (len(ordered) - 1)))]:.1f} ms')
    print(f'max    = {ordered[-1]:.1f} ms')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
