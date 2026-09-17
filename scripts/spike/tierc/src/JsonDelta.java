package spike.tierc;

import com.google.common.collect.Multiset;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import forge.card.CardTypeView;
import forge.card.ColorSet;
import forge.card.CardStateName;
import forge.card.mana.ManaCost;
import forge.game.card.CardView;
import forge.game.card.CounterType;
import forge.game.keyword.Keyword;
import forge.game.keyword.KeywordCollectionView;
import forge.game.keyword.KeywordView;
import forge.gamemodes.net.DeltaPacket;
import forge.item.IPaperCard;
import forge.trackable.TrackableCollection;
import forge.trackable.TrackableObject;
import forge.trackable.TrackableProperty;

import java.lang.reflect.RecordComponent;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * hadoku-cardtable Wave 7 lane A — a JSON codec for Forge's {@link DeltaPacket},
 * and the census of what it can and cannot carry.
 *
 * <p><b>What question this answers.</b> A browser client cannot consume Java
 * serialization, so PR-4's Tier C ("the state channel") needs the delta stream
 * expressed as JSON. `DeltaPacket` is
 * {@code Map<Integer deltaKey, Map<TrackableProperty, Object>>} — the keys are
 * settled (`DeltaPacket.makeDeltaKey` packs (typeTag,id) into one int), so the
 * open question is entirely about the <i>values</i>: what Java objects actually
 * turn up in those maps during a real game, and can each of them be written to
 * JSON and read back to something equal?
 *
 * <p><b>Three outcomes, not two.</b> Every value is classified as:
 * <ul>
 *   <li><b>PLAIN</b> — JSON-native. Any client in any language can rebuild it
 *       from the JSON alone: booleans, numbers, strings, enum names, object
 *       references by id, and collections/maps of those.</li>
 *   <li><b>DERIVED</b> — the JSON carries enough information, but rebuilding
 *       the Java object needs a Forge-side parser or Forge's card database
 *       ({@code ManaCost.deserialize}, {@code Keyword.getInstance},
 *       a {@code PaperCard} lookup). A browser
 *       client would have to re-implement the parser or accept the raw text.
 *       The bytes round-trip; the <i>object</i> only round-trips inside a
 *       JVM that has Forge on the classpath.</li>
 *   <li><b>UNSUPPORTED</b> — no JSON form at all without inventing a schema.
 *       These are the ones that decide whether Tier C is a week or a
 *       quarter, so they are reported by (property, class) with counts.</li>
 * </ul>
 *
 * <p>A reference is encoded as {@code {"t":"ref","k":typeTag,"id":n}} and
 * compared by (typeTag, id), not by object identity. That is the correct
 * comparison: {@link TrackableObject} <i>is</i> an id plus a property bag, and
 * every object a reference points at arrives in the same stream under its own
 * delta key.
 */
public final class JsonDelta {

    private JsonDelta() {}

    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final Gson GSON_PRETTY = new GsonBuilder().serializeNulls().setPrettyPrinting().create();

    // ---------------------------------------------------------------- classes

    /** How well a value survives the trip. */
    public enum Fidelity { PLAIN, DERIVED, UNSUPPORTED }

    /** Thrown by {@link #encode} for a value with no JSON form. */
    public static final class Unsupported extends RuntimeException {
        private static final long serialVersionUID = 1L;
        public final String valueClass;
        Unsupported(final String valueClass) {
            super("no JSON form for " + valueClass);
            this.valueClass = valueClass;
        }
    }

    /** Thrown by {@link #decode} when the JSON is well-formed but cannot be rebuilt. */
    public static final class Undecodable extends RuntimeException {
        private static final long serialVersionUID = 1L;
        public final String tag;
        Undecodable(final String tag, final String why) {
            super("cannot rebuild tag=" + tag + ": " + why);
            this.tag = tag;
        }
    }

    /** One (property, value-class) cell of the census. */
    public static final class Cell {
        public final String property;
        public final String valueClass;
        public String tag = "?";
        public Fidelity fidelity = Fidelity.PLAIN;
        public int seen;
        public int ok;
        public int failEncode;
        public int failDecode;
        public int failCompare;
        public String firstFailure;

        Cell(final String property, final String valueClass) {
            this.property = property;
            this.valueClass = valueClass;
        }

        public boolean clean() {
            return failEncode == 0 && failDecode == 0 && failCompare == 0;
        }
    }

    /** Accumulated over every packet of a match. */
    public static final class Report {
        public final Map<String, Cell> cells = new TreeMap<>();
        public int packets;
        public int packetsWithEvents;
        public int eventItems;
        public final Map<String, Integer> eventItemClasses = new TreeMap<>();
        /** Events whose opaque byte payload survived base64 -> JSON -> base64 intact. */
        public int eventsBytewiseOk;
        public int eventsFailEncode;
        public int eventsFailDecode;
        public int eventsFailCompare;
        public long eventJsonBytes;
        public String firstEventFailure;
        public int values;
        public int valuesOk;
        public int valuesFailEncode;
        public int valuesFailDecode;
        public int valuesFailCompare;
        /** Packets whose top-level scalars (seq, checksum, checksumProperties, keys) round-tripped. */
        public int packetsSkeletonOk;

        Cell cell(final TrackableProperty prop, final Object value) {
            final String pc = value == null ? "null" : value.getClass().getName();
            final String key = prop.name() + "\t" + pc;
            return cells.computeIfAbsent(key, k -> new Cell(prop.name(), pc));
        }
    }

    // --------------------------------------------------------------- mutation

    /**
     * Mutation fixture for the wave's "a check that cannot fail is not a check"
     * rule. {@code -Dtierc.mutate=corrupt-value} perturbs the Nth successfully
     * decoded value ({@code -Dtierc.mutateAt}, default 1) so the comparator has
     * something to catch. It mutates THIS spike's own decode path and nothing
     * in Forge.
     */
    private static final boolean MUTATE_CORRUPT =
            "corrupt-value".equals(System.getProperty("tierc.mutate"));
    private static final int MUTATE_AT = Integer.getInteger("tierc.mutateAt", 1);
    private static int decodedCount = 0;

    private static Object maybeCorrupt(final Object decoded) {
        if (!MUTATE_CORRUPT) {
            return decoded;
        }
        decodedCount++;
        if (decodedCount != MUTATE_AT) {
            return decoded;
        }
        System.out.println("  [mutate] corrupting decoded value #" + decodedCount
                + " (" + (decoded == null ? "null" : decoded.getClass().getSimpleName()) + ")");
        if (decoded instanceof Boolean b) { return !b; }
        if (decoded instanceof Integer i) { return i + 1; }
        if (decoded instanceof Long l) { return l + 1; }
        if (decoded instanceof String s) { return s + "-CORRUPTED"; }
        return null;
    }

    // --------------------------------------------------------------- encoding

    private static JsonObject tagged(final String t) {
        final JsonObject o = new JsonObject();
        o.addProperty("t", t);
        return o;
    }

    /** Fidelity of the last {@link #encode} call — set as a side effect, read immediately. */
    private static Fidelity lastFidelity = Fidelity.PLAIN;

    private static void note(final Fidelity f) {
        if (f.ordinal() > lastFidelity.ordinal()) {
            lastFidelity = f;
        }
    }

    public static JsonElement encodeTop(final Object v) {
        lastFidelity = Fidelity.PLAIN;
        return encode(v);
    }

    public static Fidelity lastFidelity() {
        return lastFidelity;
    }

    @SuppressWarnings("unchecked")
    public static JsonElement encode(final Object v) {
        if (v == null) {
            return JsonNull.INSTANCE;
        }

        // ---- JSON-native scalars -------------------------------------------
        if (v instanceof Boolean b) { final JsonObject o = tagged("bool"); o.addProperty("v", b); return o; }
        if (v instanceof Integer i) { final JsonObject o = tagged("int"); o.addProperty("v", i); return o; }
        if (v instanceof Long l) { final JsonObject o = tagged("long"); o.addProperty("v", l); return o; }
        if (v instanceof Short s) { final JsonObject o = tagged("short"); o.addProperty("v", s); return o; }
        if (v instanceof Byte b) { final JsonObject o = tagged("byte"); o.addProperty("v", b); return o; }
        if (v instanceof Float f) { final JsonObject o = tagged("float"); o.addProperty("v", f); return o; }
        if (v instanceof Double d) { final JsonObject o = tagged("double"); o.addProperty("v", d); return o; }
        if (v instanceof String s) { final JsonObject o = tagged("str"); o.addProperty("v", s); return o; }

        // NOTE: forge.card.ColorSet is itself an enum (`ColorSet.java:38`), so it
        // lands here and needs no bespoke encoder. Lane F's static sizing listed
        // ColorSetType among the 13 "bespoke" properties; measured, it is free.
        if (v instanceof Enum<?> e) {
            final JsonObject o = tagged("enum");
            o.addProperty("c", e.getDeclaringClass().getName());
            o.addProperty("v", e.name());
            return o;
        }

        if (v instanceof byte[] bytes) {
            final JsonObject o = tagged("bytes");
            o.addProperty("v", Base64.getEncoder().encodeToString(bytes));
            return o;
        }
        if (v instanceof int[] ints) {
            final JsonObject o = tagged("ints");
            final JsonArray a = new JsonArray();
            for (final int i : ints) { a.add(i); }
            o.add("v", a);
            return o;
        }

        // ---- tracked object references -------------------------------------
        if (v instanceof CardView.CardStateView csv) {
            final JsonObject o = tagged("ref");
            o.addProperty("k", DeltaPacket.TYPE_CSV);
            o.addProperty("id", csv.getId());
            o.addProperty("s", csv.getState() == null ? null : csv.getState().name());
            return o;
        }
        if (v instanceof TrackableObject to) {
            final int k = DeltaPacket.typeTagFor(to);
            if (k < 0) {
                // A TrackableObject that DeltaPacket has no type tag for cannot be
                // referenced by id in the delta key space at all — Java serialization
                // inlines the whole object graph instead. CombatView is the live case.
                throw new Unsupported(to.getClass().getName() + " (TrackableObject with no DeltaPacket type tag)");
            }
            final JsonObject o = tagged("ref");
            o.addProperty("k", k);
            o.addProperty("id", to.getId());
            return o;
        }

        // ---- collections -----------------------------------------------------
        if (v instanceof TrackableCollection<?> tc) {
            final JsonObject o = tagged("refs");
            final JsonArray a = new JsonArray();
            for (final Object item : tc) { a.add(encode(item)); }
            o.add("v", a);
            return o;
        }
        if (v instanceof Multiset<?> ms) {
            final JsonObject o = tagged("multiset");
            final JsonArray a = new JsonArray();
            for (final Multiset.Entry<?> e : ((Multiset<Object>) ms).entrySet()) {
                final JsonArray pair = new JsonArray();
                final Object el = e.getElement();
                if (el instanceof CounterType ct) {
                    pair.add(ct.getName());
                    note(Fidelity.DERIVED); // rebuilt through CounterType.getType(name)
                } else {
                    throw new Unsupported("Multiset element " + (el == null ? "null" : el.getClass().getName()));
                }
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

        // ---- Forge value objects: JSON carries the text, Forge rebuilds it ----
        if (v instanceof ManaCost mc) {
            note(Fidelity.DERIVED);
            final JsonObject o = tagged("manacost");
            o.addProperty("v", ManaCost.serialize(mc));
            return o;
        }
        if (v instanceof CardTypeView ctv) {
            // NOT ctv.toString(). Forge's CardType.toString() emits the printed
            // type line ("Creature - Wurm") and CardType.parse() does not accept
            // it back: parse() splits on spaces and classifies the literal "-"
            // as a subtype, so the round trip yields "Creature - - Wurm". The
            // two are not inverses in stock Forge, and a bridge that assumed
            // they were would corrupt every creature's type line. Carry the
            // three token sets explicitly instead — self-describing, and what a
            // browser client actually wants.
            final JsonObject o = tagged("cardtype");
            o.add("sup", strings(namesOf(ctv.getSupertypes())));
            o.add("core", strings(namesOf(ctv.getCoreTypes())));
            o.add("sub", strings(ctv.getSubtypes()));
            o.addProperty("all", ctv.hasAllCreatureTypes());
            final List<String> exc = new ArrayList<>();
            for (final String s : ctv.getExcludedCreatureSubTypes()) { exc.add(s); }
            o.add("exc", strings(exc));
            return o;
        }
        if (v instanceof KeywordCollectionView kcv) {
            note(Fidelity.DERIVED);
            final JsonObject o = tagged("keywords");
            final JsonArray a = new JsonArray();
            for (final KeywordView kv : kcv) { a.add(kv.original()); }
            o.add("v", a);
            return o;
        }
        if (v instanceof IPaperCard pc) {
            note(Fidelity.DERIVED);
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

        // ---- the record types the protocol wraps events in --------------------
        if (v.getClass().isRecord()) {
            final JsonObject o = tagged("record");
            o.addProperty("c", v.getClass().getName());
            final JsonArray a = new JsonArray();
            try {
                for (final RecordComponent rc : v.getClass().getRecordComponents()) {
                    rc.getAccessor().setAccessible(true);
                    final JsonArray pair = new JsonArray();
                    pair.add(rc.getName());
                    pair.add(encode(rc.getAccessor().invoke(v)));
                    a.add(pair);
                }
            } catch (final ReflectiveOperationException ex) {
                throw new Unsupported(v.getClass().getName() + " (record, inaccessible: " + ex + ")");
            }
            o.add("v", a);
            // A record is only reconstructible outside its package with a
            // canonical constructor we can reach; we do not attempt it.
            note(Fidelity.DERIVED);
            return o;
        }

        throw new Unsupported(v.getClass().getName());
    }

    private static List<String> namesOf(final Collection<? extends Enum<?>> es) {
        final List<String> r = new ArrayList<>();
        for (final Enum<?> e : es) { r.add(e.name()); }
        return r;
    }

    private static JsonArray strings(final Collection<String> ss) {
        final JsonArray a = new JsonArray();
        for (final String s : ss) { a.add(s); }
        return a;
    }

    private static List<String> stringList(final JsonArray a) {
        final List<String> r = new ArrayList<>();
        for (final JsonElement e : a) { r.add(e.getAsString()); }
        return r;
    }

    private static JsonArray intListList(final List<List<Integer>> lists) {
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

    // --------------------------------------------------------------- decoding

    /** A decoded reference. Compared to the original by (typeTag, id, state). */
    public record Ref(int k, int id, String state) {}

    /** A decoded record we deliberately do not rebuild — compared component-wise. */
    public record Rec(String cls, Map<String, Object> components) {}

    public static Object decode(final JsonElement e) {
        if (e == null || e.isJsonNull()) {
            return null;
        }
        if (!e.isJsonObject()) {
            throw new Undecodable("?", "not a tagged object: " + e);
        }
        final JsonObject o = e.getAsJsonObject();
        final String t = o.get("t").getAsString();
        switch (t) {
            case "bool":   return o.get("v").getAsBoolean();
            case "int":    return o.get("v").getAsInt();
            case "long":   return o.get("v").getAsLong();
            case "short":  return o.get("v").getAsShort();
            case "byte":   return o.get("v").getAsByte();
            case "float":  return o.get("v").getAsFloat();
            case "double": return o.get("v").getAsDouble();
            case "str":    return o.get("v").getAsString();
            case "enum": {
                final String cls = o.get("c").getAsString();
                try {
                    @SuppressWarnings({"unchecked", "rawtypes"})
                    final Object val = Enum.valueOf((Class<? extends Enum>) Class.forName(cls), o.get("v").getAsString());
                    return val;
                } catch (final ClassNotFoundException ex) {
                    throw new Undecodable(t, "no such enum class " + cls);
                }
            }
            case "bytes":  return Base64.getDecoder().decode(o.get("v").getAsString());
            case "ints": {
                final JsonArray a = o.getAsJsonArray("v");
                final int[] r = new int[a.size()];
                for (int i = 0; i < r.length; i++) { r[i] = a.get(i).getAsInt(); }
                return r;
            }
            case "ref": {
                final JsonElement s = o.get("s");
                return new Ref(o.get("k").getAsInt(), o.get("id").getAsInt(),
                        s == null || s.isJsonNull() ? null : s.getAsString());
            }
            case "refs": case "list": {
                final List<Object> r = new ArrayList<>();
                for (final JsonElement it : o.getAsJsonArray("v")) { r.add(decode(it)); }
                return r;
            }
            case "set": {
                final Set<Object> r = new LinkedHashSet<>();
                for (final JsonElement it : o.getAsJsonArray("v")) { r.add(decode(it)); }
                return r;
            }
            case "map": {
                final Map<Object, Object> r = new LinkedHashMap<>();
                for (final JsonElement it : o.getAsJsonArray("v")) {
                    final JsonArray pair = it.getAsJsonArray();
                    r.put(decode(pair.get(0)), decode(pair.get(1)));
                }
                return r;
            }
            case "multiset": {
                final Map<String, Integer> r = new LinkedHashMap<>();
                for (final JsonElement it : o.getAsJsonArray("v")) {
                    final JsonArray pair = it.getAsJsonArray();
                    final String name = pair.get(0).getAsString();
                    if (CounterType.getType(name) == null) {
                        throw new Undecodable(t, "CounterType.getType(\"" + name + "\") returned null");
                    }
                    r.put(name, pair.get(1).getAsInt());
                }
                return r;
            }
            case "manacost": {
                final ManaCost mc = ManaCost.deserialize(o.get("v").getAsString());
                if (mc == null) { throw new Undecodable(t, "ManaCost.deserialize returned null"); }
                return mc;
            }
            case "cardtype": {
                // Decoded to the plain structure, not back into a Forge CardType:
                // that structure IS what a browser client holds, and rebuilding a
                // CardType would only re-test Forge's own constructors.
                final Map<String, Object> m = new LinkedHashMap<>();
                m.put("sup", stringList(o.getAsJsonArray("sup")));
                m.put("core", stringList(o.getAsJsonArray("core")));
                m.put("sub", stringList(o.getAsJsonArray("sub")));
                m.put("all", o.get("all").getAsBoolean());
                m.put("exc", stringList(o.getAsJsonArray("exc")));
                return m;
            }
            case "keywords": {
                final List<KeywordView> views = new ArrayList<>();
                for (final JsonElement it : o.getAsJsonArray("v")) {
                    final String original = it.getAsString();
                    try {
                        views.add(Keyword.getInstance(original).getView());
                    } catch (final RuntimeException ex) {
                        throw new Undecodable(t, "Keyword.getInstance(\"" + original + "\") -> " + ex);
                    }
                }
                return new KeywordCollectionView(views);
            }
            case "papercard": {
                final Map<String, Object> m = new LinkedHashMap<>();
                m.put("n", o.get("n").getAsString());
                m.put("e", o.get("e").getAsString());
                m.put("a", o.get("a").getAsInt());
                m.put("f", o.get("f").getAsBoolean());
                return m;
            }
            case "combat": {
                final Map<String, Object> m = new LinkedHashMap<>();
                m.put("atk", o.get("atk").toString());
                m.put("def", o.get("def").toString());
                m.put("blk", o.get("blk").toString());
                m.put("pblk", o.get("pblk").toString());
                return m;
            }
            case "record": {
                final Map<String, Object> comps = new LinkedHashMap<>();
                for (final JsonElement it : o.getAsJsonArray("v")) {
                    final JsonArray pair = it.getAsJsonArray();
                    comps.put(pair.get(0).getAsString(), decode(pair.get(1)));
                }
                return new Rec(o.get("c").getAsString(), comps);
            }
            default:
                throw new Undecodable(t, "unknown tag");
        }
    }

    // -------------------------------------------------------------- comparing

    /**
     * Value equality across the trip. A reference compares by (typeTag, id):
     * that is the whole contract of {@link TrackableObject}, and the object it
     * points at travels in the same stream under its own delta key.
     */
    @SuppressWarnings("unchecked")
    public static boolean same(final Object original, final Object decoded) {
        if (original == null) {
            return decoded == null;
        }
        if (decoded == null) {
            return false;
        }

        if (original instanceof Boolean || original instanceof Integer || original instanceof Long
                || original instanceof Short || original instanceof Byte || original instanceof Float
                || original instanceof Double || original instanceof String || original instanceof Enum<?>) {
            return original.equals(decoded);
        }
        if (original instanceof byte[] a) {
            return decoded instanceof byte[] b && Arrays.equals(a, b);
        }
        if (original instanceof int[] a) {
            return decoded instanceof int[] b && Arrays.equals(a, b);
        }
        if (original instanceof CardView.CardStateView csv) {
            return decoded instanceof Ref r && r.k() == DeltaPacket.TYPE_CSV && r.id() == csv.getId()
                    && java.util.Objects.equals(csv.getState() == null ? null : csv.getState().name(), r.state());
        }
        if (original instanceof TrackableObject to) {
            return decoded instanceof Ref r && r.k() == DeltaPacket.typeTagFor(to) && r.id() == to.getId();
        }
        if (original instanceof TrackableCollection<?> tc) {
            if (!(decoded instanceof List<?> l) || l.size() != tc.size()) { return false; }
            int i = 0;
            for (final Object item : tc) {
                if (!same(item, l.get(i++))) { return false; }
            }
            return true;
        }
        if (original instanceof Multiset<?> ms) {
            if (!(decoded instanceof Map<?, ?> m) || m.size() != ms.entrySet().size()) { return false; }
            for (final Multiset.Entry<?> e : ((Multiset<Object>) ms).entrySet()) {
                final Object el = e.getElement();
                if (!(el instanceof CounterType ct)) { return false; }
                final Object got = m.get(ct.getName());
                if (!Integer.valueOf(e.getCount()).equals(got)) { return false; }
            }
            return true;
        }
        if (original instanceof Map<?, ?> om) {
            if (!(decoded instanceof Map<?, ?> dm) || dm.size() != om.size()) { return false; }
            // Decoded keys are value-equal but not necessarily the same objects
            // (a Ref, not a CardView), so match pairwise rather than by lookup.
            final List<Map.Entry<?, ?>> pool = new ArrayList<>(dm.entrySet());
            outer:
            for (final Map.Entry<?, ?> oe : om.entrySet()) {
                for (int i = 0; i < pool.size(); i++) {
                    if (same(oe.getKey(), pool.get(i).getKey()) && same(oe.getValue(), pool.get(i).getValue())) {
                        pool.remove(i);
                        continue outer;
                    }
                }
                return false;
            }
            return true;
        }
        if (original instanceof Set<?> os) {
            if (!(decoded instanceof Set<?> ds) || ds.size() != os.size()) { return false; }
            final List<Object> pool = new ArrayList<>(ds);
            outer:
            for (final Object item : os) {
                for (int i = 0; i < pool.size(); i++) {
                    if (same(item, pool.get(i))) { pool.remove(i); continue outer; }
                }
                return false;
            }
            return true;
        }
        if (original instanceof Collection<?> oc) {
            if (!(decoded instanceof List<?> l) || l.size() != oc.size()) { return false; }
            int i = 0;
            for (final Object item : oc) {
                if (!same(item, l.get(i++))) { return false; }
            }
            return true;
        }
        if (original instanceof ManaCost mc) {
            return decoded instanceof ManaCost d && ManaCost.serialize(mc).equals(ManaCost.serialize(d));
        }
        if (original instanceof CardTypeView ctv) {
            if (!(decoded instanceof Map<?, ?> m)) { return false; }
            final List<String> exc = new ArrayList<>();
            for (final String s : ctv.getExcludedCreatureSubTypes()) { exc.add(s); }
            return namesOf(ctv.getSupertypes()).equals(m.get("sup"))
                    && namesOf(ctv.getCoreTypes()).equals(m.get("core"))
                    && new ArrayList<>(ctv.getSubtypes()).equals(m.get("sub"))
                    && Boolean.valueOf(ctv.hasAllCreatureTypes()).equals(m.get("all"))
                    && exc.equals(m.get("exc"));
        }
        if (original instanceof KeywordCollectionView kcv) {
            if (!(decoded instanceof KeywordCollectionView d)) { return false; }
            final List<String> a = new ArrayList<>();
            for (final KeywordView k : kcv) { a.add(k.original()); }
            final List<String> b = new ArrayList<>();
            for (final KeywordView k : d) { b.add(k.original()); }
            return a.equals(b);
        }
        if (original instanceof IPaperCard pc) {
            if (!(decoded instanceof Map<?, ?> m)) { return false; }
            return pc.getName().equals(m.get("n")) && pc.getEdition().equals(m.get("e"))
                    && Integer.valueOf(pc.getArtIndex()).equals(m.get("a"))
                    && Boolean.valueOf(pc.isFoil()).equals(m.get("f"));
        }
        if (original instanceof DeltaPacket.CombatData cd) {
            if (!(decoded instanceof Map<?, ?> m)) { return false; }
            return intListList(cd.bandAttackerIds).toString().equals(m.get("atk"))
                    && intListList(cd.bandBlockerIds).toString().equals(m.get("blk"))
                    && intListList(cd.bandPlannedBlockerIds).toString().equals(m.get("pblk"));
        }
        if (original.getClass().isRecord()) {
            if (!(decoded instanceof Rec rec) || !rec.cls().equals(original.getClass().getName())) { return false; }
            try {
                for (final RecordComponent rc : original.getClass().getRecordComponents()) {
                    rc.getAccessor().setAccessible(true);
                    if (!same(rc.getAccessor().invoke(original), rec.components().get(rc.getName()))) {
                        return false;
                    }
                }
            } catch (final ReflectiveOperationException ex) {
                return false;
            }
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------ the harness

    /** One value through encode -> JSON text -> parse -> decode -> compare. */
    private static void roundTripValue(final TrackableProperty prop, final Object value, final Report r) {
        final Cell cell = r.cell(prop, value);
        cell.seen++;
        r.values++;

        JsonElement enc;
        try {
            enc = encodeTop(value);
        } catch (final Unsupported u) {
            cell.failEncode++;
            r.valuesFailEncode++;
            cell.fidelity = Fidelity.UNSUPPORTED;
            cell.tag = "-";
            if (cell.firstFailure == null) { cell.firstFailure = "ENCODE: " + u.getMessage(); }
            return;
        }
        if (cell.fidelity != Fidelity.UNSUPPORTED) {
            cell.fidelity = lastFidelity();
        }
        cell.tag = enc.isJsonNull() ? "null" : enc.getAsJsonObject().get("t").getAsString();

        // Through actual JSON text, not just the object model.
        final String text = GSON.toJson(enc);
        final JsonElement reparsed = com.google.gson.JsonParser.parseString(text);

        Object back;
        try {
            back = maybeCorrupt(decode(reparsed));
        } catch (final RuntimeException ex) {
            cell.failDecode++;
            r.valuesFailDecode++;
            if (cell.firstFailure == null) { cell.firstFailure = "DECODE: " + ex.getMessage(); }
            return;
        }

        if (same(value, back)) {
            cell.ok++;
            r.valuesOk++;
        } else {
            cell.failCompare++;
            r.valuesFailCompare++;
            if (cell.firstFailure == null) {
                cell.firstFailure = "COMPARE: sent=" + brief(value) + " got=" + brief(back);
            }
        }
    }

    private static String brief(final Object o) {
        if (o == null) { return "null"; }
        String s = String.valueOf(o);
        if (s.length() > 120) { s = s.substring(0, 117) + "..."; }
        return "[" + o.getClass().getSimpleName() + "] " + s;
    }

    /** Run a whole packet through the trip, accumulating into {@code r}. */
    public static void roundTripPacket(final DeltaPacket p, final Report r) {
        r.packets++;

        // Top-level skeleton: sequence number, checksum, sampled property ordinals
        // and the composite delta keys. All ints and longs; nothing exotic.
        boolean skeletonOk = true;
        final JsonObject skel = new JsonObject();
        skel.addProperty("seq", p.getSequenceNumber());
        skel.addProperty("checksum", p.getChecksum());
        final JsonArray cp = new JsonArray();
        if (p.getChecksumProperties() != null) {
            for (final int i : p.getChecksumProperties()) { cp.add(i); }
        }
        skel.add("checksumProperties", cp);
        final String skelText = GSON.toJson(skel);
        final JsonObject skelBack = com.google.gson.JsonParser.parseString(skelText).getAsJsonObject();
        skeletonOk &= skelBack.get("seq").getAsLong() == p.getSequenceNumber();
        skeletonOk &= skelBack.get("checksum").getAsInt() == p.getChecksum();
        skeletonOk &= skelBack.getAsJsonArray("checksumProperties").size() == cp.size();
        for (final Integer key : p.getObjectDeltas().keySet()) {
            skeletonOk &= com.google.gson.JsonParser.parseString(String.valueOf(key.intValue())).getAsInt() == key;
        }
        for (final Integer key : p.getNewObjects().keySet()) {
            skeletonOk &= com.google.gson.JsonParser.parseString(String.valueOf(key.intValue())).getAsInt() == key;
        }
        if (skeletonOk) { r.packetsSkeletonOk++; }

        for (final Map<TrackableProperty, Object> props : p.getNewObjects().values()) {
            for (final Map.Entry<TrackableProperty, Object> e : props.entrySet()) {
                roundTripValue(e.getKey(), e.getValue(), r);
            }
        }
        for (final Map<TrackableProperty, Object> props : p.getObjectDeltas().values()) {
            for (final Map.Entry<TrackableProperty, Object> e : props.entrySet()) {
                roundTripValue(e.getKey(), e.getValue(), r);
            }
        }

        if (p.hasEvents()) {
            r.packetsWithEvents++;
            for (final Object item : p.getEvents()) {
                r.eventItems++;
                final String cn = item == null ? "null" : item.getClass().getName();
                r.eventItemClasses.merge(cn, 1, Integer::sum);
                roundTripEvent(item, r);
            }
        }
    }

    /**
     * The events arm, measured rather than asserted. Each item is a
     * {@code TrackableSerializer.WrappedEvent(byte[] data)} — a GameEvent that
     * has ALREADY been Java-serialized, with its TrackableObject references
     * swapped for IdRef markers, and is carried as opaque bytes.
     *
     * <p>Base64 makes those bytes survive a JSON trip byte-for-byte, which is
     * why this counter comes out clean. It is not the same claim as "events
     * round-trip": the payload is a Java object stream, so a non-JVM client
     * that base64-decodes it holds bytes it cannot read. That distinction is
     * the whole point of reporting the two arms separately.
     */
    private static void roundTripEvent(final Object item, final Report r) {
        JsonElement enc;
        try {
            enc = encodeTop(item);
        } catch (final RuntimeException ex) {
            r.eventsFailEncode++;
            if (r.firstEventFailure == null) { r.firstEventFailure = "ENCODE: " + ex.getMessage(); }
            return;
        }
        final String text = GSON.toJson(enc);
        r.eventJsonBytes += text.length();
        Object back;
        try {
            back = decode(com.google.gson.JsonParser.parseString(text));
        } catch (final RuntimeException ex) {
            r.eventsFailDecode++;
            if (r.firstEventFailure == null) { r.firstEventFailure = "DECODE: " + ex.getMessage(); }
            return;
        }
        if (same(item, back)) {
            r.eventsBytewiseOk++;
        } else {
            r.eventsFailCompare++;
            if (r.firstEventFailure == null) { r.firstEventFailure = "COMPARE: " + brief(item) + " != " + brief(back); }
        }
    }

    /** Whole packet as JSON, for the doc's worked example. */
    public static String packetToJson(final DeltaPacket p) {
        return packetToJson(p, Integer.MAX_VALUE);
    }

    /**
     * As {@link #packetToJson(DeltaPacket)}, but keeping at most {@code limit}
     * objects from each map. The opening full sync carries 124 objects and 160 KB
     * of JSON; a committed worked example is more use at three.
     */
    public static String packetToJson(final DeltaPacket p, final int limit) {
        final JsonObject o = new JsonObject();
        o.addProperty("seq", p.getSequenceNumber());
        o.addProperty("checksum", p.getChecksum());
        final JsonArray cp = new JsonArray();
        if (p.getChecksumProperties() != null) {
            for (final int i : p.getChecksumProperties()) { cp.add(i); }
        }
        o.add("checksumProperties", cp);
        o.addProperty("_truncatedTo", limit == Integer.MAX_VALUE ? "(whole packet)" : limit + " objects per map");
        o.add("newObjects", objMapToJson(p.getNewObjects(), limit));
        o.add("objectDeltas", objMapToJson(p.getObjectDeltas(), limit));
        final JsonArray ev = new JsonArray();
        if (p.hasEvents()) {
            for (final Object item : p.getEvents()) {
                try {
                    ev.add(encodeTop(item));
                } catch (final RuntimeException ex) {
                    final JsonObject bad = new JsonObject();
                    bad.addProperty("UNSUPPORTED", ex.getMessage());
                    ev.add(bad);
                }
            }
        }
        o.add("events", ev);
        return GSON_PRETTY.toJson(o);
    }

    private static JsonObject objMapToJson(final Map<Integer, Map<TrackableProperty, Object>> m, final int limit) {
        final JsonObject out = new JsonObject();
        int n = 0;
        for (final Map.Entry<Integer, Map<TrackableProperty, Object>> e : m.entrySet()) {
            if (n++ >= limit) {
                out.addProperty("_omitted", m.size() - limit);
                break;
            }
            final int deltaKey = e.getKey();
            final JsonObject props = new JsonObject();
            props.addProperty("_type", DeltaPacket.getTypeFromDeltaKey(deltaKey));
            props.addProperty("_id", DeltaPacket.getIdFromDeltaKey(deltaKey));
            for (final Map.Entry<TrackableProperty, Object> pe : e.getValue().entrySet()) {
                try {
                    props.add(pe.getKey().name(), encodeTop(pe.getValue()));
                } catch (final RuntimeException ex) {
                    final JsonObject bad = new JsonObject();
                    bad.addProperty("UNSUPPORTED", ex.getMessage());
                    props.add(pe.getKey().name(), bad);
                }
            }
            out.add(String.valueOf(deltaKey), props);
        }
        return out;
    }

    /** The CardStateName table the CSV delta key packs into 4 bits (DeltaPacket's static assert). */
    public static int cardStateNames() {
        return CardStateName.values().length;
    }

    // ------------------------------------------------------- coverage audit

    /**
     * Names every {@code TrackableTypes} constant by reflecting over its public
     * static fields, so a property's declared type can be reported by name
     * instead of by {@code Object.toString()}. Enum property types are not
     * public fields — {@code TrackableTypes.EnumType(C)} hands them out of a
     * private cache — so they fall through to "EnumType".
     */
    private static Map<Object, String> trackableTypeNames() {
        final Map<Object, String> byIdentity = new java.util.IdentityHashMap<>();
        for (final java.lang.reflect.Field f : forge.trackable.TrackableTypes.class.getDeclaredFields()) {
            if (!java.lang.reflect.Modifier.isStatic(f.getModifiers())
                    || !java.lang.reflect.Modifier.isPublic(f.getModifiers())) {
                continue;
            }
            try {
                final Object v = f.get(null);
                if (v != null) { byIdentity.put(v, f.getName()); }
            } catch (final IllegalAccessException ignored) {
                // a non-public type we cannot name; it falls through to EnumType/unknown
            }
        }
        return byIdentity;
    }

    public static String declaredTypeOf(final TrackableProperty p, final Map<Object, String> names) {
        final String n = names.get(p.getType());
        return n != null ? n : "EnumType";
    }

    /**
     * What a run did and did not exercise. Every {@link TrackableProperty} Forge
     * declares, whether this run saw it, and with what runtime classes — so the
     * doc can say "these N properties were never exercised" instead of implying
     * the census is exhaustive.
     */
    public static String coverageTsv(final Report r) {
        final Map<Object, String> names = trackableTypeNames();
        final Map<String, List<String>> observed = new TreeMap<>();
        for (final Cell c : r.cells.values()) {
            observed.computeIfAbsent(c.property, k -> new ArrayList<>())
                    .add(c.valueClass + "(" + c.tag + " x" + c.seen + (c.clean() ? "" : " FAIL") + ")");
        }
        final StringBuilder sb = new StringBuilder();
        sb.append("property\tdeclaredType\tobserved\truntimeClasses\n");
        for (final TrackableProperty p : TrackableProperty.values()) {
            final List<String> seen = observed.get(p.name());
            sb.append(p.name()).append('\t')
              .append(declaredTypeOf(p, names)).append('\t')
              .append(seen == null ? "no" : "yes").append('\t')
              .append(seen == null ? "" : String.join(" ", seen))
              .append('\n');
        }
        return sb.toString();
    }

    /** Declared types with no observation at all — the honest edge of the result. */
    public static Map<String, List<String>> unexercisedByDeclaredType(final Report r) {
        final Map<Object, String> names = trackableTypeNames();
        final Map<String, List<String>> out = new TreeMap<>();
        for (final TrackableProperty p : TrackableProperty.values()) {
            if (!r.cells.keySet().stream().anyMatch(k -> k.startsWith(p.name() + "\t"))) {
                out.computeIfAbsent(declaredTypeOf(p, names), k -> new ArrayList<>()).add(p.name());
            }
        }
        return out;
    }

    /** Declared types that WERE observed at least once. */
    public static Set<String> exercisedDeclaredTypes(final Report r) {
        final Map<Object, String> names = trackableTypeNames();
        final Set<String> out = new java.util.TreeSet<>();
        for (final TrackableProperty p : TrackableProperty.values()) {
            if (r.cells.keySet().stream().anyMatch(k -> k.startsWith(p.name() + "\t"))) {
                out.add(declaredTypeOf(p, names));
            }
        }
        return out;
    }

    public static int propertyCount() {
        return TrackableProperty.values().length;
    }

    /** Census as TSV, sorted so the failures read first. */
    public static String censusTsv(final Report r) {
        final StringBuilder sb = new StringBuilder();
        sb.append("outcome\tfidelity\tproperty\tvalueClass\tjsonTag\tseen\tok\tfailEncode\tfailDecode\tfailCompare\tfirstFailure\n");
        final List<Cell> cells = new ArrayList<>(r.cells.values());
        cells.sort((a, b) -> {
            if (a.clean() != b.clean()) { return a.clean() ? 1 : -1; }
            final int f = b.seen - a.seen;
            return f != 0 ? f : a.property.compareTo(b.property);
        });
        for (final Cell c : cells) {
            sb.append(c.clean() ? "OK" : "FAIL").append('\t')
              .append(c.fidelity).append('\t')
              .append(c.property).append('\t')
              .append(c.valueClass).append('\t')
              .append(c.tag).append('\t')
              .append(c.seen).append('\t')
              .append(c.ok).append('\t')
              .append(c.failEncode).append('\t')
              .append(c.failDecode).append('\t')
              .append(c.failCompare).append('\t')
              .append(c.firstFailure == null ? "" : c.firstFailure.replace('\t', ' ').replace('\n', ' '))
              .append('\n');
        }
        return sb.toString();
    }

    /**
     * Deterministic fixtures, run before every match.
     *
     * <p>Two jobs. The first is the obvious one: if the codec cannot round-trip
     * a boolean, nothing it says about a real packet means anything.
     *
     * <p>The second matters more. A real match only exercises the properties the
     * cards that turned up happen to use, and the bespoke value types
     * (ManaCost, CounterType multisets, PaperCard, KeywordCollectionView,
     * CardType, CombatData, the Byte-keyed mana map) are exactly the ones a
     * random pair of precons may miss. Pinning them here turns "we happened to
     * see it" into "it is checked on every run".
     *
     * <p>The last fixture is a NEGATIVE one: a value the encoder must REFUSE.
     * Without it, "0 UNSUPPORTED over 67,619 values" would be consistent with an
     * encoder that never refuses anything, and this repo has already shipped
     * five gates that passed while doing nothing.
     */
    public static int[] selfTest() {
        int failed = 0;
        int passed = 0;
        final List<Object> fixtures = new ArrayList<>(List.of(
            Boolean.TRUE, Integer.valueOf(-7), Long.valueOf(1L << 40), "a\tstring\nwith \"quotes\"",
            forge.game.zone.ZoneType.Battlefield, forge.game.phase.PhaseType.COMBAT_DECLARE_BLOCKERS,
            new byte[] {0, 1, -128, 127}, new int[] {3, 1, 4},
            ColorSet.fromMask(0b10101), java.util.List.of("a", "b"), java.util.Set.of("x"),
            new LinkedHashMap<>(Map.of("k", "v")),
            // bespoke Forge value types, pinned so a lucky deck draw cannot hide them
            ManaCost.get(3),
            new forge.card.mana.ManaCost(new forge.card.mana.ManaCostParser("2 G G")),
            forge.card.CardType.parse("Legendary Creature Wurm", false),
            new KeywordCollectionView(List.of(Keyword.getInstance("Flying").getView())),
            new DeltaPacket.CombatData(
                    List.of(List.of(11, 12)), List.of(new int[] {1, 7}),
                    List.of(List.of(21)), List.of(List.of()))
        ));
        final com.google.common.collect.Multiset<CounterType> counters =
                com.google.common.collect.HashMultiset.create();
        counters.add(CounterType.getType("P1P1"), 3);
        counters.add(CounterType.getType("LOYALTY"), 1);
        fixtures.add(counters);
        final Map<Byte, Integer> manaMap = new LinkedHashMap<>();
        manaMap.put((byte) 1, 2);
        manaMap.put((byte) 8, 5);
        fixtures.add(manaMap);
        final Object forest = forge.StaticData.instance() == null ? null
                : forge.StaticData.instance().getCommonCards().getCard("Forest");
        if (forest != null) {
            fixtures.add(forest);
        } else {
            System.out.println("  [FAIL] selftest could not load a PaperCard fixture (StaticData empty)");
            failed++;
        }

        for (final Object f : fixtures) {
            boolean ok;
            String why = "";
            try {
                ok = same(f, decode(com.google.gson.JsonParser.parseString(GSON.toJson(encodeTop(f)))));
            } catch (final RuntimeException ex) {
                ok = false;
                why = " threw " + ex;
            }
            if (ok) {
                passed++;
            } else {
                failed++;
                System.out.println("  [FAIL] selftest fixture " + brief(f) + why);
            }
        }

        // Forge's own CardType.toString() is NOT accepted by CardType.parse().
        // This is why the codec carries the three token sets instead of the
        // printed type line. Pinned as a fixture so nobody "simplifies" it back.
        final forge.card.CardType wurm = forge.card.CardType.parse("Creature Wurm", false);
        final String printed = wurm.toString();
        final String reparsed = forge.card.CardType.parse(printed, true).toString();
        if ("Creature - Wurm".equals(printed) && !printed.equals(reparsed)) {
            passed++;
            System.out.println("  [PASS] CardType.toString() is not CardType.parse()-able, as documented:"
                    + " \"" + printed + "\" -> \"" + reparsed + "\"");
        } else {
            failed++;
            System.out.println("  [FAIL] CardType round-trip fixture changed upstream: printed=\"" + printed
                    + "\" reparsed=\"" + reparsed + "\" — re-check the cardtype encoding");
        }

        // NEGATIVE fixture: the encoder must refuse something. "0 UNSUPPORTED"
        // is only a result if UNSUPPORTED is reachable.
        try {
            encodeTop(new java.util.Random(1));
            failed++;
            System.out.println("  [FAIL] the encoder accepted java.util.Random — it refuses nothing,"
                    + " so a zero UNSUPPORTED count would mean nothing");
        } catch (final Unsupported u) {
            passed++;
            System.out.println("  [PASS] the encoder refuses a value with no JSON form: " + u.getMessage());
        }

        return new int[] {failed, passed};
    }

}
