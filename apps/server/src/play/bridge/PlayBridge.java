/*
 * hadoku-cardtable: the Forge match bridge.
 * Copyright (C) 2026  hadoku-cardtable contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.LobbyPlayer;
import forge.StaticData;
import forge.GuiDesktop;
import forge.card.CardTypeView;
import forge.card.mana.ManaCost;
import forge.deck.CardPool;
import forge.deck.Deck;
import forge.deck.io.DeckSerializer;
import forge.game.GameEntityView;
import forge.game.GameState;
import forge.game.GameView;
import forge.game.card.CardView;
import forge.game.card.CounterType;
import forge.game.keyword.KeywordCollectionView;
import forge.game.keyword.KeywordView;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.IHasIcon;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;
import forge.game.spellability.StackItemView;
import forge.game.zone.ZoneType;
import forge.gamemodes.match.GameLobby.GameLobbyData;
import forge.gamemodes.match.HostedMatch;
import forge.gamemodes.match.LobbySlot;
import forge.gamemodes.match.LobbySlotType;
import forge.gamemodes.match.NextGameDecision;
import forge.gamemodes.net.ChatMessage;
import forge.gamemodes.net.DeltaPacket;
import forge.gamemodes.net.NetworkGuiGame;
import forge.gamemodes.net.client.ClientGameLobby;
import forge.gamemodes.net.client.FGameClient;
import forge.gamemodes.net.event.UpdateLobbyPlayerEvent;
import forge.gamemodes.net.server.DeltaSyncManager;
import forge.gamemodes.net.server.FServerManager;
import forge.gamemodes.net.server.RemoteClient;
import forge.gamemodes.net.server.RemoteClientGuiGame;
import forge.gamemodes.net.server.ServerGameLobby;
import forge.gui.GuiBase;
import forge.gui.interfaces.IGuiGame;
import forge.interfaces.IGameController;
import forge.interfaces.ILobbyListener;
import forge.interfaces.IUpdateable;
import forge.item.IPaperCard;
import forge.item.PaperCard;
import forge.localinstance.properties.ForgeConstants;
import forge.localinstance.properties.ForgeNetPreferences;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.localinstance.skin.FSkinProp;
import forge.model.FModel;
import forge.player.PlayerZoneUpdate;
import forge.player.PlayerZoneUpdates;
import forge.toolbox.MouseTriggerEvent;
import forge.trackable.TrackableCollection;
import forge.trackable.TrackableObject;
import forge.trackable.TrackableProperty;
import forge.trackable.TrackableTypes;
import forge.util.FSerializableFunction;
import forge.util.FileSection;
import forge.util.ITriggerEvent;

import com.google.common.collect.Multiset;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * One Forge match, driven over stdin/stdout by the Node server
 * ({@code apps/server/src/play/host.ts}). Read {@code apps/server/src/play/README.md}
 * first.
 *
 * <p><b>Shape: architecture (b) of {@code docs/spikes/itoclient.md}.</b> The match is
 * hosted by stock Forge — {@link FServerManager}'s Netty server, a {@link ServerGameLobby},
 * a {@link RemoteClientGuiGame} per seat building that seat's delta stream — and every
 * human seat is a real, stock {@link FGameClient} connected to it over loopback. What is
 * ours is the client's {@code IGuiGame}, {@link SeatGui}: where Forge's desktop client
 * would draw, it writes one JSON line per protocol call. Nothing in {@code forge/} is
 * modified, and nothing here reaches into Forge's server: the seam is the one
 * {@code IToClient} already crosses.
 *
 * <p><b>One match per JVM.</b> {@link FServerManager#getInstance()} is a process-wide
 * singleton holding one lobby, so this program hosts exactly one match. Whether a
 * long-lived JVM should host many is Wave 9 lane D's question; answering yes would mean
 * a second server per match, which this singleton does not allow.
 *
 * <p><b>Protocol.</b> Stdout carries JSON lines and nothing else — {@code System.out} is
 * pointed at stderr before Forge is touched, so Forge's own logging cannot interleave.
 * Lines out: {@code ready}, {@code frame} (a {@code @hadoku/forge-wire} ServerFrame for
 * one seat), {@code probe}, {@code gameover}, {@code fatal}. Lines in: {@code reply},
 * {@code abort}, {@code act}, {@code probe}, {@code stop}.
 *
 * <p><b>What is not forwarded.</b> The events arm of every {@code applyDelta} is left out:
 * events carry card names, including the card an opponent just drew, and the Node side
 * has no per-event visibility rule yet. {@code applyYieldUpdate} and the 20 protocol
 * methods outside the 38 a browser needs are not forwarded either. {@code sideboard} is
 * answered with {@code null} (keep the deck as it is) and reported — a one-game match
 * never asks it.
 */
public final class PlayBridge {

    private PlayBridge() { }

    /** Stdout, before it is redirected. The only thing that writes to it is {@link #emit}. */
    private static PrintStream protocol;

    /**
     * {@code serializeNulls}: the default Gson silently DROPS a member whose value is
     * JSON null, and on this wire null is a value — {@code showPromptMessage.card},
     * a cleared property in a delta. Observed on the first run: every prompt arrived
     * without its {@code card} key and failed forge-wire's strict schema.
     */
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();

    /**
     * The match this JVM hosts, stamped on every line out and required on every line in.
     * One JVM hosts one match, so today it cannot disagree; it is on the wire because Wave
     * 9 lane D asked for it ({@code docs/spikes/jvm-per-match.md} §6): a supervisor that
     * later multiplexes several matches over one channel then changes nothing here.
     */
    static String matchId = "";

    /**
     * Optional. Seeds Forge's shared {@code MyRandom} (shuffles, the coin toss) and the
     * precon pick, so a test run can be repeated. A match is still not fully
     * deterministic: the AI and thread timing are not seeded.
     */
    static Long seed = null;

    static synchronized void emit(final JsonObject line) {
        line.addProperty("match", matchId);
        protocol.println(GSON.toJson(line));
        protocol.flush();
    }

    static JsonObject line(final String type) {
        final JsonObject o = new JsonObject();
        o.addProperty("t", type);
        return o;
    }

    static void fatal(final String message, final Throwable cause) {
        final JsonObject o = line("fatal");
        o.addProperty("message", message + (cause == null ? "" : ": " + cause));
        emit(o);
        if (cause != null) {
            cause.printStackTrace(System.err);
        }
        Runtime.getRuntime().halt(1);
    }

    // =========================================================== configuration

    /** {@code {"matchId":..,"seed":long?,"seats":[{"name":..,"ai":bool,"deck":".dck text"|null}, ...]}} */
    record SeatConfig(String name, boolean ai, String deck) { }

    static List<SeatConfig> readConfig(final Path file) throws IOException {
        final JsonObject root = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
        matchId = root.get("matchId").getAsString();
        seed = root.has("seed") && !root.get("seed").isJsonNull() ? root.get("seed").getAsLong() : null;
        final List<SeatConfig> seats = new ArrayList<>();
        for (final JsonElement e : root.getAsJsonArray("seats")) {
            final JsonObject s = e.getAsJsonObject();
            seats.add(new SeatConfig(
                    s.get("name").getAsString(),
                    s.has("ai") && s.get("ai").getAsBoolean(),
                    s.has("deck") && !s.get("deck").isJsonNull() ? s.get("deck").getAsString() : null));
        }
        return seats;
    }

    static Deck parseDeck(final String dck) {
        final List<String> lines = Arrays.asList(dck.split("\\r?\\n"));
        final Deck deck = DeckSerializer.fromSections(FileSection.parseSections(lines));
        if (deck == null || deck.getMain() == null || deck.getMain().countAll() == 0) {
            throw new IllegalArgumentException("the .dck text has no main deck");
        }
        return deck;
    }

    /** A random quest precon with at least 40 cards in its main deck. */
    static Deck randomPrecon(final Random random) {
        final File dir = new File(ForgeConstants.QUEST_PRECON_DIR);
        final File[] files = dir.listFiles((d, n) -> n.endsWith(".dck"));
        if (files == null || files.length == 0) {
            throw new IllegalStateException("no precon decks in " + dir.getAbsolutePath());
        }
        final List<File> shuffled = new ArrayList<>(Arrays.asList(files));
        Collections.shuffle(shuffled, random);
        for (final File f : shuffled) {
            final Deck d = DeckSerializer.fromFile(f);
            if (d != null && d.getMain() != null && d.getMain().countAll() >= 40) {
                return d;
            }
        }
        throw new IllegalStateException("no precon in " + dir.getAbsolutePath() + " has 40 cards");
    }

    // ============================================================ JSON encoding

    static JsonObject ref(final String kind, final int id) {
        final JsonObject o = new JsonObject();
        o.addProperty("kind", kind);
        o.addProperty("id", id);
        return o;
    }

    /** A {@code refs.ts} reference, or null for a value that is not an entity. */
    static JsonObject refOf(final Object o) {
        if (o instanceof CardView cv) { return ref("card", cv.getId()); }
        if (o instanceof PlayerView pv) { return ref("player", pv.getId()); }
        if (o instanceof SpellAbilityView sa) { return ref("spellAbility", sa.getId()); }
        if (o instanceof StackItemView si) { return ref("stackItem", si.getId()); }
        return null;
    }

    static JsonElement refOrNull(final Object o) {
        final JsonObject r = refOf(o);
        return r == null ? JsonNull.INSTANCE : r;
    }

    static JsonArray refs(final Iterable<?> items) {
        final JsonArray a = new JsonArray();
        if (items != null) {
            for (final Object o : items) {
                final JsonObject r = refOf(o);
                if (r != null) { a.add(r); }
            }
        }
        return a;
    }

    static JsonArray strings(final Iterable<String> items) {
        final JsonArray a = new JsonArray();
        if (items != null) {
            for (final String s : items) { a.add(s == null ? "" : s); }
        }
        return a;
    }

    static String str(final String s) {
        return s == null ? "" : s;
    }

    static JsonArray zones(final Collection<ZoneType> zs) {
        final JsonArray a = new JsonArray();
        if (zs != null) {
            for (final ZoneType z : zs) { a.add(z.name()); }
        }
        return a;
    }

    static JsonArray zoneUpdates(final Iterable<PlayerZoneUpdate> updates) {
        final JsonArray a = new JsonArray();
        if (updates != null) {
            for (final PlayerZoneUpdate u : updates) {
                final JsonObject o = new JsonObject();
                o.add("player", ref("player", u.getPlayer().getId()));
                o.add("zones", zones(u.getZones()));
                a.add(o);
            }
        }
        return a;
    }

    static JsonElement delayedReveal(final DelayedReveal dr) {
        if (dr == null) { return JsonNull.INSTANCE; }
        final JsonObject o = new JsonObject();
        o.add("cards", refs(dr.getCards()));
        o.add("zones", zones(dr.getZone()));
        o.add("owner", ref("player", dr.getOwner().getId()));
        o.addProperty("messagePrefix", str(dr.getMessagePrefix()));
        return o;
    }

    // ---- Tier C: the same tagged encoding Wave 7's JsonDelta proved lossless ----

    static JsonObject tagged(final String t) {
        final JsonObject o = new JsonObject();
        o.addProperty("t", t);
        return o;
    }

    /**
     * {@code scripts/spike/tierc/src/JsonDelta.java}'s {@code encode}, the STATE half only:
     * the values {@code DeltaSyncManager.toNetworkValue} leaves in a packet. It proved
     * 73,549 of 73,549 values round-trip; {@code tier-c.ts} is fitted to exactly this form.
     */
    @SuppressWarnings("unchecked")
    static JsonElement encode(final Object v) {
        if (v == null) { return JsonNull.INSTANCE; }
        if (v instanceof Boolean b) { final JsonObject o = tagged("bool"); o.addProperty("v", b); return o; }
        if (v instanceof Integer i) { final JsonObject o = tagged("int"); o.addProperty("v", i); return o; }
        if (v instanceof Long l) { final JsonObject o = tagged("long"); o.addProperty("v", l); return o; }
        if (v instanceof Short s) { final JsonObject o = tagged("short"); o.addProperty("v", s); return o; }
        if (v instanceof Byte b) { final JsonObject o = tagged("byte"); o.addProperty("v", b); return o; }
        if (v instanceof Float f) { final JsonObject o = tagged("float"); o.addProperty("v", f); return o; }
        if (v instanceof Double d) { final JsonObject o = tagged("double"); o.addProperty("v", d); return o; }
        if (v instanceof String s) { final JsonObject o = tagged("str"); o.addProperty("v", s); return o; }
        if (v instanceof Enum<?> e) {
            final JsonObject o = tagged("enum");
            o.addProperty("c", e.getDeclaringClass().getName());
            o.addProperty("v", e.name());
            return o;
        }
        if (v instanceof int[] ints) {
            final JsonObject o = tagged("ints");
            final JsonArray a = new JsonArray();
            for (final int i : ints) { a.add(i); }
            o.add("v", a);
            return o;
        }
        if (v instanceof TrackableObject || v instanceof TrackableCollection<?>) {
            // toNetworkValue flattens every reference to an id before a packet leaves the
            // server; Wave 7 measured zero of these in 73,549 values. One arriving means the
            // server stopped flattening, and tier-c.ts would refuse the frame anyway.
            throw new IllegalStateException("unflattened reference " + v.getClass().getName());
        }
        if (v instanceof Multiset<?> ms) {
            final JsonObject o = tagged("multiset");
            final JsonArray a = new JsonArray();
            for (final Multiset.Entry<?> e : ((Multiset<Object>) ms).entrySet()) {
                final JsonArray pair = new JsonArray();
                pair.add(e.getElement() instanceof CounterType ct ? ct.getName() : String.valueOf(e.getElement()));
                pair.add(e.getCount());
                a.add(pair);
            }
            o.add("v", a);
            return o;
        }
        if (v instanceof Map<?, ?> m) {
            final JsonObject o = tagged("map");
            final JsonArray a = new JsonArray();
            for (final Map.Entry<?, ?> e : m.entrySet()) {
                final JsonArray pair = new JsonArray();
                pair.add(encode(e.getKey()));
                pair.add(encode(e.getValue()));
                a.add(pair);
            }
            o.add("v", a);
            return o;
        }
        if (v instanceof Set<?> s) {
            final JsonObject o = tagged("set");
            final JsonArray a = new JsonArray();
            for (final Object item : s) { a.add(encode(item)); }
            o.add("v", a);
            return o;
        }
        if (v instanceof Collection<?> c) {
            final JsonObject o = tagged("list");
            final JsonArray a = new JsonArray();
            for (final Object item : c) { a.add(encode(item)); }
            o.add("v", a);
            return o;
        }
        if (v instanceof ManaCost mc) {
            final JsonObject o = tagged("manacost");
            o.addProperty("v", ManaCost.serialize(mc));
            return o;
        }
        if (v instanceof CardTypeView ctv) {
            // NOT ctv.toString(): CardType.parse cannot read it back (docs/spikes/tier-c.md).
            final JsonObject o = tagged("cardtype");
            final JsonArray sup = new JsonArray();
            for (final Enum<?> e : ctv.getSupertypes()) { sup.add(e.name()); }
            final JsonArray core = new JsonArray();
            for (final Enum<?> e : ctv.getCoreTypes()) { core.add(e.name()); }
            final JsonArray sub = new JsonArray();
            for (final String s : ctv.getSubtypes()) { sub.add(s); }
            final JsonArray exc = new JsonArray();
            for (final String s : ctv.getExcludedCreatureSubTypes()) { exc.add(s); }
            o.add("sup", sup);
            o.add("core", core);
            o.add("sub", sub);
            o.addProperty("all", ctv.hasAllCreatureTypes());
            o.add("exc", exc);
            return o;
        }
        if (v instanceof KeywordCollectionView kcv) {
            final JsonObject o = tagged("keywords");
            final JsonArray a = new JsonArray();
            for (final KeywordView kv : kcv) { a.add(kv.original()); }
            o.add("v", a);
            return o;
        }
        if (v instanceof IPaperCard pc) {
            final JsonObject o = tagged("papercard");
            o.addProperty("n", pc.getName());
            o.addProperty("e", pc.getEdition());
            o.addProperty("a", pc.getArtIndex());
            o.addProperty("f", pc.isFoil());
            return o;
        }
        if (v instanceof DeltaPacket.CombatData cd) {
            final JsonObject o = tagged("combat");
            o.add("atk", intListList(cd.bandAttackerIds));
            final JsonArray defs = new JsonArray();
            if (cd.bandDefenderRefs != null) {
                for (final int[] r : cd.bandDefenderRefs) {
                    final JsonArray ra = new JsonArray();
                    if (r != null) { for (final int i : r) { ra.add(i); } }
                    defs.add(ra);
                }
            }
            o.add("def", defs);
            o.add("blk", intListList(cd.bandBlockerIds));
            o.add("pblk", intListList(cd.bandPlannedBlockerIds));
            return o;
        }
        throw new IllegalStateException("no JSON form for " + v.getClass().getName());
    }

    static JsonArray intListList(final List<List<Integer>> lists) {
        final JsonArray outer = new JsonArray();
        if (lists != null) {
            for (final List<Integer> inner : lists) {
                final JsonArray ia = new JsonArray();
                if (inner != null) { for (final Integer i : inner) { ia.add(i); } }
                outer.add(ia);
            }
        }
        return outer;
    }

    static JsonObject objectTable(final Map<Integer, Map<TrackableProperty, Object>> m) {
        final JsonObject out = new JsonObject();
        for (final Map.Entry<Integer, Map<TrackableProperty, Object>> e : m.entrySet()) {
            final int deltaKey = e.getKey();
            final JsonObject props = new JsonObject();
            props.addProperty("_type", DeltaPacket.getTypeFromDeltaKey(deltaKey));
            props.addProperty("_id", DeltaPacket.getIdFromDeltaKey(deltaKey));
            for (final Map.Entry<TrackableProperty, Object> pe : e.getValue().entrySet()) {
                props.add(pe.getKey().name(), encode(pe.getValue()));
            }
            // DeltaSyncManager never puts a propertyless object in either map (:257, :281).
            if (props.size() > 2) {
                out.add(String.valueOf(Integer.toUnsignedLong(deltaKey)), props);
            }
        }
        return out;
    }

    static JsonObject packetJson(final DeltaPacket p) {
        final JsonObject o = new JsonObject();
        o.addProperty("seq", p.getSequenceNumber());
        o.addProperty("checksum", p.getChecksum());
        final JsonArray cp = new JsonArray();
        if (p.getChecksumProperties() != null) {
            for (final int i : p.getChecksumProperties()) { cp.add(i); }
        }
        o.add("checksumProperties", cp);
        o.add("newObjects", objectTable(p.getNewObjects()));
        o.add("objectDeltas", objectTable(p.getObjectDeltas()));
        // Deliberately empty — see the class comment.
        o.add("events", new JsonArray());
        return o;
    }

    // ================================================================ the seats

    static final Map<Integer, SeatGui> SEATS = new ConcurrentHashMap<>();

    /**
     * Each seat client's Netty thread, mapped to its seat. See {@link BridgeGui} for why
     * the bridge needs to know which thread is a client's.
     */
    static final Map<Thread, SeatGui> CLIENT_THREADS = new ConcurrentHashMap<>();

    /** A blocking question waiting on the browser. */
    static final class PendingAsk {
        final String callId;
        final String method;
        final CompletableFuture<JsonElement> answer = new CompletableFuture<>();
        /** The offered objects by key, so a reply's refs resolve to the very objects Forge sent. */
        final Map<String, Object> byKey = new HashMap<>();

        PendingAsk(final String callId, final String method) {
            this.callId = callId;
            this.method = method;
        }
    }

    /** Sentinel: the browser will not answer. */
    static final JsonObject ABORTED = new JsonObject();

    /**
     * The client-side {@code IGuiGame} of one human seat. Stock
     * {@link NetworkGuiGame} applies each delta to this client's tracker (we call
     * {@code super}); every method a browser needs is re-emitted as a forge-wire frame.
     */
    static final class SeatGui extends NetworkGuiGame {
        final int seat;
        private final AtomicInteger calls = new AtomicInteger();
        final Map<String, PendingAsk> pending = new ConcurrentHashMap<>();
        /** SpellAbilityViews this seat has been offered, for {@code selectAbility}. */
        final Map<Integer, SpellAbilityView> abilities = new ConcurrentHashMap<>();

        /**
         * This seat's client-side "event dispatch thread": one thread, so the seat's
         * protocol calls run in the order Forge sent them, exactly as the stock client's
         * EDT would run them — but a thread of its own. See {@link BridgeGui}.
         */
        final ExecutorService ui;
        volatile Thread uiThread;

        SeatGui(final int seat) {
            this.seat = seat;
            this.ui = Executors.newSingleThreadExecutor(r -> {
                final Thread t = new Thread(r, "seat-" + seat + "-ui");
                t.setDaemon(true);
                uiThread = t;
                return t;
            });
        }

        void frame(final JsonObject frame) {
            final JsonObject o = line("frame");
            o.addProperty("seat", seat);
            o.add("frame", frame);
            emit(o);
        }

        static JsonObject notify(final String method) {
            final JsonObject f = new JsonObject();
            f.addProperty("kind", "notify");
            f.addProperty("method", method);
            return f;
        }

        PendingAsk open(final String method, final JsonObject frame) {
            final String callId = "s" + seat + "-" + calls.incrementAndGet();
            final PendingAsk ask = new PendingAsk(callId, method);
            frame.addProperty("kind", "ask");
            frame.addProperty("callId", callId);
            frame.addProperty("method", method);
            pending.put(callId, ask);
            return ask;
        }

        /**
         * Send the ask and park this thread until the browser answers. Returns
         * {@link #ABORTED} if it never will. Forge's own reply wait is untimed
         * ({@code ReplyPool.java:29-37}); the timeout lives on the Node side and
         * arrives here as an {@code abort}.
         */
        JsonElement await(final PendingAsk ask, final JsonObject frame) {
            frame(frame);
            try {
                return ask.answer.get();
            } catch (final InterruptedException e) {
                Thread.currentThread().interrupt();
                return ABORTED;
            } catch (final java.util.concurrent.ExecutionException e) {
                return ABORTED;
            } finally {
                pending.remove(ask.callId);
            }
        }

        void resolve(final String callId, final JsonElement result) {
            final PendingAsk ask = pending.get(callId);
            if (ask == null) {
                final JsonObject o = line("stale");
                o.addProperty("seat", seat);
                o.addProperty("callId", callId);
                emit(o);
                return;
            }
            ask.answer.complete(result);
        }

        Object lookup(final PendingAsk ask, final JsonElement refJson) {
            if (refJson == null || refJson.isJsonNull()) { return null; }
            final JsonObject r = refJson.getAsJsonObject();
            return ask.byKey.get(r.get("kind").getAsString() + ":" + r.get("id").getAsInt());
        }

        static String refKey(final Object o) {
            final JsonObject r = refOf(o);
            return r == null ? null : r.get("kind").getAsString() + ":" + r.get("id").getAsInt();
        }

        void offer(final PendingAsk ask, final Iterable<?> items) {
            if (items == null) { return; }
            for (final Object o : items) {
                final String k = refKey(o);
                if (k != null) { ask.byKey.put(k, o); }
                if (o instanceof SpellAbilityView sa) { abilities.put(sa.getId(), sa); }
            }
        }

        // ---------------------------------------------------------- Tier C

        @Override
        public void setGameView(final GameView gameView, final long sequenceNumber) {
            super.setGameView(gameView, sequenceNumber);
            final GameView view = getGameView();
            if (view == null) { return; }
            // A fresh DeltaSyncManager's first walk puts every object in newObjects,
            // flattened by the same toNetworkValue the delta stream uses — so the full
            // state and a delta share one encoding, which is what tier-c.ts assumes.
            final DeltaPacket full = new DeltaSyncManager().collectDeltas(view);
            final JsonObject f = notify("setGameView");
            final JsonObject payload = new JsonObject();
            payload.add("gameView", objectTable(full.getNewObjects()));
            payload.addProperty("sequenceNumber", sequenceNumber);
            f.add("payload", payload);
            frame(f);
        }

        @Override
        public void openView(final TrackableCollection<PlayerView> myPlayers) {
            final JsonObject f = notify("openView");
            final JsonObject payload = new JsonObject();
            final JsonArray ids = new JsonArray();
            for (final PlayerView p : myPlayers) { ids.add(p.getId()); }
            payload.add("myPlayers", ids);
            f.add("payload", payload);
            frame(f);
        }

        @Override
        public void applyDelta(final DeltaPacket packet) {
            if (packet != null && (!packet.getNewObjects().isEmpty() || !packet.getObjectDeltas().isEmpty())) {
                final JsonObject f = notify("applyDelta");
                final JsonObject payload = new JsonObject();
                payload.add("packet", packetJson(packet));
                f.add("payload", payload);
                frame(f);
            }
            super.applyDelta(packet);
        }

        // ------------------------------------------------ Tier A/B notifies

        @Override public void message(final String message, final String title) {
            final JsonObject f = notify("message");
            f.addProperty("message", str(message));
            f.addProperty("title", str(title));
            frame(f);
        }

        @Override public void showErrorDialog(final String message, final String title) {
            final JsonObject f = notify("showErrorDialog");
            f.addProperty("message", str(message));
            f.addProperty("title", str(title));
            frame(f);
        }

        @Override public void afterGameEnd() { frame(notify("afterGameEnd")); }
        @Override public void finishGame() { frame(notify("finishGame")); }
        @Override public void clearSelectables() { frame(notify("clearSelectables")); }

        @Override public void showPromptMessage(final PlayerView playerView, final String message, final CardView card) {
            if (playerView == null) { return; }
            final JsonObject f = notify("showPromptMessage");
            f.add("player", ref("player", playerView.getId()));
            f.addProperty("message", str(message));
            f.add("card", refOrNull(card));
            frame(f);
        }

        @Override public void updateButtons(final PlayerView owner, final String label1, final String label2,
                                            final boolean enable1, final boolean enable2, final boolean focus1) {
            if (owner == null) { return; }
            final JsonObject f = notify("updateButtons");
            f.add("owner", ref("player", owner.getId()));
            f.addProperty("label1", str(label1));
            f.addProperty("label2", str(label2));
            f.addProperty("enable1", enable1);
            f.addProperty("enable2", enable2);
            f.addProperty("focus1", focus1);
            frame(f);
        }

        @Override public void setSelectables(final Iterable<CardView> cards, final int min, final int max) {
            final JsonObject f = notify("setSelectables");
            f.add("cards", refs(cards));
            f.addProperty("min", Math.max(0, min));
            f.addProperty("max", Math.max(0, max));
            frame(f);
        }

        @Override public void hideZones(final PlayerView controller, final Iterable<PlayerZoneUpdate> zonesToUpdate) {
            if (controller == null) { return; }
            final JsonObject f = notify("hideZones");
            f.add("controller", ref("player", controller.getId()));
            f.add("zonesToUpdate", zoneUpdates(zonesToUpdate));
            frame(f);
        }

        @Override public void restoreOldZones(final PlayerView playerView, final PlayerZoneUpdates playerZoneUpdates) {
            if (playerView == null) { return; }
            final JsonObject f = notify("restoreOldZones");
            f.add("player", ref("player", playerView.getId()));
            f.add("playerZoneUpdates", zoneUpdates(playerZoneUpdates));
            frame(f);
        }

        // ------------------------------------------------------- the 15 asks

        @Override
        public boolean showConfirmDialog(final String message, final String title, final String yesButtonText,
                                         final String noButtonText, final boolean defaultYes) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("showConfirmDialog", f);
            f.addProperty("message", str(message));
            f.addProperty("title", str(title));
            f.addProperty("yesButtonText", str(yesButtonText));
            f.addProperty("noButtonText", str(noButtonText));
            f.addProperty("defaultYes", defaultYes);
            final JsonElement r = await(ask, f);
            // An abort answers what RemoteClientGuiGame.showConfirmDialog answers for a
            // null reply: the default (RemoteClientGuiGame.java:436).
            return r == ABORTED ? defaultYes : r.getAsBoolean();
        }

        @Override
        public int showOptionDialog(final String message, final String title, final FSkinProp icon,
                                    final List<String> options, final int defaultOption) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("showOptionDialog", f);
            f.addProperty("message", str(message));
            f.addProperty("title", str(title));
            if (icon == null) { f.add("icon", JsonNull.INSTANCE); } else { f.addProperty("icon", icon.name()); }
            f.add("options", strings(options));
            f.addProperty("defaultOption", defaultOption);
            final JsonElement r = await(ask, f);
            return r == ABORTED ? defaultOption : r.getAsInt();
        }

        @Override
        public String showInputDialog(final String message, final String title, final FSkinProp icon,
                                      final String initialInput, final List<String> inputOptions, final boolean isNumeric) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("showInputDialog", f);
            f.addProperty("message", str(message));
            f.addProperty("title", str(title));
            if (icon == null) { f.add("icon", JsonNull.INSTANCE); } else { f.addProperty("icon", icon.name()); }
            f.addProperty("initialInput", str(initialInput));
            f.add("inputOptions", strings(inputOptions));
            f.addProperty("isNumeric", isNumeric);
            final JsonElement r = await(ask, f);
            return r == ABORTED || r.isJsonNull() ? null : r.getAsString();
        }

        @Override
        public boolean confirm(final CardView c, final String question, final boolean defaultIsYes, final List<String> options) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("confirm", f);
            f.add("card", refOrNull(c));
            f.addProperty("question", str(question));
            f.addProperty("defaultIsYes", defaultIsYes);
            f.add("options", strings(options));
            final JsonElement r = await(ask, f);
            return r == ABORTED ? defaultIsYes : r.getAsBoolean();
        }

        /** A choice list as {@code ChoiceOption}s keyed by position; the labels are rendered here. */
        <T> JsonArray choices(final PendingAsk ask, final String prefix, final List<T> items,
                              final FSerializableFunction<T, String> display) {
            final JsonArray a = new JsonArray();
            if (items == null) { return a; }
            for (int i = 0; i < items.size(); i++) {
                final T item = items.get(i);
                final String key = prefix + i;
                ask.byKey.put(key, item);
                if (item instanceof SpellAbilityView sa) { abilities.put(sa.getId(), sa); }
                final JsonObject o = new JsonObject();
                o.addProperty("key", key);
                String label;
                try {
                    label = display != null ? display.apply(item) : String.valueOf(item);
                } catch (final RuntimeException ex) {
                    label = String.valueOf(item);
                }
                o.addProperty("label", str(label));
                o.add("ref", refOrNull(item));
                a.add(o);
            }
            return a;
        }

        @SuppressWarnings("unchecked")
        <T> List<T> byKeys(final PendingAsk ask, final JsonElement keys) {
            final List<T> out = new ArrayList<>();
            for (final JsonElement k : keys.getAsJsonArray()) {
                final Object o = ask.byKey.get(k.getAsString());
                if (o == null) {
                    throw new IllegalArgumentException("reply names key " + k + " that was not offered");
                }
                out.add((T) o);
            }
            return out;
        }

        @Override
        public <T> List<T> getChoices(final String message, final int min, final int max, final List<T> choices,
                                      final List<T> selected, final FSerializableFunction<T, String> display) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("getChoices", f);
            f.addProperty("message", str(message));
            f.addProperty("min", min);
            f.addProperty("max", max);
            f.add("choices", choices(ask, "c", choices, display));
            final JsonArray sel = new JsonArray();
            if (selected != null && choices != null) {
                for (final T s : selected) {
                    final int i = choices.indexOf(s);
                    if (i >= 0) { sel.add("c" + i); }
                }
            }
            f.add("selected", sel);
            final JsonElement r = await(ask, f);
            return r == ABORTED ? null : byKeys(ask, r);
        }

        @Override
        public <T> OrderResult<T> order(final String title, final String top, final int remainingObjectsMin,
                                        final int remainingObjectsMax, final List<T> sourceChoices, final List<T> destChoices,
                                        final CardView referenceCard, final boolean sideboardingMode, final boolean showRememberCheckbox) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("order", f);
            f.addProperty("title", str(title));
            f.addProperty("top", str(top));
            f.addProperty("remainingObjectsMin", remainingObjectsMin);
            f.addProperty("remainingObjectsMax", remainingObjectsMax);
            f.add("sourceChoices", choices(ask, "s", sourceChoices, null));
            f.add("destChoices", choices(ask, "d", destChoices, null));
            f.add("referenceCard", refOrNull(referenceCard));
            f.addProperty("sideboardingMode", sideboardingMode);
            f.addProperty("showRememberCheckbox", showRememberCheckbox);
            final JsonElement r = await(ask, f);
            if (r == ABORTED) { return null; }
            final JsonObject o = r.getAsJsonObject();
            final List<T> ordered = byKeys(ask, o.get("ordered"));
            return new OrderResult<>(ordered, o.get("rememberDecision").getAsBoolean());
        }

        @Override
        public List<PaperCard> sideboard(final CardPool sideboard, final CardPool main, final String message) {
            final JsonObject o = line("unsupported");
            o.addProperty("seat", seat);
            o.addProperty("method", "sideboard");
            emit(o);
            return null;
        }

        @Override
        public GameEntityView chooseSingleEntityForEffect(final String title, final List<? extends GameEntityView> optionList,
                                                         final DelayedReveal delayedReveal, final boolean isOptional) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("chooseSingleEntityForEffect", f);
            offer(ask, optionList);
            f.addProperty("title", str(title));
            f.add("optionList", refs(optionList));
            f.add("delayedReveal", delayedReveal(delayedReveal));
            f.addProperty("isOptional", isOptional);
            final JsonElement r = await(ask, f);
            return r == ABORTED ? null : (GameEntityView) lookup(ask, r);
        }

        @Override
        public List<GameEntityView> chooseEntitiesForEffect(final String title, final List<? extends GameEntityView> optionList,
                                                            final int min, final int max, final DelayedReveal delayedReveal) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("chooseEntitiesForEffect", f);
            offer(ask, optionList);
            f.addProperty("title", str(title));
            f.add("optionList", refs(optionList));
            f.addProperty("min", min);
            f.addProperty("max", max);
            f.add("delayedReveal", delayedReveal(delayedReveal));
            final JsonElement r = await(ask, f);
            if (r == ABORTED) { return null; }
            final List<GameEntityView> out = new ArrayList<>();
            for (final JsonElement e : r.getAsJsonArray()) { out.add((GameEntityView) lookup(ask, e)); }
            return out;
        }

        @Override
        public List<CardView> manipulateCardList(final String title, final Iterable<CardView> cards,
                                                 final Iterable<CardView> manipulable, final boolean toTop,
                                                 final boolean toBottom, final boolean toAnywhere) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("manipulateCardList", f);
            offer(ask, cards);
            f.addProperty("title", str(title));
            f.add("cards", refs(cards));
            f.add("manipulable", refs(manipulable));
            f.addProperty("toTop", toTop);
            f.addProperty("toBottom", toBottom);
            f.addProperty("toAnywhere", toAnywhere);
            final JsonElement r = await(ask, f);
            if (r == ABORTED) { return null; }
            final List<CardView> out = new ArrayList<>();
            for (final JsonElement e : r.getAsJsonArray()) { out.add((CardView) lookup(ask, e)); }
            return out;
        }

        @Override
        public SpellAbilityView getAbilityToPlay(final CardView hostCard, final List<SpellAbilityView> abilities,
                                                 final ITriggerEvent triggerEvent) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("getAbilityToPlay", f);
            offer(ask, abilities);
            f.add("hostCard", ref("card", hostCard.getId()));
            f.add("abilities", refs(abilities));
            f.add("triggerEvent", JsonNull.INSTANCE);
            final JsonElement r = await(ask, f);
            return r == ABORTED ? null : (SpellAbilityView) lookup(ask, r);
        }

        @Override
        public Map<CardView, Integer> assignCombatDamage(final CardView attacker, final List<CardView> blockers,
                                                         final int damage, final GameEntityView defender,
                                                         final boolean overrideOrder, final boolean maySkip) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("assignCombatDamage", f);
            offer(ask, blockers);
            offer(ask, Collections.singletonList(attacker));
            f.add("attacker", ref("card", attacker.getId()));
            f.add("blockers", refs(blockers));
            f.addProperty("damage", damage);
            f.add("defender", refOrNull(defender));
            f.addProperty("overrideOrder", overrideOrder);
            f.addProperty("maySkip", maySkip);
            final JsonElement r = await(ask, f);
            if (r == ABORTED) { return null; }
            final Map<CardView, Integer> out = new LinkedHashMap<>();
            for (final JsonElement e : r.getAsJsonArray()) {
                final JsonObject o = e.getAsJsonObject();
                out.put((CardView) lookup(ask, o.get("target")), o.get("amount").getAsInt());
            }
            return out;
        }

        @Override
        public Map<Object, Integer> assignGenericAmount(final CardView effectSource, final Map<Object, Integer> target,
                                                        final int amount, final boolean atLeastOne, final String amountLabel) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("assignGenericAmount", f);
            f.add("effectSource", ref("card", effectSource.getId()));
            final JsonArray entries = new JsonArray();
            for (final Map.Entry<Object, Integer> e : target.entrySet()) {
                final JsonObject entry = new JsonObject();
                final JsonObject key = new JsonObject();
                final Object k = e.getKey();
                if (k instanceof Byte b) {
                    key.addProperty("target", "manaColor");
                    key.addProperty("color", b);
                    ask.byKey.put("manaColor:" + b, k);
                } else {
                    key.addProperty("target", "entity");
                    key.add("ref", refOf(k));
                    ask.byKey.put(refKey(k), k);
                }
                entry.add("key", key);
                entry.addProperty("amount", e.getValue() == null ? 0 : e.getValue());
                entries.add(entry);
            }
            f.add("target", entries);
            f.addProperty("amount", amount);
            f.addProperty("atLeastOne", atLeastOne);
            f.addProperty("amountLabel", str(amountLabel));
            final JsonElement r = await(ask, f);
            if (r == ABORTED) { return null; }
            final Map<Object, Integer> out = new LinkedHashMap<>();
            for (final JsonElement e : r.getAsJsonArray()) {
                final JsonObject o = e.getAsJsonObject();
                final JsonObject key = o.getAsJsonObject("key");
                final Object k = "manaColor".equals(key.get("target").getAsString())
                        ? ask.byKey.get("manaColor:" + key.get("color").getAsByte())
                        : lookup(ask, key.get("ref"));
                out.put(k, o.get("amount").getAsInt());
            }
            return out;
        }

        PlayerZoneUpdates zoneUpdatesFrom(final PendingAsk ask, final JsonElement reply) {
            final PlayerZoneUpdates out = new PlayerZoneUpdates();
            for (final JsonElement e : reply.getAsJsonArray()) {
                final JsonObject o = e.getAsJsonObject();
                final PlayerView pv = (PlayerView) lookup(ask, o.get("player"));
                if (pv == null) { continue; }
                final JsonArray zs = o.getAsJsonArray("zones");
                if (zs.isEmpty()) { out.add(new PlayerZoneUpdate(pv, null)); }
                for (final JsonElement z : zs) { out.add(new PlayerZoneUpdate(pv, ZoneType.valueOf(z.getAsString()))); }
            }
            return out;
        }

        @Override
        public Iterable<PlayerZoneUpdate> tempShowZones(final PlayerView controller, final Iterable<PlayerZoneUpdate> zonesToUpdate) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("tempShowZones", f);
            final List<PlayerView> players = new ArrayList<>();
            if (zonesToUpdate != null) { for (final PlayerZoneUpdate u : zonesToUpdate) { players.add(u.getPlayer()); } }
            offer(ask, players);
            f.add("controller", ref("player", controller.getId()));
            f.add("zonesToUpdate", zoneUpdates(zonesToUpdate));
            final JsonElement r = await(ask, f);
            return r == ABORTED ? null : zoneUpdatesFrom(ask, r);
        }

        @Override
        public PlayerZoneUpdates openZones(final PlayerView controller, final Collection<ZoneType> zones,
                                           final Map<PlayerView, Object> players, final boolean backupLastZones) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("openZones", f);
            offer(ask, players.keySet());
            f.add("controller", ref("player", controller.getId()));
            f.add("zones", zones(zones));
            f.add("players", refs(players.keySet()));
            f.addProperty("backupLastZones", backupLastZones);
            final JsonElement r = await(ask, f);
            return r == ABORTED ? null : zoneUpdatesFrom(ask, r);
        }

        // ------------------------------------ the rest: nothing a browser draws

        @Override protected void updateCurrentPlayer(final PlayerView player) { }
        @Override public boolean isUiSetToSkipPhase(final PlayerView playerTurn, final PhaseType phase) { return false; }
        @Override public void showCombat() { }
        @Override public void flashIncorrectAction() { }
        @Override public void alertUser() { }
        @Override public void updatePhase(final boolean saveState) { }
        @Override public void updateTurn(final PlayerView player) { }
        @Override public void updatePlayerControl() { }
        @Override public void enableOverlay() { }
        @Override public void disableOverlay() { }
        @Override public void showManaPool(final PlayerView player) { }
        @Override public void hideManaPool(final PlayerView player) { }
        @Override public void updateStack() { }
        @Override public void updateZones(final Iterable<PlayerZoneUpdate> zonesToUpdate) { }
        @Override public void updateCards(final Iterable<CardView> cards) { }
        @Override public GameState getGamestate() { return null; }
        @Override public void updateManaPool(final Iterable<PlayerView> manaPoolUpdate) { }
        @Override public void updateLives(final Iterable<PlayerView> livesUpdate) { }
        @Override public void updateShards(final Iterable<PlayerView> shardsUpdate) { }
        @Override public void setPanelSelection(final CardView hostCard) { }
        @Override public void setCard(final CardView card) { }
        @Override public void setPlayerAvatar(final LobbyPlayer player, final IHasIcon ihi) { }

        // ------------------------------------------------ acts, browser → Forge

        void act(final JsonObject frame) {
            final IGameController c = getGameController();
            if (c == null) {
                throw new IllegalStateException("seat " + seat + " has no game controller yet");
            }
            final String method = frame.get("method").getAsString();
            switch (method) {
                case "selectButtonOk" -> c.selectButtonOk();
                case "selectButtonCancel" -> c.selectButtonCancel();
                case "concede" -> c.concede();
                case "requestResync" -> c.requestResync();
                case "useMana" -> c.useMana(frame.get("color").getAsByte());
                case "nextGameDecision" -> c.nextGameDecision(NextGameDecision.valueOf(frame.get("decision").getAsString()));
                case "selectPlayer" -> c.selectPlayer(player(frame.get("player")), trigger(frame.get("triggerEvent")));
                case "selectCard" -> {
                    final List<CardView> others = new ArrayList<>();
                    for (final JsonElement e : frame.getAsJsonArray("otherCardViewsToSelect")) { others.add(card(e)); }
                    c.selectCard(card(frame.get("card")), others, trigger(frame.get("triggerEvent")));
                }
                case "selectAbility" -> {
                    final int id = frame.getAsJsonObject("ability").get("id").getAsInt();
                    final SpellAbilityView sa = abilities.get(id);
                    if (sa == null) {
                        throw new IllegalArgumentException("spell ability " + id + " was never offered to seat " + seat);
                    }
                    c.selectAbility(sa);
                }
                default -> throw new IllegalArgumentException("not an act: " + method);
            }
        }

        CardView card(final JsonElement ref) {
            final int id = ref.getAsJsonObject().get("id").getAsInt();
            final CardView cv = getGameView().getTracker().getObj(TrackableTypes.CardViewType, id);
            if (cv == null) { throw new IllegalArgumentException("no card " + id + " in seat " + seat + "'s view"); }
            return cv;
        }

        PlayerView player(final JsonElement ref) {
            final int id = ref.getAsJsonObject().get("id").getAsInt();
            final PlayerView pv = getGameView().getTracker().getObj(TrackableTypes.PlayerViewType, id);
            if (pv == null) { throw new IllegalArgumentException("no player " + id + " in seat " + seat + "'s view"); }
            return pv;
        }

        static ITriggerEvent trigger(final JsonElement e) {
            if (e == null || e.isJsonNull()) { return null; }
            final JsonObject o = e.getAsJsonObject();
            return new MouseTriggerEvent(o.get("button").getAsInt(), o.get("x").getAsInt(), o.get("y").getAsInt());
        }
    }

    /**
     * The headless {@code GuiBase}.
     *
     * <p><b>Two "event dispatch threads", because one deadlocks.</b> Stock Forge runs its
     * server and its client in different processes, each with its own Swing EDT. This
     * bridge runs both in one JVM, and both halves use the EDT for blocking work:
     * <ul>
     *   <li>the SERVER's input code calls {@code tempShowZones} from inside
     *       {@code FThreads.invokeInEdtNowOrLater}
     *       ({@code InputSelectEntitiesFromList.java:65-68}), and that call parks the EDT
     *       in {@code RemoteClientGuiGame.syncAndSendAndWait} until the client replies;</li>
     *   <li>the CLIENT dispatches every protocol call on the EDT
     *       ({@code GameClientHandler} passes {@code runInEdt = true},
     *       {@code GameClientHandler.java:38}) — including that {@code tempShowZones}.</li>
     * </ul>
     * One EDT, so the ask the server is waiting on queues behind the server's own wait,
     * forever. Observed in the first live two-seat run: a cleanup-step discard froze the
     * game at turn 2, and a thread dump showed {@code AWT-EventQueue-0} parked in
     * {@code ReplyPool.get} under {@code InputSelectEntitiesFromList}. Wave 6 and 7's
     * spikes never met it because their remote seat was handed to the AI.
     *
     * <p>So work a seat's CLIENT submits "to the EDT" goes to that seat's own single
     * thread ({@link SeatGui#ui}) and everything else still goes to the real EDT. A
     * client's calls are recognised by the thread they come from: each
     * {@code FGameClient} has its own {@code NioEventLoopGroup}
     * ({@code FGameClient.java:62}), so a client's channel reads — protocol calls and
     * lobby updates alike — always arrive on the one thread {@link #CLIENT_THREADS}
     * recorded from its first lobby update. Order within a seat is kept (one thread),
     * and seats no longer wait on each other or on the server.
     *
     * <p>The dialog overrides answer a dialog Forge might open on the SERVER side with no
     * one to see it; the values match
     * {@code forge-gui-desktop/src/test/java/forge/net/HeadlessGuiDesktop.java}, whose
     * comments say why each one is safe. Seats never reach these — their dialogs go
     * through {@link SeatGui}.
     */
    static final class BridgeGui extends GuiDesktop {
        static SeatGui seatUiOf(final Thread t) {
            for (final SeatGui s : SEATS.values()) {
                if (s.uiThread == t) { return s; }
            }
            return null;
        }

        @Override public boolean isGuiThread() {
            return super.isGuiThread() || seatUiOf(Thread.currentThread()) != null;
        }

        @Override public void invokeInEdtLater(final Runnable proc) {
            final SeatGui client = CLIENT_THREADS.get(Thread.currentThread());
            final SeatGui own = client != null ? client : seatUiOf(Thread.currentThread());
            if (own != null) {
                own.ui.execute(proc);
            } else {
                super.invokeInEdtLater(proc);
            }
        }

        @Override public void invokeInEdtAndWait(final Runnable proc) {
            if (seatUiOf(Thread.currentThread()) != null) {
                proc.run();
                return;
            }
            final SeatGui client = CLIENT_THREADS.get(Thread.currentThread());
            if (client == null) {
                super.invokeInEdtAndWait(proc);
                return;
            }
            try {
                client.ui.submit(proc).get();
            } catch (final InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException(e);
            } catch (final java.util.concurrent.ExecutionException e) {
                throw new RuntimeException(e.getCause());
            }
        }

        /**
         * {@code GuiDesktop.hostMatch} registers the match with the desktop's
         * {@code FControl}, which a headless process never creates (NPE at
         * {@code GuiDesktop.java:394}, observed on the first run of this bridge).
         */
        @Override public HostedMatch hostMatch() { return new HostedMatch(); }
        @Override public void showSpellShop() { }
        @Override public void showBazaar() { }
        @Override public int showOptionDialog(final String message, final String title, final FSkinProp icon,
                                              final List<String> options, final int defaultOption) {
            System.err.println("[bridge] server-side dialog, dismissed: " + title + ": " + message);
            return -1;
        }
        @Override public String showInputDialog(final String message, final String title, final FSkinProp icon,
                                                final String initialInput, final List<String> inputOptions, final boolean isNumeric) {
            System.err.println("[bridge] server-side input, defaulted: " + title + ": " + message);
            if (initialInput != null) { return initialInput; }
            if (inputOptions != null && !inputOptions.isEmpty()) { return inputOptions.get(0); }
            return isNumeric ? "0" : "";
        }
        @Override public void showImageDialog(final forge.localinstance.skin.ISkinImage image, final String message, final String title) { }
        @Override public String showFileDialog(final String title, final String defaultDir) { return null; }
        @Override public void showBugReportDialog(final String title, final String text, final boolean showExitAppBtn) {
            System.err.println("[bridge] bug report - " + title + ":\n" + text);
        }
        @Override public forge.sound.IAudioClip createAudioClip(final String filename) { return null; }
        @Override public forge.sound.IAudioMusic createAudioMusic(final String filename) { return null; }
        @Override public void startAltSoundSystem(final String filename, final boolean isSynchronized) { }
    }

    // ==================================================================== main

    static int freePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        }
    }

    public static void main(final String[] args) throws Exception {
        protocol = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        System.setOut(System.err);
        if (args.length != 1) {
            fatal("usage: PlayBridge <config.json>", null);
        }
        final List<SeatConfig> seats = readConfig(Path.of(args[0]));
        if (seats.size() != 2) {
            fatal("a match has exactly two seats, got " + seats.size(), null);
        }

        final long bootStart = System.currentTimeMillis();
        GuiBase.setInterface(new BridgeGui());
        FModel.initialize(null, prefs -> {
            prefs.setPref(FPref.LOAD_CARD_SCRIPTS_LAZILY, false);
            prefs.setPref(FPref.UI_LANGUAGE, "en-US");
            // Limited decks are 40 cards; constructed legality is not ours to enforce here.
            prefs.setPref(FPref.ENFORCE_DECK_LEGALITY, false);
            return null;
        });
        if (StaticData.instance() == null) {
            fatal("Forge did not initialise (no StaticData) — is res/ in the working directory?", null);
        }
        FModel.getPreferences().setPref(FPref.ENFORCE_DECK_LEGALITY, false);
        // UPnP ASK opens a modal dialog inside startServer (docs/spikes/forge-server.md).
        FModel.getNetPreferences().setPref(ForgeNetPreferences.FNetPref.UPnP, "NEVER");
        // AFK auto-pass would have Forge act for a human who is thinking. The Node side
        // owns the timeout on every ask; see README.md.
        FModel.getNetPreferences().setPref(ForgeNetPreferences.FNetPref.NET_AFK_TIMEOUT, "0");
        RemoteClientGuiGame.useDeltaSync = true;

        final Random random = seed == null ? new Random() : new Random(seed);
        if (seed != null) {
            forge.util.MyRandom.setRandom(new Random(seed));
        }
        final List<Deck> decks = new ArrayList<>();
        for (final SeatConfig s : seats) {
            decks.add(s.deck() != null ? parseDeck(s.deck()) : randomPrecon(random));
        }

        final int port = freePort();
        final FServerManager server = FServerManager.getInstance();
        server.startServer(port);
        if (!server.isHosting()) {
            fatal("Forge's server did not start on 127.0.0.1:" + port, null);
        }
        final ServerGameLobby lobby = new ServerGameLobby();
        server.setLobby(lobby);
        lobby.setListener(new IUpdateable() {
            @Override public void update(final boolean fullUpdate) { server.updateLobbyState(); }
            @Override public void update(final int slot, final LobbySlotType type) { }
        });

        for (int i = 0; i < seats.size(); i++) {
            final SeatConfig s = seats.get(i);
            final LobbySlot slot = lobby.getSlot(i);
            slot.setType(s.ai() ? LobbySlotType.AI : LobbySlotType.OPEN);
            slot.setName(s.name());
            slot.setDeck(decks.get(i));
            slot.setIsReady(s.ai());
        }

        // Connect the human seats IN SEAT ORDER: ServerGameLobby.connectPlayer hands each
        // arrival the first OPEN slot, so sequential connects are what makes seat i
        // land in slot i — asserted below rather than assumed.
        final List<FGameClient> clients = new ArrayList<>();
        for (int i = 0; i < seats.size(); i++) {
            if (seats.get(i).ai()) { continue; }
            final SeatGui gui = new SeatGui(i);
            SEATS.put(i, gui);
            final ClientGameLobby clientLobby = new ClientGameLobby();
            final CountDownLatch assigned = new CountDownLatch(1);
            final AtomicInteger mySlot = new AtomicInteger(-1);
            final FGameClient client = new FGameClient(seats.get(i).name(), gui, "localhost", port);
            client.addLobbyListener(new ILobbyListener() {
                @Override public void update(final GameLobbyData state, final int slot) {
                    // This runs on the client's channel thread: record it (see BridgeGui).
                    CLIENT_THREADS.put(Thread.currentThread(), gui);
                    clientLobby.setData(state);
                    if (slot >= 0 && mySlot.compareAndSet(-1, slot)) {
                        clientLobby.setLocalPlayer(slot);
                        assigned.countDown();
                    }
                }
                @Override public void message(final String source, final String message, final ChatMessage.MessageType type) { }
                @Override public void close() { }
                @Override public ClientGameLobby getLobby() { return clientLobby; }
            });
            client.connect();
            if (!assigned.await(30, TimeUnit.SECONDS)) {
                fatal("seat " + i + " was never given a lobby slot", null);
            }
            if (mySlot.get() != i) {
                fatal("seat " + i + " landed in lobby slot " + mySlot.get(), null);
            }
            final UpdateLobbyPlayerEvent ready = UpdateLobbyPlayerEvent.isReadyUpdate(true);
            clientLobby.applyToSlot(i, ready);
            client.send(ready);
            clients.add(client);
        }

        final long readyDeadline = System.currentTimeMillis() + 30_000;
        while (true) {
            boolean all = true;
            for (int i = 0; i < seats.size(); i++) { all &= lobby.getSlot(i).isReady(); }
            if (all) { break; }
            if (System.currentTimeMillis() > readyDeadline) { fatal("the seats never all became ready", null); }
            Thread.sleep(50);
        }

        final Runnable start = lobby.startGame();
        if (start == null) {
            fatal("Forge refused to start the match (lobby.startGame returned null)", null);
        }

        final JsonObject ready = line("ready");
        ready.addProperty("forgePort", port);
        ready.addProperty("bootMs", System.currentTimeMillis() - bootStart);
        final JsonArray seatInfo = new JsonArray();
        for (int i = 0; i < seats.size(); i++) {
            final JsonObject s = new JsonObject();
            s.addProperty("seat", i);
            s.addProperty("ai", seats.get(i).ai());
            s.addProperty("deck", decks.get(i).getName());
            seatInfo.add(s);
        }
        ready.add("seats", seatInfo);
        emit(ready);

        final Thread reader = new Thread(PlayBridge::readCommands, "bridge-stdin");
        reader.setDaemon(true);
        reader.start();

        final Thread watcher = new Thread(() -> watchForGameOver(lobby), "bridge-gameover");
        watcher.setDaemon(true);
        watcher.start();

        try {
            start.run();
        } catch (final RuntimeException e) {
            fatal("Forge failed while starting the match", e);
        }

        // Everything from here is Netty, the game thread and the EDT. Park until told to stop.
        STOP.await();
        for (final FGameClient c : clients) {
            try { c.close(); } catch (final RuntimeException e) { e.printStackTrace(System.err); }
        }
        try { server.stopServer(); } catch (final RuntimeException e) { e.printStackTrace(System.err); }
        // Netty's event loops are non-daemon in places; do not wait for them.
        Runtime.getRuntime().halt(0);
    }

    static final CountDownLatch STOP = new CountDownLatch(1);

    static void watchForGameOver(final ServerGameLobby lobby) {
        try {
            while (true) {
                final HostedMatch match = lobby.getHostedMatch();
                if (match != null && match.getGame() != null && match.getGame().isGameOver()) {
                    final JsonObject o = line("gameover");
                    final var outcome = match.getGame().getOutcome();
                    o.addProperty("winner", outcome == null || outcome.getWinningLobbyPlayer() == null
                            ? null : outcome.getWinningLobbyPlayer().getName());
                    emit(o);
                    return;
                }
                Thread.sleep(500);
            }
        } catch (final InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    static void readCommands() {
        final BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        try {
            String raw;
            while ((raw = in.readLine()) != null) {
                if (raw.isBlank()) { continue; }
                try {
                    handle(JsonParser.parseString(raw).getAsJsonObject());
                } catch (final RuntimeException e) {
                    final JsonObject o = line("rejected");
                    o.addProperty("message", e.toString());
                    o.addProperty("command", raw.length() > 200 ? raw.substring(0, 200) : raw);
                    emit(o);
                }
            }
        } catch (final IOException e) {
            e.printStackTrace(System.err);
        }
        // Stdin closed: the Node side is gone, and a match nobody can reach is not worth a JVM.
        STOP.countDown();
    }

    static SeatGui seat(final JsonObject cmd) {
        final int s = cmd.get("seat").getAsInt();
        final SeatGui gui = SEATS.get(s);
        if (gui == null) { throw new IllegalArgumentException("no human seat " + s); }
        return gui;
    }

    static void handle(final JsonObject cmd) {
        if (!cmd.has("match") || !matchId.equals(cmd.get("match").getAsString())) {
            throw new IllegalArgumentException("command is not for match " + matchId);
        }
        switch (cmd.get("t").getAsString()) {
            case "reply" -> seat(cmd).resolve(cmd.get("callId").getAsString(), cmd.get("result"));
            case "abort" -> seat(cmd).resolve(cmd.get("callId").getAsString(), ABORTED);
            case "act" -> seat(cmd).act(cmd.getAsJsonObject("frame"));
            case "probe" -> probe(cmd);
            case "stop" -> STOP.countDown();
            default -> throw new IllegalArgumentException("unknown command " + cmd.get("t"));
        }
    }

    /**
     * A real {@code showConfirmDialog} from the SERVER side of Forge, to one seat: the
     * stock {@link RemoteClientGuiGame} for that slot sends it over Netty exactly as the
     * engine would, and blocks in {@code sendAndWait} until the browser's answer comes
     * back through the seat's client. Wave 6 proved this seam with a test client; this
     * runs it inside a live match. Diagnostic — the Node side only exposes it behind
     * {@code CARDTABLE_PLAY_PROBE=1}.
     */
    static void probe(final JsonObject cmd) {
        final int s = cmd.get("seat").getAsInt();
        final String message = cmd.has("message") ? cmd.get("message").getAsString() : "Probe: answer me";
        final String probeId = cmd.get("probeId").getAsString();
        final Thread t = new Thread(() -> {
            final JsonObject o = line("probe");
            o.addProperty("probeId", probeId);
            o.addProperty("seat", s);
            try {
                final RemoteClient client = FServerManager.getInstance().findClientByIndex(s);
                if (client == null || client.getGui() == null) {
                    throw new IllegalStateException("no remote client GUI at slot " + s);
                }
                final long t0 = System.nanoTime();
                final boolean answer = client.getGui().showConfirmDialog(message, "cardtable probe", "Yes", "No", false);
                o.addProperty("answer", answer);
                o.addProperty("ms", (System.nanoTime() - t0) / 1_000_000.0);
            } catch (final RuntimeException e) {
                o.addProperty("error", e.toString());
            }
            emit(o);
        }, "bridge-probe");
        t.setDaemon(true);
        t.start();
    }
}
