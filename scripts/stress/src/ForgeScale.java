import forge.StaticData;
import forge.ai.LobbyPlayerAi;
import forge.ai.PlayerControllerAi;
import forge.deck.CardPool;
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.deck.io.DeckSerializer;
import forge.game.Game;
import forge.game.GameEndReason;
import forge.game.GameOutcome;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.Match;
import forge.game.combat.Combat;
import forge.game.player.Player;
import forge.game.player.RegisteredPlayer;
import forge.game.spellability.SpellAbility;
import forge.gamemodes.limited.SealedDeckBuilder;
import forge.gui.GuiBase;
import forge.item.PaperCard;
import forge.localinstance.properties.ForgeConstants;
import forge.localinstance.properties.ForgeNetPreferences;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.GuiDesktop;
import forge.util.MyRandom;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.ThreadMXBean;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.LongAdder;

/**
 * Forge scale harness: N concurrent matches in ONE JVM through the engine
 * ({@code Match.startGame}, no {@code FServerManager}), held for a fixed wall
 * time with churn — a slot whose match ends starts the next one — so the JVM
 * sits at N live matches for the whole run.
 *
 * <p>Seats are AI controllers with timing hooks ({@link Seat}). A PACED seat
 * stands in for a human: it waits a random pause before every decision a human
 * would actually make (an action, its own main-phase pass, attacks, blocks)
 * and passes instantly elsewhere, as auto-yield does. Its choices are computed
 * by the AI, which a real human's are not, so its compute time is reported on
 * its own ({@code paced_compute_s}) to be subtracted.
 *
 * <p>The "struggling" signal is Forge's own: {@code AiController} prints
 * {@code AI eval thread at timeout:} when the 5 s {@code Game.AI_TIMEOUT} cuts
 * a priority decision short. {@link Counting} counts those lines on stdout and
 * keeps the frame the eval thread was stuck in.
 *
 * <p>Output: one {@code RESULT} line of tab-separated key=value pairs on the
 * real stdout; Forge's own chatter goes to {@code stress.log}.
 */
public final class ForgeScale {

    private ForgeScale() {}

    private static final long MB = 1024L * 1024L;
    static final String TIMEOUT_MARK = "AI eval thread at timeout:";
    /**
     * Forge treats a thread as a game thread by name alone ({@code ThreadUtil.isGameThread}:
     * starts with "Game"); off one, {@code GameAction.invoke} hands work to Forge's own pool
     * and races the game loop. HostedMatch's games run on "Game-n" threads; so do ours.
     */
    static final String SLOT_PREFIX = "Game-stress-slot-";

    // --- configuration --------------------------------------------------------
    static final int N = Integer.getInteger("stress.matches", 1);
    static final String MODE = System.getProperty("stress.mode", "paced"); // paced | full
    static final double HVH = Double.parseDouble(System.getProperty("stress.hvh", "0")); // share of slots with two paced seats
    static final long PAUSE_MIN = Long.getLong("stress.pauseMinMs", 2000L);
    static final long PAUSE_MAX = Long.getLong("stress.pauseMaxMs", 15000L);
    static final long DURATION_S = Long.getLong("stress.durationSec", 600L);
    static final long MATCH_CAP_S = Long.getLong("stress.matchCapSec", 3600L);
    static final long SEED = Long.getLong("stress.seed", 20261024L);
    static final String DECKS = System.getProperty("stress.decks", "cube"); // cube | precon
    static final String DECK_DIR = System.getProperty("stress.deckDir", "decks");
    static final String CUBE_NAMES = System.getProperty("stress.cubeNames", "cube-names.txt");
    static final int CUBE_DECKS = Integer.getInteger("stress.cubeDecks", 16);
    static final long LIVE_GC_S = Long.getLong("stress.liveGcSec", 60L); // 0 = never force a GC
    static final String SERIES = System.getProperty("stress.series", "");
    static final int STAGGER_MS = Integer.getInteger("stress.staggerMs", 250);
    static final int HEAVY = Integer.getInteger("stress.heavySlots", 0); // first k slots: AI-vs-AI from a stalled crowded board
    /**
     * Fault injection (hosting-test-plan.md B2/B3): the next {@code stress.faultSlots} slots after
     * the heavy ones play a normal vs-AI match whose AI seat, at its {@code stress.faultAfter}-th
     * priority decision, does {@code stress.fault}: {@code soe} recurses until a real
     * StackOverflowError, {@code throw} throws an engine exception, {@code spin} loops on the CPU
     * forever (a hung AI no interrupt reaches), {@code block} waits forever (a hung AI an
     * interrupt does reach). {@code stress.faultRescueSec} after a hang, the harness tries what a
     * host could: end the game and interrupt its thread.
     */
    static final String FAULT = System.getProperty("stress.fault", "");
    static final int FAULT_SLOTS = FAULT.isEmpty() ? 0 : Integer.getInteger("stress.faultSlots", 1);
    static final int FAULT_AFTER = Integer.getInteger("stress.faultAfter", 10);
    static final long FAULT_RESCUE_S = Long.getLong("stress.faultRescueSec", 30L);
    /** Overrides {@code Game.AI_TIMEOUT} (seconds) for every game: 0 makes every canPlay scan a cutoff (B5). */
    static final int AI_TIMEOUT_S = Integer.getInteger("stress.aiTimeoutSec", -1);

    // --- metrics --------------------------------------------------------------
    static final ConcurrentLinkedQueue<Long> AI_PRIORITY_US = new ConcurrentLinkedQueue<>();
    static final ConcurrentLinkedQueue<Long> AI_COMBAT_US = new ConcurrentLinkedQueue<>();
    static final ConcurrentLinkedQueue<Long> ACT_US = new ConcurrentLinkedQueue<>();
    static final LongAdder AI_COMPUTE_US = new LongAdder();
    static final LongAdder PACED_COMPUTE_US = new LongAdder();
    static final LongAdder PAUSES = new LongAdder();
    static final AtomicInteger TIMEOUTS = new AtomicInteger();
    static final AtomicInteger HEAVY_TIMEOUTS = new AtomicInteger();
    static final ConcurrentLinkedQueue<Long> HEAVY_PRIORITY_US = new ConcurrentLinkedQueue<>();
    static final ConcurrentLinkedQueue<Long> HEAVY_COMBAT_US = new ConcurrentLinkedQueue<>();
    static final Map<String, AtomicInteger> TIMEOUT_FRAMES = new ConcurrentHashMap<>();
    static final AtomicLong FORCED_GC_MS = new AtomicLong();
    /**
     * Bumped before and after each forced GC. A measurement whose epoch changed spanned one of
     * OUR stop-the-world GCs, which production never runs, so it is dropped (and counted).
     */
    static final AtomicInteger GC_EPOCH = new AtomicInteger();
    static final LongAdder SPANNED_GC = new LongAdder();
    static final long SLOW_MS = Long.getLong("stress.slowMs", 3000L);
    static final java.util.Set<Seat> DECIDING = ConcurrentHashMap.newKeySet();
    static final Map<String, AtomicInteger> SLOW_FRAMES = new ConcurrentHashMap<>();
    static final AtomicInteger SLOW = new AtomicInteger();
    static final AtomicInteger OVER_5S = new AtomicInteger();
    static final java.util.Set<Game> CAPPED = ConcurrentHashMap.newKeySet();
    static volatile boolean stopping;
    static final AtomicInteger FAULTS = new AtomicInteger();
    static final Map<String, AtomicInteger> FAULT_ENDS = new ConcurrentHashMap<>();
    static final ConcurrentLinkedQueue<Long> FAULT_UNWIND_MS = new ConcurrentLinkedQueue<>();
    /** A hung fault seat -> when it hung (nanos); the main loop rescues entries older than faultRescueSec. */
    static final Map<Seat, Long> HUNG = new ConcurrentHashMap<>();
    static final AtomicInteger RESCUES = new AtomicInteger();
    static final AtomicInteger RESCUED = new AtomicInteger();
    static final AtomicLong FAULT_DETECTED_MS = new AtomicLong(-1);
    static volatile long spinSink;

    public static void main(final String[] args) throws Exception {
        final PrintStream result = new PrintStream(new FileOutputStream(java.io.FileDescriptor.out), true, StandardCharsets.UTF_8);
        final Counting forgeOut = new Counting(new FileOutputStream("stress.log"));
        System.setOut(forgeOut);
        System.setErr(forgeOut);

        final Map<String, Object> r = new LinkedHashMap<>();
        r.put("mode", MODE);
        r.put("matches", N);
        r.put("hvh", HVH);
        r.put("decks", DECKS);
        r.put("seed", SEED);
        r.put("duration_s", DURATION_S);
        r.put("pause_ms", PAUSE_MIN + "-" + PAUSE_MAX);
        r.put("cpus_jvm", Runtime.getRuntime().availableProcessors());
        r.put("xmx_mb", Runtime.getRuntime().maxMemory() / MB);
        r.put("gc", gcNames());

        final long initStart = System.nanoTime();
        initForge();
        r.put("init_ms", (System.nanoTime() - initStart) / 1_000_000L);

        MyRandom.setRandom(new Random(SEED));
        final List<Deck> decks = loadDecks(r);
        fullGc();
        r.put("heap_idle_mb", usedHeapMb());
        r.put("rss_idle_mb", procKb("/proc/self/status", "VmRSS:") / 1024);

        // --- the run ----------------------------------------------------------
        final Sampler sampler = new Sampler(SERIES);
        sampler.start();
        startWatchdog();
        final OperatingSystemCpu cpu = new OperatingSystemCpu();
        final long cpuStart = cpu.processCpuNs();
        final long gcStart = gcMillis();
        final long runStart = System.nanoTime();
        final long deadline = runStart + DURATION_S * 1_000_000_000L;

        final AtomicInteger started = new AtomicInteger();
        final AtomicInteger completed = new AtomicInteger();
        final AtomicInteger failed = new AtomicInteger();
        final AtomicInteger capped = new AtomicInteger();
        final ConcurrentLinkedQueue<Long> matchMs = new ConcurrentLinkedQueue<>();
        final ConcurrentLinkedQueue<Integer> turns = new ConcurrentLinkedQueue<>();
        final LongAdder matchNanos = new LongAdder();
        final Map<Game, Long> live = new ConcurrentHashMap<>(); // game -> start nanos
        final StringBuilder errors = new StringBuilder();

        for (int s = 0; s < N; s++) {
            final int slot = s;
            final boolean heavy = slot < HEAVY;
            final boolean fault = !heavy && slot < HEAVY + FAULT_SLOTS;
            final boolean hvh = MODE.equals("paced") && !heavy && !fault && slot < HEAVY + FAULT_SLOTS + Math.round(HVH * (N - HEAVY - FAULT_SLOTS));
            final Thread t = new Thread(() -> {
                int k = 0;
                while (!stopping && System.nanoTime() < deadline) {
                    final int pair = (slot * 7 + k++) % (decks.size() / 2);
                    final List<RegisteredPlayer> players = new ArrayList<>();
                    for (int p = 0; p < 2; p++) {
                        final boolean paced = MODE.equals("paced") && !heavy && (p == 0 || hvh);
                        final RegisteredPlayer rp = new RegisteredPlayer(decks.get(pair * 2 + p));
                        final StressPlayer lp = new StressPlayer((paced ? "Paced" : "Ai") + (p + 1) + "-s" + slot, paced, heavy, fault && p == 1);
                        lp.setAiProfile("Default");
                        rp.setPlayer(lp);
                        players.add(rp);
                    }
                    final Match match = new Match(new GameRules(GameType.Constructed), players, "stress-" + slot + "-" + k);
                    final Game game = match.createGame();
                    game.setNoGUIUser();
                    if (AI_TIMEOUT_S >= 0) {
                        game.AI_TIMEOUT = AI_TIMEOUT_S;
                    }
                    final long s0 = System.nanoTime();
                    live.put(game, s0);
                    started.incrementAndGet();
                    final Thread capper = capper(game, s0);
                    try {
                        if (heavy) {
                            final forge.game.GameState board = heavyBoard();
                            match.startGame(game, () -> board.applyToGame(game));
                        } else {
                            match.startGame(game);
                        }
                        final GameOutcome o = game.getOutcome();
                        final long ms = (System.nanoTime() - s0) / 1_000_000L;
                        if (fault) {
                            faultEnd(game, "returned:" + (game.isGameOver() ? "over" : "live"));
                        }
                        if (stopping || System.nanoTime() >= deadline && o == null) {
                            // ended by the run's deadline: partial, counted in match-minutes only
                        } else if (CAPPED.remove(game)) {
                            capped.incrementAndGet();
                        } else if (o == null || !game.isGameOver()) {
                            failed.incrementAndGet();
                        } else {
                            completed.incrementAndGet();
                            matchMs.add(ms);
                            turns.add(o.getLastTurnNumber());
                        }
                    } catch (final Throwable e) {
                        if (fault) {
                            faultEnd(game, "threw:" + e.getClass().getSimpleName());
                        }
                        failed.incrementAndGet();
                        synchronized (errors) {
                            errors.append(errors.length() == 0 ? "" : ",").append(e.getClass().getSimpleName());
                        }
                        e.printStackTrace(System.out);
                    } finally {
                        // A decision that threw never reached timed(): drop its seat, or the set holds the game.
                        DECIDING.removeIf(seat -> seat.getGame() == game);
                        capper.interrupt();
                        if (live.remove(game) != null && !stopping) {
                            matchNanos.add(System.nanoTime() - s0);
                        }
                    }
                }
            }, SLOT_PREFIX + slot);
            t.setDaemon(true);
            t.start();
            Thread.sleep(STAGGER_MS);
        }

        long nextGc = System.nanoTime() + LIVE_GC_S * 1_000_000_000L;
        long liveMax = 0;
        final List<Long> liveSamples = new ArrayList<>();
        while (System.nanoTime() < deadline) {
            Thread.sleep(1000);
            rescueHung();
            if (LIVE_GC_S > 0 && System.nanoTime() >= nextGc) {
                final long g0 = System.nanoTime();
                GC_EPOCH.incrementAndGet();
                fullGc();
                GC_EPOCH.incrementAndGet();
                FORCED_GC_MS.addAndGet((System.nanoTime() - g0) / 1_000_000L);
                final long used = usedHeapMb();
                liveSamples.add(used);
                liveMax = Math.max(liveMax, used);
                sampler.noteLive(used);
                nextGc += LIVE_GC_S * 1_000_000_000L;
            }
        }
        // Read everything at the deadline and halt with the games still live: ending them all at
        // once is not load (paced seats stop pausing and every game races to its end).
        stopping = true;
        final long runNs = System.nanoTime() - runStart;
        final long cpuNs = cpu.processCpuNs() - cpuStart;
        final long gcMs = gcMillis() - gcStart;
        final long now = System.nanoTime();
        for (final Long s0 : live.values()) {
            matchNanos.add(now - s0);
        }
        sampler.interrupt();

        final double matchMin = matchNanos.sum() / 60e9;
        r.put("run_s", Math.round(runNs / 1e9));
        r.put("started", started.get());
        r.put("completed", completed.get());
        r.put("failed", failed.get());
        r.put("capped", capped.get());
        r.put("errors", errors.length() == 0 ? "-" : errors.toString());
        r.put("match_min_median", fmt(median(matchMs) / 60000.0));
        r.put("turns_median", median(new ArrayList<>(turns).stream().map(Integer::longValue).toList()));
        r.put("match_minutes", fmt(matchMin));
        r.put("cpu_s", fmt(cpuNs / 1e9));
        r.put("cpu_s_per_match_min", fmt(matchMin > 0 ? cpuNs / 1e9 / matchMin : -1));
        r.put("cores_busy", fmt(cpuNs / (double) runNs));
        r.put("ai_compute_s", fmt(AI_COMPUTE_US.sum() / 1e6));
        r.put("paced_compute_s", fmt(PACED_COMPUTE_US.sum() / 1e6));
        r.put("pauses", PAUSES.sum());
        r.put("ai_decisions", AI_PRIORITY_US.size());
        r.put("ai_p50_ms", pct(AI_PRIORITY_US, 50));
        r.put("ai_p95_ms", pct(AI_PRIORITY_US, 95));
        r.put("ai_p99_ms", pct(AI_PRIORITY_US, 99));
        r.put("ai_max_ms", pct(AI_PRIORITY_US, 100));
        r.put("combat_p95_ms", pct(AI_COMBAT_US, 95));
        r.put("combat_max_ms", pct(AI_COMBAT_US, 100));
        r.put("ai_timeouts", TIMEOUTS.get());
        r.put("timeouts_per_100_dec", fmt(AI_PRIORITY_US.isEmpty() ? 0 : 100.0 * TIMEOUTS.get() / AI_PRIORITY_US.size()));
        r.put("act_n", ACT_US.size());
        r.put("act_p50_ms", pct(ACT_US, 50));
        r.put("act_p95_ms", pct(ACT_US, 95));
        r.put("act_p99_ms", pct(ACT_US, 99));
        r.put("gc_ms", gcMs);
        r.put("forced_gc_ms", FORCED_GC_MS.get());
        r.put("dropped_spanning_gc", SPANNED_GC.sum());
        r.put("gc_pct", fmt(100.0 * Math.max(0, gcMs - FORCED_GC_MS.get()) / (runNs / 1e6)));
        r.put("live_heap_max_mb", liveMax);
        r.put("live_heap_median_mb", median(liveSamples));
        r.put("live_heap_per_match_mb", fmt(N > 0 && !liveSamples.isEmpty() ? (median(liveSamples) - (long) r.get("heap_idle_mb")) / (double) N : -1));
        r.put("rss_peak_mb", procKb("/proc/self/status", "VmHWM:") / 1024);
        r.put("pss_peak_mb", sampler.pssMaxKb.get() / 1024);
        r.put("rss_end_mb", procKb("/proc/self/status", "VmRSS:") / 1024);
        r.put("threads_peak", ManagementFactory.getThreadMXBean().getPeakThreadCount());
        r.put("eval_threads_peak", sampler.evalMax.get());
        r.put("timeout_frames", topFrames(TIMEOUT_FRAMES));
        r.put("slow_decisions", SLOW.get());
        r.put("decisions_over_5s", OVER_5S.get());
        r.put("slow_frames", topFrames(SLOW_FRAMES));
        {
            r.put("heavy_slots", HEAVY);
            r.put("heavy_decisions", HEAVY_PRIORITY_US.size());
            r.put("heavy_p95_ms", pct(HEAVY_PRIORITY_US, 95));
            r.put("heavy_max_ms", pct(HEAVY_PRIORITY_US, 100));
            r.put("heavy_combat_p95_ms", pct(HEAVY_COMBAT_US, 95));
            r.put("heavy_combat_max_ms", pct(HEAVY_COMBAT_US, 100));
            r.put("heavy_timeouts", HEAVY_TIMEOUTS.get());
        }

        {
            r.put("fault", FAULT.isEmpty() ? "-" : FAULT);
            r.put("fault_slots", FAULT_SLOTS);
            r.put("faults", FAULTS.get());
            r.put("fault_ends", topFrames(FAULT_ENDS));
            r.put("fault_unwind_p50_ms", median(FAULT_UNWIND_MS));
            r.put("fault_detected_ms", FAULT_DETECTED_MS.get());
            r.put("rescues", RESCUES.get());
            r.put("rescued", RESCUED.get());
            r.put("still_hung", HUNG.size());
            long faultCpuNs = 0;
            int faultAlive = 0;
            final ThreadMXBean tm = ManagementFactory.getThreadMXBean();
            for (final Thread t : Thread.getAllStackTraces().keySet()) {
                final String n = t.getName();
                if (n.startsWith(SLOT_PREFIX) && Integer.parseInt(n.substring(SLOT_PREFIX.length())) >= HEAVY
                        && Integer.parseInt(n.substring(SLOT_PREFIX.length())) < HEAVY + FAULT_SLOTS) {
                    faultAlive++;
                    faultCpuNs += Math.max(0, tm.getThreadCpuTime(t.getId()));
                }
            }
            r.put("fault_threads_alive", faultAlive);
            r.put("fault_threads_cpu_s", fmt(faultCpuNs / 1e9));
            r.put("ai_timeout_s", AI_TIMEOUT_S);
            r.put("eval_threads_end", sampler.evalNow());
            r.put("threads_end", tm.getThreadCount());
        }

        final StringBuilder line = new StringBuilder("RESULT");
        for (final Map.Entry<String, Object> e : r.entrySet()) {
            line.append('\t').append(e.getKey()).append('=').append(e.getValue());
        }
        result.println(line);
        result.flush();
        Runtime.getRuntime().halt(failed.get() == 0 ? 0 : 1);
    }

    /** Forge's model, headless, from the res/ in the working directory. */
    static void initForge() {
        GuiBase.setInterface(new GuiDesktop());
        FModel.initialize(null, prefs -> {
            prefs.setPref(FPref.LOAD_CARD_SCRIPTS_LAZILY, false);
            prefs.setPref(FPref.UI_LANGUAGE, "en-US");
            prefs.setPref(FPref.ENFORCE_DECK_LEGALITY, false);
            return null;
        });
        if (StaticData.instance() == null) {
            throw new IllegalStateException("Forge did not initialise: is res/ in the working directory?");
        }
        FModel.getNetPreferences().setPref(ForgeNetPreferences.FNetPref.UPnP, "NEVER");
    }

    /** Ends a match that outlives the per-match cap, so one stuck game cannot hold a slot. */
    private static Thread capper(final Game game, final long s0) {
        final Thread t = new Thread(() -> {
            try {
                Thread.sleep(MATCH_CAP_S * 1000L);
                CAPPED.add(game);
                game.setGameOver(GameEndReason.Draw);
            } catch (final InterruptedException ignored) {
                // the match ended first: nothing to cap
            }
        }, "stress-cap");
        t.setDaemon(true);
        t.start();
        return t;
    }

    private static void faultEnd(final Game game, final String how) {
        FAULT_ENDS.computeIfAbsent(how, k -> new AtomicInteger()).incrementAndGet();
        final Long at = FAULTED_AT.remove(game);
        if (at != null) {
            FAULT_UNWIND_MS.add((System.nanoTime() - at) / 1_000_000L);
        }
    }

    static final Map<Game, Long> FAULTED_AT = new ConcurrentHashMap<>();

    /** What a host could do about a hung match without killing the JVM: end the game, interrupt its thread. */
    private static void rescueHung() {
        final long now = System.nanoTime();
        for (final Map.Entry<Seat, Long> e : HUNG.entrySet()) {
            final Seat seat = e.getKey();
            if (!seat.rescueTried && now - e.getValue() > FAULT_RESCUE_S * 1_000_000_000L) {
                seat.rescueTried = true;
                RESCUES.incrementAndGet();
                seat.getGame().setGameOver(GameEndReason.Draw);
                final Thread t = seat.decider;
                if (t != null) {
                    t.interrupt();
                }
            }
        }
    }

    static int recurse(final int depth) {
        return recurse(depth + 1) + 1;
    }

    // --- decks ----------------------------------------------------------------

    /**
     * Cube decks: built ONCE from the cube list with a fixed seed and written
     * to {@code stress.deckDir}; later runs (and other hosts) load those files,
     * so every claw plays the identical decks.
     */
    static List<Deck> loadDecks(final Map<String, Object> r) throws IOException {
        final List<Deck> decks = new ArrayList<>();
        if (DECKS.equals("precon")) {
            for (final String name : new String[] {"Abzan Siege", "Air Forces"}) {
                decks.add(DeckSerializer.fromFile(new File(ForgeConstants.QUEST_PRECON_DIR, name + ".dck")));
            }
            r.put("deck_set", "precon:2");
            return decks;
        }
        final File dir = new File(DECK_DIR);
        final File[] have = dir.listFiles((d, n) -> n.endsWith(".dck"));
        if (have != null && have.length >= 2) {
            final List<File> files = new ArrayList<>(List.of(have));
            files.sort(null);
            for (final File f : files) {
                final Deck d = DeckSerializer.fromFile(f);
                // A parsed deck loads its sections on first use, unsynchronised (Deck.loadDeferredSections):
                // two matches opening one shared deck at once can deal a player an empty library.
                d.getMain();
                decks.add(d);
            }
            r.put("deck_set", "cube-files:" + decks.size());
            return decks;
        }
        final List<String> names = new ArrayList<>(Files.readAllLines(Path.of(CUBE_NAMES)));
        names.removeIf(String::isBlank);
        final List<PaperCard> cube = new ArrayList<>();
        int missing = 0;
        for (final String n : names) {
            PaperCard c = StaticData.instance().getCommonCards().getCard(n);
            if (c == null && n.contains(" // ")) {
                c = StaticData.instance().getCommonCards().getCard(n.substring(0, n.indexOf(" // ")));
            }
            if (c == null) {
                missing++;
                System.out.println("[stress] cube card not in Forge: " + n);
            } else {
                cube.add(c);
            }
        }
        Collections.shuffle(cube, new Random(SEED));
        dir.mkdirs();
        for (int i = 0; i < CUBE_DECKS; i++) {
            final List<PaperCard> pool = new ArrayList<>(cube.subList(i * 45 % (cube.size() - 45), i * 45 % (cube.size() - 45) + 45));
            final Deck d = new SealedDeckBuilder(pool).buildDeck();
            d.setName(String.format("cube-%02d", i));
            final CardPool main = d.getOrCreate(DeckSection.Main);
            if (main.countAll() < 40) {
                throw new IllegalStateException(d.getName() + " has " + main.countAll() + " cards");
            }
            d.getOrCreate(DeckSection.Sideboard).clear();
            DeckSerializer.writeDeck(d, new File(dir, d.getName() + ".dck"));
            decks.add(d);
        }
        r.put("deck_set", "cube-built:" + decks.size() + ":missing=" + missing);
        return decks;
    }

    /**
     * A stalled, crowded board in the shape Card-Forge/forge#3410 describes:
     * two dozen creatures a side, none able to attack profitably, so every
     * declare-attackers and every priority pass weighs a large board.
     */
    static forge.game.GameState heavyBoard() {
        final String[] side = {"Grizzly Bears", "Hill Giant", "Wall of Omens", "Giant Spider", "Serra Angel",
                "Llanowar Elves", "Craw Wurm", "Prodigal Sorcerer", "Wall of Wood", "Centaur Courser",
                "Elvish Mystic", "Watchwolf", "Gray Ogre", "Horned Turtle", "Air Elemental", "Coral Merfolk"};
        final StringBuilder bf = new StringBuilder();
        for (int i = 0; i < 24; i++) {
            bf.append(bf.length() == 0 ? "" : ";").append(side[i % side.length]);
        }
        for (final String l : new String[] {"Forest", "Island", "Plains", "Mountain", "Swamp"}) {
            bf.append(';').append(l).append(';').append(l);
        }
        final forge.game.GameState st = new forge.game.GameState();
        st.parse(List.of("humanlife=20", "ailife=20", "turn=3", "activeplayer=human", "activephase=MAIN1",
                "removesummoningsickness=true", "humanbattlefield=" + bf, "aibattlefield=" + bf));
        return st;
    }

    // --- seats ----------------------------------------------------------------

    /** Forge's AI lobby player, handing out a {@link Seat} instead of a stock controller. */
    static final class StressPlayer extends LobbyPlayerAi {
        final boolean paced;

        final boolean heavy;

        final boolean fault;

        StressPlayer(final String name, final boolean paced, final boolean heavy, final boolean fault) {
            super(name, null);
            this.paced = paced;
            this.heavy = heavy;
            this.fault = fault;
        }

        @Override
        public Player createIngamePlayer(final Game game, final int id) {
            final Player p = new Player(getName(), game, id);
            final Seat c = new Seat(game, p, this, paced, heavy, fault);
            c.getAi().setUseSimulation(null);
            p.setFirstController(c);
            return p;
        }
    }

    /** One game's "a paced seat acted; when does anyone get asked next?" clock. */
    static final Map<Game, AtomicLong> ACTED_AT = Collections.synchronizedMap(new java.util.WeakHashMap<>());
    static final Map<Game, Integer> ACTED_EPOCH = Collections.synchronizedMap(new java.util.WeakHashMap<>());

    static final class Seat extends PlayerControllerAi {
        final boolean paced;
        final boolean heavy;
        final boolean fault;
        int faultCountdown = FAULT_AFTER;
        volatile boolean rescueTried;

        Seat(final Game game, final Player p, final LobbyPlayerAi lp, final boolean paced, final boolean heavy, final boolean fault) {
            super(game, p, lp);
            this.paced = paced;
            this.heavy = heavy;
            this.fault = fault;
        }

        /** The injected fault, on the game thread, inside a priority decision (so the watchdog sees a hang). */
        private void inject() {
            FAULTS.incrementAndGet();
            FAULTED_AT.put(getGame(), System.nanoTime());
            switch (FAULT) {
                case "soe" -> recurse(0);
                case "throw" -> throw new IllegalStateException("stress fault: engine exception");
                case "spin" -> {
                    HUNG.put(this, System.nanoTime());
                    long x = 0;
                    while (true) {
                        x += System.nanoTime() ^ x;
                        spinSink = x;
                    }
                }
                case "block" -> {
                    HUNG.put(this, System.nanoTime());
                    try {
                        new java.util.concurrent.CountDownLatch(1).await();
                    } catch (final InterruptedException e) {
                        Thread.currentThread().interrupt();
                    } finally {
                        if (HUNG.remove(this) != null && rescueTried) {
                            RESCUED.incrementAndGet();
                        }
                    }
                }
                default -> throw new IllegalArgumentException("unknown stress.fault " + FAULT);
            }
        }

        private void entered() {
            if (stopping) {
                return;
            }
            final AtomicLong at = ACTED_AT.get(getGame());
            if (at != null) {
                final long t = at.getAndSet(0);
                if (t != 0) {
                    if (Integer.valueOf(GC_EPOCH.get()).equals(ACTED_EPOCH.get(getGame()))) {
                        ACT_US.add((System.nanoTime() - t) / 1000L);
                    } else {
                        SPANNED_GC.increment();
                    }
                }
            }
        }

        private void acted() {
            ACTED_EPOCH.put(getGame(), GC_EPOCH.get());
            ACTED_AT.computeIfAbsent(getGame(), g -> new AtomicLong()).set(System.nanoTime());
        }

        private void think() {
            PAUSES.increment();
            final long ms = ThreadLocalRandom.current().nextLong(PAUSE_MIN, PAUSE_MAX + 1);
            final long end = System.currentTimeMillis() + ms;
            while (System.currentTimeMillis() < end && !getGame().isGameOver() && !stopping) {
                try {
                    Thread.sleep(Math.min(250, Math.max(1, end - System.currentTimeMillis())));
                } catch (final InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }

        volatile long decidingSince;
        volatile boolean sampled;
        volatile Thread decider;
        volatile int epoch;

        private long begin() {
            final long t0 = System.nanoTime();
            decider = Thread.currentThread();
            epoch = GC_EPOCH.get();
            sampled = false;
            decidingSince = t0;
            DECIDING.add(this);
            return t0;
        }

        private long timed(final long t0, final ConcurrentLinkedQueue<Long> into) {
            DECIDING.remove(this);
            decidingSince = 0;
            final long us = (System.nanoTime() - t0) / 1000L;
            if (stopping) {
                // Teardown ends every game at once; what the AI does then is not load.
                return us;
            }
            if (epoch != GC_EPOCH.get()) {
                SPANNED_GC.increment();
                return us;
            }
            if (us > 5_000_000L) {
                OVER_5S.incrementAndGet();
            }
            if (fault) {
                return us;
            }
            if (paced) {
                PACED_COMPUTE_US.add(us);
            } else if (heavy) {
                (into == AI_PRIORITY_US ? HEAVY_PRIORITY_US : HEAVY_COMBAT_US).add(us);
            } else {
                AI_COMPUTE_US.add(us);
                into.add(us);
            }
            return us;
        }

        @Override
        public List<SpellAbility> chooseSpellAbilityToPlay() {
            entered();
            final long t0 = begin();
            if (fault && --faultCountdown == 0) {
                inject();
            }
            final List<SpellAbility> sa = super.chooseSpellAbilityToPlay();
            timed(t0, AI_PRIORITY_US);
            if (paced) {
                final boolean ownMain = getGame().getPhaseHandler().isPlayerTurn(getPlayer())
                        && getGame().getPhaseHandler().getPhase() != null
                        && getGame().getPhaseHandler().getPhase().isMain();
                if ((sa != null && !sa.isEmpty()) || ownMain) {
                    think();
                }
                if (sa != null && !sa.isEmpty()) {
                    acted();
                }
            }
            return sa;
        }

        @Override
        public void declareAttackers(final Player attacker, final Combat combat) {
            entered();
            final long t0 = begin();
            super.declareAttackers(attacker, combat);
            timed(t0, AI_COMBAT_US);
            if (paced && !attacker.getCreaturesInPlay().isEmpty()) {
                think();
                acted();
            }
        }

        @Override
        public void declareBlockers(final Player defender, final Combat combat) {
            entered();
            final long t0 = begin();
            super.declareBlockers(defender, combat);
            timed(t0, AI_COMBAT_US);
            if (paced && !defender.getCreaturesInPlay().isEmpty()) {
                think();
                acted();
            }
        }
    }

    /**
     * The 5 s AI_TIMEOUT guards only the canPlay scan inside
     * {@code AiController.chooseSpellAbilityToPlayFromList}; everything else a decision does is
     * unguarded. Any decision still running after {@code stress.slowMs} gets its thread's stack
     * sampled once, so an unguarded stall says where it is.
     */
    private static void startWatchdog() {
        final Thread w = new Thread(() -> {
            while (!stopping) {
                final long now = System.nanoTime();
                for (final Seat seat : DECIDING) {
                    final long since = seat.decidingSince;
                    final Thread t = seat.decider;
                    if (since != 0 && !seat.sampled && t != null && now - since > SLOW_MS * 1_000_000L) {
                        seat.sampled = true;
                        SLOW.incrementAndGet();
                        final StringBuilder key = new StringBuilder(seat.heavy ? "heavy:" : seat.fault ? "fault:" : "");
                        if (seat.fault) {
                            final Long at = HUNG.get(seat);
                            if (at != null) {
                                FAULT_DETECTED_MS.compareAndSet(-1, (now - at) / 1_000_000L);
                            }
                        }
                        int n = 0;
                        for (final StackTraceElement e : t.getStackTrace()) {
                            if (e.getClassName().startsWith("forge.") && n < 3) {
                                final String c = e.getClassName();
                                key.append(n++ == 0 ? "" : "<").append(c.substring(c.lastIndexOf('.') + 1)).append('.').append(e.getMethodName());
                            }
                        }
                        SLOW_FRAMES.computeIfAbsent(key.toString(), k -> new AtomicInteger()).incrementAndGet();
                    }
                }
                try {
                    Thread.sleep(500);
                } catch (final InterruptedException e) {
                    return;
                }
            }
        }, "stress-watchdog");
        w.setDaemon(true);
        w.start();
    }

    // --- Forge's stdout: count AI timeouts ----------------------------------

    static final class Counting extends PrintStream {
        Counting(final FileOutputStream out) {
            super(out, true, StandardCharsets.UTF_8);
        }

        private void inspect(final String s) {
            if (s != null && s.startsWith(TIMEOUT_MARK) && !stopping) {
                // AiController prints this on the game thread, which is the slot's own thread.
                final String t = Thread.currentThread().getName();
                if (t.startsWith(SLOT_PREFIX) && Integer.parseInt(t.substring(SLOT_PREFIX.length())) < HEAVY) {
                    HEAVY_TIMEOUTS.incrementAndGet();
                    return;
                }
                TIMEOUTS.incrementAndGet();
                // The eval thread's top frames inside forge, as "Class.method" — where the AI was slow.
                final StringBuilder key = new StringBuilder();
                int n = 0;
                for (final String l : s.split("\n")) {
                    final String f = l.trim();
                    if (f.startsWith("at forge.") && n < 2) {
                        final String m = f.substring(3, f.indexOf('(') > 0 ? f.indexOf('(') : f.length());
                        final String[] parts = m.split("\\.");
                        key.append(n++ == 0 ? "" : "<").append(parts[parts.length - 2]).append('.').append(parts[parts.length - 1]);
                    }
                }
                TIMEOUT_FRAMES.computeIfAbsent(key.length() == 0 ? "?" : key.toString(), k -> new AtomicInteger()).incrementAndGet();
            }
        }

        @Override public void println(final Object x) { inspect(String.valueOf(x)); super.println(x); }
        @Override public void println(final String x) { inspect(x); super.println(x); }
    }

    private static String topFrames(final Map<String, AtomicInteger> frames) {
        if (frames.isEmpty()) {
            return "-";
        }
        final List<Map.Entry<String, AtomicInteger>> es = new ArrayList<>(frames.entrySet());
        es.sort((a, b) -> b.getValue().get() - a.getValue().get());
        final StringBuilder sb = new StringBuilder();
        for (int i = 0; i < Math.min(4, es.size()); i++) {
            sb.append(i == 0 ? "" : ";").append(es.get(i).getKey()).append('x').append(es.get(i).getValue().get());
        }
        return sb.toString();
    }

    // --- sampling -------------------------------------------------------------

    /** Every 5 s: PSS (peak), live "Game AI Eval" threads (peak), and an optional time series. */
    static final class Sampler extends Thread {
        final AtomicLong pssMaxKb = new AtomicLong();
        final AtomicInteger evalMax = new AtomicInteger();
        private final PrintStream series;
        private volatile long lastLive = -1;

        Sampler(final String seriesPath) throws IOException {
            super("stress-sampler");
            setDaemon(true);
            series = seriesPath.isEmpty() ? null : new PrintStream(new FileOutputStream(seriesPath), true, StandardCharsets.UTF_8);
            if (series != null) {
                series.println("t_s\trss_mb\tpss_mb\theap_used_mb\tlive_after_gc_mb\tthreads\teval_threads\tai_timeouts\tai_decisions\tcpu_s\tmetaspace_mb\tclasses\tgc_ms");
            }
        }

        void noteLive(final long mb) { lastLive = mb; }

        int evalNow() {
            int eval = 0;
            for (final Thread t : Thread.getAllStackTraces().keySet()) {
                if ("Game AI Eval".equals(t.getName())) {
                    eval++;
                }
            }
            return eval;
        }

        private static long metaspaceMb() {
            for (final java.lang.management.MemoryPoolMXBean p : ManagementFactory.getMemoryPoolMXBeans()) {
                if ("Metaspace".equals(p.getName())) {
                    return p.getUsage().getUsed() / MB;
                }
            }
            return -1;
        }

        @Override
        public void run() {
            final long t0 = System.nanoTime();
            final ThreadMXBean tm = ManagementFactory.getThreadMXBean();
            final OperatingSystemCpu cpu = new OperatingSystemCpu();
            while (!isInterrupted()) {
                try {
                    final long pss = procKb("/proc/self/smaps_rollup", "Pss:");
                    pssMaxKb.accumulateAndGet(pss, Math::max);
                    final int eval = evalNow();
                    evalMax.accumulateAndGet(eval, Math::max);
                    if (series != null) {
                        series.printf("%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%.1f\t%d\t%d\t%d%n", (System.nanoTime() - t0) / 1_000_000_000L,
                                procKb("/proc/self/status", "VmRSS:") / 1024, pss / 1024, usedHeapMb(), lastLive,
                                tm.getThreadCount(), eval, TIMEOUTS.get(), AI_PRIORITY_US.size(), cpu.processCpuNs() / 1e9,
                                metaspaceMb(), ManagementFactory.getClassLoadingMXBean().getLoadedClassCount(), gcMillis());
                    }
                    Thread.sleep(5000);
                } catch (final InterruptedException e) {
                    return;
                } catch (final IOException e) {
                    throw new IllegalStateException(e);
                }
            }
        }
    }

    static final class OperatingSystemCpu {
        long processCpuNs() {
            return ((com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean()).getProcessCpuTime();
        }
    }

    // --- helpers --------------------------------------------------------------

    private static void fullGc() {
        System.gc();
        System.gc();
    }

    private static long usedHeapMb() {
        return ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed() / MB;
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

    private static long median(final java.util.Collection<Long> xs) {
        if (xs.isEmpty()) {
            return -1;
        }
        final List<Long> s = new ArrayList<>(xs);
        s.sort(Long::compare);
        return s.get(s.size() / 2);
    }

    /** Percentile of microsecond samples, reported in ms with one decimal; -1 when empty. */
    private static String pct(final ConcurrentLinkedQueue<Long> us, final int p) {
        final List<Long> s = new ArrayList<>(us);
        if (s.isEmpty()) {
            return "-1";
        }
        s.sort(Long::compare);
        final int i = Math.min(s.size() - 1, (int) Math.ceil(p / 100.0 * s.size()) - 1);
        return fmt(s.get(Math.max(0, i)) / 1000.0);
    }

    private static String fmt(final double d) {
        return String.format("%.2f", d);
    }

    /** A {@code kB} field from a /proc file. Throws rather than report a 0 it did not read. */
    static long procKb(final String file, final String field) throws IOException {
        for (final String l : Files.readAllLines(Path.of(file))) {
            if (l.startsWith(field)) {
                return Long.parseLong(l.substring(field.length()).trim().split("\\s+")[0]);
            }
        }
        throw new IllegalStateException(field + " not found in " + file);
    }
}
