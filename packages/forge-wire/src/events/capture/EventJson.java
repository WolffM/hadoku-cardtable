package hadoku.events;

import com.google.common.collect.Multimap;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import forge.game.card.CardView;
import forge.game.card.CounterType;
import forge.game.event.GameEvent;
import forge.game.player.PlayerView;
import forge.trackable.TrackableObject;
import forge.trackable.TrackableProperty;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.ObjectInputStream;
import java.io.ObjectStreamClass;
import java.lang.reflect.Method;
import java.lang.reflect.RecordComponent;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Decode one {@code TrackableSerializer.WrappedEvent} payload and write the
 * {@link GameEvent} inside it as JSON.
 *
 * <h2>Decoding</h2>
 * The payload was written by {@code CObjectOutputStream} with a <i>thin class
 * descriptor</i> (one byte {@code 1} + the class name as UTF,
 * {@code CObjectOutputStream.java} {@code writeClassDescriptor}), so a stock
 * {@link ObjectInputStream} cannot read it. {@link ThinInput} mirrors
 * {@code CObjectInputStream.readClassDescriptor}.
 *
 * <p>The markers cannot simply be left in place: every event is a Java
 * {@code record}, and deserializing a record calls its canonical constructor,
 * so an {@code IdRef} arriving in a {@code PlayerView}-typed component throws
 * {@code InvalidObjectException: Cannot cast ...IdRef to ...PlayerView}. (The
 * first capture run failed 1727 of 2746 events exactly that way; the stock
 * histogram cross-check caught it.) Stock Forge avoids that by resolving each
 * marker against the client's {@code Tracker}. We have no tracker and want
 * none — a bridge must not depend on client state — so {@link ThinInput}
 * resolves each marker to an EMPTY stub view of the right class, and remembers
 * which marker each stub came from. The JSON writer then emits the marker, not
 * the stub. Nothing a stub holds is ever read.
 *
 * <h2>Encoding, and what "Java-side help" means</h2>
 * Every JSON value is produced by exactly one {@link Rule}, and each rule is
 * either GENERIC or BESPOKE:
 * <ul>
 *   <li><b>GENERIC</b> — class-agnostic. It needs to know only that a value is
 *       null, a boxed primitive, a String, an enum constant (written as its
 *       name), a record (written component by component), anything
 *       implementing {@code java.util.Collection} or {@code java.util.Map}
 *       (walked through that JDK interface only), or one of Forge's two wire
 *       reference markers ({@code IdRef}, {@code EventCardRef}, which
 *       {@code refs.ts} already models). A decoder written from the JDK's
 *       serialization spec plus those two markers produces the same JSON.</li>
 *   <li><b>BESPOKE</b> — needs knowledge of one particular non-JDK type: a
 *       Guava {@code Multimap} (Guava's own serialized form), a
 *       {@code CounterType} (an interface with three implementations, only one
 *       an enum — the JSON is {@code getName()}), or an inline
 *       {@code TrackableObject} the server did NOT swap for a marker
 *       ({@code TrackableSerializer.replace} swaps only {@code CardView} and
 *       {@code PlayerView}, {@code typeTagFor} returns -1 for everything
 *       else), which arrives as a whole object graph and has to be projected.</li>
 * </ul>
 * An event class needs <b>Java-side help</b> iff any value of it, in any
 * captured instance, needed a BESPOKE rule. That is computed per run from the
 * rules that actually fired, not asserted.
 */
final class EventJson {

    private EventJson() {}

    enum Rule {
        NULL(false), BOOL(false), INT(false), STRING(false), ENUM(false), RECORD(false),
        COLLECTION(false), MAP(false), PLAYER_REF(false), CARD_REF(false), EVENT_CARD(false),
        MULTIMAP(true), COUNTER_TYPE(true), TRACKABLE_INLINE(true), UNKNOWN(true);

        final boolean bespoke;

        Rule(final boolean bespoke) { this.bespoke = bespoke; }
    }

    static boolean needsJavaHelp(final Set<Rule> rules) {
        for (final Rule r : rules) {
            if (r.bespoke) { return true; }
        }
        return false;
    }

    /**
     * Mirrors {@code CObjectInputStream}'s thin descriptor, and resolves each
     * reference marker to an empty stub of the class the record expects.
     */
    static final class ThinInput extends ObjectInputStream {
        /** stub view -> the IdRef / EventCardRef it stands for. Identity, not equals: views compare by id. */
        final Map<Object, Object> markers = new IdentityHashMap<>();

        ThinInput(final InputStream in) throws IOException {
            super(in);
            enableResolveObject(true);
        }

        @Override
        protected Object resolveObject(final Object obj) {
            final String cn = obj == null ? "" : obj.getClass().getName();
            final Object stub;
            if (cn.equals(NET + "EventCardRef")) {
                stub = new CardView((Integer) readNamed(obj, "id"), null);
            } else if (cn.equals(NET + "IdRef")) {
                final byte tag = (Byte) readNamed(obj, "typeTag");
                final int id = (Integer) readNamed(obj, "id");
                stub = tag == 0 ? new CardView(id, null) : tag == 1 ? new PlayerView(id, null) : obj;
            } else {
                return obj;
            }
            markers.put(stub, obj);
            return stub;
        }

        @Override
        protected ObjectStreamClass readClassDescriptor() throws IOException, ClassNotFoundException {
            final int type = read();
            if (type < 0) { throw new java.io.EOFException(); }
            if (type == 1) {
                final String name = readUTF();
                return ObjectStreamClass.lookupAny(Class.forName(name, false, EventJson.class.getClassLoader()));
            }
            return super.readClassDescriptor();
        }
    }

    /** A decoded event plus the stub-to-marker table its JSON writer needs. */
    record Decoded(GameEvent event, Map<Object, Object> markers) {}

    static Decoded decode(final byte[] bytes) throws IOException, ClassNotFoundException {
        try (ThinInput in = new ThinInput(new ByteArrayInputStream(bytes))) {
            return new Decoded((GameEvent) in.readObject(), in.markers);
        }
    }

    static JsonObject toJson(final Decoded d, final Set<Rule> rules) {
        // The discriminator is "event", not "type": three records have a
        // component called `type` (AddLog, CardCounters, CardDamaged), and the
        // first capture wrote the class name and then overwrote it with theirs.
        final JsonObject o = new JsonObject();
        o.addProperty("event", d.event().getClass().getSimpleName());
        for (final RecordComponent rc : d.event().getClass().getRecordComponents()) {
            o.add(rc.getName(), value(read(rc, d.event()), d.markers(), rules));
        }
        return o;
    }

    private static Object read(final RecordComponent rc, final Object owner) {
        try {
            final Method m = rc.getAccessor();
            m.setAccessible(true);
            return m.invoke(owner);
        } catch (final ReflectiveOperationException e) {
            throw new IllegalStateException("cannot read " + rc, e);
        }
    }

    private static final String NET = "forge.gamemodes.net.TrackableSerializer$";

    static JsonElement value(final Object raw, final Map<Object, Object> markers, final Set<Rule> rules) {
        if (raw == null) {
            rules.add(Rule.NULL);
            return JsonNull.INSTANCE;
        }
        final Object v = markers.getOrDefault(raw, raw);
        final String cn = v.getClass().getName();
        if (cn.equals(NET + "IdRef")) {
            final byte tag = (Byte) readNamed(v, "typeTag");
            final int id = (Integer) readNamed(v, "id");
            final JsonObject r = new JsonObject();
            if (tag == 1) {
                rules.add(Rule.PLAYER_REF);
                r.addProperty("kind", "player");
            } else if (tag == 0) {
                rules.add(Rule.CARD_REF);
                r.addProperty("kind", "card");
            } else {
                rules.add(Rule.UNKNOWN);
                r.addProperty("kind", "unknownTag" + tag);
            }
            r.addProperty("id", id);
            return r;
        }
        if (cn.equals(NET + "EventCardRef")) {
            rules.add(Rule.EVENT_CARD);
            final JsonObject ref = new JsonObject();
            ref.addProperty("kind", "card");
            ref.addProperty("id", (Integer) readNamed(v, "id"));
            final JsonObject r = new JsonObject();
            r.add("ref", ref);
            r.add("name", nullableString((String) readNamed(v, "name")));
            r.add("imageKey", nullableString((String) readNamed(v, "imageKey")));
            r.addProperty("preserveSnapshot", (Boolean) readNamed(v, "preserveSnapshot"));
            return r;
        }
        if (v instanceof Boolean b) {
            rules.add(Rule.BOOL);
            return new JsonPrimitive(b);
        }
        if (v instanceof Integer || v instanceof Short || v instanceof Byte || v instanceof Long) {
            rules.add(Rule.INT);
            return new JsonPrimitive((Number) v);
        }
        if (v instanceof String s) {
            rules.add(Rule.STRING);
            return new JsonPrimitive(s);
        }
        // Before Enum: CounterEnumType IS an enum, but its name() ("P1P1") is not
        // its getName() ("+1/+1"), and CounterKeywordType / CounterCustomType are
        // records. One form for all three, the same one the state arm's JsonDelta
        // writes for counter multisets: getName().
        if (v instanceof CounterType ct) {
            rules.add(Rule.COUNTER_TYPE);
            return new JsonPrimitive(ct.getName());
        }
        if (v instanceof Enum<?> e) {
            rules.add(Rule.ENUM);
            return new JsonPrimitive(e.name());
        }
        if (v instanceof TrackableObject t) {
            rules.add(Rule.TRACKABLE_INLINE);
            final JsonObject ref = new JsonObject();
            ref.addProperty("kind", trackableKind(t));
            ref.addProperty("id", t.getId());
            final JsonObject props = new JsonObject();
            final Map<TrackableProperty, Object> map = t.getProps();
            for (final Map.Entry<TrackableProperty, Object> e : map.entrySet()) {
                props.add(e.getKey().name(), value(e.getValue(), markers, rules));
            }
            final JsonObject r = new JsonObject();
            r.add("ref", ref);
            r.add("props", props);
            return r;
        }
        if (v instanceof Record rec) {
            rules.add(Rule.RECORD);
            final JsonObject o = new JsonObject();
            for (final RecordComponent rc : rec.getClass().getRecordComponents()) {
                o.add(rc.getName(), value(read(rc, rec), markers, rules));
            }
            return o;
        }
        if (v instanceof Multimap<?, ?> mm) {
            rules.add(Rule.MULTIMAP);
            final JsonArray a = new JsonArray();
            for (final Map.Entry<?, ? extends java.util.Collection<?>> e : mm.asMap().entrySet()) {
                final JsonObject entry = new JsonObject();
                entry.add("key", value(e.getKey(), markers, rules));
                final JsonArray vs = new JsonArray();
                for (final Object x : e.getValue()) { vs.add(value(x, markers, rules)); }
                entry.add("values", vs);
                a.add(entry);
            }
            return a;
        }
        if (v instanceof Map<?, ?> m) {
            rules.add(Rule.MAP);
            final JsonArray a = new JsonArray();
            for (final Map.Entry<?, ?> e : m.entrySet()) {
                final JsonObject entry = new JsonObject();
                entry.add("key", value(e.getKey(), markers, rules));
                entry.add("value", value(e.getValue(), markers, rules));
                a.add(entry);
            }
            return a;
        }
        if (v instanceof java.util.Collection<?> it) {
            rules.add(Rule.COLLECTION);
            final JsonArray a = new JsonArray();
            for (final Object x : it) { a.add(value(x, markers, rules)); }
            return a;
        }
        rules.add(Rule.UNKNOWN);
        final JsonObject u = new JsonObject();
        u.addProperty("$unknown", cn);
        return u;
    }

    private static String trackableKind(final TrackableObject t) {
        final String s = t.getClass().getSimpleName();
        return switch (s) {
            case "SpellAbilityView" -> "spellAbility";
            case "StackItemView" -> "stackItem";
            default -> s;
        };
    }

    private static JsonElement nullableString(final String s) {
        return s == null ? JsonNull.INSTANCE : new JsonPrimitive(s);
    }

    private static Object readNamed(final Object rec, final String name) {
        for (final RecordComponent rc : rec.getClass().getRecordComponents()) {
            if (rc.getName().equals(name)) { return read(rc, rec); }
        }
        throw new IllegalStateException(rec.getClass().getName() + " has no component " + name);
    }

    /**
     * The (path, JSON kind) pairs one decoded event exhibits: array indices
     * collapse to {@code []}, leaves become {@code null}/{@code bool}/
     * {@code number}/{@code string}, an empty array is its own kind, and the
     * VALUE of a {@code kind} or {@code event} key is part of the pair (a player
     * ref and a card ref are different branches of the schema). The fixture
     * sampler keeps an instance only if it adds a pair no kept instance has, so
     * the committed samples cover every pair the whole run produced.
     */
    static Set<String> features(final JsonElement e) {
        final Set<String> out = new TreeSet<>();
        features(e, "$", out);
        return out;
    }

    private static void features(final JsonElement e, final String path, final Set<String> out) {
        if (e == null || e.isJsonNull()) {
            out.add(path + ":null");
        } else if (e.isJsonPrimitive()) {
            final JsonPrimitive p = e.getAsJsonPrimitive();
            out.add(path + (p.isBoolean() ? ":bool" : p.isNumber() ? ":number" : ":string"));
        } else if (e.isJsonArray()) {
            if (e.getAsJsonArray().isEmpty()) { out.add(path + ":emptyArray"); }
            for (final JsonElement x : e.getAsJsonArray()) { features(x, path + "[]", out); }
        } else {
            out.add(path + ":object");
            for (final Map.Entry<String, JsonElement> x : e.getAsJsonObject().entrySet()) {
                final String child = path + "." + x.getKey();
                if (x.getKey().equals("kind") || x.getKey().equals("event")) {
                    out.add(child + "=" + x.getValue().getAsString());
                } else {
                    features(x.getValue(), child, out);
                }
            }
        }
    }
}
