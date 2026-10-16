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
import forge.card.MagicColor;
import forge.card.mana.ManaCost;
import forge.deck.CardPool;
import forge.deck.Deck;
import forge.deck.io.DeckSerializer;
import forge.game.Game;
import forge.game.GameEntityView;
import forge.game.GameRules;
import forge.game.GameState;
import forge.game.GameType;
import forge.game.GameView;
import forge.game.event.GameEventCombatUpdate;
import forge.game.card.CardFaceView;
import forge.game.card.CardView;
import forge.game.card.CounterType;
import forge.game.keyword.KeywordCollectionView;
import forge.game.keyword.KeywordView;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.IHasIcon;
import forge.game.player.PlayerView;
import forge.game.player.RegisteredPlayer;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.spellability.SpellAbilityView;
import forge.game.spellability.StackItemView;
import forge.game.spellability.TargetChoices;
import forge.game.trigger.WrappedAbility;
import forge.game.zone.ZoneType;
import forge.gamemodes.match.GameLobby.GameLobbyData;
import forge.gamemodes.match.HostedMatch;
import forge.gamemodes.match.LobbySlot;
import forge.gamemodes.match.input.InputPayMana;
import forge.gamemodes.match.LobbySlotType;
import forge.gamemodes.match.NextGameDecision;
import forge.gamemodes.match.YieldUpdate;
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
import forge.player.AutoYieldStore;
import forge.player.PlayerControllerHuman;
import forge.player.PlayerZoneUpdate;
import forge.player.PlayerZoneUpdates;
import forge.sound.MusicPlaylist;
import forge.toolbox.MouseTriggerEvent;
import forge.trackable.TrackableCollection;
import forge.trackable.TrackableObject;
import forge.trackable.TrackableProperty;
import forge.trackable.TrackableTypes;
import forge.util.FSerializableFunction;
import forge.util.FileSection;
import forge.util.ITriggerEvent;

import com.google.common.collect.Multiset;
import com.google.common.eventbus.Subscribe;

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
import java.util.concurrent.atomic.AtomicBoolean;
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
 * modified, and — with one exception — nothing here reaches into Forge's server: the
 * seam is the one {@code IToClient} already crosses.
 *
 * <p><b>The one exception: {@link SeatGui#liveMulliganFlag()}.</b> Wave 30 §B. Forge's
 * own server-side proxy, {@code RemoteClientGuiGame}, syncs the trackable graph
 * (walks it and puts a changed property on a {@code DeltaPacket}) only for the
 * {@code showPromptMessage} overload carrying a {@code CardView}, never for
 * {@code updateButtons} or the no-card {@code showPromptMessage} —
 * {@code RemoteClientGuiGame.java:330-337}, whose own comment says why: the
 * {@code card == null} path is shared with the live-game-thread auto-pass timer, and
 * walking the graph there would race it. {@code InputLondonMulligan} sets
 * {@code GameView.Mulligan} correctly and then makes exactly those two unsynced calls,
 * so the flag never reaches a {@code DeltaPacket} for the life of that input — read
 * from {@code forge/}'s real source in the deploy tree, and measured: see
 * {@code docs/planning/wave30-evidence/B-item1-mulligan-root-cause.md}. {@link #LOBBY}
 * (set once in {@link #startMatch}) is what lets {@link SeatGui} read the SERVER's live
 * {@code Game} directly for that one property instead of waiting on a wire that never
 * carries it; {@link SeatGui#syncMulliganFlag()} is where every read happens and why
 * each one is safe.
 *
 * <p><b>One match per JVM.</b> {@link FServerManager#getInstance()} is a process-wide
 * singleton holding one lobby, so this program hosts exactly one match. Whether a
 * long-lived JVM should host many is Wave 9 lane D's question; answering yes would mean
 * a second server per match, which this singleton does not allow.
 *
 * <p><b>Protocol.</b> Stdout carries JSON lines and nothing else — {@code System.out} is
 * pointed at stderr before Forge is touched, so Forge's own logging cannot interleave.
 * Lines out: {@code warm} (a spare only), {@code ready}, {@code frame} (a
 * {@code @hadoku/forge-wire} ServerFrame for one seat), {@code probe}, {@code gameover}, {@code log}
 * (one entry of Forge's game log, or an action it does not log, worded per player:
 * {@link BridgeGui.GameLogForward}),
 * {@code fatal}. Lines in: {@code start} (a spare's first line only), {@code reply},
 * {@code abort}, {@code act}, {@code probe}, {@code stop}. See {@link #main} for the
 * warm spare.
 *
 * <p><b>What is not forwarded.</b> The events arm of every {@code applyDelta} is left out:
 * events carry card names, including the card an opponent just drew, and the Node side
 * has no per-event visibility rule. What a player may read of the game's events is
 * Forge's own game log, which {@code log} carries instead. {@code applyYieldUpdate} and the 20 protocol
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

    /**
     * Optional. Wave 33 §S — a TEST-only starting position: the text of a Forge puzzle
     * file's {@code [state]} section ({@code humanlife=}, {@code humanhand=}, … — see
     * {@code GameState.parseLine}), applied to the match once the mulligan step is over
     * and before either seat is given priority. {@code null} for an ordinary match. The
     * Node side only ever sets this behind {@code CARDTABLE_PLAY_PROBE=1}
     * ({@code socket.ts}'s {@code parseStartBody}); the bridge itself does not gate it —
     * a production server simply never sends it.
     */
    static String scenario = null;

    /**
     * The room's hand smoothing setting: Forge's filtered hands
     * ({@code StaticData.setFilteredHandsEnabled}), which keeps the opening hand closer
     * to the deck's land ratio and weights each mulligan's redraw toward it
     * ({@code forge.game.mulligan.HandSmoothing}). Absent is off, Forge's own default;
     * a room always says which.
     */
    static boolean handSmoothing = false;

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
        return configFrom(JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject());
    }

    /** The config object itself — from the file (cold) or a spare's {@code start} command. Sets {@link #matchId}. */
    static List<SeatConfig> configFrom(final JsonObject root) {
        matchId = root.get("matchId").getAsString();
        seed = root.has("seed") && !root.get("seed").isJsonNull() ? root.get("seed").getAsLong() : null;
        scenario = root.has("scenario") && !root.get("scenario").isJsonNull() ? root.get("scenario").getAsString() : null;
        handSmoothing = root.has("handSmoothing") && root.get("handSmoothing").getAsBoolean();
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

    /**
     * An ability ref WITH its label — {@link SpellAbilityView#toString()}, which
     * is Forge's "cost then description" (SpellAbilityView.java:42-55, from
     * {@code toUnsuppressedString}): {@code {1}, Sacrifice Pyrite Spellbomb: Draw a card.}
     *
     * Wave 19 lane B: the state channel carries no SpellAbilityView objects, so
     * without this the browser can only draw "ability #243". The braces stay
     * Forge's notation; the client says them in words ({@code plainRulesText},
     * because {@code {T}} is a WotC mark). Omitted when empty, so the frame is
     * the same shape an older bridge sent.
     */
    static JsonArray labelledAbilities(final Iterable<SpellAbilityView> abilities) {
        final JsonArray a = new JsonArray();
        if (abilities != null) {
            for (final SpellAbilityView sa : abilities) {
                final JsonObject r = ref("spellAbility", sa.getId());
                final String label = sa.toString();
                if (label != null && !label.isEmpty()) { r.addProperty("label", label); }
                a.add(r);
            }
        }
        return a;
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
            final boolean stackItem = DeltaPacket.getTypeFromDeltaKey(deltaKey) == DeltaPacket.TYPE_STACK_ITEM_VIEW;
            for (final Map.Entry<TrackableProperty, Object> pe : e.getValue().entrySet()) {
                final Object v = stackItem && pe.getKey() == TrackableProperty.Description
                        ? liveStackText(DeltaPacket.getIdFromDeltaKey(deltaKey), pe.getValue()) : pe.getValue();
                props.add(pe.getKey().name(), encode(v));
            }
            // DeltaSyncManager never puts a propertyless object in either map (:257, :281).
            if (props.size() > 2) {
                out.add(String.valueOf(Integer.toUnsignedLong(deltaKey)), props);
            }
        }
        return out;
    }

    /**
     * A stack item's description as every seat reads it: Forge's own, without the bracket a
     * trigger's ends in. {@code WrappedAbility.getStackDescription} appends
     * {@code " [" + Trigger.getImportantStackObjects + "]"}, the objects Forge's own debug view
     * tracks for the trigger ("Damage Source: Dragonlord Ojutai, Damaged: Bella, Amount: 6",
     * "Zone Changer: …", "Phase: …"). The trigger's text, what it remembered and its targets stay.
     * The bracket is rebuilt from the same trigger and taken off only when the description ends in
     * exactly it, so any other text reaches the seat as Forge wrote it. The two readers: the
     * {@code Description} of every stack item a packet carries ({@link #objectTable}) and the
     * resolving item an ask names as its source ({@code askSource}).
     */
    static String stackText(final SpellAbilityStackInstance si) {
        final String said = si.getStackDescription();
        if (!(si.getSpellAbility() instanceof WrappedAbility wrapped) || wrapped.getTrigger() == null) { return said; }
        final String important = wrapped.getTrigger().getImportantStackObjects(wrapped);
        final String note = " [" + important + "]";
        return !important.isEmpty() && said.endsWith(note) ? said.substring(0, said.length() - note.length()) : said;
    }

    /**
     * {@link #stackText} for the live stack item {@code id}, or Forge's {@code Description} as the
     * packet has it when the item is no longer on the live stack (it resolved before the packet was
     * read, and no seat draws it again).
     */
    static Object liveStackText(final int id, final Object forge) {
        final Game game = liveGame();
        if (game == null) { return forge; }
        for (final SpellAbilityStackInstance si : game.getStack()) {
            if (si.getId() == id) { return stackText(si); }
        }
        return forge;
    }

    /**
     * Wave 49 §A — what each stack item targets, when that target is itself
     * ANOTHER item on the stack (a spell counter-targeting a spell, or an
     * ability targeting an ability).
     *
     * <p>Not a {@code TrackableProperty}: {@code forge/} is stock upstream
     * (AGENTS.md — "Don't modify `forge/` until the fork exists"), so this
     * bridge does not get to add a 215th constant to that enum, and
     * {@code StackItemView}'s own {@code TargetCards}/{@code TargetPlayers}
     * (the two collections it DOES publish) are typed
     * {@code CardViewCollectionType}/{@code PlayerViewCollectionType} —
     * {@code TargetChoices.getTargetSpells()} is a disjoint third arm neither
     * one carries, confirmed against the real jar by
     * {@code scenario-w46-b-counterspell.jvm.test.ts}. So this method reads
     * the live {@code Game}'s own {@code MagicStack} directly and sends the
     * pairing as a SIBLING
     * of {@code packet}/{@code gameView} in the frame's own payload —
     * additive to the envelope (`packages/forge-wire/src/tier-c.ts`'s
     * {@code StackTargetSpellsSchema}), not to {@code STATE_PROPERTIES}.
     *
     * <p>One pair per stack item that targets another stack item, from the
     * item's own targets or any sub-instance's ({@link #stackTargetOf}):
     * Forge's own stack-target ask ({@code TargetSelection.chooseCardFromStack})
     * offers one choice at a time, so a real game never has a second one to
     * lose by keeping only the first match.
     */
    static JsonArray stackTargetSpellsJson(final Game game) {
        final JsonArray out = new JsonArray();
        if (game == null) { return out; }
        final Map<SpellAbility, Integer> owner = new HashMap<>();
        for (final SpellAbilityStackInstance si : game.getStack()) {
            owner.put(si.getSpellAbility(), si.getId());
        }
        for (final SpellAbilityStackInstance si : game.getStack()) {
            final Integer toId = stackTargetOf(si, owner);
            if (toId != null) {
                final JsonArray pair = new JsonArray();
                pair.add(si.getId());
                pair.add(toId);
                out.add(pair);
            }
        }
        return out;
    }

    /**
     * The first other stack item {@code si} targets, read down its whole
     * sub-instance chain: a charm's or a Command's chosen mode is a
     * sub-ability ({@code CharmEffect.chainAbilities}), so its targets sit on
     * {@code si.getSubInstance()}, never on {@code si} itself.
     */
    private static Integer stackTargetOf(final SpellAbilityStackInstance si, final Map<SpellAbility, Integer> owner) {
        for (SpellAbilityStackInstance at = si; at != null; at = at.getSubInstance()) {
            final TargetChoices tc = at.getTargetChoices();
            if (tc == null) { continue; }
            for (final SpellAbility targetSa : tc.getTargetSpells()) {
                final Integer toId = owner.get(targetSa);
                if (toId != null) { return toId; }
            }
        }
        return null;
    }

    /** The bridge's own facts beside a state frame's packet: what each stack item targets on the stack, the triggers still to go on it, what resolved abilities left waiting, who made each token, and which creatures can't block. */
    static void addStackFacts(final JsonObject payload) {
        final Game game = liveGame();
        payload.add("stackTargetSpells", stackTargetSpellsJson(game));
        final JsonArray pending = pendingTriggersJson(game);
        if (pending != null) { payload.add("pendingTriggers", pending); }
        final JsonArray effects = waitingEffectsJson(game);
        if (effects != null) { payload.add("waitingEffects", effects); }
        final JsonArray tokens = tokenSourcesJson(game);
        if (tokens != null) { payload.add("tokenSources", tokens); }
        final JsonArray cantBlock = cantBlockJson(game);
        if (cantBlock != null) { payload.add("cantBlock", cantBlock); }
        final JsonArray printedTypes = printedTypesJson(game);
        if (printedTypes != null) { payload.add("printedTypes", printedTypes); }
        final JsonArray conditionMet = conditionMetJson(game);
        if (conditionMet != null) { payload.add("conditionMet", conditionMet); }
    }

    /**
     * The permanents on a battlefield whose type line is not the one printed on them, as
     * {@code [cardId, printedType]} pairs ({@code printedType} in the same {@code cardtype} encoding
     * the view's own {@code Type} uses). The view carries only the current line ({@code Type},
     * {@code CardState.getTypeWithChanges}); the printed one is Forge's own too, read here:
     * {@link #printedType}. Face-down permanents are left out: their printed line is the hidden
     * face's. A full snapshot each time.
     *
     * <p>Null when the battlefields cannot be read (the game thread moved them under the read): the
     * frame then omits the field and the client keeps what it had.
     */
    static JsonArray printedTypesJson(final Game game) {
        final JsonArray out = new JsonArray();
        if (game == null) { return out; }
        try {
            for (final forge.game.player.Player p : game.getPlayers()) {
                for (final forge.game.card.Card c : p.getCardsIn(ZoneType.Battlefield)) {
                    if (c.isFaceDown()) { continue; }
                    final JsonElement printed = encode(printedType(c));
                    if (printed.equals(encode(c.getType()))) { continue; }
                    final JsonArray pair = new JsonArray();
                    pair.add(c.getId());
                    pair.add(printed);
                    out.add(pair);
                }
            }
            return out;
        } catch (final RuntimeException | ReflectiveOperationException e) {
            System.err.println("[bridge] printedTypes: could not read the battlefields (" + e + ")");
            return null;
        }
    }

    /**
     * A permanent's printed type line: the type of the face it shows before any effect changed it,
     * plus its own characteristic-defining abilities (Changeling's every creature type is printed,
     * CR 604.3). A copy's printed line is the copied card's ({@link #copiedBaseType}), so the copy
     * effect's own exception — Phyrexian Metamorph's "it's an artifact in addition" — reads as the
     * change it is.
     */
    static CardTypeView printedType(final forge.game.card.Card c) throws ReflectiveOperationException {
        final java.lang.reflect.Field cda = forge.game.card.Card.class.getDeclaredField("changedCardTypesCharacterDefining");
        cda.setAccessible(true);
        @SuppressWarnings("unchecked")
        final com.google.common.collect.Table<Long, Long, forge.card.ICardChangedType> own =
                (com.google.common.collect.Table<Long, Long, forge.card.ICardChangedType>) cda.get(c);
        return copiedBaseType(c, c.getCurrentStateName(), 0).getTypeWithChanges(own.values());
    }

    /**
     * The base type of {@code state} on {@code c}, before Layer 4: for a card that is a copy, the card
     * it copied ({@code CardCloneStates.getOrigin}, followed through a copy of a copy, bounded so two
     * copies of each other cannot loop); for any other card, its own state ({@code getOriginalState},
     * never a clone's). A copy shows its origin's CURRENT face as its own front face
     * ({@code CardFactory.getCloneStates}), so the front face is looked up on the origin as that.
     */
    static CardTypeView copiedBaseType(final forge.game.card.Card c, final forge.card.CardStateName state, final int depth) {
        if (c.isCloned() && depth < 8 && c.getCloneStates() instanceof java.util.NavigableMap<Long, forge.game.card.CardCloneStates> clones) {
            final forge.game.card.Card origin = clones.lastEntry().getValue().getOrigin();
            if (origin != null && origin != c) {
                return copiedBaseType(origin, state == forge.card.CardStateName.Original ? origin.getCurrentStateName() : state, depth + 1);
            }
        }
        final forge.game.card.CardState own = c.getOriginalState(state);
        return (own != null ? own : c.getState(state)).getType();
    }

    /**
     * The creatures on a battlefield that can't block: their ids, by Forge's own rule
     * ({@code CombatUtil.canBlock(Card, true)} — a "can't block" keyword, a {@code CantBlock}
     * static such as Pacifism's, or "can't block alone" with no other creature). {@code nextTurn}
     * leaves tapped and phased-out out of it: the fact is the creature's own restriction, not its
     * state this turn. Never on the view: {@code CardView} has no property for it. A full snapshot
     * each time.
     *
     * <p>Null when the battlefields cannot be read (the game thread moved them under the read): the
     * frame then omits the field and the client keeps what it had.
     */
    static JsonArray cantBlockJson(final Game game) {
        final JsonArray out = new JsonArray();
        if (game == null) { return out; }
        try {
            for (final forge.game.player.Player p : game.getPlayers()) {
                for (final forge.game.card.Card c : p.getCreaturesInPlay()) {
                    if (!forge.game.combat.CombatUtil.canBlock(c, true)) { out.add(c.getId()); }
                }
            }
            return out;
        } catch (final RuntimeException e) {
            System.err.println("[bridge] cantBlock: could not read the battlefields (" + e + ")");
            return null;
        }
    }

    /**
     * The cards in a hand or on a battlefield whose own conditional ability is on right now —
     * metalcraft with three artifacts, threshold with seven cards in the graveyard, delirium, hellbent,
     * revolt, morbid, raid, ferocious, spell mastery, coven, "as long as you control …". Never on the
     * view: {@code CardView} has no property for it. Every verdict is Forge's own check, on the card's
     * own intrinsic traits ({@link ConditionsOn}); nothing here knows an ability word. A full snapshot
     * each time; a face-down card is never read.
     *
     * <p>Null when the cards cannot be read (the game thread moved them under the read): the frame
     * then omits the field and the client keeps what it had. A card whose own check Forge cannot
     * answer outside its resolution (Pulse of the Forge's "that player", with no target yet) stays
     * dark, is reported once, and every other card is still read.
     */
    static JsonArray conditionMetJson(final Game game) {
        final JsonArray out = new JsonArray();
        if (game == null) { return out; }
        try {
            for (final forge.game.player.Player p : game.getPlayers()) {
                for (final forge.game.card.Card c : p.getCardsIn(List.of(ZoneType.Hand, ZoneType.Battlefield))) {
                    if (!c.isFaceDown() && metOrUnaskable(c)) { out.add(c.getId()); }
                }
            }
            return out;
        } catch (final ReflectiveOperationException | RuntimeException e) {
            System.err.println("[bridge] conditionMet: could not read the cards (" + e + ")");
            return null;
        }
    }

    /** The card names whose check Forge threw on, each reported once. */
    private static final Set<String> UNASKABLE_CONDITIONS = java.util.concurrent.ConcurrentHashMap.newKeySet();

    /** {@link ConditionsOn#met}, with a check Forge throws on read as not met; a move under the read still fails the frame. */
    private static boolean metOrUnaskable(final forge.game.card.Card c) throws ReflectiveOperationException {
        try {
            return ConditionsOn.met(c);
        } catch (final java.util.ConcurrentModificationException moved) {
            throw moved;
        } catch (final RuntimeException e) {
            if (UNASKABLE_CONDITIONS.add(c.getName())) {
                System.err.println("[bridge] condition of " + c.getName() + " cannot be asked outside its resolution (" + e + ")");
            }
            return false;
        }
    }

    /**
     * Whether a card's conditional ability is on, asked of Forge's own checks. Four places carry a
     * condition, and each is asked with the method Forge itself asks it with:
     * <ul>
     * <li>a static ability: {@code StaticAbility.checkConditions} ({@code Condition$ Metalcraft},
     *     {@code CheckSVar$}, {@code IsPresent$} …), on a copy that is active in every zone, so a
     *     card in hand is asked what it would be on the battlefield;</li>
     * <li>a trigger's or replacement's intervening "if": {@code CardTraitBase.meetsCommonRequirements}
     *     ({@code Delirium$ True}, {@code Revolt$ True}, {@code CheckSVar$} …);</li>
     * <li>a spell or ability, a trigger's effect, and each sub-ability under them:
     *     {@code SpellAbilityCondition.areMet} ({@code ConditionCheckSVar$}, {@code ConditionPresent$},
     *     {@code Condition$ Metalcraft} …) — not a replacement's effect, whose condition is a land's
     *     "enters tapped unless …", a drawback rather than a bonus — and
     *     an activated ability's {@code Activation$ Threshold}-style restriction
     *     ({@code SpellAbilityRestriction.checkOtherRestrictions});</li>
     * <li>a branching count: an SVar {@code Count$<Name>.<if>.<else>} (Galvanic Blast's
     *     {@code Count$Metalcraft.4.2}, {@code Count$Compare X GE1.<if>.<else>}), asked through
     *     {@code AbilityUtils.xCount} with two marker numbers in place of its branches: the marker
     *     that comes back says which branch Forge took. Any other SVar returns neither marker. Only
     *     an SVar one of the traits above names as an amount is asked: a replacement's own plumbing
     *     (Starting Town's "enters tapped unless …" count) is not a bonus.</li>
     * </ul>
     * Whether a trait HAS a condition is not a list of ability words either: its parameter map is
     * wrapped in a {@link Recorder} while Forge's checker reads it, and a trait the checker found no
     * parameter of is unconditional.
     *
     * <p>A check that holds at its count's floor never lights a card: Forge scripts an "instead" as
     * two branches, and the default one is the one met when nothing has been counted yet (Fiery
     * Impulse's {@code LT2} beside its spell mastery's {@code GE2}, Arrow Storm's {@code EQ0} beside its
     * raid's {@code GE1}); a drawback that lifts once a count is reached (a god's "isn't a creature"
     * below five devotion) is met there too. Each comparison is asked with Forge's own
     * {@code Expressions.compare} at 0, and a {@code False}/{@code None} flag is its floor. A branching
     * count lights only when the branch Forge takes now is not the one it takes at the floor. Nor does
     * a check that is only a turn or a phase ("during your turn"): it is when an ability works, and
     * would light the card every turn.
     */
    static final class ConditionsOn {
        private static final int IF = 1_000_001;
        private static final int ELSE = 1_000_002;
        /**
         * An activated ability's "activate only if …" keys, of everything
         * {@code SpellAbilityRestriction.setRestrictions} reads; the rest of what it reads is a zone, a
         * timing or a limit, which are not conditions.
         */
        private static final Set<String> RESTRICTION_CONDITIONS = Set.of("Activation", "CheckSVar", "IsPresent", "ActivationLifeTotal");
        private static java.lang.reflect.Method commonRequirements;
        private static java.lang.reflect.Field mapParams;

        /** A parameter map that remembers which of its keys a checker found. */
        static final class Recorder extends com.google.common.collect.ForwardingMap<String, String> {
            private final Map<String, String> params;
            final Set<String> found = new java.util.LinkedHashSet<>();
            Recorder(final Map<String, String> params) { this.params = params; }
            @Override protected Map<String, String> delegate() { return params; }
            @Override public boolean containsKey(final Object key) {
                final boolean has = params.containsKey(key);
                if (has) { found.add((String) key); }
                return has;
            }
            @Override public String get(final Object key) {
                final String v = params.get(key);
                if (v != null) { found.add((String) key); }
                return v;
            }
        }

        static boolean met(final forge.game.card.Card c) throws ReflectiveOperationException {
            final forge.game.player.Player controller = c.getController();
            if (controller == null) { return false; }
            /* Every parameter value of the traits asked below, with the trait it is on: the SVars they name are the amounts the branch probe asks. */
            final Map<String, forge.game.CardTraitBase> named = new HashMap<>();
            for (final forge.game.staticability.StaticAbility st : c.getStaticAbilities()) {
                if (!st.isIntrinsic()) { continue; }
                name(named, st);
                if (staticOn(st, c)) { return true; }
            }
            for (final forge.game.trigger.Trigger t : c.getTriggers()) {
                if (!t.isIntrinsic()) { continue; }
                name(named, t);
                for (SpellAbility s = t.getOverridingAbility(); s != null; s = s.getSubAbility()) { name(named, s); }
                if (commonOn(t, () -> t.copy(c, true)) || chainOn(t.getOverridingAbility(), controller)) { return true; }
            }
            for (final forge.game.replacement.ReplacementEffect r : c.getReplacementEffects()) {
                if (r.isIntrinsic() && commonOn(r, () -> r.copy(c, true))) { return true; }
            }
            for (final SpellAbility sa : c.getSpellAbilities()) {
                if (!sa.isIntrinsic()) { continue; }
                for (SpellAbility s = sa; s != null; s = s.getSubAbility()) { name(named, s); }
                if (restrictionOn(sa, c, controller) || chainOn(sa, controller)) { return true; }
            }
            return branchOn(c, named);
        }

        private static void name(final Map<String, forge.game.CardTraitBase> named, final forge.game.CardTraitBase trait) {
            for (final String value : trait.getMapParams().values()) { named.putIfAbsent(value, trait); }
        }

        private static boolean staticOn(final forge.game.staticability.StaticAbility st, final forge.game.card.Card c) throws ReflectiveOperationException {
            final forge.game.staticability.StaticAbility copy = st.copy(c, true);
            copy.setActiveZone(java.util.EnumSet.allOf(ZoneType.class));
            final Recorder zones = new Recorder(copy.getMapParams());
            mapParams().set(copy, zones);
            copy.zonesCheck();
            final Recorder all = new Recorder(zones.params);
            mapParams().set(copy, all);
            final boolean on = copy.checkConditions();
            all.found.removeAll(zones.found);
            return on && counts(all.found, copy);
        }

        /**
         * A trigger's or replacement's intervening "if". Forge reads the condition keys from the map it
         * is handed, but their comparisons ({@code PresentCompare$}, {@code SVarCompare$}) from the
         * trait's own; a trait with a condition is asked again on a copy whose own map records too.
         */
        private static boolean commonOn(final forge.game.CardTraitBase trait, final java.util.function.Supplier<? extends forge.game.CardTraitBase> copy) throws ReflectiveOperationException {
            final Recorder conditions = new Recorder(trait.getMapParams());
            if (!(Boolean) commonRequirements().invoke(trait, conditions) || conditions.found.isEmpty()) { return false; }
            final forge.game.CardTraitBase asked = copy.get();
            final Recorder all = new Recorder(asked.getMapParams());
            mapParams().set(asked, all);
            return (Boolean) commonRequirements().invoke(asked, all) && counts(all.found, asked);
        }

        private static boolean restrictionOn(final SpellAbility sa, final forge.game.card.Card c, final forge.game.player.Player controller) {
            if (!sa.isActivatedAbility()) { return false; }
            final Recorder r = new Recorder(sa.getMapParams());
            new forge.game.spellability.SpellAbilityRestriction().setRestrictions(r);
            r.found.retainAll(RESTRICTION_CONDITIONS);
            return counts(r.found, sa)
                    && sa.getRestrictions().checkOtherRestrictions(c, sa, controller);
        }

        /**
         * A spell or ability and every sub-ability under it. Forge asks a condition of the player
         * activating it; a card in hand has none yet, so the chain is asked on a copy its controller
         * activates (the live one is never touched).
         */
        private static boolean chainOn(final SpellAbility root, final forge.game.player.Player controller) {
            if (root == null) { return false; }
            SpellAbility asked = null;
            for (SpellAbility s = root; s != null; s = s.getSubAbility()) {
                final Recorder r = new Recorder(s.getMapParams());
                new forge.game.spellability.SpellAbilityCondition().setConditions(r);
                if (r.found.isEmpty()) { continue; }
                if (asked == null) { asked = root.getActivatingPlayer() == null ? root.copy(root.getHostCard(), controller, true) : root; }
                final SpellAbility same = same(asked, root, s);
                if (same != null && counts(r.found, same) && same.getConditions().areMet(same)) { return true; }
            }
            return false;
        }

        /** {@code s}'s place in {@code root}'s chain, in {@code copy}'s chain. */
        private static SpellAbility same(final SpellAbility copy, final SpellAbility root, final SpellAbility s) {
            SpellAbility a = copy;
            for (SpellAbility b = root; b != null && a != null; b = b.getSubAbility(), a = a.getSubAbility()) {
                if (b == s) { return a; }
            }
            return null;
        }

        /**
         * The card's branching counts that one of its asked traits names as an amount, each asked through
         * that trait: on when Forge takes a different branch now than at the floor, where only a
         * {@code Compare} (its comparison asked at 0) can take the first one.
         */
        private static boolean branchOn(final forge.game.card.Card c, final Map<String, forge.game.CardTraitBase> named) {
            for (final Map.Entry<String, String> svar : c.getSVars().entrySet()) {
                final forge.game.CardTraitBase asker = named.get(svar.getKey());
                final String expression = svar.getValue();
                if (asker == null || !expression.startsWith("Count$") || expression.contains("/")) { continue; }
                final String[] parts = expression.split("\\.");
                if (parts.length != 3) { continue; }
                try {
                    final boolean now = forge.game.ability.AbilityUtils.xCount(c, parts[0] + "." + IF + "." + ELSE, asker) == IF;
                    final String[] compare = parts[0].split(" ");
                    final boolean floor = compare[0].equals("Count$Compare") && compare.length == 3 && atFloor(compare[2], c, asker);
                    if (now != floor) { return true; }
                } catch (final RuntimeException notABranch) {
                    // Not a branching count: Forge could not read it with markers in its branches.
                }
            }
            return false;
        }

        /**
         * Whether the condition keys a checker {@code found} on {@code trait} make a condition this card
         * lights for: at least one, not only timing, and none met at its floor.
         */
        private static boolean counts(final Set<String> found, final forge.game.CardTraitBase trait) {
            return !found.isEmpty() && !timingOnly(found, trait.getMapParams()) && !floorMet(found, trait);
        }

        /**
         * Whether the condition keys {@code found} hold when nothing has been counted: a comparison
         * ({@code SVarCompare$ LT2}, {@code ConditionCompare$ EQ0}, {@code PresentCompare$ LE3} …) that
         * Forge's own compare meets at 0 — "NotPresent" is Forge's {@code EQ0} — or a {@code False} /
         * {@code None} flag. A comparison not given is Forge's default {@code GE1}, which 0 never meets.
         */
        private static boolean floorMet(final Set<String> found, final forge.game.CardTraitBase trait) {
            final Map<String, String> params = trait.getMapParams();
            for (final String key : found) {
                final String value = params.get(key);
                if ("False".equalsIgnoreCase(value) || "None".equalsIgnoreCase(value)) { return true; }
                final String compare = key.contains("NotPresent") ? "EQ0" : key.matches(".*Compare\\d?") ? value : null;
                if (compare != null && atFloor(compare, trait.getHostCard(), trait)) { return true; }
            }
            return false;
        }

        /** Whether 0 meets {@code compare} ({@code LT2}, {@code GEX} …), its right side counted by Forge for {@code trait}. */
        private static boolean atFloor(final String compare, final forge.game.card.Card host, final forge.game.CardTraitBase trait) {
            final int right = forge.game.ability.AbilityUtils.calculateAmount(host, compare.substring(2), trait);
            return forge.util.Expressions.compare(0, compare, right);
        }

        /**
         * Whether every key is a turn or phase — {@code PlayerTurn$}, {@code Phases$},
         * {@code ConditionPlayerTurn$}, {@code ActivationPhases$}, {@code Condition$ PlayerTurn}: "during
         * your turn" is when an ability works, not a count the player builds toward, and would light
         * the card every turn.
         */
        private static boolean timingOnly(final Set<String> found, final Map<String, String> params) {
            for (final String key : found) {
                final String value = params.get(key);
                final boolean timing = key.contains("Turn") || key.contains("Phase")
                        || (key.equals("Condition") && value != null && (value.contains("Turn") || value.contains("Phase")));
                if (!timing) { return false; }
            }
            return true;
        }

        private static java.lang.reflect.Method commonRequirements() throws NoSuchMethodException {
            if (commonRequirements == null) {
                final java.lang.reflect.Method m = forge.game.CardTraitBase.class.getDeclaredMethod("meetsCommonRequirements", Map.class);
                m.setAccessible(true);
                commonRequirements = m;
            }
            return commonRequirements;
        }

        private static java.lang.reflect.Field mapParams() throws NoSuchFieldException {
            if (mapParams == null) {
                final java.lang.reflect.Field f = forge.game.CardTraitBase.class.getDeclaredField("mapParams");
                f.setAccessible(true);
                mapParams = f;
            }
            return mapParams;
        }
    }

    /**
     * Which card made each token on a battlefield: {@code [tokenId, sourceId]}, the host of the ability
     * that created it ({@code Card.getTokenSpawningAbility}, set by {@code TokenEffectBase}) — Kalitas,
     * Traitor of Ghet for the Zombie its replacement makes, a planeswalker for its loyalty ability's
     * token. Never on the view: Forge's {@code CardView} has no property for it. A token whose ability
     * Forge does not keep (a copy, a token made by a game rule) is left out. A full snapshot each time.
     *
     * <p>Null when the battlefields cannot be read (the game thread moved them under the read): the
     * frame then omits the field and the client keeps what it had.
     */
    static JsonArray tokenSourcesJson(final Game game) {
        final JsonArray out = new JsonArray();
        if (game == null) { return out; }
        try {
            for (final forge.game.player.Player p : game.getPlayers()) {
                for (final forge.game.card.Card c : p.getCardsIn(ZoneType.Battlefield)) {
                    final SpellAbility made = c.isToken() ? c.getTokenSpawningAbility() : null;
                    final forge.game.card.Card host = made == null ? null : made.getHostCard();
                    if (host == null || host.getId() == c.getId()) { continue; }
                    final JsonArray pair = new JsonArray();
                    pair.add(c.getId());
                    pair.add(host.getId());
                    out.add(pair);
                }
            }
            return out;
        } catch (final RuntimeException e) {
            System.err.println("[bridge] tokenSources: could not read the battlefields (" + e + ")");
            return null;
        }
    }

    /**
     * What an ability left waiting on the card that made it, once it resolved: every delayed
     * trigger Forge holds ({@code TriggerHandler}'s private {@code delayedTriggers} and the
     * {@code playerDefinedDelayedTriggers} still to start — Narset Transcendent's -2, "when you cast
     * your next instant or sorcery spell…", lives there until it fires), and every effect in a command
     * zone that names its source ({@code Card.getEffectSource}, an "until end of turn" effect a
     * permanent created). Neither rides the view: a delayed trigger is on no card and on no stack, and
     * an effect card is drawn nowhere. {@code source} is the host card's id, {@code text} Forge's own
     * description; an emblem is a lasting part of its player, not a wait, and is left out.
     *
     * <p>Null when the trigger lists cannot be read (the game thread moved them under the read): the
     * frame then omits the field and the client keeps what it had.
     */
    @SuppressWarnings("unchecked")
    static JsonArray waitingEffectsJson(final Game game) {
        final JsonArray out = new JsonArray();
        if (game == null) { return out; }
        try {
            final forge.game.trigger.TriggerHandler handler = game.getTriggerHandler();
            final List<forge.game.trigger.Trigger> triggers = new ArrayList<>(
                    (List<forge.game.trigger.Trigger>) SeatGui.field(handler, forge.game.trigger.TriggerHandler.class, "delayedTriggers"));
            triggers.addAll(((com.google.common.collect.Multimap<?, forge.game.trigger.Trigger>)
                    SeatGui.field(handler, forge.game.trigger.TriggerHandler.class, "playerDefinedDelayedTriggers")).values());
            for (final forge.game.trigger.Trigger t : triggers) {
                final forge.game.card.Card host = t.getHostCard();
                final String text = t.toString();
                if (host == null || text.isEmpty()) { continue; }
                out.add(waitingEffect(host, text, "trigger"));
            }
            for (final forge.game.player.Player p : game.getPlayers()) {
                for (final forge.game.card.Card c : p.getCardsIn(ZoneType.Command)) {
                    final forge.game.card.Card source = c.getEffectSource();
                    if (!c.isImmutable() || c.isEmblem() || source == null) { continue; }
                    final List<String> said = new ArrayList<>();
                    for (final forge.game.staticability.StaticAbility st : c.getStaticAbilities()) {
                        final String d = st.toString();
                        if (!d.isEmpty()) { said.add(d); }
                    }
                    for (final forge.game.trigger.Trigger t : c.getTriggers()) {
                        final String d = t.toString();
                        if (!d.isEmpty()) { said.add(d); }
                    }
                    out.add(waitingEffect(source, said.isEmpty() ? c.getName() : String.join(" ", said), "effect"));
                }
            }
            return out;
        } catch (final ReflectiveOperationException | RuntimeException e) {
            System.err.println("[bridge] waitingEffects: could not read the delayed triggers (" + e + ")");
            return null;
        }
    }

    private static JsonObject waitingEffect(final forge.game.card.Card source, final String text, final String kind) {
        final JsonObject o = new JsonObject();
        o.addProperty("source", source.getId());
        o.addProperty("text", text);
        o.addProperty("kind", kind);
        return o;
    }

    /**
     * Every seat told the waiting triggers now, with nothing else changed, whenever a question opens
     * while any wait: a batch is formed on the game thread with no trackable property moving, so no
     * delta would carry it before its first question (the order of the batch, its first target). An
     * empty packet, as {@code emitSyntheticMulliganDelta} sends.
     */
    static void broadcastIfWaiting() {
        final Game game = liveGame();
        try {
            if (game == null || pendingTriggers(game).isEmpty()) { return; }
        } catch (final ReflectiveOperationException | RuntimeException e) {
            System.err.println("[bridge] broadcastIfWaiting: could not read the waiting triggers (" + e + ")");
            return;
        }
        for (final SeatGui g : SEATS.values()) {
            final JsonObject f = SeatGui.notify("applyDelta");
            final JsonObject payload = new JsonObject();
            payload.add("packet", packetJson(new DeltaPacket(-1L, null, null, 0, null)));
            addStackFacts(payload);
            f.add("payload", payload);
            g.frame(f);
        }
    }

    /**
     * The triggers Forge has collected but not yet put on the stack: the batch
     * {@code MagicStack.chooseOrderOfSimultaneousStackEntry} hands the controller
     * ({@code activePlayerSAs}, {@code MagicStack.java:878-909}) while
     * {@code PlayerControllerHuman.orderAndPlaySimultaneousSa} asks each one's targets in
     * turn ({@code :2370-2394}), plus the ones still waiting in
     * {@code simultaneousStackEntryList} for their controller's turn at it. Both lists are
     * private and stock upstream has no getter, so they are read the way
     * {@link SeatGui#legalPlayers} reads its input. A trigger already on the stack is not
     * pending. {@code current} marks the one whose target question is open.
     *
     * <p>Null when the lists cannot be read (the game thread moved them under the read):
     * the frame then omits the field and the client keeps what it had.
     */
    static JsonArray pendingTriggersJson(final Game game) {
        final JsonArray out = new JsonArray();
        if (game == null) { return out; }
        try {
            for (final WrappedAbility w : pendingTriggers(game)) {
                final JsonObject o = new JsonObject();
                o.addProperty("id", w.getId());
                o.addProperty("hostCard", w.getHostCard().getId());
                o.addProperty("controller", w.getActivatingPlayer() == null ? w.getHostCard().getController().getId() : w.getActivatingPlayer().getId());
                o.addProperty("key", w.yieldKey());
                if (isTargeting(w)) { o.addProperty("current", true); }
                out.add(o);
            }
            return out;
        } catch (final ReflectiveOperationException | RuntimeException e) {
            System.err.println("[bridge] pendingTriggers: could not read the waiting triggers (" + e + ")");
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    static List<WrappedAbility> pendingTriggers(final Game game) throws ReflectiveOperationException {
        final forge.game.zone.MagicStack stack = game.getStack();
        final Set<SpellAbility> onStack = new java.util.HashSet<>();
        for (final SpellAbilityStackInstance si : stack) { onStack.add(si.getSpellAbility()); }
        final Set<SpellAbility> waiting = new java.util.LinkedHashSet<>();
        waiting.addAll(new ArrayList<>((List<SpellAbility>) SeatGui.field(stack, forge.game.zone.MagicStack.class, "activePlayerSAs")));
        waiting.addAll(new ArrayList<>((List<SpellAbility>) SeatGui.field(stack, forge.game.zone.MagicStack.class, "simultaneousStackEntryList")));
        final List<WrappedAbility> out = new ArrayList<>();
        for (final SpellAbility sa : waiting) {
            if (sa instanceof WrappedAbility w && !onStack.contains(sa) && w.getHostCard() != null && w.getTrigger() != null) { out.add(w); }
        }
        return out;
    }

    /** Whether {@code w}'s controller has its target question open right now. */
    private static boolean isTargeting(final WrappedAbility w) throws ReflectiveOperationException {
        final forge.game.player.Player who = w.getActivatingPlayer() == null ? w.getHostCard().getController() : w.getActivatingPlayer();
        if (who == null || !(who.getController() instanceof PlayerControllerHuman human)) { return false; }
        final SpellAbility asked = targetedAbility(human);
        return asked != null && (asked == w || asked == w.getWrappedAbility());
    }

    /** The ability {@code human}'s open target selection is for, unwrapped from its trigger; null for any other input. */
    static SpellAbility targetedAbility(final PlayerControllerHuman human) throws ReflectiveOperationException {
        final Object input = human.getInputQueue().getInput();
        if (!(input instanceof forge.gamemodes.match.input.InputSelectTargets)) { return null; }
        final SpellAbility sa = (SpellAbility) SeatGui.field(input, forge.gamemodes.match.input.InputSelectTargets.class, "sa");
        return sa instanceof WrappedAbility w ? w.getWrappedAbility() : sa;
    }

    /** One trigger of one card, whichever instance: identical triggers from the same source share it. */
    static String triggerKey(final SpellAbility sa) {
        return sa.getHostCard().getId() + ":" + sa.getTrigger().getId();
    }

    /** The copies of one spell: every copy one effect makes of it shares this. */
    static String copyKey(final forge.game.card.Card original) {
        return "copy:" + original.getId();
    }

    /**
     * How many more copies of {@code original} will still be asked for targets after the one asked now;
     * 0 when that cannot be told.
     *
     * Storm and every other "copy it N times" ({@code CopySpellAbilityEffect.resolve}) makes all its
     * copies at once and hands them to {@code orderAndPlaySimultaneousSa}, which asks each copy's new
     * targets in turn ({@code SpellAbility.setupNewTargets}). The stack is frozen while the effect
     * resolves ({@code MagicStack.resolveStack}), so the effect is still the top of the stack and each
     * copy already answered waits in {@code MagicStack.frozenStack}: the copies still to ask are the
     * effect's own count, less those, less the one open now. A copy made by anything else (an effect
     * that is not the resolving one) is 0, and asked on its own as before.
     */
    @SuppressWarnings("unchecked")
    static int copiesStillToTarget(final Game game, final forge.game.card.Card original) throws ReflectiveOperationException {
        final forge.game.zone.MagicStack stack = game.getStack();
        if (stack.isEmpty()) { return 0; }
        final SpellAbility top = stack.peekAbility();
        SpellAbility effect = top instanceof WrappedAbility w ? w.getWrappedAbility() : top;
        while (effect != null && effect.getApi() != forge.game.ability.ApiType.CopySpellAbility) { effect = effect.getSubAbility(); }
        if (effect == null) { return 0; }
        final int total = effect.hasParam("Amount") ? forge.game.ability.AbilityUtils.calculateAmount(effect.getHostCard(), effect.getParam("Amount"), effect) : 1;
        int answered = 0;
        for (final SpellAbilityStackInstance si : new ArrayList<>((java.util.Collection<SpellAbilityStackInstance>) SeatGui.field(stack, forge.game.zone.MagicStack.class, "frozenStack"))) {
            final forge.game.card.Card host = si.getSpellAbility().getHostCard();
            if (host != null && host.isCopiedSpell() && host.getCopiedPermanent() != null && host.getCopiedPermanent().getId() == original.getId()) { answered += 1; }
        }
        return Math.max(0, total - answered - 1);
    }

    /**
     * The live {@code Game}, straight off {@link #LOBBY} — the same access
     * {@link SeatGui#liveMulliganFlag()} uses, and for the same reason: this
     * bridge's own synthetic/additive data has no other route to the engine's
     * current truth.
     */
    static Game liveGame() {
        final ServerGameLobby lobby = LOBBY;
        if (lobby == null) { return null; }
        final HostedMatch hosted = lobby.getHostedMatch();
        return hosted == null ? null : hosted.getGame();
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

    /**
     * The server's own lobby, set once in {@link #startMatch} — the one live
     * {@code Game} every {@link SeatGui} reads off directly for
     * {@link SeatGui#liveMulliganFlag()}. See that method's doc for why a seat's
     * client-side {@code IGuiGame} reads the SERVER's object at all.
     */
    static volatile ServerGameLobby LOBBY;

    static final Map<Integer, SeatGui> SEATS = new ConcurrentHashMap<>();

    /**
     * Wave 33 §S item 4 — the concede race, ORDERED shut rather than merely
     * narrowed. {@code false} until the {@code gameover} line is emitted,
     * exactly once ({@link #gameOverEmitted}'s {@code compareAndSet} is the
     * only writer).
     *
     * <p>The race: a browser learns the game is over from an ORDINARY
     * wire-synced {@code GameView} property (the client's {@code
     * view.gameOver}, `apps/ui/src/play/adapter.ts`'s {@code readBool(game,
     * 'GameOver')}) — carried by whatever {@code setGameView}/{@code
     * applyDelta} call happens to include it. {@code Match.status} only
     * becomes {@code 'over'} once THIS bridge emits a {@code gameover} line;
     * before wave 33 that line came only from {@link #watchForGameOver}, a
     * thread polling {@code game.isGameOver()} on its own clock — so a client
     * could see the end and a reconnect-and-second-concede could reach the
     * server before the next poll tick, landing on {@code Match.status ===
     * 'running'} and skipping the refusal entirely (measured: 3 of 10 runs of
     * `e2e/w31.spec.ts`'s concede test; see {@code wave33-evidence/s4-concede.md}).
     *
     * <p>{@link #maybeEmitGameOverFirst()} closes this by ORDER rather than by
     * a narrower window: called at the top of {@link SeatGui#setGameView} and
     * {@link SeatGui#applyDelta} — the only two places a {@code GameOver}
     * property can reach a seat's wire — it checks the SAME live {@code Game}
     * {@link #LOBBY} already reads for {@link SeatGui#liveMulliganFlag()}, and
     * if it is over, emits {@code gameover} BEFORE the frame that is about to
     * carry {@code GameOver} to the client. Both lines go out on the same
     * `stdout` stream, read by Node in that same order (`host.ts`'s line
     * reader, one JSON object per line) and processed by {@code match.ts}'s
     * `onLine` synchronously in arrival order — so {@code Match.status} is
     * {@code 'over'} before the state frame that lets any client learn the
     * same thing is even written, let alone acted on. {@link #watchForGameOver}
     * stays as a backstop for the one case this does not cover — the match
     * ending with no seat connected to notice via a frame at all (a bot vs
     * bot match, out of scope for this bridge, but cheap to keep correct for).
     */
    static final AtomicBoolean gameOverEmitted = new AtomicBoolean(false);

    /** See {@link #gameOverEmitted}'s doc. Idempotent; safe to call from any seat's thread. */
    static void maybeEmitGameOverFirst() {
        final ServerGameLobby lobby = LOBBY;
        if (lobby == null || lobby.getHostedMatch() == null) { return; }
        final var game = lobby.getHostedMatch().getGame();
        if (game == null || !game.isGameOver()) { return; }
        if (!gameOverEmitted.compareAndSet(false, true)) { return; }
        final JsonObject o = line("gameover");
        final var outcome = game.getOutcome();
        o.addProperty("winner", outcome == null || outcome.getWinningLobbyPlayer() == null
                ? null : outcome.getWinningLobbyPlayer().getName());
        // Who lost, by the ids the views carry: the server tells every seat with this
        // (`Match.finishSeat`), because neither `GameOver` nor `finishGame()` is sure to reach one.
        final JsonArray losers = new JsonArray();
        // Why each of them lost, in Forge's own terms (`PlayerOutcome.lossState`, `GameLossReason`), so a
        // screen says what Forge decided instead of guessing it from the board.
        final JsonArray lost = new JsonArray();
        for (final forge.game.player.Player p : game.getRegisteredPlayers()) {
            if (!p.hasLost()) { continue; }
            losers.add(p.getId());
            final forge.game.player.PlayerOutcome why = p.getOutcome();
            final JsonObject l = new JsonObject();
            l.addProperty("player", p.getId());
            l.addProperty("reason", why.lossState.name());
            if (why.loseConditionSpell != null) { l.addProperty("source", why.loseConditionSpell); }
            lost.add(l);
        }
        o.add("losers", losers);
        o.add("lost", lost);
        emit(o);
    }

    /**
     * Each seat client's Netty thread, mapped to its seat. See {@link BridgeGui} for why
     * the bridge needs to know which thread is a client's.
     */
    static final Map<Thread, SeatGui> CLIENT_THREADS = new ConcurrentHashMap<>();

    /** A blocking question waiting on the browser. */
    /**
     * {@code CostAdjustment}'s private steps, called one static at a time so the bridge knows which
     * card changed a held spell's cost ({@code SeatGui.heldChanges}). Forge's public
     * {@code adjust(ManaCostBeingPaid, …)} runs the same steps but asks the payer as it goes (which
     * reduction first, delve, convoke) and names no source, so it cannot answer "what would this cost
     * and why" without a prompt. Resolved once; a Forge that renamed a step fails here, loudly, and the
     * hand goes without tags.
     */
    static final class CostSteps {
        private static CostSteps instance;
        private final java.lang.reflect.Method requirement;
        private final java.lang.reflect.Method raise;
        private final java.lang.reflect.Method reduce;
        private final java.lang.reflect.Method set;

        private CostSteps() throws ReflectiveOperationException {
            final Class<?> ca = forge.game.cost.CostAdjustment.class;
            final Class<?> st = forge.game.staticability.StaticAbility.class;
            final Class<?> paid = forge.game.mana.ManaCostBeingPaid.class;
            requirement = ca.getDeclaredMethod("checkRequirement", SpellAbility.class, st);
            raise = ca.getDeclaredMethod("applyRaiseCostAbility", forge.game.cost.Cost.class, SpellAbility.class, st);
            reduce = ca.getDeclaredMethod("applyReduceCostAbility", st, SpellAbility.class, paid, int.class);
            set = ca.getDeclaredMethod("applySetCostAbility", st, SpellAbility.class, paid);
            for (final java.lang.reflect.Method m : List.of(requirement, raise, reduce, set)) { m.setAccessible(true); }
        }

        static synchronized CostSteps get() throws ReflectiveOperationException {
            if (instance == null) { instance = new CostSteps(); }
            return instance;
        }

        /**
         * The mana {@code sa} would cost its activating player now, in {@code CostAdjustment.adjust}'s
         * order, from the statics of {@code around} (the battlefield, stack and command zones) and of
         * the card itself. Every static that changed it is added to {@code by}, by its source's name.
         */
        ManaCost cost(final SpellAbility sa, final List<forge.game.card.Card> around, final java.util.Set<String> by)
                throws ReflectiveOperationException {
            final forge.game.card.Card host = sa.getHostCard();
            final List<forge.game.card.Card> cards = new ArrayList<>(around);
            if (!cards.contains(host)) { cards.add(host); }
            final List<forge.game.staticability.StaticAbility> raises = new ArrayList<>();
            final List<forge.game.staticability.StaticAbility> reductions = new ArrayList<>();
            final List<forge.game.staticability.StaticAbility> sets = new ArrayList<>();
            for (final forge.game.card.Card c : cards) {
                for (final forge.game.staticability.StaticAbility st : c.getStaticAbilities()) {
                    if (st.checkMode(forge.game.staticability.StaticAbilityMode.RaiseCost)) { raises.add(st); }
                    else if (st.checkMode(forge.game.staticability.StaticAbilityMode.ReduceCost)) { reductions.add(st); }
                    else if (st.checkMode(forge.game.staticability.StaticAbilityMode.SetCost)) { sets.add(st); }
                }
            }
            final forge.game.cost.Cost raised = sa.getPayCosts().copy();
            for (final forge.game.staticability.StaticAbility st : raises) {
                final String before = ManaCost.serialize(raised.getTotalMana());
                raise.invoke(null, raised, sa, st);
                if (!before.equals(ManaCost.serialize(raised.getTotalMana()))) { by.add(SeatGui.sourceName(st)); }
            }
            final forge.game.mana.ManaCostBeingPaid paid = new forge.game.mana.ManaCostBeingPaid(raised.getTotalMana());
            int generic = 0;
            for (final forge.game.staticability.StaticAbility st : reductions) {
                if (st.hasParam("UpTo") || !(boolean) requirement.invoke(null, sa, st)) { continue; }
                final String before = paid.toString();
                final int less = (int) reduce.invoke(null, st, sa, paid, generic);
                generic += less;
                if (less > 0 || !before.equals(paid.toString())) { by.add(SeatGui.sourceName(st)); }
            }
            paid.decreaseGenericMana(generic);
            for (final String pip : sa.getPipsToReduce()) {
                paid.decreaseShard(forge.card.mana.ManaCostShard.parseNonGeneric(pip), 1);
            }
            for (final forge.game.staticability.StaticAbility st : sets) {
                final String before = paid.toString();
                set.invoke(null, st, sa, paid);
                if (!before.equals(paid.toString())) { by.add(SeatGui.sourceName(st)); }
            }
            return paid.toManaCost();
        }
    }

    static final class PendingAsk {
        final String callId;
        final String method;
        final CompletableFuture<JsonElement> answer = new CompletableFuture<>();
        /** The frame as sent, kept for {@link SeatGui#resendPending}. Null until {@link SeatGui#await} sends it. */
        volatile JsonObject frame;
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
         * What this seat was LAST TOLD the Game object's {@code Mulligan} property is —
         * real wire traffic or this bridge's own synthetic correction, either one. {@code
         * null} until either has said anything; see {@link #syncMulliganFlag()}.
         */
        volatile Boolean lastToldMulligan;

        /** The first {@link BridgeGui.EffectJournal} entry this seat has not been sent. */
        private long effectsFrom = BridgeGui.EffectJournal.INSTANCE.head();

        /**
         * The damage and deaths since this seat's last state frame, added to {@code payload} as
         * {@code damage} and {@code deaths} when there are any. A snapshot ({@code setGameView})
         * passes {@code false}: it skips past them, since what it draws is the board after.
         */
        void effectsSince(final JsonObject payload, final boolean send) {
            final BridgeGui.EffectJournal journal = BridgeGui.EffectJournal.INSTANCE;
            final long head = journal.head();
            if (send && head > effectsFrom) { journal.since(effectsFrom, payload); }
            effectsFrom = head;
        }

        /**
         * The life each player has committed to an open mana payment that Forge has not taken yet,
         * as this seat was last told it: player id → the payment and its amount.
         *
         * <p>A Phyrexian shard paid with life ({@code InputPayManaOfCostPayment.onPlayerSelected})
         * only adds 2 to the input's {@code phyLifeToLose}; {@code done()} pays all of it once the
         * whole cost is paid, and a cancelled payment pays none. So while a payment is open the
         * life total still reads the old value, and this is what the board subtracts from it.
         *
         * <p>Held past the payment's end when the payment completed: {@code done()} runs on the
         * game thread while this seat may still be handed packets built before it, and dropping
         * the amount then would draw the old total again for a frame. It is dropped with the
         * packet that carries the player's new {@code Life}, so the two land together. A
         * cancelled payment (unpaid, and finished or no longer its player's open input) drops it at
         * once: Forge took nothing.
         *
         * <p>Read off the payment itself once it is known, not off the input queue: Auto pays
         * through {@code InputPayMana.runAsAi}, which swaps the player's controller for an AI one
         * while it taps, so for those frames the player has no human queue to look in.
         */
        private final Map<Integer, Object[]> lifeHeld = new HashMap<>();
        /** What this seat was last told {@link #lifePaying} is, so a press tells it only on a change. */
        private String lifeTold = "[]";

        /**
         * {@code [playerId, life]} for every player paying a cost with life right now, as of a frame
         * carrying {@code packet}'s objects ({@code null} for no packet); see {@link #lifeHeld}.
         */
        synchronized JsonArray lifePaying(final DeltaPacket packet) {
            final Game game = liveGame();
            final JsonArray out = new JsonArray();
            if (game == null) { lifeHeld.clear(); return out; }
            for (final forge.game.player.Player p : game.getPlayers()) {
                final boolean human = p.getController() instanceof PlayerControllerHuman;
                final Object open = human ? ((PlayerControllerHuman) p.getController()).getInputQueue().getInput() : null;
                final Object[] held = lifeHeld.get(p.getId());
                final InputPayMana pay = open instanceof InputPayMana o && !o.isPaid() ? o : held == null ? null : (InputPayMana) held[0];
                if (pay == null) { continue; }
                try {
                    if (pay.isPaid()) {
                        if (carriesLife(packet, p.getId())) { lifeHeld.remove(p.getId()); }
                    } else if ((Boolean) field(pay, forge.gamemodes.match.input.InputBase.class, "finished") || (human && open != pay)) {
                        lifeHeld.remove(p.getId());
                    } else {
                        final int life = (Integer) field(pay, InputPayMana.class, "phyLifeToLose");
                        if (life > 0) { lifeHeld.put(p.getId(), new Object[] { pay, life }); } else { lifeHeld.remove(p.getId()); }
                    }
                } catch (final ReflectiveOperationException | RuntimeException e) {
                    System.err.println("[bridge] lifePaying: could not read the open payment (" + e + ")");
                    lifeHeld.remove(p.getId());
                }
                final Object[] now = lifeHeld.get(p.getId());
                if (now != null) {
                    final JsonArray pair = new JsonArray();
                    pair.add(p.getId());
                    pair.add((Integer) now[1]);
                    out.add(pair);
                }
            }
            return out;
        }

        /** Whether {@code packet} carries player {@code id}'s {@code Life}; a full view always does. */
        private static boolean carriesLife(final DeltaPacket packet, final int id) {
            if (packet == null) { return false; }
            final int key = DeltaPacket.makeDeltaKey(DeltaPacket.TYPE_PLAYER_VIEW, id);
            for (final Map<Integer, Map<TrackableProperty, Object>> objects : List.of(packet.getNewObjects(), packet.getObjectDeltas())) {
                final Map<TrackableProperty, Object> props = objects.get(key);
                if (props != null && props.containsKey(TrackableProperty.Life)) { return true; }
            }
            return false;
        }

        /**
         * Send a state frame with {@link #lifePaying} added to its payload, and remember it as told.
         * Under this seat's lock, so a press told from another seat's thread
         * ({@link #tellLifePaying}) can never overtake a frame that carries an older amount.
         */
        synchronized void sendState(final JsonObject frame, final JsonObject payload, final DeltaPacket packet) {
            final JsonArray paying = lifePaying(packet);
            payload.add("lifePaying", paying);
            lifeTold = paying.toString();
            frame.add("payload", payload);
            frame(frame);
        }

        /**
         * Tell this seat a change to {@link #lifePaying} that no state frame carries: a press of
         * a payment's life button changes nothing on the view, so it is said in an empty packet's
         * frame, as {@link #broadcastIfWaiting} says waiting triggers.
         */
        synchronized void tellLifePaying() {
            if (lifePaying(null).toString().equals(lifeTold)) { return; }
            final JsonObject payload = new JsonObject();
            payload.add("packet", packetJson(new DeltaPacket(-1L, null, null, 0, null)));
            addStackFacts(payload);
            sendState(notify("applyDelta"), payload, null);
        }

        /**
         * Wave 32, Q5 — whether Forge's phase-pacing sleep is OFF for this seat, which is
         * true from an End Turn click until the yield it started is over, and never else.
         *
         * <p>{@code PlayerControllerHuman.chooseSpellAbilityToPlay} sleeps
         * {@code FControlGamePlayback.phasesDelay} (about 205 ms) at every phase an
         * auto-passing player is "not set up to skip", unless {@code YIELD_SKIP_PHASE_DELAY}
         * is true ({@code PlayerControllerHuman.java:1685-1691}). The only auto-pass this
         * bridge ever starts is End Turn ({@code InputPassPriority.onCancel} →
         * {@code autoPassUntilEndOfTurn}); every other pass is a click our own server makes
         * on a live prompt and sleeps in nobody's code. So the sleep only ever shows after
         * an End Turn, and the operator's ruling — *"only when 'end turn' is clicked"* —
         * is exactly "off while the yield runs, back on after".
         *
         * <p>The preference lives in the SERVER's {@code YieldController} (each match is its
         * own JVM, and each seat has its own controller). It used to reach there as a
         * {@code SetYieldPref} envelope sent over this seat's network channel, on the
         * belief that one channel meant Forge would apply it before reading the click
         * (ledger Y26 — wrong, see {@link #setPhaseDelayOff}: both are void protocol
         * methods, and the server races them). {@link #setPhaseDelayOff} now writes the
         * override directly into the live {@code YieldController} the game thread itself
         * reads, synchronously on this call, before the click is even sent.
         */
        private volatile boolean phaseDelayOff;
        /** Button 2 as Forge last labelled it, to know that a cancel click IS an End Turn. */
        private volatile String lastLabel2 = "";
        private volatile boolean lastEnable2;
        /** Forge's own label of the End Turn button ({@code InputPassPriority}, {@code lblEndTurn}). */
        private static final String END_TURN_LABEL = "End Turn";

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
            final JsonObject source = askSource();
            if (source != null) { frame.add("source", source); }
            pending.put(callId, ask);
            broadcastIfWaiting();
            return ask;
        }

        /**
         * The card this ask is raised on behalf of, with Forge's own text for the effect —
         * {@code {card, text}} on every ask ({@code refs.ts}'s {@code AskSourceSchema}), or null.
         *
         * <p>Forge's GUI calls drop the ability: {@code PlayerControllerHuman.chooseSomeType(kind, sa, …)}
         * asks {@code getGui().one(message, types)} with no {@code sa}, so a Cavern of Souls'
         * creature type arrives as a bare list. What the game is doing while the ask is open says
         * whose it is, read the way the rest of this bridge reads the live game: its thread is parked
         * on this ask, so nothing here moves under the read.
         * <ol>
         * <li>a replacement effect running ({@code ReplacementHandler.hasRun}, set around
         *     {@code executeReplacement}): an "As … enters" choice, asked while the card is still in
         *     the zone it is leaving. Its text is the effect's own description.</li>
         * <li>the stack item resolving ({@code MagicStack.isResolving}; the item stays on top until it
         *     has resolved): its stack description ({@link #stackText}).</li>
         * </ol>
         * A replacement wins: it is the innermost thing happening (a spell resolving puts a Cavern
         * onto the battlefield; the question is Cavern's). Null when neither applies, or when this
         * seat may not see the card.
         */
        private JsonObject askSource() {
            final Game game = liveGame();
            final forge.game.player.Player mine = liveSelf(game);
            if (mine == null) { return null; }
            forge.game.card.Card card = null;
            String text = null;
            try {
                @SuppressWarnings("unchecked")
                final Set<forge.game.replacement.ReplacementEffect> running = new java.util.HashSet<>(
                        (Set<forge.game.replacement.ReplacementEffect>) field(game.getReplacementHandler(), forge.game.replacement.ReplacementHandler.class, "hasRun"));
                for (final forge.game.replacement.ReplacementEffect re : running) {
                    if (re.getHostCard() == null) { continue; }
                    card = re.getHostCard();
                    text = re.getDescription();
                    if (card.getController() == mine) { break; }
                }
            } catch (final ReflectiveOperationException | RuntimeException e) {
                System.err.println("[bridge] askSource: could not read the running replacements (" + e + ")");
            }
            if (card == null && game.getStack().isResolving() && !game.getStack().isEmpty()) {
                final SpellAbilityStackInstance top = game.getStack().peek();
                card = top.getSourceCard();
                text = stackText(top);
            }
            if (card == null || card.isFaceDown() || !card.getView().canBeShownTo(mine.getView())) { return null; }
            final JsonObject o = new JsonObject();
            o.add("card", ref("card", card.getId()));
            o.addProperty("text", str(text));
            return o;
        }

        /**
         * Send the ask and park this thread until the browser answers. Returns
         * {@link #ABORTED} if it never will. Forge's own reply wait is untimed
         * ({@code ReplyPool.java:29-37}); the timeout lives on the Node side and
         * arrives here as an {@code abort}.
         */
        JsonElement await(final PendingAsk ask, final JsonObject frame) {
            ask.frame = frame;
            // An ask can be the very next thing after an input that cleared the flag (the
            // mulligan's bottom pick, then the order of the cards it bottoms): the client reads
            // the flag to decide what it is choosing, so it must be current before the ask lands.
            syncMulliganFlag();
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

        /**
         * Send every ask this seat is still parked on again, each with its original callId,
         * then a {@code resent} line naming them. The server asks for this when an act it sent
         * got nothing at all back: an ask frame lost on the way leaves Forge waiting on a
         * question nobody was shown. The server drops a callId it already has.
         */
        void resendPending() {
            final JsonArray callIds = new JsonArray();
            for (final PendingAsk ask : pending.values()) {
                final JsonObject f = ask.frame;
                if (f == null) { continue; }
                frame(f);
                callIds.add(ask.callId);
            }
            final JsonObject o = line("resent");
            o.addProperty("seat", seat);
            o.add("callIds", callIds);
            emit(o);
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
            // Wave 33 §S item 4 — before anything else: see `maybeEmitGameOverFirst`'s doc.
            maybeEmitGameOverFirst();
            super.setGameView(gameView, sequenceNumber);
            final GameView view = getGameView();
            if (view == null) { return; }
            // A fresh DeltaSyncManager's first walk puts every object in newObjects,
            // flattened by the same toNetworkValue the delta stream uses — so the full
            // state and a delta share one encoding, which is what tier-c.ts assumes.
            final DeltaPacket full = new DeltaSyncManager().collectDeltas(view);
            // Seed what this seat has been told, if the opening walk happens to carry
            // it — it never will in practice (Mulligan is not yet true when a match
            // opens), but this is the one other place `applyDelta` carries state, and
            // `syncMulliganFlag` is keyed on knowing what was ALREADY said.
            final Boolean seeded = mulliganIn(full.getNewObjects());
            if (seeded != null) { lastToldMulligan = seeded; }
            final JsonObject f = notify("setGameView");
            final JsonObject payload = new JsonObject();
            payload.add("gameView", objectTable(full.getNewObjects()));
            payload.addProperty("sequenceNumber", sequenceNumber);
            addStackFacts(payload);
            effectsSince(payload, false);
            sendState(f, payload, full);
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
            // Wave 33 §S item 4 — before anything else: see `maybeEmitGameOverFirst`'s doc.
            maybeEmitGameOverFirst();
            // A REAL packet that happens to carry Mulligan (every normal input syncs
            // fine; only InputLondonMulligan's two no-sync calls do not, see
            // `syncMulliganFlag`) is what this seat was just told — record it so a
            // later `syncMulliganFlag` call does not send a redundant correction for
            // a value the wire already carried.
            if (packet != null) {
                Boolean told = mulliganIn(packet.getObjectDeltas());
                if (told == null) { told = mulliganIn(packet.getNewObjects()); }
                if (told != null) { lastToldMulligan = told; }
            }
            if (packet != null && (!packet.getNewObjects().isEmpty() || !packet.getObjectDeltas().isEmpty())) {
                final JsonObject f = notify("applyDelta");
                final JsonObject payload = new JsonObject();
                payload.add("packet", packetJson(packet));
                addStackFacts(payload);
                effectsSince(payload, true);
                sendState(f, payload, packet);
            }
            super.applyDelta(packet);
            // And also here: an ordinary applyDelta is every bit as good a moment as a
            // prompt or a button to notice the live flag moved without the wire saying
            // so — the operator's report was that a stale hand stayed clickable-less
            // through several of exactly these.
            syncMulliganFlag();
        }

        /**
         * This seat's Game object's {@code Mulligan} property, read directly off the
         * SERVER'S live {@code Game} — not off anything this class receives over the
         * wire. Wave 30 §B.
         *
         * <h4>Why this exists: Forge's own protocol never syncs it here</h4>
         *
         * {@code InputLondonMulligan.showMessage()} sets it correctly
         * (forge-game's {@code GameView.updateIsMulligan}, called from
         * {@code InputLondonMulligan.java:60} and cleared at {@code :105}) and then
         * makes exactly two {@code IGuiGame} calls — {@code updateButtons} and
         * {@code showMessage(String)}, which always passes {@code card = null}
         * ({@code InputBase.java:120-121}). Forge's server-side proxy,
         * {@code RemoteClientGuiGame}, only walks the trackable graph
         * ({@code syncAndSend}, which is what puts a property on a
         * {@code DeltaPacket}) for {@code showPromptMessage} when {@code card != null}
         * — its own comment says why: {@code card == null} is also the auto-pass
         * timer's path, which fires while the game thread is live, and walking the
         * graph there would race it ({@code RemoteClientGuiGame.java:330-337}).
         * {@code updateButtons} never syncs at all ({@code :346-348}). So the property
         * Forge just set is correct on the server and never reaches a
         * {@code DeltaPacket} for the life of this input — confirmed empirically, not
         * just read: {@code mulligan.jvm.test.ts} measured zero further wire frames
         * for 3 s after reaching the London step. Full citations and the raw dump are
         * in {@code docs/planning/wave30-evidence/B-item1-mulligan-root-cause.md}.
         *
         * <h4>Why a direct read is safe here, once — not a graph walk</h4>
         *
         * This is called from {@link #showPromptMessage} and {@link #updateButtons},
         * both invoked on THIS seat's own client channel thread in response to a
         * network message Forge's game thread sent as the very last synchronous act of
         * {@code InputSyncronizedBase.showAndWait()} before it parks on
         * {@code awaitLatchRelease()} — {@code InputQueue.setInput} →
         * {@code updateObservers} → {@code showMessageInitial} → {@code showMessage},
         * all synchronous, all ahead of the latch. By the time this runs, the thread
         * that wrote the property is blocked on the input, not mutating the game. This
         * is ONE property read ({@code TrackableObject.get}, a map lookup), not the
         * graph walk {@code RemoteClientGuiGame} itself avoids racing — a fundamentally
         * cheaper and narrower operation. It is also called from {@link #applyDelta},
         * where the same reasoning does not strictly apply (a real delta can arrive
         * between unrelated game-thread activity) but the read is still just as safe:
         * a boolean field, not a graph. The one theoretical window — this seat's
         * network thread outracing the game thread's own synchronous write — is caught
         * by the very next call of any of these three, every one of which fires again
         * before a browser could possibly need the value (every card click during this
         * input re-invokes {@code showMessage()}).
         */
        private Boolean liveMulliganFlag() {
            final ServerGameLobby lobby = LOBBY;
            if (lobby == null) { return null; }
            final HostedMatch hosted = lobby.getHostedMatch();
            if (hosted == null || hosted.getGame() == null) { return null; }
            final GameView live = hosted.getGame().getView();
            return live == null ? null : live.isMulligan();
        }

        /**
         * Compare the server's live {@link #liveMulliganFlag()} against
         * {@link #lastToldMulligan} and, on a real change, emit a synthetic
         * {@code applyDelta} carrying ONLY that property — in exactly the encoding
         * {@link #packetJson} already produces for a real one, so nothing downstream
         * (this lane's {@code visibility.ts}, or a client's fold) can tell it from one
         * Forge sent. Emits in BOTH directions: the true→false transition
         * ({@code InputLondonMulligan.done()}, after the step is answered) is just as
         * unsynced as true→false's opposite, for the same reason — without this, a
         * seat that once saw {@code Mulligan: true} would fold it forever.
         */
        private void syncMulliganFlag() {
            final Boolean live = liveMulliganFlag();
            if (live == null) { return; }
            final Boolean last = lastToldMulligan;
            if (last != null && last.booleanValue() == live.booleanValue()) { return; }
            emitSyntheticMulliganDelta(live);
        }

        /**
         * Build and send the one-property synthetic delta {@link #syncMulliganFlag}
         * decided is needed, and apply it to this client's own local mirror exactly as
         * a real one would be ({@code super.applyDelta}, not {@code this.applyDelta} —
         * calling back through the override would re-run {@link #syncMulliganFlag}
         * pointlessly, since {@link #lastToldMulligan} is set here directly instead).
         */
        private void emitSyntheticMulliganDelta(final boolean value) {
            final GameView localView = getGameView();
            // No local Game object yet (before the first setGameView/openView) — there
            // is nothing to key the delta off and nothing downstream to receive it.
            if (localView == null) { return; }
            final Map<TrackableProperty, Object> props = new HashMap<>();
            props.put(TrackableProperty.Mulligan, value);
            final Map<Integer, Map<TrackableProperty, Object>> objectDeltas = new HashMap<>();
            objectDeltas.put(DeltaPacket.makeDeltaKey(DeltaPacket.TYPE_GAME_VIEW, localView.getId()), props);
            final DeltaPacket synthetic = new DeltaPacket(-1L, objectDeltas, null, 0, null);
            final JsonObject f = notify("applyDelta");
            final JsonObject payload = new JsonObject();
            payload.add("packet", packetJson(synthetic));
            addStackFacts(payload);
            sendState(f, payload, synthetic);
            super.applyDelta(synthetic);
            lastToldMulligan = value;
        }

        /** The Game object's {@code Mulligan} property in a raw (pre-JSON) delta map, if present. */
        static Boolean mulliganIn(final Map<Integer, Map<TrackableProperty, Object>> objects) {
            for (final Map.Entry<Integer, Map<TrackableProperty, Object>> e : objects.entrySet()) {
                if (DeltaPacket.getTypeFromDeltaKey(e.getKey()) != DeltaPacket.TYPE_GAME_VIEW) { continue; }
                final Object v = e.getValue().get(TrackableProperty.Mulligan);
                if (v instanceof Boolean b) { return b; }
            }
            return null;
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
        @Override public void finishGame() {
            // The `gameover` line goes first, so the server has told every seat before this arrives.
            maybeEmitGameOverFirst();
            frame(notify("finishGame"));
        }
        @Override public void clearSelectables() { frame(notify("clearSelectables")); }

        @Override public void showPromptMessage(final PlayerView playerView, final String message, final CardView card) {
            // See `syncMulliganFlag`: this is one of the two calls
            // `InputLondonMulligan.showMessage()` makes that Forge's OWN
            // `RemoteClientGuiGame` never syncs the trackable graph for.
            syncMulliganFlag();
            if (playerView == null) { return; }
            // A priority window the SEAT is shown is a real input: no yield is running, so
            // an End Turn's pacing exemption is over (it is only ever armed by the click).
            if (phaseDelayOff && message != null && message.startsWith("Priority:")) { setPhaseDelayOff(false); }
            final JsonObject f = notify("showPromptMessage");
            f.add("player", ref("player", playerView.getId()));
            f.addProperty("message", str(message));
            f.add("card", refOrNull(card));
            final JsonObject confirm = confirmAbility();
            if (confirm != null) { f.add("confirmAbility", confirm); }
            final JsonObject target = targetAbility();
            if (target != null) { f.add("targetAbility", target); }
            frame(f);
            broadcastIfWaiting();
            // A press of a payment's life button re-shows its prompt and changes nothing else, and
            // a cancelled payment may move nothing either: every seat hears it from here.
            for (final SeatGui g : SEATS.values()) { g.tellLifePaying(); }
        }

        /**
         * The trigger or spell copy an open target selection is for, or null for any other prompt.
         *
         * {@code abilityId} is the targeted ability itself, unwrapped from its trigger: the
         * same {@code SpellAbility} an effect later hands {@code confirmAction} on resolution
         * ({@code DamageDealEffect.java:180-184}'s "Do you want to deal ..."), so the server can
         * tell a confirm for a target this seat already chose. {@code trigger} names the group
         * the question belongs to — the trigger of its card ({@link #triggerKey}), shared by
         * identical instances, or the spell a copy was made of ({@link #copyKey}), shared by
         * every copy one effect makes — {@code more} counts the questions of that group still to
         * come behind this one, and {@code players} the players this selection accepts.
         */
        private JsonObject targetAbility() {
            final Game game = liveGame();
            final forge.game.player.Player mine = liveSelf(game);
            if (mine == null || !(mine.getController() instanceof PlayerControllerHuman human)) { return null; }
            try {
                final SpellAbility sa = targetedAbility(human);
                if (sa == null || sa.getHostCard() == null) { return null; }
                final SpellAbility root = sa.getRootAbility();
                final String key;
                int more = 0;
                if (root.isTrigger() && root.getTrigger() != null) {
                    key = triggerKey(root);
                    for (final WrappedAbility w : pendingTriggers(game)) {
                        if (w.getWrappedAbility() != root && triggerKey(w).equals(key)) { more += 1; }
                    }
                } else if (root.isCopied() && root.getHostCard().isCopiedSpell() && root.getHostCard().getCopiedPermanent() != null) {
                    final forge.game.card.Card original = root.getHostCard().getCopiedPermanent();
                    key = copyKey(original);
                    more = copiesStillToTarget(game, original);
                } else {
                    return null;
                }
                final JsonObject o = new JsonObject();
                o.add("hostCard", ref("card", sa.getHostCard().getId()));
                o.addProperty("abilityId", sa.getId());
                o.addProperty("trigger", key);
                o.addProperty("more", more);
                // Read here, with this input live: the selection's own `players` is read while
                // `InputSelectTargets`'s constructor runs (`:68`), before it is the open input.
                final JsonArray players = legalPlayers();
                if (players != null) { o.add("players", players); }
                return o;
            } catch (final ReflectiveOperationException | RuntimeException e) {
                System.err.println("[bridge] targetAbility: could not read the open selection (" + e + ")");
                return null;
            }
        }

        /**
         * Wave 52 §S (B) — the ability a Yes/No confirm belongs to, or null.
         *
         * Forge asks a cost confirm ("sacrifice Augur of Skulls?") through
         * {@code HumanCostDecision} → {@code PlayerControllerHuman.confirmPayment} →
         * {@code InputConfirm.confirm(controller, sa, question)}, and an optional
         * trigger through {@code confirmTrigger} → the same {@code InputConfirm} with the
         * trigger's wrapper. Both reach this method with {@code card == null}, so the
         * prose is all the wire carried and the two could not be told apart. The input
         * itself still holds the {@code SpellAbility} ({@code InputConfirm.sa}), and the
         * game thread is parked on it while its prompt is shown, so it is read here the
         * way {@link #legalPlayers} reads its input. The server answers Yes only when
         * the seat chose this same ability from {@code getAbilityToPlay} just before
         * ({@code auto.ts}'s {@code chosenCostConfirm}); every other confirm still asks.
         *
         * <p>An optional trigger's confirm also names the trigger ({@code trigger}): its
         * {@code InputConfirm.sa} is the {@code WrappedAbility} {@code confirmTrigger} was
         * handed ({@code PlayerControllerHuman.java:787-828}), and {@code key} is the
         * storage key Forge's own default auto-decision mode keeps an answer under — per
         * ability ({@code UI_AUTO_DECISION_MODE} = {@code AUTO_DECISION_PER_ABILITY},
         * {@code ForgePreferences.java:147}), so {@code AutoYieldStore.abilitySuffix} of the
         * wrapper's {@code yieldKey()}. {@link #act} stores a decision under it.
         *
         * <p>An optional search's "Search your hand?" also names the search ({@code search},
         * {@link #optionalSearch}), so the server can answer the one a No gains nothing on.
         */
        private JsonObject confirmAbility() {
            final forge.game.player.Player mine = liveSelf(liveGame());
            if (mine == null || !(mine.getController() instanceof PlayerControllerHuman human)) { return null; }
            final Object input = human.getInputQueue().getInput();
            if (!(input instanceof forge.gamemodes.match.input.InputConfirm)) { return null; }
            try {
                final var sa = (SpellAbility) field(input, forge.gamemodes.match.input.InputConfirm.class, "sa");
                if (sa == null || sa.getHostCard() == null) { return null; }
                final JsonObject o = new JsonObject();
                o.add("hostCard", ref("card", sa.getHostCard().getId()));
                o.addProperty("abilityId", sa.getId());
                if (sa instanceof WrappedAbility w && w.getTrigger() != null) {
                    final JsonObject trigger = new JsonObject();
                    trigger.addProperty("key", AutoYieldStore.abilitySuffix(w.yieldKey()));
                    trigger.addProperty("name", w.getTrigger().getHostCard().getName());
                    trigger.addProperty("abilityId", w.getWrappedAbility().getId());
                    o.add("trigger", trigger);
                }
                final JsonObject search = optionalSearch(sa, (String) field(input, forge.gamemodes.match.input.InputConfirm.class, "message"), mine);
                if (search != null) { o.add("search", search); }
                return o;
            } catch (final ReflectiveOperationException | RuntimeException e) {
                System.err.println("[bridge] confirmAbility: could not read the open confirm (" + e + "); it stays a question");
                return null;
            }
        }

        /**
         * The search a Yes/No confirm asks permission for, or null when the confirm is anything else.
         *
         * A ChangeZone from a hidden zone with {@code Optional$} asks "Search {player's} {zones}?"
         * before its card choice ({@code ChangeZoneEffect.changeHiddenOriginResolve}, the
         * {@code ChangeZoneGeneral} confirm built from {@code lblSearchPlayerZoneConfirm}). Forge does
         * not hand the confirm mode to {@code InputConfirm}, so the question is recognised as that
         * one by rebuilding Forge's own sentence for this ability and each player, exactly as the
         * effect does, and comparing it with the open input's message: the same ability's later
         * "Cancel Search?" ({@code lblCancelSearchUpToSelectNumCards}) never matches. Abilities whose
         * question is worded otherwise ({@code OptionalPrompt}, {@code Defined},
         * {@code OriginAlternative}) are not reported.
         *
         * {@code player} is whose zones are searched; {@code mayChooseNothing} is whether the card
         * choice after a Yes lets the decider pick nothing ({@code !mandatory} there, and
         * {@code AtRandom} picks for them).
         */
        private JsonObject optionalSearch(final SpellAbility sa, final String message, final forge.game.player.Player decider) {
            if (message == null || sa.getApi() != forge.game.ability.ApiType.ChangeZone || !sa.isHidden()) { return null; }
            if (!sa.hasParam("Optional") || !sa.hasParam("Origin")) { return null; }
            for (final String worded : new String[] {"OptionalPrompt", "Defined", "ChooseFromDefined", "OriginAlternative"}) {
                if (sa.hasParam(worded)) { return null; }
            }
            final List<ZoneType> origin = ZoneType.listValueOf(sa.getParam("Origin"));
            final String prompt = forge.util.Localizer.getInstance().getMessage("lblSearchPlayerZoneConfirm", "{player's}",
                    forge.util.Lang.joinHomogenous(origin, ZoneType::getTranslatedName).toLowerCase());
            for (final forge.game.player.Player searched : decider.getGame().getPlayers()) {
                if (!forge.util.MessageUtil.formatMessage(prompt, decider, searched).equals(message)) { continue; }
                final JsonObject o = new JsonObject();
                final JsonArray zones = new JsonArray();
                for (final ZoneType z : origin) { zones.add(z.name()); }
                o.add("origin", zones);
                o.add("player", ref("player", searched.getId()));
                o.addProperty("mayChooseNothing", !sa.hasParam("Mandatory") && !sa.hasParam("AtRandom"));
                return o;
            }
            return null;
        }

        /** This seat's own live {@code Player}, or null when the game or the seat is not readable. */
        private forge.game.player.Player liveSelf(final Game game) {
            if (game == null) { return null; }
            final PlayerView me = getCurrentPlayer();
            if (me == null) { return null; }
            for (final forge.game.player.Player p : game.getPlayers()) {
                if (p.getId() == me.getId()) { return p; }
            }
            return null;
        }

        @Override public void updateButtons(final PlayerView owner, final String label1, final String label2,
                                            final boolean enable1, final boolean enable2, final boolean focus1) {
            // The other of the two — see `syncMulliganFlag`.
            syncMulliganFlag();
            if (owner == null) { return; }
            lastLabel2 = label2 == null ? "" : label2;
            lastEnable2 = enable2;
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
            final JsonArray players = legalPlayers();
            if (players != null) { f.add("players", players); }
            frame(f);
        }

        /**
         * The players this seat's open selection would accept, or null when that cannot be read.
         *
         * Forge publishes cards only ({@code IGuiGame.setSelectables}) and checks a player only
         * once it is clicked. For a target selection this runs the same checks as
         * {@code InputSelectTargets.onPlayerSelected} ({@code :334-362}) for every player, against
         * the input that is live right now: the game thread is parked on it, so its spell and
         * filter are stable for the read. A choose-from-list selection offers the players in its
         * {@code validChoices}. Any other input, or any reflection failure, is null, and the
         * browser then keeps offering every player.
         */
        private JsonArray legalPlayers() {
            final Game game = liveGame();
            final forge.game.player.Player mine = liveSelf(game);
            if (mine == null || !(mine.getController() instanceof PlayerControllerHuman human)) { return null; }
            final Object input = human.getInputQueue().getInput();
            try {
                final JsonArray out = new JsonArray();
                if (input instanceof forge.gamemodes.match.input.InputSelectTargets) {
                    final var sa = (forge.game.spellability.SpellAbility) field(input, forge.gamemodes.match.input.InputSelectTargets.class, "sa");
                    final boolean mustTargetFiltered = (Boolean) field(input, forge.gamemodes.match.input.InputSelectTargets.class, "mustTargetFiltered");
                    @SuppressWarnings("unchecked")
                    final var filter = (java.util.function.Predicate<forge.game.GameObject>) field(input, forge.gamemodes.match.input.InputSelectTargets.class, "filter");
                    for (final forge.game.player.Player p : game.getPlayers()) {
                        if (p.hasLost() || mustTargetFiltered) { continue; }
                        if (sa.isSpell() && sa.getHostCard().isAura() && !p.canBeAttached(sa.getHostCard(), sa)) { continue; }
                        if (!sa.canTarget(p)) { continue; }
                        if (filter != null && !filter.test(p)) { continue; }
                        out.add(ref("player", p.getId()));
                    }
                    return out;
                }
                if (input instanceof forge.gamemodes.match.input.InputSelectEntitiesFromList) {
                    final var valid = (Iterable<?>) field(input, forge.gamemodes.match.input.InputSelectEntitiesFromList.class, "validChoices");
                    for (final Object choice : valid) {
                        if (choice instanceof forge.game.player.Player p) { out.add(ref("player", p.getId())); }
                    }
                    return out;
                }
            } catch (final ReflectiveOperationException | RuntimeException e) {
                System.err.println("[bridge] legalPlayers: could not read the open input (" + e + "); every player stays offered");
            }
            return null;
        }

        private static Object field(final Object owner, final Class<?> declaring, final String name) throws ReflectiveOperationException {
            final java.lang.reflect.Field f = declaring.getDeclaredField(name);
            f.setAccessible(true);
            return f.get(owner);
        }

        /**
         * The entities the CURRENT input has marked — the third and last thing
         * Forge says per-entity, and until Wave 22 the one this bridge dropped.
         *
         * {@code setSelectables} comes from the two selection inputs and
         * {@code setWeaklySelectable} from priority and payment. An input that
         * is neither speaks only through this method, and
         * {@code InputLondonMulligan} is exactly that one
         * ({@code InputLondonMulligan.java:138,144}): without this frame the
         * seat got the prose and the OK/Auto bar and no entity at all, which is
         * the bug the operator reported as "the cards were not clickable — had
         * to press Auto".
         *
         * <p>Unlike the other two this is INCREMENTAL and signed: {@code true}
         * marks, {@code false} unmarks, one call per change against a set the
         * GUI keeps ({@code AbstractGuiGame.java:322-337}). The boolean is on
         * the wire and the client folds; replacing a set here would lose the
         * un-highlight at {@code InputLondonMulligan.java:144}.
         *
         * <p>{@code super} is called for the same reason as
         * {@code setWeaklySelectable}: this seat's own tracker then answers
         * {@code isHighlighted} as the stock client's would. It costs nothing —
         * the two things {@code AbstractGuiGame.setHighlighted} calls back into
         * are {@code updateCards} (a no-op default,
         * {@code AbstractGuiGame.java:946}) and {@code updateLives} (a no-op
         * here, {@code :1147}).
         *
         * <p>The argument is {@code Iterable<GameEntityView>}, not
         * {@code Iterable<CardView>} (IGuiGame.java:265) — a player travels
         * through it too ({@code InputSelectTargets.java:409}) — so
         * {@link #refs} is what encodes it, and it emits {@code card} and
         * {@code player} refs as they arrive.
         */
        @Override public void setHighlighted(final Iterable<GameEntityView> entities, final boolean on) {
            super.setHighlighted(entities == null ? List.of() : entities, on);
            final JsonObject f = notify("setHighlighted");
            f.add("entities", refs(entities));
            f.addProperty("on", on);
            frame(f);
        }

        /**
         * Forge's answer to "what is worth clicking RIGHT NOW", at priority and
         * during payment — see `packages/forge-wire/src/tier-b.ts`.
         *
         * {@code setSelectables} is sent only by the two selection inputs, so
         * without this pair a client has nothing to go on at priority and has to
         * invent an affordance. {@code super} is called so this seat's own
         * tracker answers {@code isWeaklySelectable} as the stock client's would;
         * the browser gets the list.
         *
         * Forge sends the iterable WEIGHTED (a card twice when the auto-tap
         * preview also names it); {@link #refs} keeps it as sent.
         */
        @Override public void setWeaklySelectable(final Iterable<CardView> cards) {
            super.setWeaklySelectable(cards == null ? List.of() : cards);
            final JsonObject f = notify("setWeaklySelectable");
            f.add("cards", refs(cards));
            offerFacts(f, cards);
            castForbidden(f);
            heldChanges(f);
            frame(f);
        }

        /**
         * {@code castForbidden}: the cards this seat holds that an effect forbids it to cast — a
         * {@code CantBeCast} static (Reflector Mage's effect, Silence's, Meddling Mage's), asked the
         * way {@code StaticAbilityCantBeCast.cantBeCastAbility} asks it when a cast begins and the
         * fork's {@code AvailableActions.passesRestrictions} asks it for the highlight: of the spell
         * as it would stand on the stack. Not mana, not timing — a card is named only when a static
         * says no. Each entry names the static's source (the card that made an effect, not the
         * effect) and, for an effect, Forge's own {@code Duration} and the player it is counted from.
         *
         * Read with the game thread parked on the input that pushed the set, as {@link #offerFacts}
         * reads. A failure omits the field, which the browser reads as "unchanged".
         */
        private void castForbidden(final JsonObject f) {
            final Game game = liveGame();
            final forge.game.player.Player mine = liveSelf(game);
            if (mine == null) { return; }
            try {
                final List<forge.game.staticability.StaticAbility> statics = new ArrayList<>();
                for (final forge.game.card.Card c : game.getCardsIn(ZoneType.STATIC_ABILITIES_SOURCE_ZONES)) {
                    for (final forge.game.staticability.StaticAbility st : c.getStaticAbilities()) {
                        if (st.checkConditions(forge.game.staticability.StaticAbilityMode.CantBeCast)) { statics.add(st); }
                    }
                }
                final JsonArray out = new JsonArray();
                final java.util.Set<Integer> seen = new java.util.HashSet<>();
                final List<forge.game.card.Card> held = new ArrayList<>(mine.getCardsIn(ZoneType.Hand));
                held.addAll(mine.getCardsIn(ZoneType.Flashback));
                for (final forge.game.card.Card c : held) {
                    if (!seen.add(c.getId())) { continue; }
                    final forge.game.staticability.StaticAbility by = forbiddenBy(c, mine, statics);
                    if (by == null) { continue; }
                    final forge.game.card.Card host = by.getHostCard();
                    final JsonObject o = new JsonObject();
                    o.add("card", ref("card", c.getId()));
                    o.addProperty("source", sourceName(by));
                    if (host.isImmutable()) {
                        final SpellAbility made = host.getEffectSourceAbility();
                        final String duration = made == null ? null : made.getParamOrDefault("Duration", "EndOfTurn");
                        if (duration != null && !"Permanent".equals(duration)) {
                            o.addProperty("duration", duration);
                            o.add("durationPlayer", ref("player", host.getController().getId()));
                        }
                    }
                    out.add(o);
                }
                f.add("castForbidden", out);
            } catch (final RuntimeException e) {
                System.err.println("[bridge] castForbidden: could not read the cast restrictions (" + e + "); the hand keeps its last marks");
            }
        }

        /** The {@code CantBeCast} static that forbids every spell of {@code c} to {@code mine}, or null. */
        private static forge.game.staticability.StaticAbility forbiddenBy(final forge.game.card.Card c, final forge.game.player.Player mine,
                                                                          final List<forge.game.staticability.StaticAbility> statics) {
            forge.game.staticability.StaticAbility first = null;
            boolean any = false;
            for (final SpellAbility sa : c.getSpells()) {
                any = true;
                sa.setActivatingPlayer(mine);
                final forge.game.card.Card onStack = forge.game.card.CardCopyService.getLKICopy(c);
                onStack.setLKICMC(-1);
                onStack.setLastKnownZone(mine.getGame().getStackZone());
                onStack.setCastFrom(c.getZone());
                onStack.setCastSA(sa);
                final List<forge.game.staticability.StaticAbility> mineToo = new ArrayList<>(statics);
                for (final forge.game.staticability.StaticAbility st : onStack.getStaticAbilities()) {
                    if (st.checkConditions(forge.game.staticability.StaticAbilityMode.CantBeCast)) { mineToo.add(st); }
                }
                forge.game.staticability.StaticAbility by = null;
                for (final forge.game.staticability.StaticAbility st : mineToo) {
                    if (forge.game.staticability.StaticAbilityCantBeCast.applyCantBeCastAbility(st, sa, onStack, mine)) { by = st; break; }
                }
                if (by == null) { return null; }
                if (first == null) { first = by; }
            }
            return any ? first : null;
        }

        /** The card a static belongs to as its player knows it: an effect's source card (Reflector Mage's effect is Reflector Mage's), else the static's own card. */
        private static String sourceName(final forge.game.staticability.StaticAbility st) {
            final forge.game.card.Card host = st.getHostCard();
            return (host.isImmutable() && host.getEffectSource() != null ? host.getEffectSource() : host).getName();
        }

        /**
         * {@code heldChanges}: what continuous effects change about the cards this seat holds — the
         * cost of each held spell as Forge would charge it now ({@code RaiseCost}, {@code ReduceCost}
         * and {@code SetCost} statics: Thalia, Jace's Sanctum, Trinisphere, a card's own affinity), and
         * a flash a {@code CastWithFlash} static grants a card that has none (Vedalken Orrery). Each
         * entry names the cards whose statics did it. A card nothing changes is not listed; the list is
         * the whole hand's, so a cost that went back to printed drops out.
         *
         * The cost is {@code CostAdjustment}'s own arithmetic, step by step in its order (raises on the
         * {@code Cost}, then reductions, then pips, then set costs), called per static so each source is
         * known. Those steps are private, hence reflection; what is left out is what asks the player
         * while paying — delve, convoke, improvise, assist, and an "up to" reduction — which change a
         * cast, not the card.
         *
         * Read with the game thread parked on the input that pushed the set, as {@link #castForbidden}
         * reads, and sent only on this seat's own channel: a hand is never on another seat's wire.
         * A failure omits the field, which the browser reads as "unchanged".
         */
        private void heldChanges(final JsonObject f) {
            final Game game = liveGame();
            final forge.game.player.Player mine = liveSelf(game);
            if (mine == null) { return; }
            try {
                final CostSteps steps = CostSteps.get();
                final List<forge.game.card.Card> around = new ArrayList<>(game.getCardsIn(ZoneType.Battlefield));
                around.addAll(game.getCardsIn(ZoneType.Stack));
                around.addAll(game.getCardsIn(ZoneType.Command));
                final List<forge.game.staticability.StaticAbility> flash = new ArrayList<>();
                for (final forge.game.card.Card c : game.getCardsIn(ZoneType.STATIC_ABILITIES_SOURCE_ZONES)) {
                    for (final forge.game.staticability.StaticAbility st : c.getStaticAbilities()) {
                        if (st.checkConditions(forge.game.staticability.StaticAbilityMode.CastWithFlash)) { flash.add(st); }
                    }
                }
                final JsonArray out = new JsonArray();
                for (final forge.game.card.Card c : mine.getCardsIn(ZoneType.Hand)) {
                    final SpellAbility sa = c.getFirstSpellAbility();
                    if (sa == null || !sa.isSpell() || sa.getPayCosts() == null) { continue; }
                    sa.setActivatingPlayer(mine);
                    final JsonObject o = new JsonObject();
                    final java.util.LinkedHashSet<String> by = new java.util.LinkedHashSet<>();
                    final ManaCost printed = new forge.game.mana.ManaCostBeingPaid(sa.getPayCosts().getTotalMana()).toManaCost();
                    final ManaCost now = steps.cost(sa, around, by);
                    if (!ManaCost.serialize(now).equals(ManaCost.serialize(printed))) {
                        o.addProperty("cost", ManaCost.serialize(now));
                        o.addProperty("printed", ManaCost.serialize(printed));
                        final JsonArray sources = new JsonArray();
                        by.forEach(sources::add);
                        o.add("costBy", sources);
                    }
                    if (!c.isInstant() && !c.hasKeyword(forge.game.keyword.Keyword.FLASH)) {
                        for (final forge.game.staticability.StaticAbility st : flash) {
                            if (forge.game.staticability.StaticAbilityCastWithFlash.applyWithFlashAbility(st, sa, c, mine)) {
                                o.addProperty("flashBy", sourceName(st));
                                break;
                            }
                        }
                    }
                    if (o.size() == 0) { continue; }
                    o.add("card", ref("card", c.getId()));
                    out.add(o);
                }
                f.add("heldChanges", out);
            } catch (final ReflectiveOperationException | RuntimeException e) {
                System.err.println("[bridge] heldChanges: could not read the held cards' costs (" + e + "); the hand keeps its last tags");
            }
        }

        /**
         * Wave 52 §S — two facts about the offered cards, read off Forge's own
         * abilities rather than card text, added to the frame as strict optional fields.
         *
         * <ul>
         * <li>{@code manaOnly}: the offered cards with no non-mana play the seat could make
         * now — a Forest, a dual, a Signet ({@code {1},{T}}), and a Celestial Colonnade whose
         * {3}{W}{U} the seat cannot pay. The server's "nothing left to do, pass" reads this and
         * nothing else: tapping for mana is never by itself a reason to hold priority, but a
         * land with a non-mana ability the seat can take (Ghost Quarter, a fetchland, a
         * man-land it can pay for) is not in it, so it holds the window the way an instant in
         * hand does.</li>
         * <li>{@code phaseRestricted}: the offered permanents this seat controls that are a
         * play and have a playable non-mana ability whose {@code ActivationPhases}
         * restriction ({@code SpellAbilityRestriction}, {@code SpellAbilityVariables.getPhases})
         * is met now — Augur of Skulls in its controller's upkeep. Battlefield only, never the
         * hand: the card and its text are on the table for everyone.</li>
         * <li>{@code attackers}: how many creatures attack in the game's current combat, 0
         * outside one — whether a combat step is one anybody attacked in. Read off the live
         * game in the same window, so it never trails the prompt the way a state delta can.</li>
         * </ul>
         *
         * "A play" is the fork's {@code AvailableActions.Scan#plays}, which the game thread
         * records in the same walk that built the offered set, by the test the highlight and a
         * click's ability list use (affordable, targetable, allowed). It is read here, never
         * recomputed: that test runs under a swapped AI controller, and swapping it from this
         * thread while the game thread runs let the AI act for the seat (an e2e match saw
         * Gideon Blackblade's +1 activated with no click). {@code getAllPossibleAbilities} alone
         * is no substitute: its {@code canPlay} never checks mana, so a Colonnade read as a play.
         *
         * Read on this seat's channel thread. No scan (an AI seat, a window with no full walk)
         * or a failure omits both fields, which the server reads as "no such card" — the stop
         * it always made.
         */
        private void offerFacts(final JsonObject f, final Iterable<CardView> cards) {
            final Game game = liveGame();
            final forge.game.player.Player mine = liveSelf(game);
            if (mine == null || cards == null) { return; }
            // The plays of the scan that pushed this set, made on the game thread. Absent (an AI
            // seat, no full scan) omits both fields, which keeps the stop.
            final java.util.Set<CardView> scanned = mine.getController() instanceof forge.player.PlayerControllerHuman human
                    ? human.getActionablePlays() : null;
            if (scanned == null) { return; }
            final java.util.Set<Integer> plays = new java.util.HashSet<>();
            for (final CardView p : scanned) { plays.add(p.getId()); }
            try {
                final JsonArray manaOnly = new JsonArray();
                final JsonArray phaseRestricted = new JsonArray();
                final java.util.Set<Integer> seen = new java.util.HashSet<>();
                for (final CardView cv : cards) {
                    if (cv == null || !seen.add(cv.getId())) { continue; }
                    final forge.game.card.Card c = game.findById(cv.getId());
                    if (c == null) { continue; }
                    // Offered with no play to make: for its mana, or for the undo of a mana tap.
                    // Never a reason to hold priority.
                    if (!plays.contains(cv.getId())) {
                        manaOnly.add(ref("card", cv.getId()));
                        continue;
                    }
                    if (!c.isInPlay() || c.getController() != mine) { continue; }
                    for (final SpellAbility sa : c.getAllPossibleAbilities(mine, true)) {
                        if (!sa.isManaAbility() && sa.getRestrictions() != null && !sa.getRestrictions().getPhases().isEmpty()) {
                            phaseRestricted.add(ref("card", cv.getId()));
                            break;
                        }
                    }
                }
                f.add("manaOnly", manaOnly);
                f.add("phaseRestricted", phaseRestricted);
                final forge.game.combat.Combat combat = game.getCombat();
                f.addProperty("attackers", combat == null ? 0 : combat.getAttackers().size());
            } catch (final RuntimeException e) {
                System.err.println("[bridge] offerFacts: could not read the offered abilities (" + e + "); the window keeps its stop");
            }
        }

        @Override public void clearWeaklySelectable() {
            super.clearWeaklySelectable();
            frame(notify("clearWeaklySelectable"));
        }

        /** Forge turned the seat's act away (a click whose every ability it would refuse): the browser marks it. */
        @Override public void flashIncorrectAction() {
            frame(notify("flashIncorrectAction"));
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
            final String number = numberAfterOther;
            numberAfterOther = null;
            if (number != null && isNumeric) { return number; }
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

        /**
         * The first of a modal spell's mode questions, as Forge counts them: how many
         * modes this seat picks in all and whose spell they are, or null for any other
         * list. {@link ModeCounts} recorded the count on the game thread just before
         * Forge asked; the spell's card is the abilities' own host.
         */
        private <T> JsonObject modesOf(final List<T> choices) {
            if (choices == null || choices.isEmpty() || !(choices.get(0) instanceof SpellAbilityView sa)) { return null; }
            final PlayerView me = getCurrentPlayer();
            final int[] count = me == null ? null : BridgeGui.ModeCounts.PENDING.remove(me.getId());
            if (count == null || sa.getHostCard() == null) { return null; }
            final JsonObject o = new JsonObject();
            o.addProperty("min", count[0]);
            o.addProperty("max", count[1]);
            o.add("card", ref("card", sa.getHostCard().getId()));
            return o;
        }

        @Override
        public <T> List<T> getChoices(final String message, final int min, final int max, final List<T> choices,
                                      final List<T> selected, final FSerializableFunction<T, String> display) {
            final Integer cutoff = numberCutoff(choices);
            if (cutoff != null) { return numberAsk(message, choices, cutoff); }
            // A short X Forge listed whole (an XMax at or under its cutoff) still carries its mark.
            final boolean numbers = choices != null && !choices.isEmpty() && choices.stream().allMatch(c -> c instanceof Integer);
            return choiceAsk(message, min, max, choices, selected, display, numbers ? affordableX(announcing()) : null);
        }

        /** The least an open number ask reaches past its minimum (the operator, 2026-10-15: X "should allow going up to 20"). */
        static final int OPEN_NUMBER_REACH = 20;
        /** The highest X {@link #affordableX} tries: Forge's own hundred ({@code AbstractGuiGame.getInteger}). */
        static final int MOST_NUMBERS = 100;

        /** The number a pick above Forge's own list answers the "Other…" entry's numeric follow-up with; null otherwise. */
        private volatile String numberAfterOther;

        /**
         * The last number Forge listed when {@code choices} is {@code AbstractGuiGame.getInteger}'s cut-off
         * list (an announced X, {@code NumTimes}, a keyword cost's count: the integers {@code min..cutoff},
         * then {@code lblOtherInteger}, behind which Forge asks for any higher number as free text); null for
         * any other list.
         */
        private static Integer numberCutoff(final List<?> choices) {
            if (choices == null || choices.size() < 2) { return null; }
            if (!forge.util.Localizer.getInstance().getMessage("lblOtherInteger").equals(choices.get(choices.size() - 1))) { return null; }
            for (int i = 0; i < choices.size() - 1; i++) {
                if (!(choices.get(i) instanceof Integer n) || (i > 0 && n != (Integer) choices.get(i - 1) + 1)) { return null; }
            }
            return (Integer) choices.get(choices.size() - 2);
        }

        /**
         * Forge's cut-off number list as one list of numbers, past its cutoff: the browser draws it as a
         * slider, which has no place for a free-text second step. A mana X reaches the most X this seat
         * can pay ({@link #affordableX}, sent as {@code affordable}), and every list at least
         * {@link #OPEN_NUMBER_REACH} past its minimum, up to the ability's own {@code XMax}. A number
         * Forge listed is answered as itself; one above it is answered through Forge's own "Other…"
         * path ({@link #showInputDialog} gives Forge the number), so Forge still checks it against
         * the true maximum, which only it knows.
         */
        @SuppressWarnings("unchecked")
        private <T> List<T> numberAsk(final String message, final List<T> choices, final int cutoff) {
            final int min = (Integer) choices.get(0);
            final SpellAbility sa = announcing();
            final Integer affordable = affordableX(sa);
            int top = Math.max(cutoff, Math.max(min + OPEN_NUMBER_REACH, affordable == null ? min : affordable));
            if (affordable != null) { top = Math.min(top, forge.game.ability.AbilityUtils.getAnnouncementBounds(sa, "X").getMaximum()); }
            final List<Integer> numbers = new ArrayList<>();
            for (int n = min; n <= top; n++) { numbers.add(n); }
            final List<Integer> picked = choiceAsk(message, 0, 1, numbers, null, null, affordable == null ? null : Math.min(affordable, top));
            if (picked == null) { return null; }
            if (picked.isEmpty()) { return new ArrayList<>(); }
            final int n = picked.get(0);
            if (n <= cutoff) { return new ArrayList<>(List.of(choices.get(n - min))); }
            numberAfterOther = String.valueOf(n);
            return new ArrayList<>(List.of(choices.get(choices.size() - 1)));
        }

        /** The ability whose number Forge is announcing for this seat right now ({@code PlayerControllerHuman.getAnnouncing}), or null. */
        private SpellAbility announcing() {
            final forge.game.player.Player mine = liveSelf(liveGame());
            if (mine == null || !(mine.getController() instanceof PlayerControllerHuman human)) { return null; }
            try {
                return (SpellAbility) PlayerControllerHuman.class.getMethod("getAnnouncing").invoke(human);
            } catch (final ReflectiveOperationException e) {
                System.err.println("[bridge] announcing: this Forge cannot name the ability being announced (" + e + "); the number ask goes without its mark");
                return null;
            }
        }

        /**
         * The most X this seat can pay for {@code sa}, or null when {@code sa} has no X in its mana cost.
         * Its mana cost is tried at each X the way the actionable highlight tries a play
         * ({@code AvailableActions.canAfford}: Forge's own payer, {@code ComputerUtilMana.canPayManaCost},
         * under an AI controller so nothing prompts), so the sources its other costs use (Kessig Wolf
         * Run's own tap) are left out. Forge's game thread is parked on this ask while it runs.
         */
        private Integer affordableX(final SpellAbility sa) {
            if (sa == null || sa.getPayCosts() == null) { return null; }
            final forge.game.cost.CostPartMana mana = sa.getPayCosts().getCostMana();
            if (mana == null || mana.getAmountOfX() == 0) { return null; }
            final forge.game.player.Player payer = sa.getActivatingPlayer();
            if (payer == null) { return null; }
            final int[] most = { 0 };
            payer.runWithController(() -> {
                for (int x = 1; x < MOST_NUMBERS && forge.ai.ComputerUtilMana.canPayManaCost(sa, payer, x, false); x++) { most[0] = x; }
            }, new forge.ai.PlayerControllerAi(payer.getGame(), payer, payer.getOriginalLobbyPlayer()));
            return most[0];
        }

        private <T> List<T> choiceAsk(final String message, final int min, final int max, final List<T> choices,
                                      final List<T> selected, final FSerializableFunction<T, String> display, final Integer affordable) {
            final JsonObject f = new JsonObject();
            final PendingAsk ask = open("getChoices", f);
            f.addProperty("message", str(message));
            f.addProperty("min", min);
            f.addProperty("max", max);
            if (affordable != null) { f.addProperty("affordable", affordable); }
            final boolean named = choices != null && !choices.isEmpty() && choices.get(0) instanceof CardFaceView;
            if (named) {
                // A card-name ask (`chooseSingleCardFace`): every face Forge's predicate let
                // through, tens of thousands of them. Each name is its own key, listed once.
                final JsonArray names = new JsonArray();
                for (final T item : choices) {
                    final String name = ((CardFaceView) item).getName();
                    if (ask.byKey.putIfAbsent(name, item) == null) { names.add(name); }
                }
                f.add("choices", new JsonArray());
                f.add("names", names);
            } else {
                f.add("choices", choices(ask, "c", choices, display));
                final JsonObject modes = modesOf(choices);
                if (modes != null) { f.add("modes", modes); }
            }
            final JsonArray sel = new JsonArray();
            if (selected != null && choices != null) {
                for (final T s : selected) {
                    final int i = choices.indexOf(s);
                    if (i >= 0) { sel.add(named ? ((CardFaceView) s).getName() : "c" + i); }
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
            final JsonObject destination = orderDestination(title, top);
            if (destination != null) { f.add("destination", destination); }
            final JsonElement r = await(ask, f);
            if (r == ABORTED) { return null; }
            final JsonObject o = r.getAsJsonObject();
            final List<T> ordered = byKeys(ask, o.get("ordered"));
            return new OrderResult<>(ordered, o.get("rememberDecision").getAsBoolean());
        }

        /**
         * Where an order's cards go ({@code OrderDestinationSchema}): the zone, its end, and which way
         * the answer's first card lies from the others once there. Null when the items are not cards
         * moving into a library or a graveyard.
         *
         * <p>Forge's caption does not say it. {@code PlayerControllerHuman.orderMoveToZoneList} labels a
         * library order "Closest to top" or "Closest to bottom" from {@code orderedMoveToTopOfLibrary},
         * which reads only {@code LibraryPosition}/{@code RevealedLibraryPosition} — Tezzeret's +1 (a
         * {@code Dig} whose rest go to {@code LibraryPosition2}, -1 by default) is labelled "Closest to
         * top" and goes to the bottom. What that caption does say is how Forge reads the answer: it
         * reverses it exactly when the caption is "Closest to top", then moves the cards one by one to
         * where the effect puts them. Each card moved goes next to the one before it, on the far side
         * from the rest of the zone, so the card moved FIRST ends next to the rest of the library: the
         * lowest of them on top, the highest of them at the bottom.
         *
         * <p>This seat is a network client: the question arrives here off the wire, while the server's
         * game thread that asked it is parked in {@code RemoteClientGuiGame}'s send-and-wait inside
         * the asking method of {@code PlayerControllerHuman}. That thread's stack says which question
         * this is ({@link #askingStack}); for a library order the end is read off the ability doing
         * the moving ({@link #libraryEndIsTop}).
         */
        private JsonObject orderDestination(final String title, final String top) {
            final forge.util.Localizer l = forge.util.Localizer.getInstance();
            final StackTraceElement[] frames = askingStack();
            String asker = null;
            for (final StackTraceElement frame : frames) {
                if (PlayerControllerHuman.class.getName().equals(frame.getClassName())) { asker = frame.getMethodName(); break; }
            }
            if (asker == null) {
                System.err.println("[bridge] orderDestination: no game thread parked in an order (" + title + " / " + top + ")");
                return null;
            }
            final boolean libraryTop = l.getMessage("lblTopOfLibrary").equals(top);
            switch (asker) {
                case "tuckCardsViaMulligan":
                    // Under the library one after another (LondonMulligan.keep: moveToLibrary(c, -1)).
                    return destination("library", false, true);
                case "arrangeForScry":
                    if (l.getMessage("lblCardsToPutOnTheBottom").equals(top)) { return destination("library", false, true); }
                    return libraryTop ? destination("library", true, true) : null;
                case "arrangeForSurveil":
                    if (l.getMessage("lblCardsToPutInTheGraveyard").equals(top)) { return destination("graveyard", true, false); }
                    return libraryTop ? destination("library", true, true) : null;
                case "orderMoveToZoneList":
                    if (l.getMessage("lblChooseOrderCardsPutIntoGraveyard").equals(title)) { return destination("graveyard", true, false); }
                    if (!l.getMessage("lblChooseOrderCardsPutIntoLibrary").equals(title)) { return null; }
                    final boolean reversed = l.getMessage("lblClosestToTop").equals(top);
                    final boolean onTop = libraryEndIsTop(frames, reversed);
                    // The first card moved is the answer's last when reversed: next to the library,
                    // so the lowest on top, the highest at the bottom.
                    return destination("library", onTop, reversed == onTop);
                default:
                    return null;
            }
        }

        /** The stack of the server thread parked in {@code RemoteClientGuiGame.order}, or empty. */
        private static StackTraceElement[] askingStack() {
            for (final StackTraceElement[] stack : Thread.getAllStackTraces().values()) {
                for (final StackTraceElement frame : stack) {
                    if (RemoteClientGuiGame.class.getName().equals(frame.getClassName()) && "order".equals(frame.getMethodName())) { return stack; }
                }
            }
            return new StackTraceElement[0];
        }

        private static JsonObject destination(final String zone, final boolean onTop, final boolean firstHighest) {
            final JsonObject o = new JsonObject();
            o.addProperty("zone", zone);
            o.addProperty("end", onTop ? "top" : "bottom");
            o.addProperty("first", firstHighest ? "top" : "bottom");
            return o;
        }

        /**
         * Whether the cards being ordered go on top of the library: read off the ability moving them,
         * the effect on this thread's stack matched to the resolving item's ability or one of its
         * sub-abilities, and that effect's own position parameter with its own default — the same
         * expressions the effects pass to {@code GameAction.moveTo} ({@code DigEffect.java:124-125},
         * {@code ChangeZoneEffect}'s and {@code ChangeZoneAllEffect}'s {@code LibraryPosition} with 0,
         * {@code DigUntilEffect}'s {@code RevealedLibraryPosition}, {@code RearrangeTopOfLibraryEffect}'s
         * 0). A {@code Dig} orders its rest for {@code LibraryPosition2}, and its chosen cards (through
         * {@code GameActionUtil.orderCardsByTheirOwners}) for {@code LibraryPosition}. When no such
         * ability is found, Forge's own reading stands: it reverses exactly when it takes the cards to
         * go on top.
         */
        private static boolean libraryEndIsTop(final StackTraceElement[] frames, final boolean reversed) {
            Class<?> effect = null;
            boolean byOwners = false;
            for (final StackTraceElement frame : frames) {
                if (forge.game.GameActionUtil.class.getName().equals(frame.getClassName()) && "orderCardsByTheirOwners".equals(frame.getMethodName())) { byOwners = true; }
                final Class<?> c = loaded(frame.getClassName());
                if (c != null && forge.game.ability.SpellAbilityEffect.class.isAssignableFrom(c)) { effect = c; break; }
            }
            final Game game = liveGame();
            if (effect == null || game == null || !game.getStack().isResolving() || game.getStack().isEmpty()) { return reversed; }
            SpellAbility sa = game.getStack().peek().getSpellAbility();
            while (sa != null && (sa.getApi() == null || sa.getApi().getSpellEffect().getClass() != effect)) { sa = sa.getSubAbility(); }
            if (sa == null) { return reversed; }
            final String param;
            final int otherwise;
            switch (sa.getApi()) {
                case RearrangeTopOfLibrary: return true;
                case Dig: param = byOwners ? "LibraryPosition" : "LibraryPosition2"; otherwise = -1; break;
                case DigUntil: param = "RevealedLibraryPosition"; otherwise = 0; break;
                default: param = "LibraryPosition"; otherwise = 0; break;
            }
            final int position = sa.hasParam(param)
                    ? forge.game.ability.AbilityUtils.calculateAmount(sa.getHostCard(), sa.getParam(param), sa) : otherwise;
            return position >= 0;
        }

        private static Class<?> loaded(final String name) {
            if (!name.startsWith("forge.game.ability.effects.")) { return null; }
            try {
                return Class.forName(name, false, PlayBridge.class.getClassLoader());
            } catch (final ClassNotFoundException e) {
                return null;
            }
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
            f.add("abilities", labelledAbilities(abilities));
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
                // A mana combination (PlayerControllerHuman.specifyManaCombo) keys the map by
                // MagicColor.Color, not by the Byte IGuiGame's doc still names.
                if (k instanceof MagicColor.Color c) {
                    key.addProperty("target", "manaColor");
                    key.addProperty("color", c.getColorMask());
                    ask.byKey.put("manaColor:" + c.getColorMask(), k);
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
                case "selectButtonCancel" -> {
                    // End Turn is Forge's own button 2 at a priority window. The exemption is
                    // set BEFORE the click is sent, and setPhaseDelayOff now writes it directly
                    // into the live YieldController (see its own comment) instead of racing the
                    // click over the network, so this ordering is real rather than assumed.
                    if (lastEnable2 && END_TURN_LABEL.equals(lastLabel2)) { setPhaseDelayOff(true); }
                    c.selectButtonCancel();
                }
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
                case "sendYieldUpdate" -> setTriggerDecision(frame.getAsJsonObject("update"));
                default -> throw new IllegalArgumentException("not an act: " + method);
            }
        }

        /**
         * Switch Forge's phase-pacing sleep for this seat's controller, and say so on the
         * protocol (a {@code pace} line) so a suite and a log can see when it flipped.
         *
         * <p><b>Ledger Y26 — why this does not go over the network.</b> Every human seat is
         * a real {@link forge.gamemodes.net.client.FGameClient}; {@link #getGameController()}
         * returns that seat's {@code NetGameController}, and calling an {@code IGameController}
         * method on it sends a Netty message to the server rather than mutating anything here.
         * {@code NetGameController.setYieldPref} (forge's {@code net/client/NetGameController.java:191})
         * wraps the call as {@code ProtocolMethod.sendYieldUpdate} with a
         * {@code YieldUpdate.SetYieldPref} envelope and sends it; {@code selectButtonCancel}
         * sends its own message right after, on the SAME channel. Both are {@code void}
         * protocol methods, so neither gets a reply the bridge could wait on (confirmed:
         * {@code IGameController.setYieldPref}/{@code .selectButtonCancel} both return
         * {@code void}, and {@code GameProtocolHandler.channelRead} only replies for a
         * non-void return type). And "same channel" only orders the DECODE: the server's
         * {@code GameServerHandler} is built with {@code runInEdt = false}
         * ({@code net/server/GameServerHandler.java:17}), so {@code GameProtocolHandler
         * .channelRead} dispatches every decoded message via
         * {@code FThreads.invokeInBackgroundThread} ({@code gui/FThreads.java:55-61}), which
         * is a bare {@code new Thread(proc, …).start()} — a fresh, unsynchronized thread per
         * message, not a queue. Two messages decoded in order can still have their handler
         * threads run in either order once dispatched, and worse under CPU load (observed:
         * {@code known_flaky} 2 of 4 CI runs) — this is X1's finding, now with its exact
         * mechanism. {@code PlayerControllerHuman.setYieldPref} is also a dead end for this
         * pref on its own terms: its body is {@code if (pref != YIELD_AUTO_PASS_NO_ACTIONS ||
         * !parseBoolean(value)) return;} ({@code player/PlayerControllerHuman.java:3904-3910}),
         * so even a same-thread server call would do nothing for
         * {@code YIELD_SKIP_PHASE_DELAY} — the pref only ever takes effect through
         * {@code YieldController.setPref}, reached from {@code applyYieldUpdate}
         * ({@code gamemodes/match/YieldController.java:387-388}), which this bridge's own
         * class comment says is deliberately not forwarded.
         *
         * <p>So instead of sending anything, this writes straight into the SAME live
         * {@code YieldController} the game thread reads ({@code PlayerControllerHuman
         * .java:1690}, via {@code getBoolPref} → {@code getStringPref},
         * {@code YieldController.java:90-96}, both {@code synchronized} on the controller
         * so the write is visible with no extra signal needed) — found the server's real
         * {@code PlayerControllerHuman} the same way {@link #confirmAbility()} does, via
         * {@link #liveSelf}. That write happens-before this method returns, which happens
         * before {@code act()} even sends the click, so there is only one network message
         * left on the wire to race: itself.
         */
        void setPhaseDelayOff(final boolean off) {
            final IGameController c = getGameController();
            if (c == null || phaseDelayOff == off) { return; }
            phaseDelayOff = off;
            final forge.game.player.Player mine = liveSelf(liveGame());
            if (mine != null && mine.getController() instanceof PlayerControllerHuman human) {
                human.getYieldController().setPref(FPref.YIELD_SKIP_PHASE_DELAY, String.valueOf(off));
            } else {
                System.err.println("[bridge] setPhaseDelayOff: no live PlayerControllerHuman for seat " + seat + "; pacing exemption NOT applied");
            }
            final JsonObject o = line("pace");
            o.addProperty("seat", seat);
            o.addProperty("skipPhaseDelay", off);
            o.addProperty("at", System.currentTimeMillis());
            emit(o);
        }

        /**
         * A remembered answer to an optional trigger, or {@code ASK} to forget it. Only the
         * {@code triggerDecision} arm of {@code YieldUpdate} is taken from a browser.
         *
         * <p>Written straight into the server's live {@code YieldController} for the same
         * reason {@link #setPhaseDelayOff} is: the seat's {@code NetGameController} would
         * send it as its own network message, dispatched on a fresh thread, racing the Yes
         * the browser presses right after it. The server's controller for a remote seat
         * keeps decisions in its per-game cache, and {@code YieldController.apply} is the
         * path Forge's own {@code sendYieldUpdate} takes into it
         * ({@code YieldController.java:379-380}), read back by {@code getTriggerDecision}
         * ({@code :274-281}) when {@code confirmTrigger} next asks.
         */
        void setTriggerDecision(final JsonObject update) {
            if (!"triggerDecision".equals(update.get("update").getAsString())) {
                throw new IllegalArgumentException("only a triggerDecision is taken from a seat: " + update);
            }
            final forge.game.player.Player mine = liveSelf(liveGame());
            if (mine == null || !(mine.getController() instanceof PlayerControllerHuman human)) {
                throw new IllegalStateException("seat " + seat + " has no live PlayerControllerHuman");
            }
            human.getYieldController().apply(new YieldUpdate.TriggerDecision(
                update.get("storageKey").getAsString(),
                AutoYieldStore.TriggerDecision.valueOf(update.get("decision").getAsString())));
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
         *
         * <p><b>Wave 33 §S — the scenario hook.</b> {@link #scenario}, when set, is
         * parsed once per match and applied from {@code HostedMatch}'s own
         * {@code startGameHook} — the identical seam Forge's own puzzle screens use
         * ({@code PuzzleScreen.java:63}: {@code hostedMatch.setStartGameHook(() ->
         * chosen.applyToGame(hostedMatch.getGame()))}). That hook runs from
         * {@code PhaseHandler.setupFirstTurn} ({@code :1018-1021}), AFTER
         * {@code MulliganService.perform()} ({@code GameAction.java:2351-2373}) and
         * before priority is given to either seat ({@code givePriorityToPlayer} is
         * still false) — so the mulligan still happens and a scenario starts the game
         * already in its scripted position.
         *
         * <p><b>Verified safe to call directly, not from a second {@code invoke}.</b>
         * {@code setupFirstTurn} runs on whatever thread called
         * {@code startFirstTurn} — here, the game thread {@code HostedMatch.startGame}
         * already dispatched onto via {@code game.getAction().invoke(() -> …
         * match.startGame(currentGame, startGameHook) …)} ({@code HostedMatch.java:280-294}).
         * {@code GameState.applyToGame} itself calls {@code game.getAction().invoke(() ->
         * applyGameOnThread(game))} ({@code GameState.java:582-583}), and
         * {@code GameAction.invoke} checks {@code ThreadUtil.isGameThread()} first and
         * runs the proc INLINE when it is already on it ({@code GameAction.java:2526-2531}
         * — the only other branch hands off to the game thread pool, which would be the
         * deadlock risk this comment is here to rule out). So the call chain
         * {@code startGameHook -> applyToGame -> invoke} never leaves the thread it
         * started on; see {@code wave33-evidence/s1-harness.md}.
         *
         * <p><b>Why {@link #refreshActionable} runs after the scenario applies.</b>
         * Wave 33 §S, the "empty actionable set at MAIN1" finding
         * (measured in {@code wave33-evidence/s3-blockers.md}): the FIRST
         * {@code chooseSpellAbilityToPlay()} of the match runs during the natural
         * UNTAP step, before this hook has replaced anyone's hand, and caches its
         * (correctly empty, for UNTAP) result in {@code PlayerControllerHuman}'s
         * {@code cachedActionableCards}. {@code InputPassPriority.showNormalPrompt()}
         * — what actually SENDS {@code setWeaklySelectable} for an ordinary priority
         * window — calls {@code pushActionableCards(false)} directly, which reuses
         * that cached set verbatim rather than rescanning
         * ({@code PlayerControllerHuman.java:1550-1590}: only recomputes when the
         * cache is {@code null}). A scenario that replaces the hand AFTER that first
         * cache fill therefore ships a stale, empty set to the very first priority
         * window it opens — confirmed directly: {@code AvailableActions.collectActionable}
         * called fresh, by hand, at the moment {@code setWeaklySelectable} sends {@code []},
         * finds the scripted card correctly. Forcing one more
         * {@code pushActionableCards(false)} per human seat right after the scenario
         * applies — before the game thread ever reaches a real priority window —
         * overwrites the stale cache with a fresh scan of the FINAL, scripted zones.
         *
         * <p>That push still lost intermittently, and so did the real first window's:
         * Wave 37 §A found the scan was right and the CLIENT dropped its cards on decode.
         * {@link #resyncSeats} runs first for that; its doc is the cause.
         */
        @Override public HostedMatch hostMatch() {
            final HostedMatch hm = new HostedMatch() {
                /**
                 * Every other {@code startMatch} overload lands here with the rules
                 * {@code HostedMatch.getDefaultRules} built. Forge's own Adventure mode
                 * turns the AI-cards warning off the same way ({@code DuelScene.java:519}):
                 * it reveals the cards an AI deck plays badly to every seat at the start
                 * ({@code Match.java:347}) and removes none of them.
                 */
                @Override public void startMatch(final GameRules rules, final Set<GameType> variants,
                        final List<RegisteredPlayer> players, final Map<RegisteredPlayer, IGuiGame> guis,
                        final MusicPlaylist playlist) {
                    rules.setWarnAboutAICards(false);
                    super.startMatch(rules, variants, players, guis, playlist);
                }
            };
            final String text = scenario;
            final GameState state;
            if (text != null) {
                state = new GameState();
                state.parse(Arrays.asList(text.split("\\r?\\n")));
            } else {
                state = null;
            }
            hm.setStartGameHook(() -> {
                hm.getGame().subscribeToEvents(new CombatSync(hm.getGame()));
                hm.getGame().subscribeToEvents(EffectJournal.INSTANCE.reset());
                final GameLogForward log = GameLogForward.install(hm.getGame());
                ModeCounts.install(hm.getGame());
                if (state == null) {
                    log.listen();
                    return;
                }
                state.applyToGame(hm.getGame());
                log.listen();
                resyncSeats(hm.getGame());
                refreshActionable(hm.getGame());
            });
            return hm;
        }

        /**
         * What a resolution or a state-based action did that the view cannot say, as Forge fires it,
         * numbered as it happens. Each seat sends what happened since its own last state frame
         * ({@link SeatGui#effectsSince}), so it rides the frame that shows the result. A bounded window:
         * a seat that has not sent a frame for {@link #KEEP} entries loses the oldest.
         *
         * <ul>
         * <li>{@code damage}: every point of damage dealt to a card ({@code GameEventCardDamaged},
         * {@code Card.java:6229}) as {@code [targetId, sourceId, amount]}. A creature that takes lethal
         * damage is in its graveyard, its damage wiped, by the time the delta is built (the operator,
         * 2026-10-15: Slagstorm and five creatures "instantly went to the graveyard").</li>
         * <li>{@code deaths}: why each permanent went to its graveyard ({@code GameEventCardDied}, the
         * fork's, pin {@code b6b2deff}) as {@code [cardId, cause]}, cause one of its {@code Cause}
         * names — the operator: "forge should tell the cause". Read by name and by reflection, so this
         * file still compiles against a jar from before that event, where none ever comes.</li>
         * </ul>
         */
        static final class EffectJournal {
            static final EffectJournal INSTANCE = new EffectJournal();
            static final int KEEP = 256;
            private record Entry(long seq, JsonArray damage, JsonArray death) {}
            private final java.util.ArrayDeque<Entry> entries = new java.util.ArrayDeque<>();
            private long next = 1;

            /** A new game: nothing has happened yet. Returns itself, to subscribe. */
            synchronized EffectJournal reset() {
                entries.clear();
                return this;
            }

            private synchronized void add(final JsonArray damage, final JsonArray death) {
                entries.addLast(new Entry(next++, damage, death));
                while (entries.size() > KEEP) { entries.removeFirst(); }
            }

            @Subscribe
            public void cardDamaged(final forge.game.event.GameEventCardDamaged ev) {
                if (ev.card() == null || ev.amount() <= 0) { return; }
                final JsonArray hit = new JsonArray();
                hit.add(ev.card().getId());
                hit.add(ev.source() == null ? -1 : ev.source().getId());
                hit.add(ev.amount());
                add(hit, null);
            }

            /** Every event, so {@code GameEventCardDied} is heard without naming its class (see above). */
            @Subscribe
            public void any(final forge.game.event.GameEvent ev) {
                if (!"GameEventCardDied".equals(ev.getClass().getSimpleName())) { return; }
                try {
                    final Object card = ev.getClass().getMethod("card").invoke(ev);
                    final Object cause = ev.getClass().getMethod("cause").invoke(ev);
                    if (!(card instanceof CardView view) || cause == null) { return; }
                    final JsonArray death = new JsonArray();
                    death.add(view.getId());
                    death.add(cause.toString());
                    add(null, death);
                } catch (final ReflectiveOperationException e) {
                    System.err.println("[bridge] GameEventCardDied: could not read it (" + e + ")");
                }
            }

            /** The number the next entry will get: a cursor past everything so far. */
            synchronized long head() {
                return next;
            }

            /** Every entry numbered at or after {@code from}, oldest first, into {@code payload}'s {@code damage} and {@code deaths}. */
            synchronized void since(final long from, final JsonObject payload) {
                final JsonArray damage = new JsonArray();
                final JsonArray deaths = new JsonArray();
                for (final Entry e : entries) {
                    if (e.seq() < from) { continue; }
                    if (e.damage() != null) { damage.add(e.damage()); }
                    if (e.death() != null) { deaths.add(e.death()); }
                }
                if (!damage.isEmpty()) { payload.add("damage", damage); }
                if (!deaths.isEmpty()) { payload.add("deaths", deaths); }
            }
        }

        /**
         * Every seat sees a declaration as it is made: the defender's blocks on the
         * attacker's screen, the attacker's attacks on the defender's.
         *
         * <p>{@code InputBlock}/{@code InputAttack} fire {@code GameEventCombatUpdate}
         * after each click has changed {@code Combat} ({@code InputBlock.java:87-88},
         * {@code InputAttack.java:358-359}). The acting seat's own stream carries the change
         * with its next prompt, but every other seat hears of it only through its
         * {@code GameEventForwarder}, which flushes when an event arrives 500 ms or more
         * after its last flush, or when an input queue changes
         * ({@code GameEventForwarder.java:38-46}, {@code :65-68}). Inside one input no
         * queue changes, so a click within 500 ms of the previous one sat in the buffer
         * until the next click — measured: an undo 300 ms after a block never reached the
         * attacker. Flushing every seat's buffer here, on the thread that fired the event
         * (where the forwarder itself flushes), sends each click as it lands.
         */
        static final class CombatSync {
            private final Game game;

            CombatSync(final Game game) {
                this.game = game;
            }

            @Subscribe
            public void combatUpdated(final GameEventCombatUpdate ev) {
                for (final var player : game.getPlayers()) {
                    if (player.getController() instanceof PlayerControllerHuman human
                            && human.getGui() instanceof RemoteClientGuiGame remote
                            && remote.getForwarder() != null) {
                        remote.getForwarder().flush();
                    }
                }
            }
        }

        /**
         * Forge's own game log, one {@code log} line per entry, worded for each player —
         * and the game actions Forge's log has no entry for, written here in its words.
         *
         * <p>{@code GameLog} is what Forge's desktop log panel draws: its
         * {@code GameLogFormatter} turns the game's events into entries (a cast and its
         * target, damage, life, combat, a land, a discard, a mill, a card put into a
         * graveyard or exile from the battlefield, a scry, a turn) and a few effects add
         * their own. It is an {@code Observable}, notified on the game thread as each entry
         * is added, so this reads the game exactly as it stands when the entry was written.
         *
         * <p><b>What Forge does not log</b> is read off the same game's events, on the same
         * thread, and joins the same stream: a draw and any other move between library,
         * hand, battlefield, graveyard and exile ({@code GameEventCardChangeZone}, fired by
         * {@code GameAction.changeZone}; a draw is the move {@code Player.doDraw} marks
         * {@code setDrawnThisTurn}), a token ({@code GameEventCardChangeZone} from no zone,
         * {@code GameAction.java:582}), a tap or untap ({@code GameEventCardTapped},
         * {@code Card.tap}/{@code untap}) and a counter put or removed
         * ({@code GameEventCardCounters}, {@code Card.java:1788}, {@code :1917}). Each is held
         * as a {@link Pending} until the next entry Forge writes, so a burst is one line —
         * the untap step is "Bob untaps their permanents", three tokens are one "creates
         * three" — and so nothing is said twice:
         * <ul>
         * <li>an entry that names the card of a held line, other than a new token ("Unsummon - Return Llanowar
         * Elves to its owner's hand.", "Alice played Mountain", a mana ability's line for
         * the land it tapped) is that line, and the held line is dropped;</li>
         * <li>what happens while a spell or ability resolves waits for that resolution's
         * own line ({@code GameEventSpellResolved} fires after the effect,
         * {@code MagicStack.java:660}), which already says what it did in general terms
         * ("Alice draws a card."): the held line then goes only to the players it tells
         * a card name, and a token only when that line does not already name it outside
         * reminder text ("create a 1/1 white Spirit creature token");</li>
         * <li>a payment is one line: Forge writes one {@code MANA} entry per mana ability
         * ({@code MagicStack.java:321}), and the run of them up to the next other entry is
         * sent as "Alice taps Forest and Forest for {G}{G}".</li>
         * </ul>
         * A priority window ({@code GameEventPlayerPriority}) or a new step sends whatever
         * is still held.
         *
         * <p>Forge's log is written to be public, but its words carry card names the way
         * {@code CardView.toString()} does, {@code "Name (id)"}, and so do the lines written
         * here. Each name is checked against Forge's own visibility rule,
         * {@code CardView.canBeShownTo}, for each player, on the card as it is NOW (a
         * discarded card is already in the graveyard when its line is written): a card the
         * player may see keeps its name and is listed with its id, so the browser can hand
         * that exact card to the inspector; one they may not is "a card", and a run of them
         * is counted ("Bob draws three cards"). A card that left a public zone (a bounced
         * creature) keeps the name it had there. A name this cannot place is never guessed
         * at: a player who may not see that card gets no line at all ({@code text: null}).
         *
         * <p>{@code PHASE} entries are not sent: one per step, and the phase rail says it.
         */
        @SuppressWarnings("deprecation")
        static final class GameLogForward implements java.util.Observer {
            private static final java.util.regex.Pattern CARD_ID = java.util.regex.Pattern.compile(" \\((\\d+)\\)");
            private static final java.util.regex.Pattern HIDDEN_RUN = java.util.regex.Pattern.compile("\\ba card((?:, a card)*,? and a card)");
            private static final java.util.regex.Pattern REMINDER = java.util.regex.Pattern.compile("\\([^)]*\\)");
            private static final java.util.regex.Pattern MANA_ADDED = java.util.regex.Pattern.compile("Add ([^.]*)");
            private static final java.util.Set<ZoneType> LOGGED_ZONES = java.util.EnumSet.of(
                    ZoneType.Library, ZoneType.Hand, ZoneType.Battlefield, ZoneType.Graveyard, ZoneType.Exile);
            private static final java.util.Set<ZoneType> PUBLIC_ZONES = java.util.EnumSet.of(
                    ZoneType.Battlefield, ZoneType.Graveyard, ZoneType.Exile);

            /** A game action Forge's log has no entry for. */
            private enum Kind { MOVE, TOKEN, TAP, UNTAP, UNTAP_STEP, COUNTER }

            /**
             * One action waiting for the entry that closes it. {@code shown}: a moved card
             * that left a public zone, named to everyone; a token's printed power and
             * toughness as it entered. {@code resolving}: it happened while the stack
             * resolved, and waits for that resolution's line.
             */
            private record Pending(Kind kind, forge.game.player.Player player, forge.game.card.Card card,
                    ZoneType from, ZoneType to, CounterType counter, int delta, String shown, boolean resolving) { }

            private final Game game;
            private int sent;
            private final List<Pending> pending = new ArrayList<>();
            private final List<forge.game.GameLogEntry> payment = new ArrayList<>();

            private GameLogForward(final Game game) {
                this.game = game;
                this.sent = game.getGameLog().getLogEntries(null).size();
            }

            /** Forwards Forge's log from now on; {@link #listen} adds the actions it does not log. */
            static GameLogForward install(final Game game) {
                final GameLogForward forward = new GameLogForward(game);
                game.getGameLog().addObserver(forward);
                return forward;
            }

            /**
             * Starts reading the game's events. Called once the game is set up (after a
             * scenario has put its cards in place), so setting up a board is not logged.
             */
            void listen() {
                game.subscribeToEvents(this);
            }

            @Override
            public synchronized void update(final java.util.Observable o, final Object arg) {
                // Newest first, as Forge returns it.
                final List<forge.game.GameLogEntry> entries = game.getGameLog().getLogEntries(null);
                for (int i = entries.size() - 1 - sent; i >= 0; i--) {
                    final forge.game.GameLogEntry entry = entries.get(i);
                    sent++;
                    written(entry);
                }
            }

            private void written(final forge.game.GameLogEntry entry) {
                final java.util.Set<Integer> named = namedIds(entry);
                // A token is new: a later line naming it ("… gain hexproof") did not say it was created.
                pending.removeIf(p -> p.kind() != Kind.TOKEN && p.card() != null && named.contains(p.card().getId()));
                if (entry.type() == forge.game.GameLogEntryType.MANA) {
                    send(false, null);
                    payment.add(entry);
                    return;
                }
                sendPayment();
                if (entry.type() == forge.game.GameLogEntryType.PHASE) {
                    send(true, null);
                    return;
                }
                final boolean resolution = entry.type() == forge.game.GameLogEntryType.STACK_RESOLVE
                        && entry.sourceCard() != null && game.getStack().isResolving();
                send(false, resolution ? entry : null);
                forward(entry.type(), entry.message(), entry.sourceCard(), java.util.Set.of(), false);
            }

            private static java.util.Set<Integer> namedIds(final forge.game.GameLogEntry entry) {
                final java.util.Set<Integer> ids = new java.util.HashSet<>();
                final java.util.regex.Matcher m = CARD_ID.matcher(entry.message() == null ? "" : entry.message());
                while (m.find()) { ids.add(Integer.parseInt(m.group(1))); }
                if (entry.sourceCard() != null) { ids.add(entry.sourceCard().getId()); }
                return ids;
            }

            @Subscribe
            public synchronized void zoneChanged(final forge.game.event.GameEventCardChangeZone ev) {
                if (game.getAge() != forge.game.GameStage.Play || ev.to() == null || ev.card() == null) { return; }
                final forge.game.card.Card card = game.findById(ev.card().getId());
                if (card == null) { return; }
                final ZoneType to = ev.to().zoneType();
                if (ev.from() == null) {
                    if (card.isToken() && to == ZoneType.Battlefield) {
                        final String pt = card.isCreature() ? card.getNetPower() + "/" + card.getNetToughness() + " " : "";
                        hold(Kind.TOKEN, card.getController(), card, null, to, null, 0, pt);
                    }
                    return;
                }
                final ZoneType from = ev.from().zoneType();
                // Forge logs a permanent put into a graveyard or exile itself (GameLogFormatter.visit(GameEventCardChangeZone)).
                final boolean logged = from == ZoneType.Battlefield && (to == ZoneType.Graveyard || to == ZoneType.Exile);
                if (from == to || logged || !LOGGED_ZONES.contains(from) || !LOGGED_ZONES.contains(to)) { return; }
                hold(Kind.MOVE, card.getOwner(), card, from, to, null, 0, PUBLIC_ZONES.contains(from) && !card.isFaceDown() ? "public" : null);
            }

            @Subscribe
            public synchronized void tapped(final forge.game.event.GameEventCardTapped ev) {
                if (game.getAge() != forge.game.GameStage.Play || ev.card() == null) { return; }
                final forge.game.card.Card card = game.findById(ev.card().getId());
                // A card leaving the battlefield tapped is untapped on its way out (GameAction.java:537): the move says it.
                if (card == null || !card.isInZone(ZoneType.Battlefield)) { return; }
                final forge.game.phase.PhaseHandler ph = game.getPhaseHandler();
                if (!ev.tapped() && ph.getPhase() == PhaseType.UNTAP && card.getController() == ph.getPlayerTurn()) {
                    final boolean said = pending.stream().anyMatch(p -> p.kind() == Kind.UNTAP_STEP && p.player() == card.getController());
                    if (!said) { hold(Kind.UNTAP_STEP, card.getController(), null, null, null, null, 0, null); }
                    return;
                }
                hold(ev.tapped() ? Kind.TAP : Kind.UNTAP, card.getController(), card, null, null, null, 0, null);
            }

            @Subscribe
            public synchronized void counters(final forge.game.event.GameEventCardCounters ev) {
                if (game.getAge() != forge.game.GameStage.Play || ev.card() == null || ev.newValue() == ev.oldValue()) { return; }
                final forge.game.card.Card card = game.findById(ev.card().getId());
                if (card == null || !card.isInZone(ZoneType.Battlefield) && !card.isInZone(ZoneType.Exile)) { return; }
                final int delta = ev.newValue() - ev.oldValue();
                final Pending last = pending.isEmpty() ? null : pending.get(pending.size() - 1);
                if (last != null && last.kind() == Kind.COUNTER && last.card() == card && last.counter().equals(ev.type())
                        && Integer.signum(last.delta()) == Integer.signum(delta)) {
                    pending.set(pending.size() - 1, new Pending(Kind.COUNTER, last.player(), card, null, null, ev.type(),
                            last.delta() + delta, null, last.resolving()));
                    return;
                }
                hold(Kind.COUNTER, card.getController(), card, null, null, ev.type(), delta, null);
            }

            /** A player is given priority: nothing that happened before it is still unsaid. */
            @Subscribe
            public synchronized void priority(final forge.game.event.GameEventPlayerPriority ev) {
                sendPayment();
                send(true, null);
            }

            private void hold(final Kind kind, final forge.game.player.Player player, final forge.game.card.Card card,
                    final ZoneType from, final ZoneType to, final CounterType counter, final int delta, final String shown) {
                pending.add(new Pending(kind, player, card, from, to, counter, delta, shown, game.getStack().isResolving()));
            }

            /**
             * Sends the held lines, oldest first, a run of the same action by the same
             * player as one line. {@code all}: the ones waiting for a resolution's line
             * too (no resolution is in progress any more). {@code resolution}: the line
             * of the resolution they waited for, which has already said what they did.
             */
            private void send(final boolean all, final forge.game.GameLogEntry resolution) {
                final List<Pending> out = new ArrayList<>();
                for (final java.util.Iterator<Pending> it = pending.iterator(); it.hasNext(); ) {
                    final Pending p = it.next();
                    if (p.resolving() && !all && resolution == null) { continue; }
                    it.remove();
                    if (p.resolving() && resolution != null && p.kind() == Kind.TOKEN && says(resolution, p.card())) { continue; }
                    out.add(p);
                }
                for (int i = 0; i < out.size(); ) {
                    final Pending first = out.get(i);
                    final List<Pending> run = new ArrayList<>();
                    while (i < out.size() && sameLine(first, out.get(i))) { run.add(out.get(i++)); }
                    say(run, resolution != null && first.resolving());
                }
            }

            /** Whether a resolution's line already names this token's kind, outside reminder text. */
            private static boolean says(final forge.game.GameLogEntry resolution, final forge.game.card.Card token) {
                final String kind = token.getName().replaceFirst("(?i)\\s*token$", "").trim().toLowerCase(java.util.Locale.ROOT);
                final String text = REMINDER.matcher(resolution.message() == null ? "" : resolution.message()).replaceAll("");
                return !kind.isEmpty() && text.toLowerCase(java.util.Locale.ROOT).contains(kind);
            }

            private static boolean drawn(final Pending p) {
                return p.kind() == Kind.MOVE && p.from() == ZoneType.Library && p.to() == ZoneType.Hand && p.card().getDrawnThisTurn();
            }

            private static boolean sameLine(final Pending a, final Pending b) {
                if (a.kind() != b.kind() || a.player() != b.player() || a.resolving() != b.resolving()) { return false; }
                return switch (a.kind()) {
                    case MOVE -> drawn(a) == drawn(b) && a.from() == b.from() && a.to() == b.to();
                    case COUNTER -> a == b;
                    default -> true;
                };
            }

            private void say(final List<Pending> run, final boolean revealOnly) {
                final Pending first = run.get(0);
                final String who = first.player() == null ? "" : first.player().getName();
                final List<String> cards = new ArrayList<>();
                final java.util.Set<Integer> publicIds = new java.util.HashSet<>();
                for (final Pending p : run) {
                    if (p.card() == null) { continue; }
                    cards.add(p.card().getView().toString());
                    if (p.kind() == Kind.MOVE && p.shown() != null) { publicIds.add(p.card().getId()); }
                }
                final String list = forge.util.Lang.joinHomogenous(cards);
                final forge.game.GameLogEntryType type;
                final String text;
                switch (first.kind()) {
                    case MOVE -> {
                        type = forge.game.GameLogEntryType.ZONE_CHANGE;
                        text = drawn(first)
                                ? who + " draws " + list + "."
                                : list + (run.size() == 1 ? " was" : " were") + " put into " + first.to() + " from " + first.from() + ".";
                    }
                    case TOKEN -> {
                        type = forge.game.GameLogEntryType.ZONE_CHANGE;
                        text = who + " creates " + tokens(run) + ".";
                    }
                    case TAP, UNTAP -> {
                        type = forge.game.GameLogEntryType.INFORMATION;
                        text = who + (first.kind() == Kind.TAP ? " taps " : " untaps ") + list + ".";
                    }
                    case UNTAP_STEP -> {
                        type = forge.game.GameLogEntryType.INFORMATION;
                        text = who + " untaps their permanents.";
                    }
                    default -> {
                        type = forge.game.GameLogEntryType.INFORMATION;
                        final int n = Math.abs(first.delta());
                        final String counter = first.counter().getName() + " counter";
                        text = list + (first.delta() > 0 ? " gets " : " loses ")
                                + (n == 1 ? (forge.util.Lang.startsWithVowel(counter) ? "an " : "a ") + counter : forge.util.Lang.nounWithNumeral(n, counter))
                                + ".";
                    }
                }
                forward(type, text, null, publicIds, revealOnly);
            }

            /** "a 1/1 Goblin Token (45)", "three 1/1 Goblin Token (45)s and a Clue Token (48)". */
            private static String tokens(final List<Pending> run) {
                final Map<String, List<Pending>> byName = new java.util.LinkedHashMap<>();
                for (final Pending p : run) { byName.computeIfAbsent(p.shown() + p.card().getName(), k -> new ArrayList<>()).add(p); }
                final List<String> parts = new ArrayList<>();
                for (final List<Pending> same : byName.values()) {
                    final Pending p = same.get(0);
                    final String one = p.shown() + p.card().getView().toString();
                    parts.add(same.size() == 1
                            ? (forge.util.Lang.startsWithVowel(one) ? "an " : "a ") + one
                            : forge.util.Lang.getNumeral(same.size()) + " " + one + "s");
                }
                return forge.util.Lang.joinHomogenous(parts);
            }

            /** The held run of mana abilities, as one line per player: "Alice taps Forest and Forest for {G}{G}." */
            private void sendPayment() {
                if (payment.isEmpty()) { return; }
                final List<forge.game.GameLogEntry> run = new ArrayList<>(payment);
                payment.clear();
                forge.game.player.Player payer = null;
                final List<String> cards = new ArrayList<>();
                final StringBuilder mana = new StringBuilder();
                boolean tapped = true;
                for (final forge.game.GameLogEntry entry : run) {
                    final String message = entry.message() == null ? "" : entry.message();
                    final java.util.regex.Matcher id = CARD_ID.matcher(message);
                    final forge.game.card.Card card = id.find() ? game.findById(Integer.parseInt(id.group(1))) : null;
                    if (card == null) {
                        // Not a card's mana ability: Forge's own line as it is.
                        forward(entry.type(), message, entry.sourceCard(), java.util.Set.of(), false);
                        continue;
                    }
                    if (payer != null && payer != card.getController()) {
                        forward(forge.game.GameLogEntryType.MANA, paid(payer, cards, mana, tapped), null, java.util.Set.of(), false);
                        cards.clear();
                        mana.setLength(0);
                        tapped = true;
                    }
                    payer = card.getController();
                    cards.add(card.getView().toString());
                    tapped &= card.isTapped();
                    mana.append(produced(card, message.substring(id.end())));
                }
                if (payer != null) { forward(forge.game.GameLogEntryType.MANA, paid(payer, cards, mana, tapped), null, java.util.Set.of(), false); }
            }

            private static String paid(final forge.game.player.Player payer, final List<String> cards, final CharSequence mana, final boolean tapped) {
                return payer.getName() + (tapped ? " taps " : " uses ") + forge.util.Lang.joinHomogenous(cards)
                        + (mana.length() == 0 ? "" : " for " + mana) + ".";
            }

            /**
             * What a mana ability made, off the ability itself
             * ({@code AbilityManaPart.getLastManaProduced}); the {@code "Add …"} of the
             * ability's text when it cannot be told which ability it was. {@code rest} is the
             * entry's text after the card, {@code " - <ability>"} ({@code MagicStack.java:321}).
             */
            private static String produced(final forge.game.card.Card card, final String rest) {
                final String text = rest.startsWith(" - ") ? rest.substring(3) : rest;
                SpellAbility used = null;
                for (final SpellAbility sa : card.getManaAbilities()) {
                    if (text.equals(sa.toString()) || card.getManaAbilities().size() == 1) { used = sa; }
                }
                if (used != null && used.getManaPart() != null && !used.getManaPart().getLastManaProduced().isEmpty()) {
                    final StringBuilder sb = new StringBuilder();
                    for (final forge.game.mana.Mana m : used.getManaPart().getLastManaProduced()) { sb.append('{').append(m).append('}'); }
                    return sb.toString();
                }
                final java.util.regex.Matcher add = MANA_ADDED.matcher(text);
                return add.find() ? add.group(1).trim() : "";
            }

            private void forward(final forge.game.GameLogEntryType type, final String message, final CardView source,
                    final java.util.Set<Integer> publicIds, final boolean revealOnly) {
                final JsonObject o = line("log");
                o.addProperty("type", type.name());
                final JsonArray players = new JsonArray();
                for (final forge.game.player.Player p : game.getPlayers()) {
                    players.add(worded(message, source, p.getView(), publicIds, revealOnly));
                }
                o.add("players", players);
                emit(o);
            }

            /**
             * {@code raw} as {@code viewer} may read it. {@code publicIds}: cards named to
             * everyone whatever their zone now. {@code revealOnly}: a line the viewer gets
             * only if it names them a card — Forge's own line has already said the rest.
             */
            private JsonObject worded(final String raw, final CardView source, final PlayerView viewer,
                    final java.util.Set<Integer> publicIds, final boolean revealOnly) {
                final JsonObject out = new JsonObject();
                out.addProperty("player", viewer.getId());
                final String message = raw == null ? "" : raw;
                final JsonArray cards = new JsonArray();
                final StringBuilder text = new StringBuilder();
                final java.util.regex.Matcher m = CARD_ID.matcher(message);
                int at = 0;
                boolean namesACard = false;
                while (m.find()) {
                    final int id = Integer.parseInt(m.group(1));
                    final forge.game.card.Card card = game.findById(id);
                    final CardView view = card == null ? null : card.getView();
                    final String before = message.substring(at, m.start());
                    at = m.end();
                    if (view == null) {
                        // Gone from the game (a token that left the battlefield): it was public where it was.
                        text.append(before);
                        continue;
                    }
                    final String name = view.getName();
                    final boolean placed = name != null && !name.isEmpty() && before.endsWith(name);
                    final boolean visible = view.canBeShownTo(viewer);
                    final boolean shown = visible || publicIds.contains(id);
                    if (!placed && !shown) {
                        return silent(out);
                    }
                    if (!shown) {
                        text.append(before, 0, before.length() - name.length()).append("a card");
                        continue;
                    }
                    namesACard = true;
                    text.append(before);
                    // Listed only where the viewer can see it now: the inspector has nothing to show of a
                    // bounced card in another hand, and the server holds a line until its listed cards show.
                    if (placed && visible) { cards.add(cardRef(id, name)); }
                }
                text.append(message.substring(at));
                if (revealOnly && !namesACard) {
                    return silent(out);
                }
                final java.util.regex.Matcher hidden = HIDDEN_RUN.matcher(text);
                final StringBuilder counted = new StringBuilder();
                while (hidden.find()) {
                    final int n = hidden.group().split("a card", -1).length - 1;
                    hidden.appendReplacement(counted, forge.util.Lang.getNumeral(n) + " cards");
                }
                hidden.appendTail(counted);
                if (!counted.isEmpty()) { counted.setCharAt(0, Character.toUpperCase(counted.charAt(0))); }
                out.addProperty("text", counted.toString());
                final forge.game.card.Card host = source == null ? null : game.findById(source.getId());
                if (host != null && host.getView().canBeShownTo(viewer)) {
                    final String name = host.getView().getName();
                    boolean listed = false;
                    for (final JsonElement c : cards) { listed |= c.getAsJsonObject().get("id").getAsInt() == host.getId(); }
                    if (!listed && name != null && !name.isEmpty() && counted.indexOf(name) >= 0) { cards.add(cardRef(host.getId(), name)); }
                }
                out.add("cards", cards);
                return out;
            }

            /** The line is not this viewer's to read. */
            private static JsonObject silent(final JsonObject out) {
                out.add("text", JsonNull.INSTANCE);
                out.add("cards", new JsonArray());
                return out;
            }

            private static JsonObject cardRef(final int id, final String name) {
                final JsonObject c = new JsonObject();
                c.addProperty("id", id);
                c.addProperty("name", name);
                return c;
            }
        }

        /**
         * How many modes a modal spell's caster picks, as Forge itself counts them.
         *
         * <p>{@code CharmEffect.makeChoices} works out {@code min} and {@code num} ("choose
         * two", "choose one or both", "choose one or more") and hands them to
         * {@code PlayerControllerHuman.chooseModeForAbility}, which then asks ONE mode at a
         * time — {@code getGui().one(...)} per mode, {@code oneOrNone} past {@code min}
         * ({@code PlayerControllerHuman.java:1925-1951}) — so the wire never carries the
         * count. Just before that loop the controller offers the choice to its macro system
         * ({@code macros().consumeRememberedModeChoice(choices, min, num, allowRepeat)},
         * {@code :1917}), with the count. Each human seat's macro system is wrapped here
         * (Forge's own {@code RecordActionsMacroSystem} kept underneath, every call passed
         * through) so that call also leaves {@code {min, num}} under the chooser's player
         * id; the seat's next {@code getChoices} — Forge's first mode question — carries it
         * as {@code modes} ({@link SeatGui#modesOf}), and the server asks the seat once.
         * A spell that may pick one mode twice ({@code CanRepeatModes}) is still asked a
         * mode at a time: one list of checkboxes cannot pick an entry twice. The private {@code macros} field is set by reflection, as
         * {@link #refreshActionable} does; no Forge file changes.
         */
        static final class ModeCounts implements forge.interfaces.IMacroSystem {
            static final Map<Integer, int[]> PENDING = new ConcurrentHashMap<>();

            private final forge.interfaces.IMacroSystem forge;
            private final int playerId;

            private ModeCounts(final forge.interfaces.IMacroSystem forge, final int playerId) {
                this.forge = forge;
                this.playerId = playerId;
            }

            static void install(final Game game) {
                for (final var player : game.getPlayers()) {
                    if (!(player.getController() instanceof PlayerControllerHuman human) || human.macros() instanceof ModeCounts) { continue; }
                    try {
                        final java.lang.reflect.Field macros = PlayerControllerHuman.class.getDeclaredField("macros");
                        macros.setAccessible(true);
                        macros.set(human, new ModeCounts(human.macros(), player.getId()));
                    } catch (final ReflectiveOperationException e) {
                        System.err.println("[bridge] ModeCounts: macros reflection failed (" + e + "); modes are asked one at a time");
                    }
                }
            }

            @Override public List<String> consumeRememberedModeChoice(final List<String> choices, final int min, final int num, final boolean allowRepeat) {
                final List<String> remembered = forge.consumeRememberedModeChoice(choices, min, num, allowRepeat);
                if (remembered == null && num > 1 && !allowRepeat) { PENDING.put(playerId, new int[] { min, num }); }
                return remembered;
            }

            @Override public void addRememberedAction(final forge.game.player.actions.PlayerAction action) { forge.addRememberedAction(action); }
            @Override public void setRememberedActions() { forge.setRememberedActions(); }
            @Override public void nextRememberedAction() { forge.nextRememberedAction(); }
            @Override public void repeatRememberedActions() { forge.repeatRememberedActions(); }
            @Override public void cancelPlayback() { forge.cancelPlayback(); }
            @Override public void cancelCurrentMacro() { forge.cancelCurrentMacro(); }
            @Override public boolean isRecording() { return forge.isRecording(); }
            @Override public boolean isReplaying() { return forge.isReplaying(); }
            @Override public boolean hasRememberedActions() { return forge.hasRememberedActions(); }
            @Override public Byte consumeRememberedColorChoice(final List<MagicColor.Color> choices) { return forge.consumeRememberedColorChoice(choices); }
            @Override public Map<Byte, Integer> consumeRememberedManaCombo(final List<MagicColor.Color> choices, final int manaAmount, final boolean different) {
                return forge.consumeRememberedManaCombo(choices, manaAmount, different);
            }
            @Override public List<String> consumeRememberedAbilityOrder(final List<String> choices) { return forge.consumeRememberedAbilityOrder(choices); }
            @Override public org.apache.commons.lang3.tuple.ImmutablePair<forge.game.card.CardCollection, forge.game.card.CardCollection> consumeRememberedScry(final forge.game.card.CardCollection topN) {
                return forge.consumeRememberedScry(topN);
            }
            @Override public String playbackText() { return forge.playbackText(); }
        }

        /**
         * Wave 37 §A — make every seat's client hold the scenario's cards before any
         * frame that names them is decoded, so the first priority window offers exactly
         * what the scripted zones make castable, every time.
         *
         * <p><b>The race.</b> The in-JVM client resolves a frame's card references while
         * its netty thread DECODES the frame ({@code CObjectInputStream.resolveObject} →
         * {@code TrackableSerializer.resolve}, {@code TrackableSerializer.java:136-141}: an
         * id its tracker does not hold yet becomes {@code null}). The cards
         * {@code applyToGame} just created reach the client in an {@code applyDelta},
         * and a delta's new objects enter the tracker only when
         * {@code NetworkGuiGame.applyDelta} runs ({@code NetworkGuiGame.java:66-107}, via
         * {@code createObjectOnly}, {@code :427-462}) — dispatched to the GUI thread
         * ({@code GameClientHandler} is {@code super(true)}, {@code GameClientHandler.java:38};
         * {@code GameProtocolHandler.java:117-118}), which here is the seat's own
         * {@code seat-N-ui} executor ({@link BridgeGui#invokeInEdtLater}). So a
         * {@code setWeaklySelectable} decoded before that executor has applied the delta
         * arrives with the scenario's cards dropped ({@link #refs} skips the nulls) —
         * the empty first window CI failed on. Our own hook push lost it almost always;
         * the real priority window's push lost it whenever the seat's executor was still
         * behind its netty thread.
         *
         * <p><b>The fix is ordering, not timing.</b> {@code setResyncPending} is Forge's
         * own resync request ({@code RemoteClientGuiGame.java:266-269}): the next
         * {@code updateGameView} on the game thread — the one {@code setWeaklySelectable}
         * performs before it sends ({@code :507-510}) — sends the full state as
         * {@code setGameView} instead of a delta ({@code :223-227}, {@code :275-283}). The
         * client registers a {@code setGameView}'s objects ON THE NETTY THREAD, in
         * {@code beforeCall}, before the next frame on that channel is even decoded
         * ({@code GameClientHandler.java:116-126}: {@code updateObjLookup} plus
         * {@code refreshTrackerCardViews}). One channel, one netty thread, frames in
         * order: every frame after it resolves the scenario's cards. Scenario-only — the
         * hook is set only when {@link #scenario} is non-null.
         */
        private static void resyncSeats(final Game game) {
            if (game == null) { return; }
            for (final var player : game.getPlayers()) {
                if (player.getController() instanceof PlayerControllerHuman human
                        && human.getGui() instanceof RemoteClientGuiGame remote) {
                    remote.setResyncPending();
                }
            }
        }

        /**
         * Force a fresh {@code setWeaklySelectable} push for every human seat, so a
         * scenario's scripted hand/battlefield is what the first priority window
         * offers — see {@link #hostMatch}'s doc for why the default push is stale.
         *
         * <p><b>Why {@code pushActionableCards(false)} alone is not enough</b> —
         * found by the manager re-running this exact test twice (1 fail, 1 pass).
         * {@code pushActionableCards} ({@code PlayerControllerHuman.java:1550-1590})
         * does NOT recompute the actionable set itself when not paying a cost:
         * {@code :1572-1574}, {@code else if (cachedActionableCards != null) {
         * actionable.addAll(cachedActionableCards); }}. That field
         * ({@code :1539}, {@code private Set<CardView> cachedActionableCards})
         * is only ever (re)computed by {@code chooseSpellAbilityToPlay()}
         * ({@code :1664}/{@code :1668}/{@code :1672}) — and THIS method runs from
         * the START-GAME HOOK, before the main loop has called
         * {@code chooseSpellAbilityToPlay()} even once, so whatever the field holds
         * is leftover from BEFORE the scenario applied (sometimes still {@code null}
         * from construction, sometimes non-null — empirically, from the mulligan
         * step's own input, timing-dependent — which is exactly why the failure was
         * intermittent rather than constant). Calling {@code pushActionableCards(false)}
         * while that stale value is non-null resends IT, not a fresh scan.
         *
         * <p>The fix: null the field directly (reflection on a {@code private} Forge
         * field — no Forge file is changed, and this bridge already reads Forge
         * internals this way for {@link SeatGui#liveMulliganFlag()}) immediately
         * before calling {@code pushActionableCards(false)}. With the field null,
         * {@code pushActionableCards}'s OWN {@code else} branch ({@code :1575-1578})
         * runs a fresh {@code AvailableActions.collectActionable} scan instead of
         * reusing anything — and since {@code pushActionableCards} never WRITES this
         * field (only reads it), it is still null afterward, so
         * {@code chooseSpellAbilityToPlay}'s own first real call (once the main loop
         * starts) is guaranteed to take its own fresh-scan branch too
         * ({@code :1659-1661}, unconditional whenever {@code cachedActionableCards}
         * is null), rather than finding a non-null value some other caller already
         * wrote.
         */
        private static void refreshActionable(final Game game) {
            if (game == null) { return; }
            for (final var player : game.getPlayers()) {
                if (player.getController() instanceof PlayerControllerHuman human) {
                    try {
                        final java.lang.reflect.Field cache = PlayerControllerHuman.class.getDeclaredField("cachedActionableCards");
                        cache.setAccessible(true);
                        cache.set(human, null);
                    } catch (final ReflectiveOperationException e) {
                        // Forge's own field renamed under us: fall through and push
                        // whatever's cached rather than fail the match over a highlight.
                        System.err.println("[bridge] refreshActionable: cachedActionableCards reflection failed: " + e);
                    }
                    human.pushActionableCards(false);
                }
            }
        }
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

    /** Stdin, shared: a spare reads its {@code start} line from it, then {@link #readCommands} the rest. */
    static final BufferedReader IN = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));

    /**
     * Two ways in. {@code PlayBridge <config.json>} is a cold start: read the match, boot
     * Forge, play. {@code PlayBridge --spare <spareId>} is the warm spare
     * ({@code host.ts}): boot Forge and its server with no match, say {@code warm}, then
     * block on stdin for ONE {@code start} line carrying the same config object the file
     * would have held. Everything {@link #bootForge} does is independent of the match, so
     * a spare and a cold start run the same code in a different order.
     *
     * <p>Until {@code start} the spare's lines carry {@code spareId} as their
     * {@code match}; from then on, the match's id. The {@code start} command itself is
     * addressed to {@code spareId} and names the match in its config.
     */
    public static void main(final String[] args) throws Exception {
        protocol = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        System.setOut(System.err);
        final List<SeatConfig> seats;
        final Booted booted;
        final long startAt;
        if (args.length == 2 && "--spare".equals(args[0])) {
            matchId = args[1];
            final long bootStart = System.currentTimeMillis();
            booted = bootForge();
            final JsonObject warm = line("warm");
            warm.addProperty("bootMs", System.currentTimeMillis() - bootStart);
            emit(warm);
            final String first = IN.readLine();
            if (first == null) {
                // Node went away before this spare was needed. Nothing to clean up but Netty.
                Runtime.getRuntime().halt(0);
            }
            final JsonObject cmd = JsonParser.parseString(first).getAsJsonObject();
            if (!cmd.has("match") || !matchId.equals(cmd.get("match").getAsString())) {
                fatal("the spare's first command is not addressed to spare " + matchId, null);
            }
            final String t = cmd.get("t").getAsString();
            if ("stop".equals(t)) {
                Runtime.getRuntime().halt(0);
            }
            if (!"start".equals(t)) {
                fatal("a spare's first command is start or stop, got " + t, null);
            }
            startAt = System.currentTimeMillis();
            seats = configFrom(cmd.getAsJsonObject("config"));
        } else if (args.length == 1) {
            seats = readConfig(Path.of(args[0]));
            startAt = System.currentTimeMillis();
            booted = bootForge();
        } else {
            fatal("usage: PlayBridge <config.json> | PlayBridge --spare <spareId>", null);
            return;
        }
        if (seats.size() != 2) {
            fatal("a match has exactly two seats, got " + seats.size(), null);
        }
        startMatch(seats, booted, startAt);
    }

    /** What {@link #bootForge} leaves running: Forge's server on its port, with an empty lobby. */
    record Booted(int port, FServerManager server, ServerGameLobby lobby) { }

    /** Everything that does not depend on the match: Forge's model, preferences, server, lobby. */
    static Booted bootForge() throws IOException {
        GuiBase.setInterface(new BridgeGui());
        FModel.initialize(null, prefs -> {
            prefs.setPref(FPref.LOAD_CARD_SCRIPTS_LAZILY, false);
            prefs.setPref(FPref.UI_LANGUAGE, "en-US");
            // Limited decks are 40 cards; constructed legality is not ours to enforce here.
            prefs.setPref(FPref.ENFORCE_DECK_LEGALITY, false);
            // Forge's priority-time "what can I actually click" scan. It defaults to
            // "false" (ForgePreferences.java:100), and while it is false
            // PlayerControllerHuman.pushActionableCards sends clearWeaklySelectable and
            // nothing else (:1551-1558) — so the browser would have no answer outside a
            // selection and would go back to inventing one. UI_SHOW_AUTOTAP_PREVIEW is
            // deliberately left off: it only raises a card's WEIGHT inside the same set
            // (:1580-1589), and our board reads the set, not the weights.
            prefs.setPref(FPref.UI_SHOW_ACTIONABLE_HIGHLIGHTS, true);
            return null;
        });
        if (StaticData.instance() == null) {
            fatal("Forge did not initialise (no StaticData) — is res/ in the working directory?", null);
        }
        FModel.getPreferences().setPref(FPref.ENFORCE_DECK_LEGALITY, false);
        // Belt and braces: FModel.initialize only runs its lambda on a FIRST init, and
        // YieldController.getStringPref falls back to FModel for any pref a client did
        // not override (YieldController.java:90-96).
        FModel.getPreferences().setPref(FPref.UI_SHOW_ACTIONABLE_HIGHLIGHTS, true);
        // UPnP ASK opens a modal dialog inside startServer (docs/spikes/forge-server.md).
        FModel.getNetPreferences().setPref(ForgeNetPreferences.FNetPref.UPnP, "NEVER");
        // AFK auto-pass would have Forge act for a human who is thinking. The Node side
        // owns the timeout on every ask; see README.md.
        FModel.getNetPreferences().setPref(ForgeNetPreferences.FNetPref.NET_AFK_TIMEOUT, "0");
        RemoteClientGuiGame.useDeltaSync = true;

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
        return new Booted(port, server, lobby);
    }

    /**
     * The match: decks, seats, clients, go. {@code startAt} is when the match was
     * handed to this JVM (the config file read, or the spare's {@code start}); the
     * {@code ready} line's {@code startMs} is measured from it, and its {@code bootMs}
     * from the JVM's own start — which for a spare includes however long it sat idle.
     */
    static void startMatch(final List<SeatConfig> seats, final Booted booted, final long startAt) throws Exception {
        final int port = booted.port();
        final FServerManager server = booted.server();
        final ServerGameLobby lobby = booted.lobby();
        LOBBY = lobby;
        final Random random = seed == null ? new Random() : new Random(seed);
        if (seed != null) {
            forge.util.MyRandom.setRandom(new Random(seed));
        }
        // Read when the opening hands are dealt (GameAction.startGame) and on every
        // mulligan, so it is set here, after FModel.initialize set it from preferences.
        StaticData.instance().setFilteredHandsEnabled(handSmoothing);
        final List<Deck> decks = new ArrayList<>();
        for (final SeatConfig s : seats) {
            decks.add(s.deck() != null ? parseDeck(s.deck()) : randomPrecon(random));
        }

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
        final long now = System.currentTimeMillis();
        ready.addProperty("bootMs", now - java.lang.management.ManagementFactory.getRuntimeMXBean().getStartTime());
        ready.addProperty("startMs", now - startAt);
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

    /**
     * Wave 33 §S item 4 — the concede race, now a BACKSTOP only. Until wave 33
     * this loop, polling at 500 ms, was the ONLY way the {@code gameover} line
     * was ever emitted — and {@code GameOver} itself reaches a browser far
     * faster, as an ordinary wire-synced {@code GameView} property (the
     * client's {@code view.gameOver}, `apps/ui/src/play/adapter.ts:861`), so a
     * client could learn the game had ended and a reconnect-and-second-concede
     * could beat this loop's next tick to the server, landing on
     * {@code Match.status === 'running'} and skipping the refusal entirely
     * (measured: 3 of 10 runs of `e2e/w31.spec.ts`'s concede test; see
     * `wave33-evidence/s4-concede.md`).
     *
     * <p>The real fix is {@link #maybeEmitGameOverFirst()}, called from
     * {@link SeatGui#setGameView} and {@link SeatGui#applyDelta} — the only
     * two places a {@code GameOver} property can reach a seat's wire — which
     * closes the race by ORDER: the {@code gameover} line is always written
     * before the state frame that would let any client learn the same thing,
     * on the same stream, read by Node in that order. This loop still exists
     * for the one case that reasoning does not cover — a match nobody is
     * connected to, so no seat's {@code setGameView}/{@code applyDelta} ever
     * runs to trigger it — and shares {@link #gameOverEmitted} with it, so
     * whichever notices first is the one that emits.
     */
    static void watchForGameOver(final ServerGameLobby lobby) {
        try {
            while (true) {
                final HostedMatch match = lobby.getHostedMatch();
                if (match != null && match.getGame() != null && match.getGame().isGameOver()) {
                    maybeEmitGameOverFirst();
                    return;
                }
                Thread.sleep(20);
            }
        } catch (final InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    static void readCommands() {
        try {
            String raw;
            while ((raw = IN.readLine()) != null) {
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
            case "resend-pending" -> seat(cmd).resendPending();
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
