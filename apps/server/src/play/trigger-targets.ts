/**
 * A batch of identical triggers, or of one spell's copies, asked once.
 *
 * Forge puts simultaneous triggers on the stack one at a time and asks each
 * one's targets in turn (`PlayerControllerHuman.orderAndPlaySimultaneousSa`):
 * six Valakut triggers are six identical target questions. A storm spell's
 * copies go through the same method, each asking for its new target: a Brain
 * Freeze with storm 17 is seventeen. The bridge names the group an open target
 * selection belongs to (`targetAbility`: the ability, the trigger of its card or
 * the spell it copies, how many of the group are still to ask). A seat that
 * answers one with "same target for all" (`sameTarget` on its select act) has
 * answered the rest: each following question of the same group is answered
 * here with the same target, for as long as Forge still offers it.
 *
 * And a target the seat chose is a "yes" already: an effect that asks on
 * resolution whether to go ahead ("Do you want to deal 3 damage to Bella?",
 * `DamageDealEffect.java:180-184`, or an optional trigger's "Use triggered
 * ability?") for an ability whose target this seat picked is answered Yes. An
 * optional trigger the seat chose nothing for still asks.
 */

import type { ClientFrame, ServerFrame } from '@hadoku/forge-wire';

import type { SeatNotes } from './auto.ts';

export interface TargetRef {
	kind: 'player' | 'card';
	id: number;
}

/** A seat's "same target for all": the trigger it answered, and with what. */
export interface SameTarget {
	trigger: string;
	target: TargetRef;
}

type TargetAbility = NonNullable<Extract<ServerFrame, { method: 'showPromptMessage' }>['targetAbility']>;

/** The trigger an open target selection is for, or null when `prompt` is not one. */
export function targetAbilityOf(prompt: ServerFrame | null): TargetAbility | null {
	return prompt !== null && prompt.method === 'showPromptMessage' ? (prompt.targetAbility ?? null) : null;
}

/** What a select act picked, or null for any other act. */
export function pickedBy(frame: ClientFrame): TargetRef | null {
	if (frame.kind !== 'act') return null;
	if (frame.method === 'selectPlayer') return { kind: 'player', id: frame.player.id };
	if (frame.method === 'selectCard') return { kind: 'card', id: frame.card.id };
	return null;
}

/**
 * The act that answers this target selection from the seat's "same target for
 * all", or null: another trigger, or a target Forge no longer offers (it left,
 * gained protection, a player lost) — then the seat is asked. A player is checked
 * against the question's own `players`; a question that does not say (the bridge
 * could not read it) is asked too.
 */
export function sameTargetAct(prompt: ServerFrame | null, selection: ServerFrame | null, same: SameTarget | null): Extract<ClientFrame, { kind: 'act' }> | null {
	const asked = targetAbilityOf(prompt);
	if (same === null || asked === null || asked.trigger !== same.trigger) return null;
	if (selection === null || selection.method !== 'setSelectables') return null;
	const { kind, id } = same.target;
	if (kind === 'player') {
		if (asked.players?.some((p) => p.id === id) !== true) return null;
		return { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id }, triggerEvent: null };
	}
	if (!selection.cards.some((c) => c.id === id)) return null;
	return { kind: 'act', method: 'selectCard', card: { kind: 'card', id }, otherCardViewsToSelect: [], triggerEvent: null };
}

/**
 * Yes to a resolution confirm for an ability whose target this seat chose, or
 * null. `chosen` holds the abilities whose target selection the seat answered
 * (its own pick, or its "same target for all"). The confirm names the ability
 * itself, or — an optional trigger's own "Use triggered ability?" — the trigger
 * wrapping it (`confirmAbility.trigger.abilityId`).
 */
export function chosenTargetConfirm(notes: SeatNotes, chosen: ReadonlySet<number>): number | null {
	if (chosen.size === 0 || notes.openAsks > 0) return null;
	const { prompt, buttons } = notes;
	if (prompt === null || prompt.method !== 'showPromptMessage' || prompt.confirmAbility === undefined) return null;
	if (buttons === null || buttons.method !== 'updateButtons' || buttons.enable1 !== true) return null;
	if (notes.playerId === null || prompt.player.id !== notes.playerId || buttons.owner.id !== notes.playerId) return null;
	const { abilityId, trigger } = prompt.confirmAbility;
	if (chosen.has(abilityId)) return abilityId;
	if (trigger?.abilityId !== undefined && chosen.has(trigger.abilityId)) return trigger.abilityId;
	return null;
}
