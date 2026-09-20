package spike;

/*
 * Wave 14 lane B left ONE thing unverified, and said the whole GO depends on
 * it: CheerpJ's `natives` JS-interop path. This probe settles it.
 *
 * The question is not "can JS implement a Java native" — that is documented.
 * It is the one a TRANSPORT needs answered:
 *
 *   Can a Java native method BLOCK on an asynchronous JS Promise?
 *
 * Forge's client calls `IToServer.send(...)` and expects it to have happened
 * when it returns. A browser WebSocket is asynchronous. If CheerpJ cannot
 * suspend the Java thread across a JS `await`, then every Forge call site that
 * assumes a synchronous transport has to be rewritten, and lane B's
 * "GO-WITH-COST" becomes a much larger number than it claimed.
 *
 * Four steps, each reported separately so a failure names its own step rather
 * than collapsing into "natives do not work":
 *
 *   1 BOUND    — a native declared in Java and implemented in JS is callable
 *   2 BYTES    — a Java byte[] crosses out and comes back, content intact
 *   3 ASYNC    — the native awaits a JS Promise and Java sees the result
 *   4 SOCKET   — the round trip goes through a real WebSocket to a real server
 *
 * Step 3 is the one that matters. Steps 1, 2 and 4 can all pass while 3 fails,
 * and that combination is a NO-GO wearing a GO's clothes.
 *
 * Nothing here touches forge/ and nothing is written inside the repo.
 */
public final class NativesProbe {

    /** Step 1: is a JS-implemented native reachable from Java at all? */
    private static native String ping(String in);

    /** Step 2: does a byte[] survive the crossing, both directions? */
    private static native byte[] echoBytes(byte[] in);

    /**
     * Step 5: can a native return an array of a DIFFERENT length than it was
     * handed? A transport's replies are not the size of its requests, so a No
     * here changes the bridge's shape rather than blocking it.
     */
    private static native byte[] growBytes(byte[] in);

    /** Step 3 + 4: JS opens a WebSocket, sends, awaits the reply, returns it. */
    private static native byte[] wsRoundTrip(String url, byte[] payload);

    private static void ok(String step, String detail) {
        System.out.println("NATIVES " + step + " PASS " + detail);
    }

    private static void fail(String step, Throwable t) {
        // UnsatisfiedLinkError and "not implemented" are different answers and
        // the distinction is the whole point, so print the class, not just the
        // message.
        System.out.println("NATIVES " + step + " FAIL " + t.getClass().getName()
                + ": " + String.valueOf(t.getMessage()));
    }

    public static void main(String[] args) {
        final String wsUrl = args.length > 0 ? args[0] : "ws://127.0.0.1:8099/echo";
        System.out.println("NATIVES START url=" + wsUrl);

        // ── 1 BOUND ──────────────────────────────────────────────────────────
        try {
            final String r = ping("hello");
            ok("BOUND", "ping->" + r);
        } catch (Throwable t) {
            fail("BOUND", t);
            System.out.println("NATIVES DONE");
            return; // nothing after this can mean anything
        }

        // ── 2 BYTES ──────────────────────────────────────────────────────────
        // Deliberately not ASCII: a transport carries arbitrary octets, and a
        // path that only survives text is not a transport. 0x00 and 0xFF are
        // the two that string-coercion bugs eat.
        final byte[] probe = new byte[] { 0x00, 0x01, 0x7F, (byte) 0x80, (byte) 0xFF, 0x42 };
        try {
            final byte[] back = echoBytes(probe);
            if (back == null) {
                System.out.println("NATIVES BYTES FAIL null returned");
            } else if (!java.util.Arrays.equals(probe, back)) {
                System.out.println("NATIVES BYTES FAIL sent=" + hex(probe) + " got=" + hex(back));
            } else {
                ok("BYTES", "len=" + back.length + " " + hex(back));
            }
        } catch (Throwable t) {
            fail("BYTES", t);
        }

        // ── 3 ASYNC + 4 SOCKET ───────────────────────────────────────────────
        // One call, because they are one question: the await and the socket are
        // the same suspension. Timing is printed because "it returned" and "it
        // returned after actually waiting" are different claims — a stub that
        // resolves immediately would pass a naive check.
        try {
            final long t0 = System.nanoTime();
            final byte[] back = wsRoundTrip(wsUrl, probe);
            final long ms = (System.nanoTime() - t0) / 1_000_000L;
            if (back == null) {
                System.out.println("NATIVES ASYNC FAIL null returned after " + ms + "ms");
            } else if (!java.util.Arrays.equals(probe, back)) {
                System.out.println("NATIVES ASYNC FAIL sent=" + hex(probe) + " got=" + hex(back) + " after " + ms + "ms");
            } else {
                ok("ASYNC", "round trip " + back.length + "B in " + ms + "ms");
                ok("SOCKET", "echoed through a real WebSocket");
            }
        } catch (Throwable t) {
            fail("ASYNC", t);
        }

        // ── 5 GROW ───────────────────────────────────────────────────────────
        try {
            final byte[] grown = growBytes(probe);
            if (grown == null) {
                System.out.println("NATIVES GROW FAIL null returned");
            } else if (grown.length != probe.length * 2) {
                System.out.println("NATIVES GROW FAIL expected " + (probe.length * 2)
                        + "B got " + grown.length + "B " + hex(grown));
            } else {
                ok("GROW", "a fresh " + grown.length + "B array crossed back: " + hex(grown));
            }
        } catch (Throwable t) {
            fail("GROW", t);
        }

        System.out.println("NATIVES DONE");
    }

    private static String hex(byte[] b) {
        final StringBuilder s = new StringBuilder();
        for (final byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }
}
