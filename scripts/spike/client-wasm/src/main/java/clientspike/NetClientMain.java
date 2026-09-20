package clientspike;

import java.util.List;

import forge.game.card.CardView;
import forge.game.spellability.SpellAbilityView;
import forge.gamemodes.match.DrawOfferMessage;
import forge.gamemodes.match.NextGameDecision;
import forge.gamemodes.match.YieldUpdate;
import forge.gamemodes.net.client.IToServer;
import forge.gamemodes.net.client.NetGameController;
import forge.gamemodes.net.event.IdentifiableNetEvent;
import forge.gamemodes.net.event.NetEvent;
import forge.game.player.PlayerView;
import forge.interfaces.IGameController;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.player.AutoYieldStore;
import forge.screens.match.MatchController;
import forge.util.ITriggerEvent;

/**
 * Entry point B: entry point A plus the client's OUTBOUND half.
 *
 * The 15 {@code Mode.CLIENT} entries in {@code ProtocolMethod} leave through
 * {@link IGameController}; on a net client that is
 * {@link NetGameController}, which wraps a {@code GameProtocolSender} and
 * parks blocking questions on a {@code ReplyPool}.
 *
 * The transport itself is NOT linked here. {@link StubToServer} stands in for
 * netty, because in this design our bridge is the transport - a browser cannot
 * open a raw TCP socket and Forge's {@code FGameClient} bootstraps a
 * {@code NioEventLoopGroup}. What this entry point measures is the cost of
 * keeping Forge's own reply plumbing above that transport.
 *
 * Never run. See {@link GuiSurfaceMain}.
 */
public final class NetClientMain {
    private NetClientMain() {
    }

    public static void main(final String[] args) {
        GuiSurfaceMain.driveGui(MatchController.instance);
        GuiSurfaceMain.driveQuarantined(MatchController.instance);
        driveController(new NetGameController(new StubToServer()));
    }

    /** Calls the client's outbound protocol surface. */
    static void driveController(final IGameController c) {
        c.mayLookAtAllCards();
        c.canPlayUnlimitedLands();
        c.concede();
        c.drawOfferAction((DrawOfferMessage.Action) null);
        c.alphaStrike();
        c.useMana((byte) 0);
        c.selectButtonOk();
        c.selectButtonCancel();
        c.selectPlayer((PlayerView) null, (ITriggerEvent) null);
        c.selectCard((CardView) null, (List<CardView>) null, (ITriggerEvent) null);
        c.selectAbility((SpellAbilityView) null);
        c.undoLastAction();
        c.cheat();
        c.macros();
        c.nextGameDecision((NextGameDecision) null);
        c.getActivateDescription((CardView) null);
        c.reorderHand((CardView) null, 0);
        c.requestResync();
        c.shouldAutoYield((String) null);
        c.setShouldAutoYield((String) null, false, false);
        c.setDisableAutoYields(false);
        c.getTriggerDecision((String) null);
        c.setTriggerDecision((String) null, (AutoYieldStore.TriggerDecision) null, false);
        c.setDisableAutoTriggers(false);
        c.applyYieldUpdate((YieldUpdate) null);
        c.sendYieldUpdate((YieldUpdate) null);
        c.getYieldController();
        c.setYieldPref((FPref) null, (String) null);
    }

    /**
     * Stands in for netty. Our bridge terminates the wire; Forge's client half
     * above it only ever sees this interface.
     */
    static final class StubToServer implements IToServer {
        @Override
        public void send(final NetEvent event) {
        }

        @Override
        public Object sendAndWait(final IdentifiableNetEvent event) {
            return null;
        }
    }
}
