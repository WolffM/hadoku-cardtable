package clientspike;

import java.util.Collection;
import java.util.List;
import java.util.Map;

import forge.LobbyPlayer;
import forge.deck.CardPool;
import forge.game.GameEntityView;
import forge.game.GameView;
import forge.game.card.CardView;
import forge.game.event.GameEvent;
import forge.game.event.GameEventSpellAbilityCast;
import forge.game.event.GameEventSpellRemovedFromStack;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.IHasIcon;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;
import forge.game.zone.ZoneType;
import forge.gamemodes.match.DrawOfferMessage;
import forge.gamemodes.match.YieldUpdate;
import forge.gamemodes.net.DeltaPacket;
import forge.gui.control.PlaybackSpeed;
import forge.gui.interfaces.IGuiGame;
import forge.interfaces.IGameController;
import forge.localinstance.skin.FSkinProp;
import forge.player.PlayerZoneUpdate;
import forge.player.PlayerZoneUpdates;
import forge.screens.match.MatchController;
import forge.trackable.TrackableCollection;
import forge.util.FSerializableFunction;
import forge.util.ITriggerEvent;
import forge.util.collect.FCollectionView;

/**
 * Entry point A: the Forge client's INBOUND surface.
 *
 * Every one of the 45 {@code Mode.SERVER} entries in {@code ProtocolMethod}
 * lands on a method of {@link IGuiGame}. On the mobile port the implementation
 * is {@link MatchController}. This class calls that surface through the
 * interface, so TeaVM's whole-program reachability analysis has to link the
 * mobile client's rendering path and everything it drags in.
 *
 * It is deliberately NEVER RUN. Every argument is null or zero and the first
 * call would NPE. Linking is the question this lane asks; a running client is a
 * later wave. See docs/spikes/client-wasm.md.
 *
 * Nothing here touches Forge's outbound half - no netty, no ReplyPool. That is
 * {@link NetClientMain}, kept separate so the two costs can be read apart.
 */
public final class GuiSurfaceMain {
    private GuiSurfaceMain() {
    }

    public static void main(final String[] args) {
        driveGui(MatchController.instance);
        driveQuarantined(MatchController.instance);
    }

    /** Calls the client's inbound protocol surface. */
    static void driveGui(final IGuiGame g) {
        // --- lifecycle -----------------------------------------------------
        g.isLibgdxPort();
        g.isNetGame();
        g.setNetGame();
        g.setGameView((GameView) null);
        g.setGameView((GameView) null, 0L);
        g.getGameView();
        g.getGamestate();

        // --- controllers ---------------------------------------------------
        g.setOriginalGameController((PlayerView) null, (IGameController) null);
        g.setGameController((PlayerView) null, (IGameController) null);
        g.setSpectator((IGameController) null);
        g.setCurrentPlayer((PlayerView) null);

        // --- prompt / buttons ----------------------------------------------
        g.showPromptMessage((PlayerView) null, (String) null);
        g.showPromptMessage((PlayerView) null, (String) null, (CardView) null);
        g.updateButtons((PlayerView) null, false, false, false);
        g.updateButtons((PlayerView) null, (String) null, (String) null, false, false, false);
        g.flashIncorrectAction();
        g.alertUser();
        g.awaitNextInput();
        g.cancelAwaitNextInput();
        g.showWaitingTimer((PlayerView) null, (String) null);

        // --- board / state updates -----------------------------------------
        g.showCombat();
        g.updateTurn((PlayerView) null);
        g.enableOverlay();
        g.disableOverlay();
        g.showManaPool((PlayerView) null);
        g.hideManaPool((PlayerView) null);
        g.updateStack();
        g.notifyStackAddition((GameEventSpellAbilityCast) null);
        g.notifyStackRemoval((GameEventSpellRemovedFromStack) null);
        g.handleLandPlayed((CardView) null);
        g.handleGameEvent((GameEvent) null);
        g.handleGameEvents((List<GameEvent>) null);
        g.tempShowZones((PlayerView) null, (Iterable<PlayerZoneUpdate>) null);
        g.hideZones((PlayerView) null, (Iterable<PlayerZoneUpdate>) null);
        g.updateZones((Iterable<PlayerZoneUpdate>) null);
        g.updateSingleCard((CardView) null);
        g.updateCards((Iterable<CardView>) null);
        g.updateCardsNetSafe((FCollectionView<CardView>) null);
        g.updateRevealedCards((TrackableCollection<CardView>) null);
        g.refreshCardDetails((Iterable<CardView>) null);
        g.refreshField();
        g.updateManaPool((Iterable<PlayerView>) null);
        g.updateLives((Iterable<PlayerView>) null);
        g.updateShards((Iterable<PlayerView>) null);
        g.updateDependencies();
        g.setPanelSelection((CardView) null);
        g.setCard((CardView) null);

        // --- zones / selection ---------------------------------------------
        g.openZones((PlayerView) null, (Collection<ZoneType>) null, (Map<PlayerView, Object>) null, false);
        g.restoreOldZones((PlayerView) null, (PlayerZoneUpdates) null);
        g.setHighlighted((Iterable<GameEntityView>) null, false);
        g.setSelectables((Iterable<CardView>) null, 0, 0);
        g.clearSelectables();
        g.isSelecting();
        g.setWeaklySelectable((Iterable<CardView>) null);
        g.clearWeaklySelectable();

        // --- pause / speed / day-night --------------------------------------
        g.isGamePaused();
        g.setGamePause(false);
        g.getGameSpeed();
        g.setGameSpeed((PlaybackSpeed) null);
        g.getDayTime();
        g.updateDayTime((String) null);
        g.isUiSetToSkipPhase((PlayerView) null, (PhaseType) null);

        // --- yields (Forge's own stop-point model) ---------------------------
        g.refreshYieldUi((PlayerView) null);
        g.applyYieldUpdate((YieldUpdate) null);
        g.updateDrawOffer((DrawOfferMessage.Status) null);

        // --- blocking questions: the sendAndWait half of the protocol ---------
        g.getAbilityToPlay((CardView) null, (List<SpellAbilityView>) null, (ITriggerEvent) null);
        g.assignCombatDamage((CardView) null, (List<CardView>) null, 0, (GameEntityView) null, false, false);
        g.assignGenericAmount((CardView) null, (Map<Object, Integer>) null, 0, false, (String) null);
        g.message((String) null);
        g.message((String) null, (String) null);
        g.showErrorDialog((String) null);
        g.showErrorDialog((String) null, (String) null);
        g.showConfirmDialog((String) null, (String) null);
        g.showConfirmDialog((String) null, (String) null, (String) null, (String) null);
        g.showConfirmDialog((String) null, (String) null, (String) null, (String) null, false);
        g.showOptionDialog((String) null, (String) null, (FSkinProp) null, (List<String>) null, 0);
        g.showInputDialog((String) null, (String) null, (FSkinProp) null, (String) null, (List<String>) null, false);
        g.confirm((CardView) null, (String) null);
        g.confirm((CardView) null, (String) null, false, (List<String>) null);
        g.getChoices((String) null, 0, 0, (List<Object>) null);
        g.getChoices((String) null, 0, 0, (List<Object>) null, (List<Object>) null,
                (FSerializableFunction<Object, String>) null);
        g.getInteger((String) null, 0, 0, false);
        g.getInteger((String) null, 0, 0, 0);
        g.oneOrNone((String) null, (List<Object>) null);
        g.one((String) null, (List<Object>) null);
        g.one((String) null, (List<Object>) null, (FSerializableFunction<Object, String>) null);
        g.reveal((String) null, (List<Object>) null);
        g.many((String) null, (String) null, 0, (List<Object>) null, (CardView) null);
        g.many((String) null, (String) null, 0, 0, (List<Object>) null, (CardView) null);
        g.many((String) null, (String) null, 0, 0, (List<Object>) null, (List<Object>) null, (CardView) null);
        g.order((String) null, (String) null, (List<Object>) null, (CardView) null);
        g.order((String) null, (String) null, 0, 0, (List<Object>) null, (List<Object>) null, (CardView) null, false);
        g.order((String) null, (String) null, 0, 0, (List<Object>) null, (List<Object>) null, (CardView) null, false,
                false);
        g.insertInList((String) null, (Object) null, (List<Object>) null);
        g.sideboard((CardPool) null, (CardPool) null, (String) null);
        g.chooseSingleEntityForEffect((String) null, (List<GameEntityView>) null, (DelayedReveal) null, false);
        g.chooseEntitiesForEffect((String) null, (List<GameEntityView>) null, 0, 0, (DelayedReveal) null);
        g.manipulateCardList((String) null, (Iterable<CardView>) null, (Iterable<CardView>) null, false, false, false);
    }

    /**
     * The eight calls that account for every missing API in this entry point.
     * {@link GuiSurfaceMinusMain} is the other 37; the difference between the
     * two link attempts is what these eight cost.
     *
     * Each reaches out of the client and into the rest of the mobile product:
     *   openView            -> MatchScreen -> VChat -> OnlineMenu ->
     *                          FServerManager (hosting a server), and
     *                          ForgePreferences' &lt;clinit&gt;
     *   finishGame          -> ViewWinLose -> QuestDraftWinLose /
     *                          GauntletWinLose -> Match.createGame -> Game,
     *                          and adventure's Config
     *   applyDelta          -> TrackableSerializer -> CObjectInputStream
     *                          (Java serialization) and netty's logger discovery
     *   setPlayerAvatar     -> ImageCache -> ImageKeys (a thread pool)
     *   updatePhase         -> GameState.initFromGame -> Game.&lt;clinit&gt;
     *                          (dev-mode state snapshot; dead on a net client)
     *   afterGameEnd        -> ImageCache.disposeTextures -> Assets / FModel
     *   updatePlayerControl -> VPlayerPanel.&lt;clinit&gt; -> FSkinFont ->
     *                          gdx-freetype's native loader
     *   updateAutoPassPrompt-> YieldController.&lt;clinit&gt; -> ForgePreferences
     */
    static void driveQuarantined(final IGuiGame g) {
        g.openView((TrackableCollection<PlayerView>) null);
        g.finishGame();
        g.setPlayerAvatar((LobbyPlayer) null, (IHasIcon) null);
        g.applyDelta((DeltaPacket) null);
        g.updatePhase(false);
        g.afterGameEnd();
        g.updatePlayerControl();
        g.updateAutoPassPrompt();
    }
}
