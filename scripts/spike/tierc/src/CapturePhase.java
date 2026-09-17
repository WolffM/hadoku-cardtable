package spike.tierc;

import forge.deck.Deck;
import forge.game.Game;
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

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * hadoku-cardtable Wave 7 lane A, phase 2 — <b>does a real delta survive a JSON
 * round trip?</b>
 *
 * <p>Phase 1 ({@link MatchPhase}) proved deltas flow, using only stock Forge.
 * This phase needs the packet <i>objects</i>, and the stock client's
 * {@code DeltaLoggingGuiGame} is a private inner class of
 * {@code HeadlessNetworkClient} with no hook to reach them. So this class
 * stands up the same game shape by hand — server, lobby, one AI host, one
 * remote slot — and connects a client whose {@code IGuiGame} is ours. Everything
 * else on the path is production Forge: {@link FServerManager}'s Netty server,
 * {@link FGameClient}'s real TCP connection, {@code RemoteClientGuiGame} building
 * the deltas, and {@code NetworkGuiGame.applyDelta} applying them (we call
 * {@code super}).
 *
 * <p>The round trip runs <b>inside</b> {@code applyDelta}, before
 * {@code super.applyDelta} mutates the client tracker. A packet analysed later
 * would be a packet whose {@code CardView} values have since been rewritten in
 * place, and the comparison would be meaningless.
 *
 * <p>Exit codes: 0 only if a game started, the client counted &gt; 0 deltas, and
 * every self-test fixture and every captured value round-tripped. Any
 * round-trip failure exits 1 — but per the wave brief a failure here is a
 * <i>useful</i> outcome, and the census names exactly which (property, class)
 * pairs failed and why.
 */
public final class CapturePhase {

    private static final long CONNECT_TIMEOUT_MS = 30_000;

    private CapturePhase() {}

    // ------------------------------------------------------------------ state

    static final AtomicLong deltaPackets = new AtomicLong();
    static final AtomicLong fullSyncs = new AtomicLong();
    static final AtomicInteger setGameViewCalls = new AtomicInteger();
    static final AtomicInteger openViewCalls = new AtomicInteger();
    /** Packets that carried object STATE, as opposed to events only. */
    static final AtomicInteger statePackets = new AtomicInteger();
    static final JsonDelta.Report report = new JsonDelta.Report();
    static volatile String sampleNewJson;
    static volatile String sampleNewHeader;
    static volatile String sampleDeltaJson;
    static volatile String sampleDeltaHeader;
    /** Which GameEvent classes a real match actually fires — the true size of the events schema. */
    static final Map<String, Integer> eventClasses = new java.util.TreeMap<>();
    static int eventsDelivered;
    /** Errors thrown by OUR analysis (never by Forge) — a crash here must not read as a pass. */
    static final List<String> analysisErrors = new ArrayList<>();

    /**
     * The receiving GUI. Its only addition to the stock
     * {@link HeadlessNetworkGuiGame} is the capture-and-analyse hook.
     */
    static final class CapturingGui extends HeadlessNetworkGuiGame {
        @Override
        public void applyDelta(final DeltaPacket packet) {
            deltaPackets.incrementAndGet();
            if (packet != null) {
                if (!packet.getNewObjects().isEmpty() || !packet.getObjectDeltas().isEmpty()) {
                    statePackets.incrementAndGet();
                }
                try {
                    synchronized (report) {
                        JsonDelta.roundTripPacket(packet, report);
                        // Two worked examples for the doc: the first packet that
                        // creates objects (truncated — the opening sync has 124 of
                        // them), and the first small mid-game packet that only
                        // mutates existing ones, which is what the stream is mostly
                        // made of.
                        if (sampleNewJson == null && !packet.getNewObjects().isEmpty()) {
                            sampleNewHeader = packet.toString();
                            sampleNewJson = JsonDelta.packetToJson(packet, 3);
                        }
                        if (sampleDeltaJson == null && packet.getNewObjects().isEmpty()
                                && !packet.getObjectDeltas().isEmpty()
                                && packet.getObjectDeltas().size() <= 4) {
                            sampleDeltaHeader = packet.toString();
                            sampleDeltaJson = JsonDelta.packetToJson(packet, 4);
                        }
                    }
                } catch (final RuntimeException | StackOverflowError ex) {
                    synchronized (analysisErrors) {
                        analysisErrors.add(ex.getClass().getName() + ": " + ex.getMessage());
                    }
                }
            }
            super.applyDelta(packet);
        }

        /**
         * Stock Forge has already run
         * {@code TrackableSerializer.unwrapEvents(packet.getEvents(), tracker)}
         * by the time this is called (`NetworkGuiGame.java:171-173`), so this is
         * the cheapest place to learn which GameEvent classes a real match
         * actually fires. `forge-game/.../event/` declares 58 of them; the
         * question for Tier C is how many a game uses, because each one needs
         * its own JSON schema.
         */
        @Override
        public void handleGameEvents(final List<forge.game.event.GameEvent> events) {
            synchronized (eventClasses) {
                for (final forge.game.event.GameEvent e : events) {
                    eventsDelivered++;
                    eventClasses.merge(e.getClass().getSimpleName(), 1, Integer::sum);
                }
            }
            super.handleGameEvents(events);
        }

        @Override
        public void openView(final forge.trackable.TrackableCollection<forge.game.player.PlayerView> myPlayers) {
            openViewCalls.incrementAndGet();
            super.openView(myPlayers);
        }

        @Override
        public void setGameView(final forge.game.GameView gameView, final long sequenceNumber) {
            super.setGameView(gameView, sequenceNumber);
            setGameViewCalls.incrementAndGet();
            if (sequenceNumber >= 0) {
                fullSyncs.incrementAndGet();
            }
        }
    }

    // ------------------------------------------------------------------- main

    private static int failed = 0;
    private static int passed = 0;
    private static final List<String> gameLines = new ArrayList<>();

    public static void main(final String[] args) throws Exception {
        final long gameTimeoutMs = Long.getLong("tierc.gameTimeoutMs", 240_000L);
        final int games = Integer.getInteger("tierc.games", 1);
        final Path outDir = Paths.get(System.getProperty("tierc.outDir", "."));
        Files.createDirectories(outDir);

        System.out.println("=== Wave 7 lane A / phase 2: does a real delta survive a JSON round trip? ===");
        System.out.println("tierc.mutate=" + System.getProperty("tierc.mutate", "(none)"));
        System.out.println("tierc.games=" + games);
        System.out.println("forge.deltasync=" + System.getProperty("forge.deltasync", "(unset -> on)"));

        // 1. Bring Forge up. This comes first even though the self-test does not
        //    need a game: PhaseType's enum constants call Localizer in their
        //    constructor, so touching one before FModel is initialised throws
        //    ExceptionInInitializerError.
        TestUtils.ensureFModelInitialized();

        // 0. Codec self-test on fixtures. If the codec cannot round-trip a
        //    boolean, nothing it says about a real packet means anything.
        final int[] st = JsonDelta.selfTest();
        System.out.printf("%n-- codec self-test on fixtures: %d failed / %d passed --%n", st[0], st[1]);
        if (st[0] == 0) { passed++; } else { failed++; }

        // Several matches, because the census is only as wide as the cards that
        // actually turned up. Decks are random precons, so each game exercises a
        // different slice of TrackableProperty; the coverage table at the end
        // says which slice, and the doc says which properties were never hit.
        for (int g = 1; g <= games; g++) {
            System.out.printf("%n################ game %d of %d ################%n", g, games);
            playOneGame(gameTimeoutMs);
        }

        summarise(outDir);
    }

    private static void playOneGame(final long gameTimeoutMs) throws Exception {
        final int port = PortAllocator.allocatePort();
        final FServerManager server = FServerManager.getInstance();
        server.startServer(port);
        final ServerGameLobby lobby = new ServerGameLobby();
        server.setLobby(lobby);

        final Deck hostDeck = TestDeckLoader.getRandomPrecon();
        final Deck remoteDeck = TestDeckLoader.getRandomPrecon();

        final LobbySlot host = lobby.getSlot(0);
        host.setType(LobbySlotType.AI);
        host.setName("Alice (Host AI)");
        host.setDeck(hostDeck);
        host.setIsReady(true);

        final LobbySlot open = lobby.getSlot(1);
        open.setType(LobbySlotType.OPEN);
        open.setDeck(remoteDeck);
        open.setIsReady(false);

        System.out.printf("server on port %d; decks: host=%s remote=%s%n",
                port, hostDeck.getName(), remoteDeck.getName());
        Thread.sleep(1000);

        // 2. Connect OUR client. Same shape as HeadlessNetworkClient.connect().
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

        final boolean connected = slotAssigned.await(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        System.out.printf("  [%s] client reached a lobby slot (slot=%d)%n",
                connected ? "PASS" : "FAIL", mySlot.get());
        if (connected) { passed++; } else { failed++; }
        if (!connected) {
            shutdown(client, server);
            return;
        }

        Thread.sleep(500);
        final UpdateLobbyPlayerEvent ready = UpdateLobbyPlayerEvent.isReadyUpdate(true);
        clientLobby.applyToSlot(mySlot.get(), ready);
        client.send(ready);
        Thread.sleep(1000);

        // 3. Start the game.
        final Runnable startRunnable = lobby.startGame();
        final boolean started = startRunnable != null;
        System.out.printf("  [%s] lobby.startGame() returned a runnable%n", started ? "PASS" : "FAIL");
        if (started) { passed++; } else { failed++; }
        if (!started) {
            shutdown(client, server);
            return;
        }
        startRunnable.run();

        // 4. Hand the remote player to the server-side AI, exactly as
        //    UnifiedNetworkHarness.swapRemotePlayersToAi() does, so the match
        //    plays itself and the delta stream is a real game's, not a stalled
        //    lobby's.
        final RemoteClient remote = server.findClientByIndex(mySlot.get());
        if (remote != null) {
            server.convertToAI(remote);
            System.out.println("  converted slot " + mySlot.get() + " to server-side AI");
        } else {
            System.out.println("  WARNING: no RemoteClient at index " + mySlot.get() + "; not converting to AI");
        }

        // 5. Let it play.
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
        final boolean gameOver = finalGame != null && finalGame.isGameOver();
        System.out.printf("%ngame: turns=%d over=%s%n", turns, gameOver);

        Thread.sleep(1500);
        shutdown(client, server);
        gameLines.add(String.format("game turns=%-3d over=%-5s decks=[%s vs %s] deltasSoFar=%d",
                turns, gameOver, hostDeck.getName(), remoteDeck.getName(), deltaPackets.get()));
    }

    private static void summarise(final Path outDir) {
        // 6. The verdict.
        final long deltas = deltaPackets.get();
        System.out.println();
        System.out.println("################ verdict ################");
        for (final String l : gameLines) {
            System.out.println("  " + l);
        }
        System.out.println();
        System.out.println("-- delta stream --");
        System.out.println("  applyDelta calls        = " + deltas);
        System.out.println("  setGameView calls       = " + setGameViewCalls.get());
        System.out.println("  full state syncs        = " + fullSyncs.get());
        System.out.println("  openView calls          = " + openViewCalls.get());
        System.out.println("  packets analysed        = " + report.packets);
        System.out.println("  packets with events     = " + report.packetsWithEvents);
        System.out.println("  packets carrying STATE  = " + statePackets.get());

        final boolean nonZero = deltas > 0;
        System.out.printf("  [%s] the client counted a NON-ZERO number of delta packets (%d)%n",
                nonZero ? "PASS" : "FAIL", deltas);
        if (nonZero) { passed++; } else { failed++; }

        // A packet COUNT cannot tell delta sync from no delta sync: with
        // RemoteClientGuiGame.useDeltaSync=false the server still sends
        // applyDelta, carrying DeltaPacket.eventsOnly(...). This is the
        // assertion that can tell the difference, and the mutation
        // -Dforge.deltasync=false is what proves it can.
        final boolean carriedState = statePackets.get() > 0;
        System.out.printf("  [%s] at least one packet carried object STATE, not just events (%d)%n",
                carriedState ? "PASS" : "FAIL", statePackets.get());
        if (carriedState) { passed++; } else { failed++; }

        final boolean analysedAll = analysisErrors.isEmpty();
        System.out.printf("  [%s] our analysis threw nothing (%d errors)%n",
                analysedAll ? "PASS" : "FAIL", analysisErrors.size());
        if (analysedAll) { passed++; } else { failed++; }
        for (final String e : analysisErrors) {
            System.out.println("      " + e);
        }

        System.out.println();
        System.out.println("-- JSON round trip over every value in every captured packet --");
        System.out.println("  values seen             = " + report.values);
        System.out.println("  round-tripped           = " + report.valuesOk);
        System.out.println("  failed: no JSON form    = " + report.valuesFailEncode);
        System.out.println("  failed: cannot rebuild  = " + report.valuesFailDecode);
        System.out.println("  failed: value differed  = " + report.valuesFailCompare);
        System.out.println("  packet skeleton ok      = " + report.packetsSkeletonOk + "/" + report.packets
                + "   (seq, checksum, sampled ordinals, composite delta keys)");

        int plain = 0;
        int derived = 0;
        int unsupported = 0;
        for (final JsonDelta.Cell c : report.cells.values()) {
            switch (c.fidelity) {
                case PLAIN -> plain++;
                case DERIVED -> derived++;
                case UNSUPPORTED -> unsupported++;
                default -> { }
            }
        }
        System.out.println();
        System.out.println("-- by fidelity, over distinct (property, value class) pairs --");
        System.out.println("  PLAIN       (any client can rebuild from the JSON)     = " + plain);
        System.out.println("  DERIVED     (needs a Forge parser or the card DB)      = " + derived);
        System.out.println("  UNSUPPORTED (no JSON form without inventing a schema)  = " + unsupported);

        System.out.println();
        System.out.println("-- events arm (carried as opaque Java-serialized bytes, NOT as state) --");
        System.out.println("  event items             = " + report.eventItems);
        System.out.println("  bytes survived base64   = " + report.eventsBytewiseOk);
        System.out.println("  failed: no JSON form    = " + report.eventsFailEncode);
        System.out.println("  failed: cannot rebuild  = " + report.eventsFailDecode);
        System.out.println("  failed: bytes differed  = " + report.eventsFailCompare);
        System.out.println("  JSON text for events    = " + report.eventJsonBytes + " chars");
        if (report.firstEventFailure != null) {
            System.out.println("  first failure           = " + report.firstEventFailure);
        }
        for (final Map.Entry<String, Integer> e : report.eventItemClasses.entrySet()) {
            System.out.println("    " + e.getValue() + " x " + e.getKey());
        }
        System.out.println();
        System.out.println("  GameEvent classes this match actually fired: " + eventClasses.size()
                + " distinct, " + eventsDelivered + " deliveries");
        System.out.println("  (forge-game/src/main/java/forge/game/event/ declares 58 GameEvent types)");
        for (final Map.Entry<String, Integer> e : eventClasses.entrySet()) {
            System.out.printf("    %6d x %s%n", e.getValue(), e.getKey());
        }
        System.out.println("  NOTE: a clean byte count is NOT 'events round-trip'. The payload is a");
        System.out.println("        Java object stream; a browser that base64-decodes it holds bytes");
        System.out.println("        it cannot read. Tier C's events need a per-event JSON schema.");

        final boolean eventBytesOk = report.eventItems == 0
                || (report.eventsFailEncode == 0 && report.eventsFailDecode == 0 && report.eventsFailCompare == 0);
        System.out.printf("  [%s] every event item's bytes survived the JSON trip%n",
                eventBytesOk ? "PASS" : "FAIL");
        if (eventBytesOk) { passed++; } else { failed++; }

        System.out.println();
        System.out.println("-- (property, class) pairs that did NOT round-trip --");
        int badPairs = 0;
        for (final JsonDelta.Cell c : report.cells.values()) {
            if (!c.clean()) {
                badPairs++;
                System.out.printf("  %-28s %-58s seen=%d enc=%d dec=%d cmp=%d%n    %s%n",
                        c.property, c.valueClass, c.seen, c.failEncode, c.failDecode, c.failCompare,
                        c.firstFailure);
            }
        }
        if (badPairs == 0) {
            System.out.println("  (none)");
        }

        final boolean roundTrips = report.values > 0
                && report.valuesFailEncode == 0 && report.valuesFailDecode == 0
                && report.valuesFailCompare == 0;
        System.out.printf("%n  [%s] every captured value round-tripped through JSON%n",
                roundTrips ? "PASS" : "FAIL");
        if (roundTrips) { passed++; } else { failed++; }

        // 7. What this run did NOT exercise. The census is only as wide as the
        //    cards that turned up, and saying so is the difference between a
        //    verified result and an implied one.
        final Map<String, List<String>> unexercised = JsonDelta.unexercisedByDeclaredType(report);
        int unexercisedProps = 0;
        for (final List<String> l : unexercised.values()) { unexercisedProps += l.size(); }
        System.out.println();
        System.out.println("-- coverage: " + (JsonDelta.propertyCount() - unexercisedProps) + "/"
                + JsonDelta.propertyCount() + " TrackableProperty constants observed --");
        System.out.println("  declared types exercised   : " + JsonDelta.exercisedDeclaredTypes(report));
        System.out.println("  declared types NEVER seen, with the properties that carry them:");
        for (final Map.Entry<String, List<String>> e : unexercised.entrySet()) {
            System.out.printf("    %-28s %d: %s%n", e.getKey(), e.getValue().size(),
                    String.join(" ", e.getValue()));
        }

        // 8. Artifacts. /tmp is tmpfs on this host, so these go into the repo.
        write(outDir.resolve("coverage.tsv"), JsonDelta.coverageTsv(report));
        write(outDir.resolve("census.tsv"), JsonDelta.censusTsv(report));
        if (sampleNewJson != null) {
            write(outDir.resolve("sample-newobjects.json"),
                    "// " + sampleNewHeader + "\n" + sampleNewJson + "\n");
        }
        if (sampleDeltaJson != null) {
            write(outDir.resolve("sample-delta.json"),
                    "// " + sampleDeltaHeader + "\n" + sampleDeltaJson + "\n");
        }
        System.out.println();
        System.out.println("wrote census.tsv, coverage.tsv, sample-newobjects.json and sample-delta.json into "
                + outDir);

        finish(deltas);
    }

    private static void finish(final long deltas) {
        System.out.printf("%nphase 2: %d failed / %d passed  (deltas=%d)%n", failed, passed, deltas);
        System.out.flush();
        // Netty's event loops are non-daemon in places; do not wait for them.
        Runtime.getRuntime().halt(failed == 0 ? 0 : 1);
    }

    private static void write(final Path p, final String s) {
        try {
            Files.writeString(p, s, StandardCharsets.UTF_8);
        } catch (final IOException e) {
            System.err.println("could not write " + p + ": " + e);
        }
    }

    private static void shutdown(final FGameClient client, final FServerManager server) {
        try { client.close(); } catch (final RuntimeException ignored) { /* shutting down */ }
        try { server.clearPlayerGuis(); } catch (final RuntimeException ignored) { /* shutting down */ }
        try { server.stopServer(); } catch (final RuntimeException ignored) { /* shutting down */ }
    }
}
