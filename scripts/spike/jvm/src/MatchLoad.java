package spike.jvm;

import forge.deck.Deck;
import forge.deck.io.DeckSerializer;
import forge.game.Game;
import forge.game.GameEndReason;
import forge.game.GameOutcome;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.Match;
import forge.game.player.RegisteredPlayer;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgeConstants;
import forge.localinstance.properties.ForgeNetPreferences;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.net.HeadlessGuiDesktop;
import forge.player.GamePlayerUtil;

import java.io.File;
import java.io.IOException;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * hadoku-cardtable Wave 9 lane D — O3: what does one Forge match cost, and what
 * does the N-th one cost in a JVM that is already hosting some?
 *
 * <p>One process of this class loads Forge's card database once, then plays
 * {@code jvm.matches} complete AI-vs-AI games of Constructed CONCURRENTLY, each
 * in its own thread with its own {@link Match} and {@link Game}, sharing the one
 * immutable card DB ({@code StaticData}). Run it with {@code jvm.matches=N} for
 * "one JVM hosting N"; run N copies with {@code jvm.matches=1} for "N JVMs".
 * The run script does both; this class only measures itself.
 *
 * <p>It is the ENGINE path — {@code Match.startGame}, as {@code SimulateMatch}
 * drives it — and not Forge's network server. That is deliberate:
 * {@code FServerManager} is a per-JVM singleton holding ONE lobby
 * ({@code FServerManager.java:79,154,212,496}), so Forge's own net stack cannot
 * host two matches in one JVM at all, and upstream's own test suite spawns one
 * JVM per networked game for exactly that reason
 * ({@code MultiProcessGameExecutor.java}, class javadoc). The only way one JVM
 * hosts many matches is many {@code Game}s behind a bridge of ours, and this is
 * that shape with the bridge left out.
 *
 * <p>Every number is printed on one {@code RESULT} line of {@code key=value}
 * pairs, tab-separated, which the run script turns into a TSV row. RSS and PSS
 * come from {@code /proc/self/status} and {@code /proc/self/smaps_rollup}, which
 * is what the host actually pays; heap comes from the platform MXBeans.
 *
 * <p>Properties:
 * <ul>
 *   <li>{@code jvm.matches} (1) — concurrent matches in this JVM</li>
 *   <li>{@code jvm.decks} ("Abzan Siege|Air Forces") — two quest precons</li>
 *   <li>{@code jvm.timeoutSec} (180) — per-match wall cap; a timeout is a draw
 *       and is REPORTED, never hidden</li>
 *   <li>{@code jvm.rounds} (1) — play N matches, release them, repeat. Round 0's
 *       numbers are the headline; heap and RSS after each release show whether
 *       a long-lived JVM gives finished matches back</li>
 *   <li>{@code jvm.readyFile} — touched after the card DB is loaded and the
 *       matches have been launched, so the run script can kill us mid-match</li>
 * </ul>
 *
 * <p>Exit codes: 0 = every match reached a game-over with a winner or a draw on
 * the board. 1 = any match threw, timed out, or never ended. A match that fails
 * is a finding; the harness never swallows it.
 */
public final class MatchLoad {

    private MatchLoad() {}

    private static final long MB = 1024L * 1024L;

    public static void main(final String[] args) throws Exception {
        final long mainAtUptime = ManagementFactory.getRuntimeMXBean().getUptime();
        final int n = Integer.getInteger("jvm.matches", 1);
        final String[] deckNames = System.getProperty("jvm.decks", "Abzan Siege|Air Forces").split("\\|");
        final long timeoutSec = Long.getLong("jvm.timeoutSec", 180L);
        final String readyFile = System.getProperty("jvm.readyFile", "");
        final int rounds = Integer.getInteger("jvm.rounds", 1);

        final Map<String, Object> r = new LinkedHashMap<>();
        r.put("matches", n);
        r.put("xmx_mb", Runtime.getRuntime().maxMemory() / MB);
        r.put("gc", gcNames());
        r.put("jvm_to_main_ms", mainAtUptime);

        // --- the card DB: 33,752 scripts. Per JVM, or amortised? -------------
        final long initStart = System.nanoTime();
        GuiBase.setInterface(new HeadlessGuiDesktop());
        // Same preference handling as DedicatedServer.start() (our fork's `forge server`):
        // defaults, with UPnP decided up front because ASK opens a dialog.
        FModel.initialize(null, preferences -> {
            FModel.getNetPreferences().setPref(ForgeNetPreferences.FNetPref.UPnP, "NEVER");
            return null;
        });
        final long initMs = (System.nanoTime() - initStart) / 1_000_000L;
        r.put("lazy_card_scripts", FModel.getPreferences().getPrefBoolean(FPref.LOAD_CARD_SCRIPTS_LAZILY));
        r.put("init_ms", initMs);
        r.put("ready_uptime_ms", ManagementFactory.getRuntimeMXBean().getUptime());

        final List<Deck> decks = new ArrayList<>();
        for (final String name : deckNames) {
            final File f = new File(ForgeConstants.QUEST_PRECON_DIR, name + ".dck");
            final Deck d = DeckSerializer.fromFile(f);
            if (d == null) {
                throw new IllegalStateException("could not load deck " + f.getAbsolutePath());
            }
            decks.add(d);
        }
        r.put("decks", String.join("|", deckNames));

        fullGc();
        r.put("heap_idle_mb", usedHeapMb());
        r.put("heap_idle_committed_mb", committedHeapMb());
        r.put("rss_idle_mb", procKb("/proc/self/status", "VmRSS:") / 1024);
        r.put("pss_idle_mb", procKb("/proc/self/smaps_rollup", "Pss:") / 1024);

        // --- N matches, concurrently; then again, `rounds` times ---------------
        // Rounds answer a question a single round cannot: does a JVM that has
        // FINISHED matches give their memory back? A shared JVM lives for days;
        // a per-match JVM exits and never has to.
        int ok = 0;
        int failed = 0;
        final StringBuilder outcomes = new StringBuilder();
        final StringBuilder releasedByRound = new StringBuilder();
        final StringBuilder rssByRound = new StringBuilder();
        for (int round = 0; round < rounds; round++) {
            final Map<String, Object> m = new LinkedHashMap<>();
            final int[] okFailed = playRound(n, decks, timeoutSec, readyFile, round, m, outcomes);
            ok += okFailed[0];
            failed += okFailed[1];
            if (round == 0) {
                r.putAll(m);
            }
            releasedByRound.append(round == 0 ? "" : ",").append(m.get("heap_released_mb"));
            rssByRound.append(round == 0 ? "" : ",").append(m.get("rss_released_mb"));
        }
        r.put("rounds", rounds);
        r.put("heap_released_by_round_mb", releasedByRound.toString());
        r.put("rss_released_by_round_mb", rssByRound.toString());
        r.put("rss_hwm_final_mb", procKb("/proc/self/status", "VmHWM:") / 1024);
        r.put("gc_count", gcCount());
        r.put("gc_ms", gcMillis());
        r.put("ok", ok);
        r.put("failed", failed);
        r.put("outcomes", outcomes.toString());
        r.put("total_uptime_ms", ManagementFactory.getRuntimeMXBean().getUptime());

        final StringBuilder line = new StringBuilder("RESULT");
        for (final Map.Entry<String, Object> e : r.entrySet()) {
            line.append('\t').append(e.getKey()).append('=').append(e.getValue());
        }
        System.out.println(line);
        System.out.flush();
        // Forge leaves non-daemon threads (AI, event bus) behind; exit explicitly.
        System.exit(failed == 0 ? 0 : 1);
    }

    /** One round: N concurrent matches, measured. Returns {ok, failed}. */
    private static int[] playRound(final int n, final List<Deck> decks, final long timeoutSec,
                                   final String readyFile, final int round,
                                   final Map<String, Object> r, final StringBuilder outcomes)
            throws Exception {
        final AtomicLong peakUsed = new AtomicLong();
        final AtomicLong peakCommitted = new AtomicLong();
        final Thread sampler = new Thread(() -> {
            final MemoryMXBean mem = ManagementFactory.getMemoryMXBean();
            while (!Thread.currentThread().isInterrupted()) {
                peakUsed.accumulateAndGet(mem.getHeapMemoryUsage().getUsed(), Math::max);
                peakCommitted.accumulateAndGet(mem.getHeapMemoryUsage().getCommitted(), Math::max);
                try {
                    Thread.sleep(25);
                } catch (final InterruptedException e) {
                    return;
                }
            }
        }, "jvm-spike-sampler");
        sampler.setDaemon(true);
        sampler.start();

        final ExecutorService pool = Executors.newFixedThreadPool(n, runnable -> {
            final Thread t = new Thread(runnable);
            t.setName("jvm-spike-match-" + t.threadId());
            return t;
        });
        final List<Game> games = new ArrayList<>();
        final List<Future<Long>> futures = new ArrayList<>();
        final long playStart = System.nanoTime();
        for (int i = 0; i < n; i++) {
            final List<RegisteredPlayer> players = new ArrayList<>();
            for (int p = 0; p < decks.size(); p++) {
                final RegisteredPlayer rp = new RegisteredPlayer(decks.get(p));
                rp.setPlayer(GamePlayerUtil.createAiPlayer("Ai" + (p + 1) + "-m" + i, p));
                players.add(rp);
            }
            final Match match = new Match(new GameRules(GameType.Constructed), players, "jvm-spike-" + i);
            final Game game = match.createGame();
            game.setNoGUIUser();
            games.add(game);
            futures.add(pool.submit(() -> {
                final long s = System.nanoTime();
                match.startGame(game);
                return (System.nanoTime() - s) / 1_000_000L;
            }));
        }
        if (round == 0 && !readyFile.isEmpty()) {
            Files.writeString(Path.of(readyFile), "started " + n + "\n");
        }
        System.out.println("STARTED round " + round + ": " + n + " match(es) at uptime "
                + ManagementFactory.getRuntimeMXBean().getUptime() + " ms");

        int ok = 0;
        int failed = 0;
        final List<Long> durations = new ArrayList<>();
        final long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSec);
        for (int i = 0; i < n; i++) {
            final Game g = games.get(i);
            String what;
            try {
                final long left = Math.max(1L, deadline - System.nanoTime());
                final long ms = futures.get(i).get(left, TimeUnit.NANOSECONDS);
                durations.add(ms);
                final GameOutcome o = g.getOutcome();
                if (o == null || !g.isGameOver()) {
                    what = "no-outcome";
                    failed++;
                } else {
                    what = (o.isDraw() ? "draw" : "win") + "@t" + o.getLastTurnNumber() + "/" + ms + "ms";
                    ok++;
                }
            } catch (final TimeoutException e) {
                what = "TIMEOUT";
                g.setGameOver(GameEndReason.Draw);
                failed++;
            } catch (final ExecutionException e) {
                final Throwable c = e.getCause();
                what = "THREW:" + c.getClass().getSimpleName();
                System.out.println("round " + round + " match " + i + " threw:");
                c.printStackTrace(System.out);
                failed++;
            }
            System.out.println("MATCH r" + round + "/" + i + " " + what);
            outcomes.append(outcomes.length() == 0 ? "" : ",").append(what);
        }
        final long playMs = (System.nanoTime() - playStart) / 1_000_000L;
        sampler.interrupt();
        pool.shutdownNow();

        r.put("play_wall_ms", playMs);
        r.put("match_ms_median", median(durations));
        r.put("match_ms_max", durations.isEmpty() ? -1 : durations.stream().mapToLong(Long::longValue).max().getAsLong());
        r.put("heap_peak_used_mb", peakUsed.get() / MB);
        r.put("heap_peak_committed_mb", peakCommitted.get() / MB);
        r.put("rss_hwm_mb", procKb("/proc/self/status", "VmHWM:") / 1024);

        // Does the heap SETTLE with N finished games still referenced?
        fullGc();
        r.put("heap_held_mb", usedHeapMb());
        r.put("heap_held_committed_mb", committedHeapMb());
        r.put("rss_held_mb", procKb("/proc/self/status", "VmRSS:") / 1024);
        r.put("pss_held_mb", procKb("/proc/self/smaps_rollup", "Pss:") / 1024);
        r.put("games_held", games.size());

        // ...and does it come back once we let go of them?
        games.clear();
        futures.clear();
        fullGc();
        r.put("heap_released_mb", usedHeapMb());
        r.put("rss_released_mb", procKb("/proc/self/status", "VmRSS:") / 1024);
        return new int[] {ok, failed};
    }

    private static void fullGc() {
        // Twice: the first pass can leave finalizable/soft garbage for the second.
        System.gc();
        System.gc();
    }

    private static long usedHeapMb() {
        return ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed() / MB;
    }

    private static long committedHeapMb() {
        return ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getCommitted() / MB;
    }

    private static long gcCount() {
        long c = 0;
        for (final GarbageCollectorMXBean b : ManagementFactory.getGarbageCollectorMXBeans()) {
            c += Math.max(0, b.getCollectionCount());
        }
        return c;
    }

    private static long gcMillis() {
        long c = 0;
        for (final GarbageCollectorMXBean b : ManagementFactory.getGarbageCollectorMXBeans()) {
            c += Math.max(0, b.getCollectionTime());
        }
        return c;
    }

    private static String gcNames() {
        final List<String> names = new ArrayList<>();
        for (final GarbageCollectorMXBean b : ManagementFactory.getGarbageCollectorMXBeans()) {
            names.add(b.getName().replace(' ', '_'));
        }
        return String.join("+", names);
    }

    private static long median(final List<Long> xs) {
        if (xs.isEmpty()) {
            return -1;
        }
        final List<Long> s = new ArrayList<>(xs);
        s.sort(Long::compare);
        return s.get(s.size() / 2);
    }

    /** A {@code kB} field from a /proc file. Throws rather than report a 0 it did not read. */
    private static long procKb(final String file, final String field) throws IOException {
        for (final String l : Files.readAllLines(Path.of(file))) {
            if (l.startsWith(field)) {
                return Long.parseLong(l.substring(field.length()).trim().split("\\s+")[0]);
            }
        }
        throw new IllegalStateException(field + " not found in " + file);
    }
}
