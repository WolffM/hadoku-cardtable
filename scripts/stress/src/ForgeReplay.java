import forge.ai.LobbyPlayerAi;
import forge.deck.Deck;
import forge.game.Game;
import forge.game.GameLogEntry;
import forge.game.GameOutcome;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.Match;
import forge.game.card.Card;
import forge.game.player.Player;
import forge.game.player.RegisteredPlayer;
import forge.game.zone.ZoneType;
import forge.util.MyRandom;

import java.io.FileOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Determinism harness (docs/spikes/per-game-rng.md): plays AI-vs-AI games from fixed seeds, solo
 * (one after another) or all at once in this JVM, and prints one {@code GAME} line per game with a
 * hash of its full game log and final state. The same seed must give the same hash whichever way
 * it ran; a game whose AI hit its wall-clock cutoff is marked, since that cut is time-dependent.
 *
 * <p>{@code -Dreplay.seeds=1,2,3} (game i plays cube deck pair i), {@code -Dreplay.concurrent=true},
 * {@code -Dreplay.repeat=k} (each seed k times; solo only), {@code -Dreplay.out=dir} (a log per game),
 * {@code -Dreplay.trace=true} (and {@code -Dreplay.traceDepth=n}: every draw's caller, per game, to diff).
 * Seeds a game through {@code Match.setRandom} when the jar has it (the per-game fork); on a stock
 * jar it can only seed the JVM-wide {@code MyRandom}, which is the cross-talk this harness exists
 * to detect.
 */
public final class ForgeReplay {
    private ForgeReplay() {}

    static final String PREFIX = "Game-replay-";
    static final Map<String, AtomicInteger> TIMEOUTS = new ConcurrentHashMap<>();
    static final boolean TRACE = Boolean.getBoolean("replay.trace");
    static final int DEPTH = Integer.getInteger("replay.traceDepth", 6);

    /** {@code -Dreplay.trace=true}: a game's random that writes each draw's thread and Forge caller frames, to diff where two runs part. */
    static final class Tracing extends Random {
        private static final long serialVersionUID = 1L;
        private final transient PrintStream sink;
        private int n;

        Tracing(final long seed, final Path file) {
            super(seed);
            try {
                sink = new PrintStream(Files.newOutputStream(file), false, StandardCharsets.UTF_8);
            } catch (final IOException e) {
                throw new IllegalStateException(e);
            }
        }

        @Override
        protected synchronized int next(final int bits) {
            if (sink != null) {
                final StringBuilder sb = new StringBuilder().append(n++).append(' ').append(Thread.currentThread().getName().replaceAll("-\\d+$", ""));
                int k = 0;
                for (final StackTraceElement e : Thread.currentThread().getStackTrace()) {
                    if (e.getClassName().startsWith("forge.") && !e.getClassName().startsWith("forge.util.") && k++ < DEPTH) {
                        sb.append(' ').append(e.getClassName().substring(e.getClassName().lastIndexOf('.') + 1)).append('.').append(e.getMethodName()).append(':').append(e.getLineNumber());
                    }
                }
                sink.println(sb);
                sink.flush();
            }
            return super.next(bits);
        }
    }

    public static void main(final String[] args) throws Exception {
        final PrintStream result = new PrintStream(new FileOutputStream(java.io.FileDescriptor.out), true, StandardCharsets.UTF_8);
        final PrintStream forgeOut = new PrintStream(new FileOutputStream("replay.log"), true, StandardCharsets.UTF_8) {
            private void inspect(final Object x) {
                if (String.valueOf(x).startsWith(ForgeScale.TIMEOUT_MARK)) {
                    TIMEOUTS.computeIfAbsent(Thread.currentThread().getName(), k -> new AtomicInteger()).incrementAndGet();
                }
            }
            @Override public void println(final String x) { inspect(x); super.println(x); }
            @Override public void println(final Object x) { inspect(x); super.println(x); }
        };
        System.setOut(forgeOut);
        System.setErr(forgeOut);

        final List<Long> seeds = new ArrayList<>();
        for (final String s : System.getProperty("replay.seeds", "1").split(",")) {
            seeds.add(Long.parseLong(s.trim()));
        }
        final boolean concurrent = Boolean.getBoolean("replay.concurrent");
        final int repeat = Integer.getInteger("replay.repeat", 1);
        final Path out = Path.of(System.getProperty("replay.out", "replay-out"));
        Files.createDirectories(out);

        ForgeScale.initForge();
        final List<Deck> decks = ForgeScale.loadDecks(new LinkedHashMap<>());
        final Method setRandom = seedingMethod();
        result.println("MODE concurrent=" + concurrent + " repeat=" + repeat + " perGameRandom=" + (setRandom != null) + " cpus=" + Runtime.getRuntime().availableProcessors());

        final List<Thread> threads = new ArrayList<>();
        for (int i = 0; i < seeds.size(); i++) {
            final int index = i;
            final long seed = seeds.get(i);
            final Runnable one = () -> {
                for (int k = 0; k < (concurrent ? 1 : repeat); k++) {
                    result.println(play(decks, index, seed, setRandom, !concurrent, out, k));
                }
            };
            if (concurrent) {
                threads.add(new Thread(one, PREFIX + seed));
            } else {
                final Thread t = new Thread(one, PREFIX + seed);
                t.start();
                t.join();
            }
        }
        if (concurrent && setRandom == null) {
            MyRandom.setRandom(new Random(seeds.get(0))); // a stock jar has one stream for the JVM
        }
        threads.forEach(Thread::start);
        for (final Thread t : threads) {
            t.join();
        }
        Runtime.getRuntime().halt(0);
    }

    private static Method seedingMethod() {
        try {
            return Match.class.getMethod("setRandom", Random.class);
        } catch (final NoSuchMethodException e) {
            return null;
        }
    }

    private static String play(final List<Deck> decks, final int index, final long seed, final Method setRandom, final boolean seedGlobal, final Path out, final int run) {
        final int pair = index % (decks.size() / 2);
        final List<RegisteredPlayer> players = new ArrayList<>();
        for (int p = 0; p < 2; p++) {
            final LobbyPlayerAi lp = new LobbyPlayerAi("Ai" + (p + 1), null);
            lp.setAiProfile("Default");
            players.add(new RegisteredPlayer(decks.get(pair * 2 + p)).setPlayer(lp));
        }
        if (setRandom == null && seedGlobal) {
            MyRandom.setRandom(new Random(seed));
        }
        final Match match = new Match(new GameRules(GameType.Constructed), players, "replay-" + seed);
        if (setRandom != null) {
            try {
                setRandom.invoke(match, TRACE ? new Tracing(seed, out.resolve(seed + "-" + run + ".draws")) : new Random(seed));
            } catch (final ReflectiveOperationException e) {
                throw new IllegalStateException(e);
            }
        }
        final String thread = Thread.currentThread().getName();
        final int timeoutsBefore = TIMEOUTS.getOrDefault(thread, new AtomicInteger()).get();
        final long t0 = System.nanoTime();
        final Game game = match.createGame();
        game.setNoGUIUser();
        String error = "-";
        try {
            match.startGame(game);
        } catch (final RuntimeException e) {
            error = e.getClass().getSimpleName();
            e.printStackTrace(System.out);
        }
        final long ms = (System.nanoTime() - t0) / 1_000_000L;
        final StringBuilder text = new StringBuilder();
        for (final GameLogEntry e : game.getGameLog().getAllEntries()) {
            text.append(e.type()).append(' ').append(e.message()).append('\n');
        }
        text.append("--- final state\n").append(finalState(game));
        try {
            Files.writeString(out.resolve(seed + "-" + run + ".txt"), text);
        } catch (final IOException e) {
            throw new IllegalStateException(e);
        }
        final GameOutcome o = game.getOutcome();
        final int timeouts = TIMEOUTS.getOrDefault(thread, new AtomicInteger()).get() - timeoutsBefore;
        return "GAME\tseed=" + seed + "\trun=" + run + "\tpair=" + pair + "\thash=" + sha256(text.toString())
                + "\tlog_lines=" + game.getGameLog().getAllEntries().size()
                + "\tturns=" + (o == null ? -1 : o.getLastTurnNumber())
                + "\twinner=" + (o == null || o.getWinningLobbyPlayer() == null ? "-" : o.getWinningLobbyPlayer().getName())
                + "\tai_timeouts=" + timeouts + "\tms=" + ms + "\terror=" + error;
    }

    private static String finalState(final Game game) {
        final StringBuilder sb = new StringBuilder();
        sb.append("turn ").append(game.getPhaseHandler().getTurn()).append(' ').append(game.getPhaseHandler().getPhase()).append('\n');
        for (final Player p : game.getRegisteredPlayers()) {
            sb.append(p.getName()).append(" life=").append(p.getLife()).append(" poison=").append(p.getPoisonCounters()).append('\n');
            for (final ZoneType z : new ZoneType[] {ZoneType.Library, ZoneType.Hand, ZoneType.Battlefield, ZoneType.Graveyard, ZoneType.Exile}) {
                sb.append("  ").append(z).append(':');
                for (final Card c : p.getCardsIn(z)) {
                    sb.append(' ').append(c.getId()).append('=').append(c.getName()).append(c.isTapped() ? "(T)" : "")
                            .append(c.getCounters().isEmpty() ? "" : c.getCounters().toString());
                }
                sb.append('\n');
            }
        }
        return sb.toString();
    }

    private static String sha256(final String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8))).substring(0, 16);
        } catch (final java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
