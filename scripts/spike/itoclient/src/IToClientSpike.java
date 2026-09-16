package spike;

import forge.gamemodes.net.ProtocolMethod;
import forge.gamemodes.net.client.FGameClient;
import forge.gamemodes.net.server.FServerManager;
import forge.gamemodes.net.server.IToClient;
import forge.gamemodes.net.server.RemoteClient;
import forge.gamemodes.net.server.RemoteClientGuiGame;
import forge.gamemodes.net.server.ServerGameLobby;
import forge.net.HeadlessNetworkGuiGame;
import forge.net.PortAllocator;
import forge.net.TestUtils;

import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * hadoku-cardtable PR-4 spike 2 (Wave 6, lane F) — does a real {@code IToClient}
 * call cross a real socket?
 *
 * <p>An OVERLAY. It adds no Java to {@code forge/}; it compiles against the
 * stock fat jar plus the stock {@code forge-gui-desktop} test-classes and is
 * built in a scratch copy of the Forge checkout, never the vendored one.
 *
 * <p><b>Why this is not a simulation.</b> Every object on the send side is
 * production Forge:
 * <ul>
 *   <li>{@link FServerManager#startServer(int)} binds a real Netty
 *       {@code NioServerSocketChannel}.</li>
 *   <li>{@link FGameClient#connect()} opens a real TCP connection to it and
 *       logs in, which is what makes the server mint a {@link RemoteClient} —
 *       and {@code RemoteClient} <i>is</i> the only implementation of
 *       {@link IToClient} (`RemoteClient.java:16`).</li>
 *   <li>{@link RemoteClientGuiGame} is the stock server-side GUI proxy. Its
 *       {@code message(String,String)} is literally
 *       {@code send(ProtocolMethod.message, message, title)}
 *       (`RemoteClientGuiGame.java:424-426`), and its {@code send} runs through
 *       the {@code GameProtocolSender} built over that {@code IToClient}
 *       (`RemoteClientGuiGame.java:76`).</li>
 * </ul>
 * The only class this spike supplies is the receiving {@link IGuiGame}, which
 * records what arrived. Nothing on the path between the two is ours.
 *
 * <p>Three assertions, each of which fails the process with a non-zero exit:
 * <ol>
 *   <li><b>S2C fire-and-forget.</b> {@code proxy.message(nonce, title)} arrives
 *       at the client GUI with the exact nonce. The nonce is generated at run
 *       time, so a stub that echoed a constant could not pass.</li>
 *   <li><b>It crossed a socket, not a reference.</b> The receiving thread is a
 *       Netty client event-loop thread, not the caller's thread, and the
 *       server-side peer address is a real loopback {@code InetSocketAddress}
 *       on the allocated port.</li>
 *   <li><b>S2C-and-reply round trip.</b> {@code proxy.showConfirmDialog(...)}
 *       blocks in {@code IToClient.sendAndWait}, the client answers, and the
 *       answer comes back. Run twice with opposite expected answers so a
 *       hardcoded default cannot pass both.</li>
 * </ol>
 */
public final class IToClientSpike {

    private static final long CONNECT_TIMEOUT_MS = 20_000;
    private static final long ARRIVAL_TIMEOUT_MS = 20_000;

    /** Non-zero on any failed assertion; read by run.sh. */
    private static int failures = 0;

    private static void check(final String what, final boolean ok, final String detail) {
        System.out.printf("  [%s] %s%n      %s%n", ok ? "PASS" : "FAIL", what, detail);
        if (!ok) {
            failures++;
        }
    }

    /**
     * The receiving end. Everything it overrides is a {@link ProtocolMethod}
     * the server is about to send; the superclass is stock Forge test-harness
     * code ({@code forge-gui-desktop/src/test/java/forge/net/HeadlessNetworkGuiGame.java}).
     */
    static final class RecordingGui extends HeadlessNetworkGuiGame {
        final CountDownLatch messageArrived = new CountDownLatch(1);
        final AtomicReference<String> messageText = new AtomicReference<>();
        final AtomicReference<String> messageTitle = new AtomicReference<>();
        final AtomicReference<String> messageThread = new AtomicReference<>();

        /** What the next showConfirmDialog should answer. */
        volatile boolean confirmAnswer = true;
        final AtomicReference<String> confirmPrompt = new AtomicReference<>();
        final AtomicReference<String> confirmThread = new AtomicReference<>();

        @Override
        public void message(final String message, final String title) {
            messageText.set(message);
            messageTitle.set(title);
            messageThread.set(Thread.currentThread().getName());
            messageArrived.countDown();
        }

        @Override
        public boolean showConfirmDialog(final String message, final String title,
                                         final String yesButtonText, final String noButtonText,
                                         final boolean defaultYes) {
            confirmPrompt.set(message);
            confirmThread.set(Thread.currentThread().getName());
            return confirmAnswer;
        }
    }

    public static void main(final String[] args) throws Exception {
        System.out.println("=== PR-4 spike 2: one IToClient call across a real socket ===");

        // Stand up the stock headless harness: HeadlessGuiDesktop as the GuiBase,
        // full card data, UPnP=NEVER. This is Wave 3's finding reused, not re-proved.
        final long t0 = System.currentTimeMillis();
        TestUtils.ensureFModelInitialized();
        System.out.printf("harness up in %d ms (GuiBase=%s)%n",
                System.currentTimeMillis() - t0,
                forge.gui.GuiBase.getInterface().getClass().getName());

        final int port = PortAllocator.allocatePort();
        final FServerManager server = FServerManager.getInstance();
        server.startServer(port);
        server.setLobby(new ServerGameLobby());
        System.out.printf("server: isHosting=%s port=%d upnpMapped=%s%n",
                server.isHosting(), port, server.isUPnPMapped());

        final RecordingGui gui = new RecordingGui();
        final String username = "spike-client";
        final FGameClient client = new FGameClient(username, gui, "127.0.0.1", port);
        client.connect();

        // Slot 0 is the host; the first remote peer lands in slot 1 once its
        // LoginEvent (sent by GameClientHandler.channelActive) is processed.
        RemoteClient remote = null;
        final long deadline = System.currentTimeMillis() + CONNECT_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            remote = server.findClientByIndex(1);
            if (remote != null && remote.hasValidSlot()) {
                break;
            }
            Thread.sleep(25);
        }
        if (remote == null || !remote.hasValidSlot()) {
            System.out.println("  [FAIL] client never reached a lobby slot — nothing to send through");
            shutdown(client, server);
            System.exit(1);
        }

        final SocketAddress peer = remote.getRemoteAddress();
        System.out.printf("connected: username=%s slot=%d peer=%s%n",
                remote.getUsername(), remote.getIndex(), peer);

        // The seam under test. RemoteClient is the sole implementation of IToClient.
        final IToClient toClient = remote;
        final RemoteClientGuiGame proxy = new RemoteClientGuiGame(remote);

        System.out.println();
        System.out.println("-- assertion 1: S2C fire-and-forget carries an exact run-time nonce --");
        final String nonce = "itoclient-spike-" + UUID.randomUUID();
        final String callerThread = Thread.currentThread().getName();
        proxy.message(nonce, "cardtable-w6");

        final boolean arrived = gui.messageArrived.await(ARRIVAL_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        check("ProtocolMethod.message reached the client GUI",
                arrived, "latch=" + arrived);
        check("payload is byte-exact",
                nonce.equals(gui.messageText.get()) && "cardtable-w6".equals(gui.messageTitle.get()),
                "sent=[" + nonce + "] got=[" + gui.messageText.get()
                        + "] title=[" + gui.messageTitle.get() + "]");

        System.out.println();
        System.out.println("-- assertion 2: it crossed a socket, not an object reference --");
        final String recvThread = gui.messageThread.get();
        check("delivered on a different thread than the caller",
                recvThread != null && !recvThread.equals(callerThread),
                "caller=[" + callerThread + "] receiver=[" + recvThread + "]");
        check("server-side peer is a real TCP endpoint on the allocated port",
                peer instanceof InetSocketAddress
                        && ((InetSocketAddress) peer).getAddress().isLoopbackAddress(),
                "peer=" + peer + " serverPort=" + port);
        check("the send side is the IToClient seam",
                toClient instanceof IToClient && toClient == remote,
                IToClient.class.getName() + " <- " + toClient.getClass().getName());

        System.out.println();
        System.out.println("-- assertion 3: sendAndWait round trip, both answers --");
        for (final boolean answer : new boolean[] { true, false }) {
            gui.confirmAnswer = answer;
            final String q = "round-trip-" + answer + "-" + UUID.randomUUID();
            final long rt0 = System.nanoTime();
            final boolean got = proxy.showConfirmDialog(q, "cardtable-w6", "Yes", "No", !answer);
            final long rtMs = (System.nanoTime() - rt0) / 1_000_000;
            check("showConfirmDialog returned the client's answer (" + answer + ")",
                    got == answer && q.equals(gui.confirmPrompt.get()),
                    "returned=" + got + " expected=" + answer
                            + " defaultYes-sent=" + (!answer)
                            + " promptEchoed=" + q.equals(gui.confirmPrompt.get())
                            + " rtt=" + rtMs + "ms"
                            + " answeredOn=[" + gui.confirmThread.get() + "]");
        }

        System.out.println();
        System.out.printf("server send errors: %d%n", server.getTotalSendErrors());
        if (server.getByteTracker() != null) {
            System.out.printf("byte tracker: %s%n", server.getByteTracker());
        }

        shutdown(client, server);

        System.out.println();
        System.out.printf("=== %s: %d failed assertion(s) ===%n",
                failures == 0 ? "ALL PASS" : "FAILURES", failures);
        System.exit(failures == 0 ? 0 : 1);
    }

    private static void shutdown(final FGameClient client, final FServerManager server) {
        try {
            client.close();
        } catch (final Exception e) {
            System.err.println("client close: " + e);
        }
        try {
            server.stopServer();
        } catch (final Exception e) {
            System.err.println("server stop: " + e);
        }
    }
}
