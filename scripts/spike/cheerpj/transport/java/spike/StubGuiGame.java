package spike;

import forge.gui.interfaces.IGuiGame;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * An {@link IGuiGame} that only records — 87 methods, generated, then committed.
 *
 * <h2>Why this is not a {@code java.lang.reflect.Proxy}</h2>
 *
 * It was, and CheerpJ 4.3 will not have it. Measured by this lane on
 * 2026-09-20:
 *
 * <pre>
 *   PROBE PROXY FAIL java.lang.InternalError: java.lang.ExceptionInInitializerError
 * </pre>
 *
 * {@code Proxy.newProxyInstance} generates a class at runtime, and CheerpJ is
 * an AOT compiler — there is no bytecode generator behind it. So every dynamic
 * proxy in the stack has to become a concrete class. That matters well beyond
 * this stub; see {@code docs/spikes/cheerpj-transport.md}.
 *
 * <h2>What it returns</h2>
 *
 * Nothing but zeroes and nulls, with one deliberate exception:
 * {@code showConfirmDialog} returns the ask's own {@code defaultYes}. Two asks
 * with different defaults therefore produce two different replies, and a
 * transport that carried a constant instead of the payload cannot pass.
 */
public final class StubGuiGame implements IGuiGame {

    /** Every method the transport delivered, in order. */
    public final List<String> calls = Collections.synchronizedList(new ArrayList<>());
    private volatile Object[] lastArgs = new Object[0];

    private void record(final String name, final Object... args) {
        lastArgs = args;
        calls.add(name);
        final StringBuilder sb = new StringBuilder();
        for (int i = 0; i < args.length; i++) {
            if (i > 0) sb.append(", ");
            sb.append(String.valueOf(args[i]));
        }
        System.out.println("PROBE GUI " + name + "(" + sb + ")");
    }

    @Override public void afterGameEnd() {
        record("afterGameEnd");
    }
    @Override public void alertUser() {
        record("alertUser");
    }
    @Override public void applyDelta(forge.gamemodes.net.DeltaPacket a0) {
        record("applyDelta", a0);
    }
    @Override public void applyYieldUpdate(forge.gamemodes.match.YieldUpdate a0) {
        record("applyYieldUpdate", a0);
    }
    @Override public java.util.Map<forge.game.card.CardView, java.lang.Integer> assignCombatDamage(forge.game.card.CardView a0, java.util.List<forge.game.card.CardView> a1, int a2, forge.game.GameEntityView a3, boolean a4, boolean a5) {
        record("assignCombatDamage", a0, a1, a2, a3, a4, a5);
        return null;
    }
    @Override public java.util.Map<java.lang.Object, java.lang.Integer> assignGenericAmount(forge.game.card.CardView a0, java.util.Map<java.lang.Object, java.lang.Integer> a1, int a2, boolean a3, java.lang.String a4) {
        record("assignGenericAmount", a0, a1, a2, a3, a4);
        return null;
    }
    @Override public void awaitNextInput() {
        record("awaitNextInput");
    }
    @Override public void cancelAwaitNextInput() {
        record("cancelAwaitNextInput");
    }
    @Override public java.util.List<forge.game.GameEntityView> chooseEntitiesForEffect(java.lang.String a0, java.util.List<? extends forge.game.GameEntityView> a1, int a2, int a3, forge.game.player.DelayedReveal a4) {
        record("chooseEntitiesForEffect", a0, a1, a2, a3, a4);
        return null;
    }
    @Override public forge.game.GameEntityView chooseSingleEntityForEffect(java.lang.String a0, java.util.List<? extends forge.game.GameEntityView> a1, forge.game.player.DelayedReveal a2, boolean a3) {
        record("chooseSingleEntityForEffect", a0, a1, a2, a3);
        return null;
    }
    @Override public void clearSelectables() {
        record("clearSelectables");
    }
    @Override public void clearWeaklySelectable() {
        record("clearWeaklySelectable");
    }
    @Override public boolean confirm(forge.game.card.CardView a0, java.lang.String a1, boolean a2, java.util.List<java.lang.String> a3) {
        record("confirm", a0, a1, a2, a3);
        return false;
    }
    @Override public void disableOverlay() {
        record("disableOverlay");
    }
    @Override public void enableOverlay() {
        record("enableOverlay");
    }
    @Override public void finishGame() {
        record("finishGame");
    }
    @Override public void flashIncorrectAction() {
        record("flashIncorrectAction");
    }
    @Override public forge.game.spellability.SpellAbilityView getAbilityToPlay(forge.game.card.CardView a0, java.util.List<forge.game.spellability.SpellAbilityView> a1, forge.util.ITriggerEvent a2) {
        record("getAbilityToPlay", a0, a1, a2);
        return null;
    }
    @Override public <T> java.util.List<T> getChoices(java.lang.String a0, int a1, int a2, java.util.List<T> a3, java.util.List<T> a4, forge.util.FSerializableFunction<T, java.lang.String> a5) {
        record("getChoices", a0, a1, a2, a3, a4, a5);
        return null;
    }
    @Override public java.lang.String getDayTime() {
        record("getDayTime");
        return null;
    }
    @Override public forge.gui.control.PlaybackSpeed getGameSpeed() {
        record("getGameSpeed");
        return null;
    }
    @Override public forge.game.GameView getGameView() {
        record("getGameView");
        return null;
    }
    @Override public forge.game.GameState getGamestate() {
        record("getGamestate");
        return null;
    }
    @Override public java.lang.Integer getInteger(java.lang.String a0, int a1, int a2, boolean a3) {
        record("getInteger", a0, a1, a2, a3);
        return null;
    }
    @Override public java.lang.Integer getInteger(java.lang.String a0, int a1, int a2, int a3) {
        record("getInteger", a0, a1, a2, a3);
        return null;
    }
    @Override public void handleGameEvent(forge.game.event.GameEvent a0) {
        record("handleGameEvent", a0);
    }
    @Override public void handleLandPlayed(forge.game.card.CardView a0) {
        record("handleLandPlayed", a0);
    }
    @Override public void hideManaPool(forge.game.player.PlayerView a0) {
        record("hideManaPool", a0);
    }
    @Override public void hideZones(forge.game.player.PlayerView a0, java.lang.Iterable<forge.player.PlayerZoneUpdate> a1) {
        record("hideZones", a0, a1);
    }
    @Override public <T> java.util.List<T> insertInList(java.lang.String a0, T a1, java.util.List<T> a2) {
        record("insertInList", a0, a1, a2);
        return null;
    }
    @Override public boolean isGamePaused() {
        record("isGamePaused");
        return false;
    }
    @Override public boolean isNetGame() {
        record("isNetGame");
        return false;
    }
    @Override public boolean isSelecting() {
        record("isSelecting");
        return false;
    }
    @Override public boolean isUiSetToSkipPhase(forge.game.player.PlayerView a0, forge.game.phase.PhaseType a1) {
        record("isUiSetToSkipPhase", a0, a1);
        return false;
    }
    @Override public java.util.List<forge.game.card.CardView> manipulateCardList(java.lang.String a0, java.lang.Iterable<forge.game.card.CardView> a1, java.lang.Iterable<forge.game.card.CardView> a2, boolean a3, boolean a4, boolean a5) {
        record("manipulateCardList", a0, a1, a2, a3, a4, a5);
        return null;
    }
    @Override public <T> java.util.List<T> many(java.lang.String a0, java.lang.String a1, int a2, int a3, java.util.List<T> a4, java.util.List<T> a5, forge.game.card.CardView a6) {
        record("many", a0, a1, a2, a3, a4, a5, a6);
        return null;
    }
    @Override public void message(java.lang.String a0, java.lang.String a1) {
        record("message", a0, a1);
    }
    @Override public void notifyStackAddition(forge.game.event.GameEventSpellAbilityCast a0) {
        record("notifyStackAddition", a0);
    }
    @Override public void notifyStackRemoval(forge.game.event.GameEventSpellRemovedFromStack a0) {
        record("notifyStackRemoval", a0);
    }
    @Override public <T> T one(java.lang.String a0, java.util.List<T> a1, forge.util.FSerializableFunction<T, java.lang.String> a2) {
        record("one", a0, a1, a2);
        return null;
    }
    @Override public <T> T oneOrNone(java.lang.String a0, java.util.List<T> a1) {
        record("oneOrNone", a0, a1);
        return null;
    }
    @Override public void openView(forge.trackable.TrackableCollection<forge.game.player.PlayerView> a0) {
        record("openView", a0);
    }
    @Override public forge.player.PlayerZoneUpdates openZones(forge.game.player.PlayerView a0, java.util.Collection<forge.game.zone.ZoneType> a1, java.util.Map<forge.game.player.PlayerView, java.lang.Object> a2, boolean a3) {
        record("openZones", a0, a1, a2, a3);
        return null;
    }
    @Override public <T> forge.gui.interfaces.IGuiGame.OrderResult<T> order(java.lang.String a0, java.lang.String a1, int a2, int a3, java.util.List<T> a4, java.util.List<T> a5, forge.game.card.CardView a6, boolean a7, boolean a8) {
        record("order", a0, a1, a2, a3, a4, a5, a6, a7, a8);
        return null;
    }
    @Override public void refreshCardDetails(java.lang.Iterable<forge.game.card.CardView> a0) {
        record("refreshCardDetails", a0);
    }
    @Override public void refreshField() {
        record("refreshField");
    }
    @Override public void restoreOldZones(forge.game.player.PlayerView a0, forge.player.PlayerZoneUpdates a1) {
        record("restoreOldZones", a0, a1);
    }
    @Override public <T> void reveal(java.lang.String a0, java.util.List<T> a1) {
        record("reveal", a0, a1);
    }
    @Override public void setCard(forge.game.card.CardView a0) {
        record("setCard", a0);
    }
    @Override public void setCurrentPlayer(forge.game.player.PlayerView a0) {
        record("setCurrentPlayer", a0);
    }
    @Override public void setGameController(forge.game.player.PlayerView a0, forge.interfaces.IGameController a1) {
        record("setGameController", a0, a1);
    }
    @Override public void setGamePause(boolean a0) {
        record("setGamePause", a0);
    }
    @Override public void setGameSpeed(forge.gui.control.PlaybackSpeed a0) {
        record("setGameSpeed", a0);
    }
    @Override public void setGameView(forge.game.GameView a0) {
        record("setGameView", a0);
    }
    @Override public void setHighlighted(java.lang.Iterable<forge.game.GameEntityView> a0, boolean a1) {
        record("setHighlighted", a0, a1);
    }
    @Override public void setNetGame() {
        record("setNetGame");
    }
    @Override public void setOriginalGameController(forge.game.player.PlayerView a0, forge.interfaces.IGameController a1) {
        record("setOriginalGameController", a0, a1);
    }
    @Override public void setPanelSelection(forge.game.card.CardView a0) {
        record("setPanelSelection", a0);
    }
    @Override public void setPlayerAvatar(forge.LobbyPlayer a0, forge.game.player.IHasIcon a1) {
        record("setPlayerAvatar", a0, a1);
    }
    @Override public void setSelectables(java.lang.Iterable<forge.game.card.CardView> a0, int a1, int a2) {
        record("setSelectables", a0, a1, a2);
    }
    @Override public void setSpectator(forge.interfaces.IGameController a0) {
        record("setSpectator", a0);
    }
    @Override public void setWeaklySelectable(java.lang.Iterable<forge.game.card.CardView> a0) {
        record("setWeaklySelectable", a0);
    }
    @Override public void showCombat() {
        record("showCombat");
    }
    @Override public boolean showConfirmDialog(java.lang.String a0, java.lang.String a1, java.lang.String a2, java.lang.String a3, boolean a4) {
        record("showConfirmDialog", a0, a1, a2, a3, a4);
        return ((Boolean) lastArgs[4]);
    }
    @Override public void showErrorDialog(java.lang.String a0, java.lang.String a1) {
        record("showErrorDialog", a0, a1);
    }
    @Override public java.lang.String showInputDialog(java.lang.String a0, java.lang.String a1, forge.localinstance.skin.FSkinProp a2, java.lang.String a3, java.util.List<java.lang.String> a4, boolean a5) {
        record("showInputDialog", a0, a1, a2, a3, a4, a5);
        return null;
    }
    @Override public void showManaPool(forge.game.player.PlayerView a0) {
        record("showManaPool", a0);
    }
    @Override public int showOptionDialog(java.lang.String a0, java.lang.String a1, forge.localinstance.skin.FSkinProp a2, java.util.List<java.lang.String> a3, int a4) {
        record("showOptionDialog", a0, a1, a2, a3, a4);
        return 0;
    }
    @Override public void showPromptMessage(forge.game.player.PlayerView a0, java.lang.String a1, forge.game.card.CardView a2) {
        record("showPromptMessage", a0, a1, a2);
    }
    @Override public void showWaitingTimer(forge.game.player.PlayerView a0, java.lang.String a1) {
        record("showWaitingTimer", a0, a1);
    }
    @Override public java.util.List<forge.item.PaperCard> sideboard(forge.deck.CardPool a0, forge.deck.CardPool a1, java.lang.String a2) {
        record("sideboard", a0, a1, a2);
        return null;
    }
    @Override public java.lang.Iterable<forge.player.PlayerZoneUpdate> tempShowZones(forge.game.player.PlayerView a0, java.lang.Iterable<forge.player.PlayerZoneUpdate> a1) {
        record("tempShowZones", a0, a1);
        return null;
    }
    @Override public void updateAutoPassPrompt() {
        record("updateAutoPassPrompt");
    }
    @Override public void updateButtons(forge.game.player.PlayerView a0, java.lang.String a1, java.lang.String a2, boolean a3, boolean a4, boolean a5) {
        record("updateButtons", a0, a1, a2, a3, a4, a5);
    }
    @Override public void updateCards(java.lang.Iterable<forge.game.card.CardView> a0) {
        record("updateCards", a0);
    }
    @Override public void updateDayTime(java.lang.String a0) {
        record("updateDayTime", a0);
    }
    @Override public void updateDependencies() {
        record("updateDependencies");
    }
    @Override public void updateLives(java.lang.Iterable<forge.game.player.PlayerView> a0) {
        record("updateLives", a0);
    }
    @Override public void updateManaPool(java.lang.Iterable<forge.game.player.PlayerView> a0) {
        record("updateManaPool", a0);
    }
    @Override public void updatePhase(boolean a0) {
        record("updatePhase", a0);
    }
    @Override public void updatePlayerControl() {
        record("updatePlayerControl");
    }
    @Override public void updateRevealedCards(forge.trackable.TrackableCollection<forge.game.card.CardView> a0) {
        record("updateRevealedCards", a0);
    }
    @Override public void updateShards(java.lang.Iterable<forge.game.player.PlayerView> a0) {
        record("updateShards", a0);
    }
    @Override public void updateSingleCard(forge.game.card.CardView a0) {
        record("updateSingleCard", a0);
    }
    @Override public void updateStack() {
        record("updateStack");
    }
    @Override public void updateTurn(forge.game.player.PlayerView a0) {
        record("updateTurn", a0);
    }
    @Override public void updateZones(java.lang.Iterable<forge.player.PlayerZoneUpdate> a0) {
        record("updateZones", a0);
    }
}
