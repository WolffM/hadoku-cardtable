package clientspike;

import forge.screens.match.MatchController;

/**
 * Entry point D: {@link GuiSurfaceMain} minus the eight calls in
 * {@code GuiSurfaceMain.driveQuarantined} - {@code openView},
 * {@code finishGame}, {@code setPlayerAvatar}, {@code applyDelta},
 * {@code updatePhase}, {@code afterGameEnd}, {@code updatePlayerControl} and
 * {@code updateAutoPassPrompt}.
 *
 * Those eight are where every missing API in entry point A enters; this entry
 * point is the other 37 protocol methods, and linking it measures what is left
 * once the eight are cut - the size of the workaround a GO would need.
 *
 * Never run.
 */
public final class GuiSurfaceMinusMain {
    private GuiSurfaceMinusMain() {
    }

    public static void main(final String[] args) {
        GuiSurfaceMain.driveGui(MatchController.instance);
    }
}
