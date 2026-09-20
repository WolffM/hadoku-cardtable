package clientspike;

import forge.screens.match.MatchController;

/**
 * Entry point E: one protocol method, {@code updatePhase}, on its own.
 *
 * It is isolated because it is the shortest route from the client to
 * {@code forge.game.Game} that is not the win/lose screen - and because in a
 * larger entry point TeaVM reports some other, shorter path to the same
 * missing APIs, so the chain disappears from the log. Linking this alone makes
 * {@code MatchController.updatePhase -> GameState.initFromGame ->
 * Game.<clinit>} reproducible on demand.
 *
 * Never run.
 */
public final class UpdatePhaseMain {
    private UpdatePhaseMain() {
    }

    public static void main(final String[] args) {
        MatchController.instance.updatePhase(true);
    }
}
