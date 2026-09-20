package spike;

import forge.gamemodes.net.ProtocolMethod;
import forge.gamemodes.net.client.BrowserTransport;
import forge.gamemodes.net.client.FGameClient;
import forge.gamemodes.net.client.NetGameController;
import forge.gui.interfaces.IGuiGame;
import forge.interfaces.IGameController;

import java.lang.reflect.Proxy;

/**
 * Wave 15 lane A — does a real Forge client complete a protocol round trip from
 * inside CheerpJ, over a browser WebSocket, speaking {@code @hadoku/forge-wire}?
 *
 * This is the SPIKE's main, not a fork change: the fork change is the patch in
 * {@code ../forge-patch/}. Everything below drives Forge's own client classes
 * ({@code FGameClient}, {@code NetGameController}, {@code ProtocolMethod},
 * {@code GuiGameEvent}) and asserts nothing itself — every verdict is printed
 * and checked by the server and by {@code measure.mjs}, because a probe that
 * grades its own homework is the "passes while measuring nothing" defect this
 * repo has hit six times.
 *
 * Steps, each named so a failure names its own step:
 *
 *   0 BUILD    — which build of the jar is actually running
 *   1 PROXY    — does java.lang.reflect.Proxy work under CheerpJ? It does NOT,
 *                and that is a finding this lane keeps measuring rather than
 *                deleting: see StubGuiGame's header.
 *   2 OPEN     — FGameClient.connect() takes the browser branch and the socket opens
 *   3 THREAD   — does a background Java thread run the inbound pump?
 *   4 OUT      — IGameController.selectButtonOk() reaches the server as an `act`
 *   5 IN       — a `notify message` reaches IGuiGame.message(...) with the
 *                server's nonce
 *   6 ASK      — two `ask showConfirmDialog` frames get two DIFFERENT `reply`
 *                frames back, so the reply cannot be a constant
 *   7 REFUSE   — a legal Tier B frame is declined BY NAME, not silently eaten
 *   8 SAW      — what IRemote.sendAndWait actually does on this wire
 *   9 RTT      — how long one act->notify round trip costs, from Java
 */
public final class TransportProbe {

    private static StubGuiGame stub;

    public static void main(final String[] args) {
        System.out.println("PROBE START build=" + BuildId.ID);

        // ── 1 PROXY ──────────────────────────────────────────────────────────
        // Kept as a MEASUREMENT, not as the mechanism: it fails under CheerpJ
        // and the failure is worth more than the convenience was. The stub
        // below is a concrete generated class for exactly this reason.
        try {
            final Object p = Proxy.newProxyInstance(
                    IGuiGame.class.getClassLoader(),
                    new Class<?>[] { IGuiGame.class },
                    (proxy, m, a) -> null);
            System.out.println("PROBE PROXY PASS " + p.getClass().getName());
        } catch (final Throwable t) {
            final StringBuilder chain = new StringBuilder();
            for (Throwable c = t; c != null; c = c.getCause()) {
                if (chain.length() > 0) chain.append(" <- ");
                chain.append(c.getClass().getName()).append(": ").append(c.getMessage());
                if (c.getCause() == c) break;
            }
            System.out.println("PROBE PROXY FAIL " + chain);
        }

        stub = new StubGuiGame();
        final IGuiGame gui = stub;

        // ── 2 OPEN ───────────────────────────────────────────────────────────
        // hostname/port are ignored on the browser branch: the URL comes from
        // -Dforge.net.browserTransport, because a page's socket needs a scheme
        // and a path that a host:port pair cannot carry.
        final FGameClient client = new FGameClient("w15a-transport", gui, "unused", 0);
        client.connect();
        final BrowserTransport tx = client.getBrowserTransport();
        if (tx == null) {
            System.out.println("PROBE OPEN FAIL transport is null (property="
                    + System.getProperty(FGameClient.BROWSER_TRANSPORT_PROPERTY) + ")");
            System.out.println("PROBE DONE");
            return;
        }
        System.out.println("PROBE OPEN PASS modelledMethods=" + BrowserTransport.modelledMethodCount());

        // ── 3 THREAD ─────────────────────────────────────────────────────────
        final boolean threaded = tx.startPump();
        System.out.println("PROBE THREAD " + (threaded ? "PASS" : "FAIL")
                + " (background pump " + (threaded ? "started" : "unavailable; pumping inline") + ")");

        final IGameController ctl = new NetGameController(client);

        // ── 4 OUT ────────────────────────────────────────────────────────────
        // Forge's own path: IGameController -> GameProtocolSender ->
        // GuiGameEvent(ProtocolMethod.selectButtonOk) -> IToServer.send.
        ctl.selectButtonOk();
        System.out.println("PROBE OUT sent=" + ProtocolMethod.selectButtonOk.name());

        // ── 5 IN ─────────────────────────────────────────────────────────────
        if (!await("message", 20_000, tx, threaded)) {
            System.out.println("PROBE IN FAIL no message() within 20s; calls=" + stub.calls);
            System.out.println("PROBE DONE");
            return;
        }
        System.out.println("PROBE IN PASS " + ProtocolMethod.message.name());

        // ── 6 ASK ────────────────────────────────────────────────────────────
        // useMana carries a byte, so this also proves a scalar ARGUMENT crosses
        // rather than just a method name.
        ctl.useMana((byte) 3);
        System.out.println("PROBE OUT sent=" + ProtocolMethod.useMana.name() + " color=3");

        if (!await("finishGame", 25_000, tx, threaded)) {
            System.out.println("PROBE ASK FAIL no finishGame() within 25s; calls=" + stub.calls);
            System.out.println("PROBE DONE");
            return;
        }
        System.out.println("PROBE ASK PASS calls=" + stub.calls);

        // ── 9 RTT ────────────────────────────────────────────────────────────
        // A floor, not a click-to-pixel figure: lane D owns that number and
        // takes it the way streaming's 65 ms was taken. This is
        //   Java call -> JS -> socket -> node -> socket -> JS -> Java callback,
        // the cheapest legal act answered by the cheapest legal notify, so what
        // it measures is the bridge rather than a codec. Both ends poll, so
        // read it as "not better than this", with about 2 ms of granularity.
        final int n = 20;
        final long[] rttUs = new long[n];
        int rttOk = 0;
        for (int i = 0; i < n; i++) {
            final long s = System.nanoTime();
            ctl.requestResync();
            if (!awaitCount("clearSelectables", i + 1, 5_000, tx, threaded)) {
                break;
            }
            rttUs[i] = (System.nanoTime() - s) / 1000L;
            rttOk++;
        }
        if (rttOk == n) {
            final long[] sorted = java.util.Arrays.copyOf(rttUs, n);
            java.util.Arrays.sort(sorted);
            System.out.println("PROBE RTT n=" + n
                    + " medianMs=" + fmt(sorted[n / 2])
                    + " minMs=" + fmt(sorted[0])
                    + " maxMs=" + fmt(sorted[n - 1]));
        } else {
            System.out.println("PROBE RTT FAIL completed=" + rttOk + "/" + n);
        }

        // ── 8 SAW ────────────────────────────────────────────────────────────
        // getActivateDescription is the ONLY Mode.CLIENT method with a return
        // value, and forge-wire models no client->server ask. This records what
        // the seam does rather than pretending the question does not exist.
        final long t0 = System.currentTimeMillis();
        String desc = "<threw>";
        try {
            desc = ctl.getActivateDescription(null);
        } catch (final Throwable t) {
            desc = "<" + t.getClass().getName() + ">";
        }
        System.out.println("PROBE SAW returned=" + desc + " in " + (System.currentTimeMillis() - t0) + "ms");

        ctl.concede();
        System.out.println("PROBE OUT sent=" + ProtocolMethod.concede.name());

        // Give the last act time to reach the server before the page is read.
        await("<never>", 1500, tx, threaded);

        System.out.println("PROBE COUNTS framesOut=" + tx.getFramesOut()
                + " framesIn=" + tx.getFramesIn()
                + " refusedOut=" + tx.getRefusedOut()
                + " refusedIn=" + tx.getRefusedIn());
        System.out.println("PROBE DONE");
    }

    private static String fmt(final long micros) {
        return String.format(java.util.Locale.ROOT, "%.1f", micros / 1000.0);
    }

    /** Waits until {@code method} has arrived at least {@code want} times. */
    private static boolean awaitCount(final String method, final int want, final long ms,
                                      final BrowserTransport tx, final boolean threaded) {
        final long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end) {
            if (countOf(method) >= want) {
                return true;
            }
            if (threaded) {
                try {
                    Thread.sleep(1);
                } catch (final InterruptedException e) {
                    return countOf(method) >= want;
                }
            } else {
                tx.pumpFor(1);
            }
        }
        return countOf(method) >= want;
    }

    private static int countOf(final String method) {
        int c = 0;
        synchronized (stub.calls) {
            for (final String s : stub.calls) {
                if (s.equals(method)) c++;
            }
        }
        return c;
    }

    /**
     * Waits for {@code method} to arrive on the GUI stub.
     *
     * With a pump thread we sleep; without one we ARE the pump. Doing both
     * would double-consume the queue, which would look like a dropped frame.
     */
    private static boolean await(final String method, final long ms,
                                 final BrowserTransport tx, final boolean threaded) {
        final long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end) {
            if (stub.calls.contains(method)) {
                return true;
            }
            if (threaded) {
                try {
                    Thread.sleep(50);
                } catch (final InterruptedException e) {
                    return stub.calls.contains(method);
                }
            } else {
                tx.pumpFor(50);
            }
        }
        return stub.calls.contains(method);
    }

}
