/*
 * A spell on the stack as a target (wave 32 Q7).
 *
 * The operator, on Mana Leak: *"the question for 'select target spell' feels
 * weird. why can't i drag an arrow to it?"* Forge asks it as a mandatory
 * `getChoices` over `StackItemView`s (`../../prompts/rules.ts`'s
 * `stackItemChoices` says where), so it never opens a selection and
 * `boardInteraction` offers nothing while it is up. This module is the other
 * half of that ask: the stack items it names are the drop targets, the same
 * arrow draws to them, and a release on one answers the ask.
 *
 * Nothing here decides legality. The reply goes through `rules.ts`'s
 * `getChoicesProblems` and `answerAsk`, which re-checks that the ask is still
 * the open one, so a stale gesture cannot answer whatever Forge asks next.
 */
import { answerAsk, currentAsk, type LiveMatch } from '../match.ts';
import { getChoicesProblems, stackItemChoices } from '../../prompts/rules.ts';
import type { AskOf } from '../../prompts/types.ts';

export interface StackAsk {
  callId: string;
  ask: AskOf<'getChoices'>;
  /** Stack item id → the choice key that answers with it. */
  keys: ReadonlyMap<number, string>;
}

/** The open ask, when it is a choice between stack items; otherwise null. */
export function stackAsk(match: LiveMatch): StackAsk | null {
  const ask = currentAsk(match);
  if (ask === null || ask.method !== 'getChoices') return null;
  const items = stackItemChoices(ask);
  if (items === null) return null;
  return { callId: ask.callId, ask, keys: new Map(items.map((i) => [i.stackItemId, i.key])) };
}

/** A stack item's `<li>`: `data-stack-id` is on it (`Board.tsx`'s `StackItem`). */
export function stackItemBox(root: ParentNode, id: number): Element | null {
  return root.querySelector(`[data-stack-id="${id}"]`);
}

/** The stack item the ask offers under `node`, or null. */
export function stackItemUnder(node: EventTarget | null, offered: StackAsk): number | null {
  const el = node instanceof Element ? node.closest('[data-stack-id]') : null;
  const raw = el?.getAttribute('data-stack-id');
  if (raw === null || raw === undefined || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return offered.keys.has(id) ? id : null;
}

/**
 * Answer the ask with the stack item `id`. False, and nothing sent, when that
 * is not a legal reply now.
 *
 * Wave 46 §B's counterspell arc reads off this reply too, but not from here:
 * `match.ts`'s `answerAsk` is the one choke point every `getChoices` reply
 * passes through (this gesture's, and Forge's own single-legal-choice
 * auto-answer alike), so that is where the targeted stack item's id is
 * recorded — see its own note.
 */
export function commitStackTarget(match: LiveMatch, id: number): boolean {
  const offered = stackAsk(match);
  const key = offered?.keys.get(id);
  if (offered === null || key === undefined) return false;
  if (getChoicesProblems(offered.ask, [key]).length > 0) return false;
  return answerAsk(match, offered.callId, 'getChoices', [key]);
}
