/*
 * The asks a seat's own browser answers the moment they land, with nobody deciding anything —
 * one statement, read by both sides of the wire:
 *
 * - the browser (`apps/ui/src/play/live/LiveBoard.tsx`) sends the reply instead of drawing a prompt;
 * - the server (`apps/server/src/play/match.ts`'s `waitingOnFor`) never tells the OTHER seat that
 *   this one is deciding while such an ask is open. A loaded browser takes 139–371 ms to reply, longer
 *   than any grace, and the other screen read "Waiting for Alice to decide…" for a land she had
 *   already played (`e2e/w62-bounce.spec.ts`). Two copies of this rule had drifted: the server's
 *   knew the one-ability offer, not the lone counterspell target.
 *
 * Both callers read it under full control too: full control brings back every stop and every real
 * choice, never a question with one answer (the operator, 2026-10-19).
 *
 * The rule is the server's (`apps/server/src/play/auto.ts`): a shortcut may remove a question,
 * never information, and it never decides anything about the GAME — only that Forge left one
 * possibility. Everything else with one legal reply is answered a hop earlier, by `onlyAnswer` in
 * `auto.ts`, and never reaches a browser.
 *
 * ## A one-ability `getAbilityToPlay`
 *
 * The offer's LABEL is what makes the shortcut safe to report, and labels are resolved in the
 * browser (`lookup.ts`'s `withAbilityLabels`), so the browser is the side that can name what it
 * played. Forge's own desktop client does the same: `CMatchUI.getAbilityToPlay` with a null
 * `triggerEvent` returns the only ability and never opens `GuiChoose.oneOrNone`
 * (`CMatchUI.java:1017-1023`). A one-ability offer that reaches a browser is always the direct
 * consequence of that seat's own click — `InputPassPriority` for a card in hand, or
 * `InputPayMana.onCardSelected` for a land, which plays a lone mana ability itself and only asks for
 * two or more (`InputPayMana.java:101-106`).
 *
 * ## A counterspell's lone stack target (wave 32 Q7)
 *
 * *"If there's only one spell on the stack then the target of Mana Leak is obvious"* (operator).
 * Forge asks it through `TargetSelection.chooseCardFromStack` (`TargetSelection.java:299-343`): a
 * `getChoices` over `StackItemView`s, `min = max = 1`, or `min 0, max 1` for `oneOrNone` — and the
 * operator ruled one spell is the obvious target either way.
 *
 * ## Never a reveal
 *
 * A reveal is `getChoices` with `min === max === -1` (`AbstractGuiGame.java:785-788`) and one legal
 * reply, the empty list. The server answers it and sends it on as display-only; answering it here
 * would delete the information (`max < 1` keeps it out).
 */
import { REPLY_SCHEMAS, type ServerFrame } from '@hadoku/forge-wire';

type ReplyOf<M extends keyof typeof REPLY_SCHEMAS> = ReturnType<(typeof REPLY_SCHEMAS)[M]['parse']>;

export type SelfAnswer =
  | { method: 'getAbilityToPlay'; reply: ReplyOf<'getAbilityToPlay'> }
  | { method: 'getChoices'; reply: ReplyOf<'getChoices'> };

/** The reply `frame` gives itself, or null when it is a real question (or not an ask at all). */
export function selfAnswer(frame: ServerFrame): SelfAnswer | null {
  if (frame.kind !== 'ask') return null;
  if (frame.method === 'getChoices') {
    const only = frame.choices.length === 1 ? frame.choices[0] : undefined;
    if (frame.max < 1 || only === undefined || only.ref?.kind !== 'stackItem') return null;
    const offered = frame.names ?? frame.choices.map((c) => c.key);
    return offered.includes(only.key) && frame.min <= 1 ? { method: 'getChoices', reply: [only.key] } : null;
  }
  // Exactly one ability: two are a real choice, and none is Forge asking about nothing.
  if (frame.method !== 'getAbilityToPlay' || frame.abilities.length !== 1) return null;
  // A malformed answer must never leave: it would be refused a hop later with no player to blame.
  const parsed = REPLY_SCHEMAS.getAbilityToPlay.safeParse(frame.abilities[0]);
  return parsed.success ? { method: 'getAbilityToPlay', reply: parsed.data } : null;
}
