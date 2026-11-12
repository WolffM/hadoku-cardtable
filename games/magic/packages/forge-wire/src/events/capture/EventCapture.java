package hadoku.events;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.deck.Deck;
import forge.game.Game;
import forge.game.event.GameEvent;
import forge.gamemodes.match.GameLobby.GameLobbyData;
import forge.gamemodes.match.HostedMatch;
import forge.gamemodes.match.LobbySlot;
import forge.gamemodes.match.LobbySlotType;
import forge.gamemodes.net.ChatMessage;
import forge.gamemodes.net.DeltaPacket;
import forge.gamemodes.net.client.ClientGameLobby;
import forge.gamemodes.net.client.FGameClient;
import forge.gamemodes.net.event.UpdateLobbyPlayerEvent;
import forge.gamemodes.net.server.FServerManager;
import forge.gamemodes.net.server.RemoteClient;
import forge.gamemodes.net.server.ServerGameLobby;
import forge.interfaces.ILobbyListener;
import forge.net.HeadlessGuiDesktop;
import forge.net.HeadlessNetworkGuiGame;
import forge.net.PortAllocator;
import forge.net.TestDeckLoader;
import forge.net.TestUtils;

import java.io.BufferedWriter;
import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * hadoku-cardtable Wave 8 lane B — capture every {@code GameEvent} a real match
 * puts on the wire and decode each one to browser-readable JSON.
 *
 * <p>Game setup is the same shape as {@code scripts/spike/tierc/src/CapturePhase.java}
 * (server, lobby, one AI host, one remote slot converted to server-side AI, our
 * own {@code IGuiGame} on the client). It is re-stated here rather than called,
 * because that file's GUI is package-private and its {@code main} halts the VM;
 * this lane may not edit {@code scripts/spike/**}.
 *
 * <p><b>Where the bytes are taken.</b> In {@code applyDelta}, before
 * {@code super.applyDelta}: the items in {@code DeltaPacket.getEvents()} are
 * still {@code TrackableSerializer.WrappedEvent(byte[])}, exactly what crossed
 * the socket. {@link EventJson#decode} reads them WITHOUT a tracker, and the
 * JSON carries the {@code IdRef}/{@code EventCardRef} markers the server wrote —
 * which is what a bridge would forward — rather than live {@code CardView}s.
 *
 * <p><b>The cross-check.</b> Stock Forge then unwraps the same items with its own
 * decoder and calls {@code handleGameEvents}; we histogram those too. The run
 * FAILS unless our per-class histogram equals stock's, count for count.
 *
 * <p>Outputs (to {@code -Devents.outDir}):
 * <ul>
 *   <li>{@code events.ndjson} — every decoded event, one JSON object per line.
 *       Large; scratch only.</li>
 *   <li>{@code fixtures/<Class>.json} — a handful of instances per class,
 *       kept only when they add a (field path, JSON kind) pair no kept instance
 *       has, so the samples cover every such pair the run produced (up to
 *       {@code -Devents.samples} per class; the summary says if a cap bit).</li>
 *   <li>{@code census.json} — per class: count, and which decoder rules fired
 *       (see {@link EventJson.Rule}); the "Java-side help" classification is
 *       computed from this, not asserted by hand.</li>
 * </ul>
 *
 * <p>Exit 0 only if at least one game ran, every wrapped item decoded, nothing
 * fell to {@link EventJson.Rule#UNKNOWN}, and the histogram cross-check matched.
 */
public final class EventCapture {

    private static final long CONNECT_TIMEOUT_MS = 30_000;
    private static final int SAMPLES_PER_CLASS = Integer.getInteger("events.samples", 12);
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();

    private EventCapture() {}

    /** Per-class tallies from OUR decode of the raw bytes. */
    static final Map<String, ClassTally> ours = new TreeMap<>();
    /** Per-class tallies from STOCK Forge's unwrapEvents, as handed to handleGameEvents. */
    static final Map<String, Integer> stock = new TreeMap<>();
    static final List<String> decodeFailures = new ArrayList<>();
    static int wrappedItems;
    static int nonWrappedItems;
    static long deltaPackets;
    static BufferedWriter ndjson;
    /** Games and events carried in from earlier runs by {@code -Devents.merge}. */
    static int mergedGames;
    static int mergedEvents;
    static final JsonArray runs = new JsonArray();

    static final class ClassTally {
        int count;
        final Set<EventJson.Rule> rules = new TreeSet<>();
        final List<JsonObject> samples = new ArrayList<>();
        /** Every (path, kind) pair the kept samples exhibit — see {@link EventJson#features}. */
        final Set<String> covered = new TreeSet<>();

        /** True once an instance with an uncovered pair was turned away by the cap. */
        boolean capped;

        /** Keep {@code json} iff it shows a pair no kept sample does, up to the cap. */
        void offer(final JsonObject json) {
            final Set<String> f = EventJson.features(json);
            if (covered.containsAll(f)) { return; }
            if (samples.size() >= SAMPLES_PER_CLASS) {
                capped = true;
                return;
            }
            samples.add(json);
            covered.addAll(f);
        }
    }

    static final class CapturingGui extends HeadlessNetworkGuiGame {
        @Override
        public void applyDelta(final DeltaPacket packet) {
            if (packet != null) {
                synchronized (ours) {
                    deltaPackets++;
                    for (final Object item : packet.getEvents()) {
                        capture(item);
                    }
                }
            }
            super.applyDelta(packet);
        }

        @Override
        public void handleGameEvents(final List<GameEvent> events) {
            synchronized (stock) {
                for (final GameEvent e : events) {
                    stock.merge(e.getClass().getSimpleName(), 1, Integer::sum);
                }
            }
            super.handleGameEvents(events);
        }
    }

    private static void capture(final Object item) {
        if (item == null || !item.getClass().getName().equals("forge.gamemodes.net.TrackableSerializer$WrappedEvent")) {
            nonWrappedItems++;
            return;
        }
        wrappedItems++;
        final byte[] bytes;
        final EventJson.Decoded decoded;
        try {
            final Method data = item.getClass().getDeclaredMethod("data");
            data.setAccessible(true);
            bytes = (byte[]) data.invoke(item);
            decoded = EventJson.decode(bytes);
        } catch (final Exception e) {
            decodeFailures.add(e.getClass().getName() + ": " + e.getMessage());
            return;
        }
        final Set<EventJson.Rule> rules = new TreeSet<>();
        final JsonObject json = EventJson.toJson(decoded, rules);
        final String cls = decoded.event().getClass().getSimpleName();
        final ClassTally t = ours.computeIfAbsent(cls, k -> new ClassTally());
        t.count++;
        t.rules.addAll(rules);
        t.offer(json);
        try {
            ndjson.write(GSON.toJson(json));
            ndjson.write('\n');
        } catch (final IOException e) {
            decodeFailures.add("ndjson write: " + e.getMessage());
        }
    }

    public static void main(final String[] args) throws Exception {
        final long gameTimeoutMs = Long.getLong("events.gameTimeoutMs", 240_000L);
        final int games = Integer.getInteger("events.games", 1);
        final Path outDir = Paths.get(System.getProperty("events.outDir", "."));
        Files.createDirectories(outDir.resolve("fixtures"));
        ndjson = Files.newBufferedWriter(outDir.resolve("events.ndjson"), StandardCharsets.UTF_8);

        System.out.println("=== Wave 8 lane B: GameEvent capture -> JSON ===");
        System.out.println("events.games=" + games + "  events.samples=" + SAMPLES_PER_CLASS);
        TestUtils.ensureFModelInitialized();

        for (final String dir : System.getProperty("events.merge", "").split(",")) {
            if (!dir.isBlank()) { seed(Paths.get(dir.trim())); }
        }

        final List<String> gameLines = new ArrayList<>();
        for (int g = 1; g <= games; g++) {
            System.out.printf("%n######## game %d of %d ########%n", g, games);
            gameLines.add(playOneGame(gameTimeoutMs));
        }
        ndjson.close();
        final int rc = summarise(outDir, gameLines);
        // Netty's event loops are non-daemon in places; do not wait for them.
        Runtime.getRuntime().halt(rc);
    }

    /**
     * {@code -Devents.merge=DIR[,DIR...]} folds earlier runs' {@code census.json}
     * and {@code fixtures/} into this one before any game is played, so the
     * committed census can span several runs. Random precons make every run
     * fire a slightly different set of classes; a merge is how a class seen in
     * one run and not the next stays evidenced. Each merged run already passed
     * its own ours-equals-stock cross-check (it would not have exited 0
     * otherwise), so its counts are seeded into both sides.
     */
    private static void seed(final Path dir) throws IOException {
        final JsonObject c = JsonParser.parseString(
                Files.readString(dir.resolve("census.json"), StandardCharsets.UTF_8)).getAsJsonObject();
        mergedGames += c.get("games").getAsInt();
        mergedEvents += c.get("events").getAsInt();
        if (c.has("runs")) {
            runs.addAll(c.getAsJsonArray("runs"));
        } else {
            final JsonObject run = new JsonObject();
            run.addProperty("games", c.get("games").getAsInt());
            run.addProperty("events", c.get("events").getAsInt());
            runs.add(run);
        }
        for (final Map.Entry<String, JsonElement> e : c.getAsJsonObject("classes").entrySet()) {
            final String cls = e.getKey();
            final JsonObject cc = e.getValue().getAsJsonObject();
            final ClassTally t = ours.computeIfAbsent(cls, k -> new ClassTally());
            t.count += cc.get("count").getAsInt();
            stock.merge(cls, cc.get("count").getAsInt(), Integer::sum);
            for (final JsonElement r : cc.getAsJsonArray("rules")) { t.rules.add(EventJson.Rule.valueOf(r.getAsString())); }
        }
        // Resample from the run's FULL decoded output when it is still there, so
        // the merged fixtures cover every (path, kind) pair of every event, not
        // just what that run's own sampler happened to keep.
        final Path dump = dir.resolve("events.ndjson");
        if (Files.isRegularFile(dump) && Files.size(dump) > 0) {
            try (java.io.BufferedReader in = Files.newBufferedReader(dump, StandardCharsets.UTF_8)) {
                for (String line = in.readLine(); line != null; line = in.readLine()) {
                    final JsonObject o = JsonParser.parseString(line).getAsJsonObject();
                    ours.get(o.get("event").getAsString()).offer(o);
                }
            }
        } else {
            for (final String cls : c.getAsJsonObject("classes").keySet()) {
                final JsonArray samples = JsonParser.parseString(Files.readString(
                        dir.resolve("fixtures").resolve(cls + ".json"), StandardCharsets.UTF_8)).getAsJsonArray();
                for (final JsonElement sample : samples) { ours.get(cls).offer(sample.getAsJsonObject()); }
            }
        }
        System.out.printf("merged %s: %d games, %d events%n", dir, c.get("games").getAsInt(), c.get("events").getAsInt());
    }

    /**
     * {@code -Devents.decks=Name A,Name B,...} seats these quest precons first,
     * in order (host, remote, host, remote, ...), before falling back to random
     * ones. A capture can then be AIMED at an event random precons rarely fire —
     * {@code GameEventRollDie} needs a die-rolling card, for instance.
     */
    private static final List<String> forcedDecks = new ArrayList<>(
            List.of(System.getProperty("events.decks", "").split(",")).stream()
                    .map(String::trim).filter(x -> !x.isEmpty()).toList());

    private static Deck nextDeck() {
        if (!forcedDecks.isEmpty()) {
            final String name = forcedDecks.remove(0);
            System.out.println("[events] forced precon: " + name);
            return TestDeckLoader.loadQuestPrecon(name);
        }
        return TestDeckLoader.getRandomPrecon();
    }

    private static String playOneGame(final long gameTimeoutMs) throws Exception {
        final int port = PortAllocator.allocatePort();
        final FServerManager server = FServerManager.getInstance();
        server.startServer(port);
        final ServerGameLobby lobby = new ServerGameLobby();
        server.setLobby(lobby);

        final Deck hostDeck = nextDeck();
        final Deck remoteDeck = nextDeck();
        final LobbySlot host = lobby.getSlot(0);
        host.setType(LobbySlotType.AI);
        host.setName("Alice (Host AI)");
        host.setDeck(hostDeck);
        host.setIsReady(true);
        final LobbySlot open = lobby.getSlot(1);
        open.setType(LobbySlotType.OPEN);
        open.setDeck(remoteDeck);
        open.setIsReady(false);
        Thread.sleep(1000);

        final CapturingGui gui = new CapturingGui();
        final ClientGameLobby clientLobby = new ClientGameLobby();
        final CountDownLatch slotAssigned = new CountDownLatch(1);
        final AtomicInteger mySlot = new AtomicInteger(-1);
        final FGameClient client = new FGameClient("Bob (Capturing)", gui, "localhost", port);
        client.addLobbyListener(new ILobbyListener() {
            @Override
            public void update(final GameLobbyData state, final int slot) {
                clientLobby.setData(state);
                if (slot >= 0 && mySlot.compareAndSet(-1, slot)) {
                    clientLobby.setLocalPlayer(slot);
                    slotAssigned.countDown();
                }
            }
            @Override public void message(final String s, final String m, final ChatMessage.MessageType t) { }
            @Override public void close() { }
            @Override public ClientGameLobby getLobby() { return clientLobby; }
        });
        client.connect();
        if (!slotAssigned.await(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            shutdown(client, server);
            return "game FAILED: client never reached a lobby slot";
        }
        Thread.sleep(500);
        final UpdateLobbyPlayerEvent ready = UpdateLobbyPlayerEvent.isReadyUpdate(true);
        clientLobby.applyToSlot(mySlot.get(), ready);
        client.send(ready);
        Thread.sleep(1000);

        final Runnable start = lobby.startGame();
        if (start == null) {
            shutdown(client, server);
            return "game FAILED: lobby.startGame() returned null";
        }
        start.run();
        final RemoteClient remote = server.findClientByIndex(mySlot.get());
        if (remote != null) {
            server.convertToAI(remote);
        }

        final HostedMatch hostedMatch = HeadlessGuiDesktop.getLastMatch();
        int turns = 0;
        final long deadline = System.currentTimeMillis() + gameTimeoutMs;
        while (System.currentTimeMillis() < deadline) {
            final Game game = hostedMatch == null ? null : hostedMatch.getGame();
            if (game != null) {
                turns = game.getPhaseHandler() == null ? 0 : game.getPhaseHandler().getTurn();
                if (game.isGameOver()) {
                    break;
                }
            }
            Thread.sleep(250);
        }
        final Game finalGame = hostedMatch == null ? null : hostedMatch.getGame();
        final boolean over = finalGame != null && finalGame.isGameOver();
        Thread.sleep(1500);
        shutdown(client, server);
        return String.format("game turns=%-3d over=%-5s decks=[%s vs %s]", turns, over,
                hostDeck.getName(), remoteDeck.getName());
    }

    private static int summarise(final Path outDir, final List<String> gameLines) throws IOException {
        int failed = 0;
        System.out.println();
        for (final String l : gameLines) {
            System.out.println("  " + l);
            if (l.startsWith("game FAILED")) { failed++; }
        }
        System.out.println("  delta packets          = " + deltaPackets);
        System.out.println("  wrapped event items    = " + wrappedItems);
        System.out.println("  non-wrapped items      = " + nonWrappedItems);
        System.out.println("  decode failures        = " + decodeFailures.size());
        for (final String f : decodeFailures.subList(0, Math.min(10, decodeFailures.size()))) {
            System.out.println("    " + f);
        }
        if (!decodeFailures.isEmpty() || wrappedItems + mergedEvents == 0 || nonWrappedItems != 0) { failed++; }

        final JsonObject census = new JsonObject();
        final JsonObject classes = new JsonObject();
        int unknown = 0;
        int generic = 0;
        System.out.println();
        System.out.printf("  %-34s %7s %7s %3s  %-8s %s%n", "class", "ours", "stock", "fix", "help?", "rules");
        final Set<String> all = new TreeSet<>(ours.keySet());
        all.addAll(stock.keySet());
        for (final String cls : all) {
            final ClassTally t = ours.get(cls);
            final int mine = t == null ? 0 : t.count;
            final int theirs = stock.getOrDefault(cls, 0);
            final Set<EventJson.Rule> rules = t == null ? Set.of() : t.rules;
            final boolean needsHelp = EventJson.needsJavaHelp(rules);
            if (!needsHelp) { generic++; }
            if (rules.contains(EventJson.Rule.UNKNOWN)) { unknown++; }
            System.out.printf("  %-34s %7d %7d %3d  %-8s %s%s%s%n", cls, mine, theirs,
                    t == null ? 0 : t.samples.size(), needsHelp ? "JAVA" : "generic", rules,
                    mine == theirs ? "" : "   <-- MISMATCH", t != null && t.capped ? "   (sample cap bit)" : "");
            if (mine != theirs) { failed++; }
            final JsonObject c = new JsonObject();
            c.addProperty("count", mine);
            final JsonArray r = new JsonArray();
            for (final EventJson.Rule rule : rules) { r.add(rule.name()); }
            c.add("rules", r);
            c.addProperty("javaSideHelp", needsHelp);
            c.addProperty("samples", t == null ? 0 : t.samples.size());
            // false = some (path, kind) pair seen in the run is NOT in the fixtures.
            c.addProperty("fixturesCoverRun", t != null && !t.capped);
            classes.add(cls, c);
            if (t != null) {
                final JsonArray samples = new JsonArray();
                for (final JsonObject s : t.samples) { samples.add(s); }
                Files.writeString(outDir.resolve("fixtures").resolve(cls + ".json"),
                        new GsonBuilder().serializeNulls().setPrettyPrinting().create().toJson(samples) + "\n",
                        StandardCharsets.UTF_8);
            }
        }
        if (!gameLines.isEmpty()) {
            final JsonObject run = new JsonObject();
            run.addProperty("games", gameLines.size());
            run.addProperty("events", wrappedItems);
            runs.add(run);
        }
        census.addProperty("games", gameLines.size() + mergedGames);
        census.addProperty("events", wrappedItems + mergedEvents);
        census.add("runs", runs);
        census.add("classes", classes);
        Files.writeString(outDir.resolve("census.json"),
                new GsonBuilder().serializeNulls().setPrettyPrinting().create().toJson(census) + "\n",
                StandardCharsets.UTF_8);

        System.out.println();
        System.out.println("  distinct classes fired  = " + all.size());
        System.out.println("  expressible by the generic rules alone = " + generic + " of " + all.size());
        System.out.println("  classes hitting an UNKNOWN value       = " + unknown);
        if (unknown != 0) { failed++; }
        System.out.printf("%nevents capture: %d failed  (events=%d, classes=%d)%n", failed, wrappedItems, all.size());
        System.out.flush();
        return failed == 0 ? 0 : 1;
    }

    private static void shutdown(final FGameClient client, final FServerManager server) {
        try { client.close(); } catch (final RuntimeException ignored) { /* shutting down */ }
        try { server.clearPlayerGuis(); } catch (final RuntimeException ignored) { /* shutting down */ }
        try { server.stopServer(); } catch (final RuntimeException ignored) { /* shutting down */ }
    }
}
