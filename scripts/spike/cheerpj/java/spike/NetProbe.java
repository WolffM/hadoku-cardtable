package spike;

import java.io.PrintStream;

/**
 * Wave 14, lane B -- CheerpJ networking probe.
 *
 * The question this answers is NOT "does CheerpJ support sockets" (the docs say
 * it does, via Tailscale). It is: does the specific stack Forge's client uses
 * -- io.netty NioEventLoopGroup / NioSocketChannel, i.e. java.nio.channels.Selector
 * -- construct at all inside CheerpJ?
 *
 * forge/forge-gui/src/main/java/forge/gamemodes/net/client/FGameClient.java:63-66
 *     final EventLoopGroup group = new NioEventLoopGroup();
 *     new Bootstrap().group(group).channel(NioSocketChannel.class)
 *
 * Each step prints one line: STEP <n> <name> OK|FAIL <detail>. Nothing throws out
 * of main, so a failure at step 2 still reports steps 3..n. Every step is
 * deliberately construct-only: no step dials a remote host, because the point is
 * to find where the stack stops being constructible, not to test connectivity.
 */
public final class NetProbe {
    private static int step = 0;

    public static void main(String[] args) throws Exception {
        PrintStream out = System.out;
        out.println("PROBE net begin");
        out.println("java.version=" + System.getProperty("java.version"));
        out.println("java.vendor=" + System.getProperty("java.vendor"));
        out.println("os.name=" + System.getProperty("os.name"));

        run(out, "java.nio.channels.Selector.open", () -> {
            java.nio.channels.Selector s = java.nio.channels.Selector.open();
            String d = s.provider().getClass().getName();
            s.close();
            return d;
        });

        run(out, "java.nio.channels.SocketChannel.open", () -> {
            java.nio.channels.SocketChannel c = java.nio.channels.SocketChannel.open();
            String d = c.getClass().getName();
            c.close();
            return d;
        });

        run(out, "new java.net.Socket()", () -> {
            java.net.Socket s = new java.net.Socket();
            String d = s.getClass().getName();
            s.close();
            return d;
        });

        run(out, "java.net.InetAddress.getByName(127.0.0.1)", () ->
                java.net.InetAddress.getByName("127.0.0.1").toString());

        run(out, "io.netty.util.internal.PlatformDependent.<clinit>", () ->
                "hasUnsafe=" + io.netty.util.internal.PlatformDependent.hasUnsafe()
                        + " javaVersion=" + io.netty.util.internal.PlatformDependent.javaVersion()
                        + " directBufferPreferred=" + io.netty.util.internal.PlatformDependent.directBufferPreferred());

        run(out, "new io.netty.channel.nio.NioEventLoopGroup()", () -> {
            io.netty.channel.nio.NioEventLoopGroup g = new io.netty.channel.nio.NioEventLoopGroup(1);
            String d = g.getClass().getName();
            g.shutdownGracefully();
            return d;
        });

        run(out, "new io.netty.channel.socket.nio.NioSocketChannel()", () ->
                new io.netty.channel.socket.nio.NioSocketChannel().getClass().getName());

        run(out, "io.netty.buffer.ByteBufAllocator.DEFAULT.buffer(1024)", () -> {
            io.netty.buffer.ByteBuf b = io.netty.buffer.ByteBufAllocator.DEFAULT.buffer(1024);
            String d = b.getClass().getName() + " direct=" + b.isDirect();
            b.release();
            return d;
        });

        // Forge's own client object, constructed but never connected. Its ctor is
        // trivial; this only proves the class and its transitive statics link.
        run(out, "new forge.gamemodes.net.client.FGameClient(...)", () ->
                new forge.gamemodes.net.client.FGameClient("spike", null, "127.0.0.1", 36743)
                        .getClass().getName());

        // --- the candidate workaround ---------------------------------------
        // Netty 4.1 still ships the blocking OIO transport (dropped in 4.2), and
        // forge.jar carries it: io/netty/channel/socket/oio/OioSocketChannel.class.
        // OIO is built on java.net.Socket, not on sun.nio.ch.EPoll, so it is the
        // obvious swap if NIO is what CheerpJ cannot provide.
        run(out, "new io.netty.channel.oio.OioEventLoopGroup()", () -> {
            io.netty.channel.oio.OioEventLoopGroup g = new io.netty.channel.oio.OioEventLoopGroup(1);
            String d = g.getClass().getName();
            g.shutdownGracefully();
            return d;
        });

        run(out, "new io.netty.channel.socket.oio.OioSocketChannel()", () ->
                new io.netty.channel.socket.oio.OioSocketChannel().getClass().getName());

        // --- does anything actually reach the network? -----------------------
        // args[0], when present, is the page's own origin. Same-origin HTTP is the
        // one networking mode CheerpJ supports with no Tailscale control plane, so
        // it should work; a raw TCP connect to the SAME host and port should not.
        // The DIFFERENCE between the two failures is the finding, not the failures.
        final String origin = args.length > 0 ? args[0] : null;
        if (origin != null) {
            final java.net.URL u = new java.net.URL(origin + "/probe.jar");
            run(out, "URL.openStream() same-origin " + u, () -> {
                try (java.io.InputStream in = u.openStream()) {
                    byte[] b = new byte[4];
                    int n = in.read(b);
                    return "read " + n + " bytes, magic=" + String.format("%02x%02x%02x%02x",
                            b[0], b[1], b[2], b[3]);
                }
            });

            final String host = u.getHost();
            final int port = u.getPort() == -1 ? 80 : u.getPort();
            run(out, "new java.net.Socket(\"" + host + "\", " + port + ") -- raw TCP, no Tailscale", () -> {
                try (java.net.Socket s = new java.net.Socket()) {
                    s.connect(new java.net.InetSocketAddress(host, port), 4000);
                    return "connected local=" + s.getLocalSocketAddress();
                }
            });
        }

        out.println("PROBE net end");
    }

    private interface Step {
        String call() throws Throwable;
    }

    private static void run(PrintStream out, String name, Step s) {
        step++;
        try {
            out.println("STEP " + step + " " + name + " OK " + s.call());
        } catch (Throwable t) {
            out.println("STEP " + step + " " + name + " FAIL " + describe(t));
            for (StackTraceElement e : t.getStackTrace()) {
                out.println("    at " + e);
            }
            Throwable c = t.getCause();
            int depth = 0;
            while (c != null && depth++ < 4) {
                out.println("  caused by " + describe(c));
                for (StackTraceElement e : c.getStackTrace()) {
                    out.println("    at " + e);
                }
                c = c.getCause();
            }
        }
        out.flush();
    }

    private static String describe(Throwable t) {
        return t.getClass().getName() + ": " + t.getMessage();
    }
}
