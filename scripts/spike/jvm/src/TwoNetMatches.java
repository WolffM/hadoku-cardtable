package spike.jvm;

import forge.gamemodes.net.server.FServerManager;
import forge.net.TestUtils;
import forge.net.UnifiedNetworkHarness;
import forge.net.UnifiedNetworkHarness.GameResult;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * hadoku-cardtable Wave 9 lane D — can ONE JVM host two networked matches through
 * Forge's own server?
 *
 * <p>Reads as a yes/no on the {@code FServerManager} singleton
 * ({@code FServerManager.getInstance()}, one {@code localLobby} field). Two stock
 * {@link UnifiedNetworkHarness} runs — the same harness Wave 7's
 * {@code MatchPhase} proved plays a real 2-player match over a real socket —
 * are started 2 s apart in one JVM, each asking for its own port.
 *
 * <p>Prints both {@link GameResult}s and whether they saw the same server
 * object. Exit 0 = both matches started AND completed AND each client counted
 * deltas (the singleton is NOT a limit). Exit 3 = at least one did not (it is).
 * Exit 1 = the harness itself threw.
 */
public final class TwoNetMatches {

    private TwoNetMatches() {}

    public static void main(final String[] args) throws Exception {
        TestUtils.ensureFModelInitialized();
        final long timeoutMs = Long.getLong("jvm.gameTimeoutMs", 120_000L);

        final ExecutorService pool = Executors.newFixedThreadPool(2);
        final Future<GameResult> a = pool.submit(() -> run("A", timeoutMs));
        Thread.sleep(2_000);
        final Object serverSeenBetween = FServerManager.getInstance();
        final Future<GameResult> b = pool.submit(() -> run("B", timeoutMs));

        final GameResult ra = a.get(timeoutMs + 60_000, TimeUnit.MILLISECONDS);
        final GameResult rb = b.get(timeoutMs + 60_000, TimeUnit.MILLISECONDS);
        pool.shutdownNow();

        System.out.println();
        System.out.println("FServerManager.getInstance() is one object for the whole JVM: "
                + (serverSeenBetween == FServerManager.getInstance()));
        final boolean okA = print("A", ra);
        final boolean okB = print("B", rb);
        System.out.printf("%nboth networked matches completed in one JVM: %s%n", okA && okB);
        System.out.flush();
        System.exit(okA && okB ? 0 : 3);
    }

    private static GameResult run(final String tag, final long timeoutMs) {
        System.out.println("[" + tag + "] starting a 2-player, 1-remote-client match");
        return new UnifiedNetworkHarness()
                .playerCount(2)
                .remoteClients(1)
                .useAiForRemotePlayers(true)
                .gameTimeout(timeoutMs)
                .execute();
    }

    private static boolean print(final String tag, final GameResult r) {
        System.out.println("-- match " + tag + " --");
        System.out.println("  port                 = " + r.port);
        System.out.println("  gameStarted          = " + r.gameStarted);
        System.out.println("  gameCompleted        = " + r.gameCompleted);
        System.out.println("  turnCount            = " + r.turnCount);
        System.out.println("  winner               = " + r.winner);
        System.out.println("  deltaPacketsReceived = " + r.deltaPacketsReceived);
        System.out.println("  errorMessage         = " + r.errorMessage);
        return r.gameStarted && r.gameCompleted && r.deltaPacketsReceived > 0;
    }
}
