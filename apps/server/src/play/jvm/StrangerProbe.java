import forge.gamemodes.net.CompatibleObjectDecoder;
import forge.gamemodes.net.CompatibleObjectEncoder;
import forge.gamemodes.net.event.LobbyUpdateEvent;
import forge.gamemodes.net.event.LoginEvent;
import forge.gamemodes.net.event.MessageEvent;
import io.netty.bootstrap.Bootstrap;
import io.netty.channel.Channel;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelInboundHandlerAdapter;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.EventLoopGroup;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioSocketChannel;
import io.netty.handler.codec.serialization.ClassResolvers;

/**
 * A peer that is not one of a match's seats, speaking Forge's own wire format to that match's
 * Forge server: what anyone who can reach the port could do. Used by {@code h16-stranger.jvm.test.ts}.
 *
 * <p>{@code StrangerProbe <host> <port> <mode> <ms>}. Modes: {@code chat} sends a chat line without
 * logging in; {@code login} logs in as a new player. It then listens for {@code ms} and prints one
 * tab-separated line per thing it saw: {@code recv <class> <detail>}, {@code closed}, and last
 * {@code done}. Exits 0 whenever it could connect at all; {@code refused} and exit 0 when it could not.
 */
public final class StrangerProbe {
    public static void main(final String[] args) throws Exception {
        final String host = args[0];
        final int port = Integer.parseInt(args[1]);
        final String mode = args[2];
        final long listenMs = Long.parseLong(args[3]);
        final EventLoopGroup group = new NioEventLoopGroup(1);
        try {
            final Channel ch;
            try {
                ch = new Bootstrap().group(group).channel(NioSocketChannel.class)
                        .handler(new ChannelInitializer<SocketChannel>() {
                            @Override public void initChannel(final SocketChannel c) {
                                c.pipeline().addLast(
                                        new CompatibleObjectEncoder(null),
                                        new CompatibleObjectDecoder(9766 * 1024, ClassResolvers.cacheDisabled(null)),
                                        new ChannelInboundHandlerAdapter() {
                                            @Override public void channelRead(final ChannelHandlerContext ctx, final Object msg) {
                                                say("recv", msg.getClass().getSimpleName(), detail(msg));
                                            }
                                            @Override public void channelInactive(final ChannelHandlerContext ctx) {
                                                say("closed");
                                            }
                                            @Override public void exceptionCaught(final ChannelHandlerContext ctx, final Throwable e) {
                                                say("error", e.toString());
                                            }
                                        });
                            }
                        })
                        .connect(host, port).sync().channel();
            } catch (final Exception e) {
                say("refused", e.toString());
                return;
            }
            say("connected", String.valueOf(ch.remoteAddress()));
            switch (mode) {
                case "chat" -> ch.writeAndFlush(new MessageEvent("stranger", "a line from outside the match"));
                case "login" -> ch.writeAndFlush(new LoginEvent("stranger", 0, 0, null, false));
                default -> throw new IllegalArgumentException("mode: " + mode);
            }
            ch.closeFuture().await(listenMs);
            ch.close().sync();
            say("done");
        } finally {
            group.shutdownGracefully().sync();
        }
    }

    private static String detail(final Object msg) {
        if (msg instanceof MessageEvent m) {
            return m.getSource() + ": " + m.getMessage();
        }
        if (msg instanceof LobbyUpdateEvent u) {
            return "slot " + u.getSlot();
        }
        return "";
    }

    private static synchronized void say(final String... cells) {
        System.out.println(String.join("\t", cells).replace('\n', ' '));
        System.out.flush();
    }
}
