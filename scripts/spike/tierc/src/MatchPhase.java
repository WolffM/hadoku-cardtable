package spike.tierc;

import forge.net.TestUtils;
import forge.net.UnifiedNetworkHarness;
import forge.net.UnifiedNetworkHarness.GameResult;

/**
 * hadoku-cardtable Wave 7 lane A, phase 1 — "does a real match produce deltas?"
 *
 * <p>This phase contains NO logic of ours on the measured path. It calls the
 * stock {@link UnifiedNetworkHarness} exactly as Forge's own
 * {@code NetworkPlayIntegrationTest} does, and reads the number the stock
 * {@code HeadlessNetworkClient.DeltaLoggingGuiGame} counted
 * ({@code GameResult.deltaPacketsReceived}, summed in
 * {@code collectRemoteClientMetrics}). The point of keeping it separate from
 * phase 2 is that a sceptic can see that the non-zero delta count comes from
 * upstream code we did not write.
 *
 * <p>Exit codes: 0 = a game started AND the client counted &gt; 0 deltas.
 * 1 = anything else. A zero count is a FAILURE here, per the wave brief.
 *
 * <p>Mutation for this assertion: {@code -Dtierc.remoteClients=0}. The harness
 * then takes its local-AI path, no client ever connects, and
 * {@code deltaPacketsReceived} must be 0 — so this class must exit non-zero.
 *
 * <p>{@code -Dforge.deltasync=false} is NOT the mutation here, and finding that
 * out is a result in itself: it sets {@code RemoteClientGuiGame.useDeltaSync}
 * false, which stops the server building STATE deltas, but
 * {@code RemoteClientGuiGame} still sends {@code ProtocolMethod.applyDelta}
 * carrying {@code DeltaPacket.eventsOnly(...)} (`RemoteClientGuiGame.java:607`
 * and `:640`). The measured run with it off: 49 applyDelta calls, 588 delta
 * bytes and 52 setGameView calls, against 48 / 289746 / 3 with it on. A packet
 * COUNT therefore cannot detect it; {@link CapturePhase} asserts on packets
 * that carry state instead, and that assertion does detect it.
 */
public final class MatchPhase {

    private MatchPhase() {}

    public static void main(final String[] args) {
        final long timeoutMs = Long.getLong("tierc.gameTimeoutMs", 240_000L);
        final int remoteClients = Integer.getInteger("tierc.remoteClients", 1);
        System.out.println("=== Wave 7 lane A / phase 1: a real 2-player match over a real socket ===");
        System.out.println("forge.deltasync=" + System.getProperty("forge.deltasync", "(unset -> on)"));
        System.out.println("tierc.remoteClients=" + remoteClients + "   (mutation: 0)");
        System.out.println("gameTimeoutMs=" + timeoutMs);

        TestUtils.ensureFModelInitialized();

        final GameResult r = new UnifiedNetworkHarness()
                .playerCount(2)
                .remoteClients(remoteClients)
                .useAiForRemotePlayers(true)
                .gameTimeout(timeoutMs)
                .execute();

        System.out.println();
        System.out.println("-- stock UnifiedNetworkHarness.GameResult --");
        System.out.println("  description             = " + r.description);
        System.out.println("  port                    = " + r.port);
        System.out.println("  decks                   = " + r.deckNames);
        System.out.println("  gameStarted             = " + r.gameStarted);
        System.out.println("  gameCompleted           = " + r.gameCompleted);
        System.out.println("  turnCount               = " + r.turnCount);
        System.out.println("  winner                  = " + r.winner);
        System.out.println("  gameDurationMs          = " + r.gameDurationMs);
        System.out.println("  errorMessage            = " + r.errorMessage);
        System.out.println("  clientOpenViewCalled    = " + r.clientOpenViewCalled);
        System.out.println("  clientSetGameViewCount  = " + r.clientSetGameViewCount);
        System.out.println("  deltaPacketsReceived    = " + r.deltaPacketsReceived + "   <- client side");
        System.out.println("  fullStateSyncsReceived  = " + r.fullStateSyncsReceived);
        System.out.println("  totalDeltaBytes         = " + r.totalDeltaBytes);
        System.out.println("  deltaPacketCount        = " + r.deltaPacketCount + "   <- server side");
        System.out.println("  deltaBytesSent          = " + r.deltaBytesSent);
        System.out.println("  fullStateBytesSent      = " + r.fullStateBytesSent);
        System.out.println("  sendErrors              = " + r.sendErrors);
        System.out.println("  eventStateMismatches    = " + r.eventStateMismatches);

        int failed = 0;
        int passed = 0;

        if (r.gameStarted) { passed++; } else { failed++; }
        System.out.printf("%n  [%s] a game actually started (gameStarted=%s)%n",
                r.gameStarted ? "PASS" : "FAIL", r.gameStarted);

        final boolean deltas = r.deltaPacketsReceived > 0;
        if (deltas) { passed++; } else { failed++; }
        System.out.printf("  [%s] the client counted a NON-ZERO number of delta packets (%d)%n",
                deltas ? "PASS" : "FAIL", r.deltaPacketsReceived);

        final boolean stateChannel = r.clientOpenViewCalled && r.clientSetGameViewCount > 0;
        if (stateChannel) { passed++; } else { failed++; }
        System.out.printf("  [%s] the state channel opened (openView=%s, setGameView x%d)%n",
                stateChannel ? "PASS" : "FAIL", r.clientOpenViewCalled, r.clientSetGameViewCount);

        System.out.printf("%nphase 1: %d failed / %d passed%n", failed, passed);
        System.exit(failed == 0 ? 0 : 1);
    }
}
