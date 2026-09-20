package spike;

import com.thoughtworks.xstream.XStream;
import com.thoughtworks.xstream.converters.reflection.ReflectionProvider;
import com.thoughtworks.xstream.core.JVM;

/**
 * Wave 15, lane D -- which reflection provider does XStream actually CHOOSE
 * under CheerpJ, and does a round trip survive it?
 *
 * Lane B's XStreamProbe answers "does com.thoughtworks.xstream.core.JVM
 * initialise". That is necessary and nowhere near sufficient, and this lane
 * learned the difference the expensive way: binding a NO-OP CheerpJ native for
 * Java_jdk_internal_misc_Unsafe_putChar makes JVM.<clinit> initialise fine --
 * and then Forge dies deserialising a gauntlet with
 *
 *   com.thoughtworks.xstream.converters.ConversionException
 *   cause-exception : java.lang.NullPointerException
 *   class           : forge.deck.Deck
 *   converter-type  : ...reflection.ReflectionConverter
 *
 * i.e. the stub converted a loud failure into a WRONG ANSWER. JVM.<clinit>
 * self-tests the unsafe provider by writing a char field; a no-op stub makes
 * that test pass, XStream selects SunUnsafeReflectionProvider, and every
 * subsequent field write goes through Unsafe natives that are not there.
 *
 * So the question is not "does it initialise" but "which provider is selected
 * and does data survive it". Both are printed:
 *
 *   XP vendor=...                     java.vm.vendor as seen by XStream
 *   XP provider=<class>               what JVM.newReflectionProvider() returns
 *   XP roundtrip OK|MISMATCH|FAILED   a real marshal/unmarshal of real values
 *
 * A pass requires the round trip, not the provider name.
 */
public final class XStreamPick {
    /** Deliberately one field of each kind XStream writes through the provider. */
    public static final class Thing {
        char c;
        int i;
        long l;
        boolean b;
        String s;
        int[] arr;
        Thing inner;
    }

    public static void main(String[] args) {
        if (args.length > 0 && !args[0].isEmpty()) {
            System.setProperty("java.vm.vendor", args[0]);
        }
        System.out.println("XP vendor=" + System.getProperty("java.vm.vendor"));

        try {
            ReflectionProvider p = JVM.newReflectionProvider();
            System.out.println("XP provider=" + p.getClass().getName());
        } catch (Throwable t) {
            System.out.println("XP provider FAILED " + t.getClass().getName() + ": " + t.getMessage());
        }

        try {
            Thing t = new Thing();
            t.c = 'Z'; t.i = 4242; t.l = 1234567890123L; t.b = true;
            t.s = "forge"; t.arr = new int[] { 1, 2, 3 };
            t.inner = new Thing();
            t.inner.c = 'q'; t.inner.s = "nested";

            XStream xs = new XStream();
            xs.allowTypesByWildcard(new String[] { "spike.**" });
            String xml = xs.toXML(t);
            System.out.println("XP xml len=" + xml.length());

            Thing r = (Thing) xs.fromXML(xml);
            StringBuilder bad = new StringBuilder();
            if (r == null) {
                bad.append("null-result ");
            } else {
                if (r.c != 'Z') bad.append("char(").append((int) r.c).append(") ");
                if (r.i != 4242) bad.append("int(").append(r.i).append(") ");
                if (r.l != 1234567890123L) bad.append("long(").append(r.l).append(") ");
                if (!r.b) bad.append("boolean ");
                if (!"forge".equals(r.s)) bad.append("String(").append(r.s).append(") ");
                if (r.arr == null || r.arr.length != 3 || r.arr[2] != 3) bad.append("array ");
                if (r.inner == null) bad.append("inner-null ");
                else if (r.inner.c != 'q' || !"nested".equals(r.inner.s)) bad.append("inner-fields ");
            }
            System.out.println(bad.length() == 0
                    ? "XP roundtrip OK"
                    : "XP roundtrip MISMATCH " + bad);
        } catch (Throwable t) {
            System.out.println("XP roundtrip FAILED " + t.getClass().getName() + ": " + t.getMessage());
            Throwable c = t.getCause();
            for (int d = 0; c != null && d < 4; d++, c = c.getCause()) {
                System.out.println("XP   cause[" + d + "] " + c.getClass().getName() + ": " + c.getMessage());
            }
        }
        System.out.println("XP end");
    }
}
