package spike;

import java.io.PrintStream;
import java.lang.reflect.Field;

/**
 * Wave 15, lane B -- the wall AFTER the assets, named so nobody spends a wave
 * assuming it is one.
 *
 * With res/ unpacked into /files/, Forge loads 33,785 cards and builds its home
 * UI, then dies in forge.util.IgnoringXStream.<init> with a bare
 * NullPointerException. That is not a file that could not be found: XStream
 * picks a reflection provider at construction time and the fast ones go through
 * sun.misc.Unsafe. This isolates which half is missing, because "CheerpJ has no
 * Unsafe" and "XStream failed for some other reason" lead to completely
 * different answers.
 */
public final class XStreamProbe {
    public static void main(String[] args) {
        PrintStream out = System.out;
        out.println("PROBE xstream begin");

        try {
            Class<?> unsafe = Class.forName("sun.misc.Unsafe");
            out.println("XS sun.misc.Unsafe class=" + unsafe.getName());
            Field f = unsafe.getDeclaredField("theUnsafe");
            f.setAccessible(true);
            Object u = f.get(null);
            out.println("XS theUnsafe instance=" + (u == null ? "null" : u.getClass().getName()));
            if (u != null) {
                try {
                    Object o = unsafe.getMethod("allocateInstance", Class.class).invoke(u, Thing.class);
                    out.println("XS allocateInstance OK -> " + o.getClass().getName());
                } catch (Throwable t) {
                    out.println("XS allocateInstance THREW " + t.getClass().getName() + ": " + t.getMessage());
                }
            }
        } catch (Throwable t) {
            out.println("XS Unsafe THREW " + t.getClass().getName() + ": " + t.getMessage());
        }

        // Each provider separately: XStream's no-arg ctor picks one by probing,
        // and a failure in the probe looks identical to a failure in the pick.
        // XStream's JVM.<clinit> reads java.vm.vendor and calls String.contains on
        // it unguarded. Print what CheerpJ reports for the properties it touches
        // before blaming XStream.
        for (String k : new String[] { "java.vm.vendor", "java.vm.name", "java.version",
                "java.specification.version", "java.vendor", "os.name" }) {
            out.println("XS prop " + k + "=" + System.getProperty(k));
        }

        // args[0]=fix sets the missing property FIRST, so a pass here proves the
        // whole failure is that one null and needs no XStream or Forge change.
        // A failed <clinit> is permanent for the life of the JVM, so only ONE
        // vendor string can be tried per page load -- it is argv[0].
        if (args.length > 0 && !args[0].isEmpty()) {
            System.setProperty("java.vm.vendor", args[0]);
            out.println("XS set java.vm.vendor=" + System.getProperty("java.vm.vendor"));
        }

        // Force the static initialiser of the class every provider depends on and
        // print the WHOLE cause chain: an ExceptionInInitializerError reported one
        // level deep says "null" and names nothing.
        forceInit(out, "com.thoughtworks.xstream.core.JVM");

        tryNew(out, "com.thoughtworks.xstream.converters.reflection.PureJavaReflectionProvider");
        tryNew(out, "com.thoughtworks.xstream.converters.reflection.SunLimitedUnsafeReflectionProvider");
        tryNew(out, "com.thoughtworks.xstream.converters.reflection.SunUnsafeReflectionProvider");
        tryNew(out, "com.thoughtworks.xstream.XStream");
        tryNew(out, "forge.util.IgnoringXStream");

        out.println("PROBE xstream end");
        out.flush();
    }

    public static final class Thing { public int x; }

    private static void forceInit(PrintStream out, String cls) {
        try {
            Class.forName(cls, true, XStreamProbe.class.getClassLoader());
            out.println("XS init " + cls + " OK");
        } catch (Throwable t) {
            out.println("XS init " + cls + " FAILED");
            dump(out, t, 0);
        }
        out.flush();
    }

    private static void dump(PrintStream out, Throwable t, int depth) {
        if (t == null || depth > 6) { return; }
        out.println("XS   [" + depth + "] " + t.getClass().getName() + ": " + t.getMessage());
        StackTraceElement[] st = t.getStackTrace();
        for (int i = 0; i < Math.min(6, st.length); i++) {
            out.println("XS       at " + st[i]);
        }
        dump(out, t.getCause(), depth + 1);
    }

    private static void tryNew(PrintStream out, String cls) {
        try {
            Object o = Class.forName(cls).getDeclaredConstructor().newInstance();
            out.println("XS new " + cls + " OK -> " + o.getClass().getName());
        } catch (Throwable t) {
            out.println("XS new " + cls + " FAILED");
            dump(out, t, 0);
        }
        out.flush();
    }
}
