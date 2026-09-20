package clientspike;

import forge.game.GameView;
import forge.game.card.CardView;
import forge.game.player.PlayerView;
import forge.trackable.TrackableCollection;
import forge.trackable.TrackableProperty;
import forge.trackable.Tracker;

/**
 * Entry point C: the narrowest possible client. No libGDX, no MatchController,
 * no netty - just the trackable view layer that any client, ours or Forge's,
 * has to be able to hold.
 *
 * {@code TrackableProperty} is the 214-property enum the whole wire format is
 * built on; {@code CardView} / {@code PlayerView} / {@code GameView} are what
 * the 45 server-&gt;client methods carry. If even this does not link, no browser
 * client of any shape is possible without changing Forge. If it does link, the
 * gap between this and {@link GuiSurfaceMain} is what the mobile UI costs.
 *
 * Never run.
 */
public final class ViewLayerMain {
    private ViewLayerMain() {
    }

    public static void main(final String[] args) {
        System.out.println(TrackableProperty.values().length);

        final Tracker tracker = new Tracker();
        final GameView game = null;
        final CardView card = new CardView(0, tracker);
        final PlayerView player = new PlayerView(0, tracker);

        final TrackableCollection<CardView> cards = new TrackableCollection<>(card);
        cards.add(card);

        System.out.println(card.getName());
        System.out.println(card.getCurrentState() != null);
        System.out.println(player.getLife());
        System.out.println(game != null ? game.getTurn() : -1);
        System.out.println(cards.size());
        System.out.println(tracker.isFrozen());
    }
}
