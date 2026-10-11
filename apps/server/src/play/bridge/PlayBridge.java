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
import forge.game.Game;
import forge.game.GameEntityView;
import forge.game.GameState;
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
 * {@code @hadoku/forge-wire} ServerFrame for one seat), {@code probe}, {@code gameover},
 * {@code fatal}. Lines in: {@code start} (a spare's first line only), {@code reply},
 * {@code abort}, {@code act}, {@code probe}, {@code stop}. See {@link #main} for the
 * warm spare.
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
     * <p>One pair per stack item that targets exactly one OTHER stack item:
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
            final TargetChoices tc = si.getTargetChoices();
            if (tc == null) { continue; }
            for (final SpellAbility targetSa : tc.getTargetSpells()) {
                final Integer toId = owner.get(targetSa);
                if (toId != null) {
                    final JsonArray pair = new JsonArray();
                    pair.add(si.getId());
                    pair.add(toId);
                    out.add(pair);
                    break;
                }
            }
        }
        return out;
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
        emit(o);
    }

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
         * What this seat was LAST TOLD the Game object's {@code Mulligan} property is —
         * real wire traffic or this bridge's own synthetic correction, either one. {@code
         * null} until either has said anything; see {@link #syncMulliganFlag()}.
         */
        volatile Boolean lastToldMulligan;

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
            payload.add("stackTargetSpells", stackTargetSpellsJson(liveGame()));
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
                payload.add("stackTargetSpells", stackTargetSpellsJson(liveGame()));
                f.add("payload", payload);
                frame(f);
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
            payload.add("stackTargetSpells", stackTargetSpellsJson(liveGame()));
            f.add("payload", payload);
            frame(f);
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
        @Override public void finishGame() { frame(notify("finishGame")); }
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
            frame(f);
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
                    o.add("trigger", trigger);
                }
                return o;
            } catch (final ReflectiveOperationException | RuntimeException e) {
                System.err.println("[bridge] confirmAbility: could not read the open confirm (" + e + "); it stays a question");
                return null;
            }
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
            frame(f);
        }

        /**
         * Wave 52 §S — two facts about the offered cards, read off Forge's own
         * abilities rather than card text, added to the frame as strict optional fields.
         *
         * <ul>
         * <li>{@code manaOnly}: the offered cards whose every playable ability is a mana
         * ability. Since w52's fork commit Forge offers a Signet ({@code {1},{T}}) at
         * priority, and a Signet is not a land, so the server's "nothing but lands is
         * actionable" pass would have become a stop for every seat holding one. Tapping
         * for mana is never by itself a reason to hold priority, land or not.</li>
         * <li>{@code phaseRestricted}: the offered permanents this seat controls with a
         * playable non-mana ability whose {@code ActivationPhases} restriction
         * ({@code SpellAbilityRestriction}, {@code SpellAbilityVariables.getPhases}) is
         * met now — Augur of Skulls in its controller's upkeep. Playable means
         * {@code getAllPossibleAbilities(player, true)} kept it, which runs the
         * restriction check. Battlefield only, never the hand: the card and its text are
         * on the table for everyone.</li>
         * </ul>
         *
         * Read on this seat's channel thread while the game thread is parked on the input
         * that pushed the set, as {@link #legalPlayers} does. A failure omits both fields,
         * which the server reads as "no such card" — the stop it always made.
         */
        private void offerFacts(final JsonObject f, final Iterable<CardView> cards) {
            final Game game = liveGame();
            final forge.game.player.Player mine = liveSelf(game);
            if (mine == null || cards == null) { return; }
            try {
                final JsonArray manaOnly = new JsonArray();
                final JsonArray phaseRestricted = new JsonArray();
                final java.util.Set<Integer> seen = new java.util.HashSet<>();
                for (final CardView cv : cards) {
                    if (cv == null || !seen.add(cv.getId())) { continue; }
                    final forge.game.card.Card c = game.findById(cv.getId());
                    if (c == null) { continue; }
                    boolean mana = false;
                    boolean other = false;
                    boolean restricted = false;
                    for (final SpellAbility sa : c.getAllPossibleAbilities(mine, true)) {
                        if (sa.isManaAbility()) { mana = true; continue; }
                        other = true;
                        if (c.isInPlay() && c.getController() == mine && sa.getRestrictions() != null
                                && !sa.getRestrictions().getPhases().isEmpty()) {
                            restricted = true;
                        }
                    }
                    // A tapped card offered with nothing playable is offered for its untap (a mana
                    // tap Forge can take back): mana too, never a reason to hold priority.
                    if (!other && (mana || c.isTapped())) { manaOnly.add(ref("card", cv.getId())); }
                    if (restricted) { phaseRestricted.add(ref("card", cv.getId())); }
                }
                f.add("manaOnly", manaOnly);
                f.add("phaseRestricted", phaseRestricted);
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
            final HostedMatch hm = new HostedMatch();
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
                if (state == null) { return; }
                state.applyToGame(hm.getGame());
                resyncSeats(hm.getGame());
                refreshActionable(hm.getGame());
            });
            return hm;
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
