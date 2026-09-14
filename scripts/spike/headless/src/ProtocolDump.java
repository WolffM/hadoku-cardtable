/*
 * hadoku-cardtable PR-4 spike (Wave 2, lane D).
 *
 * Reads forge.gamemodes.net.ProtocolMethod out of a built Forge jar by
 * reflection and prints one machine-readable row per enum constant. The point
 * is that the count and the per-method signature come from the compiled enum
 * rather than from grepping the source, so the "how many methods does the
 * protocol actually have" number in docs/spikes/headless-server.md is checkable
 * rather than asserted.
 *
 * Deliberately not placed inside forge/: decision D2/O1 says the fork does not
 * exist yet and this spike writes no Java into the vendored tree. This file is
 * an overlay compiled against Forge's jar, never into it.
 *
 * It also calls ProtocolMethod.getMethod() on each constant. That method looks
 * the name up on IGuiGame (SERVER) or IGameController (CLIENT) and returns null
 * when neither the full-signature nor the no-arg lookup finds anything — i.e. a
 * constant that can be named on the wire but dispatches nowhere. Those are worth
 * knowing about before anyone budgets work to implement them.
 *
 * Output format, tab-separated:
 *   ordinal<TAB>name<TAB>SERVER|CLIENT<TAB>resolution<TAB>returnType<TAB>argType,...
 * where resolution is the declaring class + descriptor of the resolved Method,
 * or UNRESOLVED.
 */
import java.lang.reflect.Field;
import java.lang.reflect.Method;

public final class ProtocolDump {
    private ProtocolDump() {
    }

    public static void main(final String[] args) throws Exception {
        final Class<?> pm = Class.forName("forge.gamemodes.net.ProtocolMethod");
        final Object[] values = (Object[]) pm.getMethod("values").invoke(null);

        // Mode is a private nested enum; read the private instance field rather
        // than adding an accessor to Forge.
        final Field modeField = pm.getDeclaredField("mode");
        modeField.setAccessible(true);

        final Method getReturnType = pm.getMethod("getReturnType");
        final Method getArgTypes = pm.getMethod("getArgTypes");
        final Method getMethod = pm.getMethod("getMethod");

        int server = 0;
        int client = 0;
        int unresolved = 0;
        for (final Object v : values) {
            final Enum<?> constant = (Enum<?>) v;
            final String mode = ((Enum<?>) modeField.get(v)).name();
            if ("SERVER".equals(mode)) {
                server++;
            } else {
                client++;
            }

            final Class<?> ret = (Class<?>) getReturnType.invoke(v);
            final Class<?>[] argTypes = (Class<?>[]) getArgTypes.invoke(v);
            final StringBuilder sb = new StringBuilder();
            for (int i = 0; i < argTypes.length; i++) {
                if (i > 0) {
                    sb.append(',');
                }
                sb.append(argTypes[i].getName());
            }

            final Method resolved = (Method) getMethod.invoke(v);
            final String resolution;
            if (resolved == null) {
                resolution = "UNRESOLVED";
                unresolved++;
            } else {
                resolution = resolved.getDeclaringClass().getSimpleName() + "#"
                        + resolved.getName() + "/" + resolved.getParameterCount();
            }

            System.out.printf("%d\t%s\t%s\t%s\t%s\t%s%n",
                    constant.ordinal(), constant.name(), mode, resolution, ret.getName(), sb);
        }

        System.out.printf("TOTAL\t%d\tSERVER\t%d\tCLIENT\t%d\tUNRESOLVED\t%d%n",
                values.length, server, client, unresolved);
    }
}
