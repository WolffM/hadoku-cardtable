/*
 * hadoku-cardtable: the Forge pool service.
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
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.GuiDesktop;
import forge.StaticData;
import forge.card.CardDb;
import forge.card.CardEdition;
import forge.card.CardRarity;
import forge.card.CardRules;
import forge.card.CardSplitType;
import forge.gui.GuiBase;
import forge.item.PaperCard;
import forge.item.SealedTemplate;
import forge.item.generation.BoosterGenerator;
import forge.localinstance.properties.ForgeNetPreferences;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.util.MyRandom;

import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;

/**
 * Answers draft-pool questions ({@code docs/planning/draft-pools-plan.md}, "The jar's pool
 * service") on its own long-lived JVM, separate from the per-match bridge
 * ({@code PlayBridge.java}) so a pool request can never stall a game. One JSON object per
 * line on stdin, one back on stdout — the same shape of protocol, a different, much smaller
 * vocabulary: {@code check}, {@code sets}, {@code setCards}, {@code boosters}, {@code stop}.
 *
 * <p>Compiled and launched by {@code apps/server/src/pools/forge.ts}, which reuses
 * {@code host.ts}'s {@code jvmHostConfig}/{@code bridgeLaunch} (the same compile-once,
 * launch-by-classname helpers the match bridge uses) rather than duplicating them — see
 * that file's header for why.
 *
 * <p>No match, no lobby, no network server: just {@code FModel.initialize} for the card
 * database ({@code StaticData}), then {@code CardEdition.hasBoosterTemplate},
 * {@code BoosterGenerator.getBoosterPack} and {@code MyRandom.setRandom}, exactly as
 * verified in the plan. {@code GuiDesktop} is used directly (no bridge-specific EDT
 * overrides needed — nothing here ever calls {@code hostMatch}).
 *
 * <p>{@code handleCheck} calls {@link PlayBridge#forgeCardName} directly — a
 * package-private static method of the sibling class, reachable because both
 * classes are top-level in the same (unnamed) package — rather than
 * reimplementing the Scryfall-name-to-Forge-name rule a second time. That is
 * why {@code host.ts}'s {@code bridgeLaunch} compiles this file with
 * {@code PlayBridge.java}'s own directory on {@code javac}'s
 * {@code -sourcepath}: without it, compiling {@code PoolService.java} alone
 * cannot resolve {@code PlayBridge}, and the no-javac source-launcher fallback
 * cannot resolve it at all (JEP 330's single-file mode has no sourcepath), so
 * {@code forge.ts} refuses to spawn in that case rather than let the JVM fail
 * to compile silently underneath it.
 */
public final class PoolService {
    private PoolService() { }

    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final SimpleDateFormat ISO_DATE = new SimpleDateFormat("yyyy-MM-dd");

    /** The real stdout, captured before Forge's own output is redirected. */
    private static PrintStream protocol;

    /**
     * Forge's own {@code System.out}: progress chatter, never a warning or an error, which Forge
     * writes to {@code System.err} (kept as it is). A booster draw alone prints a line per slot
     * ({@code BoosterGenerator}, {@code BoosterSlot}), which was two-thirds of the server's whole log;
     * so it is counted, not printed, and each phase leaves one summary line instead ({@link #quiet}).
     */
    private static final class LineCounter extends OutputStream {
        private long lines;

        @Override
        public void write(final int b) {
            if (b == '\n') { lines++; }
        }

        @Override
        public void write(final byte[] buf, final int off, final int len) {
            for (int i = off; i < off + len; i++) {
                if (buf[i] == '\n') { lines++; }
            }
        }

        long take() {
            final long n = lines;
            lines = 0;
            return n;
        }
    }

    private static final LineCounter FORGE_OUT = new LineCounter();

    /** One line for a phase's worth of Forge's own output: how much there was, and how long the phase took. */
    private static void quiet(final String phase, final long startedNanos) {
        final long n = FORGE_OUT.take();
        if (n == 0) { return; }
        System.err.println("[PoolService] " + phase + ": " + n + " lines of Forge output in " + (System.nanoTime() - startedNanos) / 1_000_000 + " ms");
    }

    public static void main(final String[] args) throws Exception {
        protocol = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        System.setOut(new PrintStream(FORGE_OUT, true, StandardCharsets.UTF_8));
        final long boot = System.nanoTime();

        GuiBase.setInterface(new GuiDesktop());
        FModel.initialize(null, prefs -> {
            prefs.setPref(FPref.LOAD_CARD_SCRIPTS_LAZILY, false);
            prefs.setPref(FPref.UI_LANGUAGE, "en-US");
            return null;
        });
        if (StaticData.instance() == null) {
            fatal("Forge did not initialise (no StaticData) — is res/ in the working directory?");
            return;
        }
        // UPnP ASK would open a modal dialog; this process never hosts a network server at all,
        // but FModel.initialize touches net preferences regardless. See PlayBridge.bootModel.
        FModel.getNetPreferences().setPref(ForgeNetPreferences.FNetPref.UPnP, "NEVER");

        quiet("boot", boot);
        emit(line("ready"));

        final BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String text;
        while ((text = in.readLine()) != null) {
            if (text.isBlank()) { continue; }
            handle(text);
        }
        // stdin closed (the Node side exited without sending stop): go quietly.
        Runtime.getRuntime().halt(0);
    }

    private static JsonObject line(final String t) {
        final JsonObject o = new JsonObject();
        o.addProperty("t", t);
        return o;
    }

    private static void emit(final JsonObject o) {
        protocol.println(GSON.toJson(o));
        protocol.flush();
    }

    private static void fatal(final String message) {
        final JsonObject o = line("fatal");
        o.addProperty("message", message);
        emit(o);
        Runtime.getRuntime().halt(1);
    }

    /** One request line in, one response line out. A bad line (no id) is logged to stderr, never answered. */
    private static void handle(final String text) {
        final JsonObject req;
        try {
            req = JsonParser.parseString(text).getAsJsonObject();
        } catch (final Exception e) {
            System.err.println("[PoolService] not a JSON object, ignored: " + text);
            return;
        }
        final String id = req.has("id") && !req.get("id").isJsonNull() ? req.get("id").getAsString() : null;
        if (id == null) {
            System.err.println("[PoolService] request has no id, ignored: " + text);
            return;
        }
        final String op = req.has("op") && !req.get("op").isJsonNull() ? req.get("op").getAsString() : null;
        final long started = System.nanoTime();
        final JsonObject resp = new JsonObject();
        resp.addProperty("id", id);
        try {
            if ("stop".equals(op)) {
                resp.addProperty("ok", true);
                emit(resp);
                Runtime.getRuntime().halt(0);
                return;
            } else if ("check".equals(op)) {
                handleCheck(req, resp);
            } else if ("sets".equals(op)) {
                handleSets(resp);
            } else if ("setCards".equals(op)) {
                handleSetCards(req, resp);
            } else if ("boosters".equals(op)) {
                handleBoosters(req, resp);
            } else {
                resp.addProperty("ok", false);
                resp.addProperty("error", "unknown op: " + op);
            }
        } catch (final Exception e) {
            resp.addProperty("ok", false);
            resp.addProperty("error", e.toString());
        }
        quiet(String.valueOf(op), started);
        emit(resp);
    }

    /** Names that would refuse the match a cube or deck drafts into — not merely names the card DB has never heard of. */
    private static void handleCheck(final JsonObject req, final JsonObject resp) {
        final CardDb cards = StaticData.instance().getCommonCards();
        final JsonArray unknown = new JsonArray();
        for (final JsonElement e : req.getAsJsonArray("names")) {
            final String name = e.getAsString();
            if (!isPlayable(name, cards)) { unknown.add(name); }
        }
        resp.addProperty("ok", true);
        resp.add("unknown", unknown);
    }

    /**
     * Would a match play {@code name}, exactly as {@code PlayBridge.parseDeck}/
     * {@code unsupportedIn} already decide for a drafted deck? Two rules, both
     * already applied there, both needed here:
     *
     * <ol>
     *   <li>{@code name} may be Scryfall's {@code Front // Back} for a two-faced
     *   card — the shape every {@code DraftCard} and so every cube's name list
     *   carries. Forge never indexes a transform/MDFC/adventure/flip card under
     *   that joined form ({@code PlayBridge.forgeCardName}'s own doc), so without
     *   this step every one of those names comes back "unplayable" even though
     *   Forge plays the card happily under its own name — the bug this method
     *   exists to fix (a real cube's plan was refused wholesale on exactly this).
     *   {@code forgeCardName} resolves it; a pair that is not a real card (the
     *   back half wrong) is left as written, which then correctly fails the
     *   lookup below.</li>
     *   <li>Known to the card DB is not the same as playable: {@code
     *   CardRules.isUnsupported()} is what {@code Deck.getValid} drops at match
     *   start ({@code unsupportedIn}), so a known-but-unsupported card is
     *   unplayable too.</li>
     * </ol>
     */
    private static boolean isPlayable(final String name, final CardDb cards) {
        final String forgeName = PlayBridge.forgeCardName(name, n -> cards.getRules(n, false));
        final PaperCard card = cards.getCard(forgeName);
        if (card == null) { return false; }
        final CardRules rules = card.getRules();
        return rules == null || !rules.isUnsupported();
    }

    /** Every set the jar can make a draft booster for (ruling 8: searchable, newest first is the caller's job). */
    private static void handleSets(final JsonObject resp) {
        final JsonArray sets = new JsonArray();
        for (final CardEdition ed : StaticData.instance().getEditions()) {
            if (!ed.hasBoosterTemplate()) { continue; }
            final JsonObject s = new JsonObject();
            s.addProperty("code", ed.getCode());
            s.addProperty("name", ed.getName());
            s.addProperty("date", ISO_DATE.format(ed.getDate()));
            s.addProperty("type", ed.getType().name());
            s.addProperty("scryfallCode", scryfallCode(ed.getCode()));
            sets.add(s);
        }
        resp.addProperty("ok", true);
        resp.add("sets", sets);
    }

    /** Non-basic unique names in the set (ruling 2: set-cube is one copy of every non-basic card). */
    private static void handleSetCards(final JsonObject req, final JsonObject resp) {
        final String code = req.get("code").getAsString();
        final CardEdition ed = StaticData.instance().getEditions().get(code);
        if (ed == null) {
            resp.addProperty("ok", false);
            resp.addProperty("error", "no such set: " + code);
            return;
        }
        final LinkedHashSet<String> names = new LinkedHashSet<>();
        for (final CardEdition.EditionEntry entry : ed.getAllCardsInSet()) {
            if (entry.rarity() != CardRarity.BasicLand) { names.add(entry.name()); }
        }
        final JsonArray arr = new JsonArray();
        for (final String n : names) { arr.add(n); }
        resp.addProperty("ok", true);
        resp.add("cards", arr);
    }

    /**
     * {@code count} draft boosters of {@code code}, seeded through {@link MyRandom#setRandom}
     * so the same seed gives the same boosters (same seed, same sequence of
     * {@link BoosterGenerator#getBoosterPack} calls, deterministic {@link Random}).
     *
     * {@code getBoosterPack} may add one foil of any rarity in place of a common slot card
     * ({@code FoilAlwaysInCommonSlot}, default true); {@link #draftPack} leaves it out with the
     * basic land, so each card's {@code foil} is false, sent so a reader never has to guess.
     */
    private static void handleBoosters(final JsonObject req, final JsonObject resp) {
        final String code = req.get("code").getAsString();
        final int count = req.get("count").getAsInt();
        final String seed = req.get("seed").getAsString();
        final CardEdition ed = StaticData.instance().getEditions().get(code);
        if (ed == null || !ed.hasBoosterTemplate()) {
            resp.addProperty("ok", false);
            resp.addProperty("error", "no draft booster for set: " + code);
            return;
        }
        final SealedTemplate template = ed.getBoosterTemplate();
        MyRandom.setRandom(new Random(seedToLong(seed)));
        final JsonArray boosters = new JsonArray();
        for (int i = 0; i < count; i++) {
            final List<PaperCard> pack = draftPack(BoosterGenerator.getBoosterPack(template), ed);
            final JsonArray packArr = new JsonArray();
            for (final PaperCard pc : pack) {
                final JsonObject c = new JsonObject();
                c.addProperty("name", pc.getName());
                c.addProperty("set", scryfallCode(pc.getEdition()));
                c.addProperty("collectorNumber", pc.getCollectorNumber());
                c.addProperty("foil", pc.isFoil());
                packArr.add(c);
            }
            boosters.add(packArr);
        }
        resp.addProperty("ok", true);
        resp.add("boosters", boosters);
    }

    /**
     * The set code Scryfall prints {@code forgeCode} under, which is how the server's card catalog
     * keys a printing: Conflux is Forge's CFX and Scryfall's CON. The code itself where Forge knows
     * no other.
     */
    private static String scryfallCode(final String forgeCode) {
        final CardEdition ed = StaticData.instance().getEditions().get(forgeCode);
        return ed == null ? forgeCode : ed.getScryfallCode().toUpperCase();
    }

    /** The layouts a booster deals in a slot of their own, never as a top-up common. */
    private static final Set<CardSplitType> DOUBLE_FACED = EnumSet.of(CardSplitType.Transform, CardSplitType.Modal, CardSplitType.Meld);

    /** Every draft pack's size, whatever the set's booster holds. */
    private static final int PACK_SIZE = 15;

    /**
     * A booster as a draft pack (the operator, 2026-10-22: "i dont like the land/foil being in the
     * packs. lets make sure all packs are 15 cards"): its basic land and its foils left out, then
     * topped up to {@link #PACK_SIZE} with the set's commons not already in it, or cut to it by its
     * last commons. A play booster (Bloomburrow: 14, a land and a foil wildcard among them) and a
     * draft booster with a land slot (Dominaria United's 15th) both come out 15. The top-up is
     * never a double-faced card: a set that has them deals them in their own slot (Innistrad's
     * {@code 1 dfc}, its commons {@code !dfc}), so a common Delver of Secrets would be a second.
     */
    private static List<PaperCard> draftPack(final List<PaperCard> booster, final CardEdition ed) {
        final List<PaperCard> pack = new ArrayList<>();
        for (final PaperCard pc : booster) {
            if (!pc.isFoil() && pc.getRarity() != CardRarity.BasicLand) { pack.add(pc); }
        }
        final Set<String> held = new HashSet<>();
        for (final PaperCard pc : pack) { held.add(pc.getName()); }
        final List<PaperCard> commons = new ArrayList<>();
        final CardDb cards = StaticData.instance().getCommonCards();
        for (final CardEdition.EditionEntry entry : ed.getAllCardsInSet()) {
            if (entry.rarity() != CardRarity.Common || held.contains(entry.name())) { continue; }
            final PaperCard pc = cards.getCard(entry.name(), ed.getCode(), entry.collectorNumber());
            if (pc == null || DOUBLE_FACED.contains(pc.getRules().getSplitType())) { continue; }
            if (commons.stream().noneMatch(c -> c.getName().equals(pc.getName()))) { commons.add(pc); }
        }
        while (pack.size() < PACK_SIZE && !commons.isEmpty()) {
            pack.add(commons.remove(MyRandom.getRandom().nextInt(commons.size())));
        }
        for (int i = pack.size() - 1; pack.size() > PACK_SIZE && i >= 0; i--) {
            if (pack.get(i).getRarity() == CardRarity.Common) { pack.remove(i); }
        }
        return pack;
    }

    /** A stable 64-bit seed from an arbitrary string, so the wire seed can be anything the caller likes. */
    private static long seedToLong(final String seed) {
        try {
            final MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
            final byte[] digest = sha256.digest(seed.getBytes(StandardCharsets.UTF_8));
            long v = 0;
            for (int i = 0; i < 8; i++) { v = (v << 8) | (digest[i] & 0xFFL); }
            return v;
        } catch (final Exception e) {
            return seed.hashCode();
        }
    }
}
