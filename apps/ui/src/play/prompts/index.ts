/*
 * The prompt components, by `ProtocolMethod` name — one import for whoever
 * wires them to a socket.
 *
 *     import { PROMPT_COMPONENTS, isPromptMethod } from './prompts/index.ts';
 *
 *     if (frame.kind === 'ask' && isPromptMethod(frame.method)) {
 *       const Prompt = PROMPT_COMPONENTS[frame.method];
 *       …
 *     }
 *
 * `PromptFor` does that dispatch for a frame whose method is only known at
 * runtime. Fourteen methods: the fifteenth blocking one, `showConfirmDialog`,
 * is lane B's (`../live/`), and `PROMPT_METHODS` holds this directory to the
 * rest. Nothing here opens a socket — see `types.ts`.
 */

import { createElement, type ComponentType } from 'react';

import { AssignCombatDamagePrompt, AssignGenericAmountPrompt } from './AssignPrompts.tsx';
import {
  ChooseEntitiesPrompt,
  ChooseSingleEntityPrompt,
  GetAbilityToPlayPrompt,
  GetChoicesPrompt,
} from './ChoicePrompts.tsx';
import { ConfirmAskPrompt, ShowInputDialogPrompt, ShowOptionDialogPrompt } from './DialogPrompts.tsx';
import { ManipulateCardListPrompt } from './ManipulateCardListPrompt.tsx';
import { OrderPrompt } from './OrderPrompt.tsx';
import { AskSourceContext } from './PromptShell.tsx';
import { SideboardPrompt } from './SideboardPrompt.tsx';
import { OpenZonesPrompt, TempShowZonesPrompt } from './ZonePrompts.tsx';
import type { PromptLookup } from './lookup.ts';
import { PROMPT_METHODS, type AskOf, type PromptMethod, type PromptProps, type ReplyOf } from './types.ts';

export const PROMPT_COMPONENTS: { readonly [M in PromptMethod]: ComponentType<PromptProps<M>> } = {
  tempShowZones: TempShowZonesPrompt,
  getAbilityToPlay: GetAbilityToPlayPrompt,
  assignCombatDamage: AssignCombatDamagePrompt,
  assignGenericAmount: AssignGenericAmountPrompt,
  showOptionDialog: ShowOptionDialogPrompt,
  showInputDialog: ShowInputDialogPrompt,
  confirm: ConfirmAskPrompt,
  getChoices: GetChoicesPrompt,
  order: OrderPrompt,
  sideboard: SideboardPrompt,
  chooseSingleEntityForEffect: ChooseSingleEntityPrompt,
  chooseEntitiesForEffect: ChooseEntitiesPrompt,
  manipulateCardList: ManipulateCardListPrompt,
  openZones: OpenZonesPrompt,
};

const PROMPT_SET: ReadonlySet<string> = new Set(PROMPT_METHODS);

export function isPromptMethod(method: string): method is PromptMethod {
  return PROMPT_SET.has(method);
}

/** Props for `PromptFor`: any of the fourteen asks, and an answer for it. */
export interface AnyPromptProps {
  ask: AskOf<PromptMethod>;
  onAnswer: (reply: ReplyOf<PromptMethod>) => void;
  lookup: PromptLookup;  /**
   * What the answer being built would do to cards on the board, by card id, for
   * the board to echo while the prompt is open. Only a prompt with such an
   * answer calls it (`AssignCombatDamagePrompt`).
   */
  onPreview?: (amounts: ReadonlyMap<number, number>) => void;
}

/**
 * Render the component for an ask whose method is only known at runtime.
 *
 * The cast is the one place the method→component correspondence is taken on
 * trust, and `PROMPT_COMPONENTS`' mapped type is what makes it true: entry `M`
 * is typed `ComponentType<PromptProps<M>>`, so `ask.method` picks the component
 * that takes exactly that ask. TypeScript cannot follow the correlation
 * through a union, which is the only reason the cast exists.
 */
export function PromptFor(props: AnyPromptProps) {
  const component = PROMPT_COMPONENTS[props.ask.method] as unknown as ComponentType<AnyPromptProps>;
  const { source } = props.ask;
  const sheet = createElement(component, props);
  return source === undefined ? sheet : createElement(AskSourceContext.Provider, { value: { source, lookup: props.lookup } }, sheet);
}

// T8: `checkedReply`, `PromptAnswerError`, `ReplyOf`, `EMPTY_LOOKUP`,
// `lookupFromState`, `withAbilityLabels`, `PromptLookup`, `DEFENDER_SENTINEL`,
// `SelectionButton`, `SelectionLike`, `SelectionPromptProps` used to re-export
// here too — knip's own count (11) for this file, because every real importer
// reaches each of them through its OWN source file instead (`types.ts`,
// `lookup.ts`, `rules.ts`, `SelectionPrompt.tsx`), never through this barrel.
// Deleted here; still exported from those files for the callers that use them.
export { PROMPT_METHODS, DIRECT_CONFIRM_METHOD } from './types.ts';
export type { AskOf, PromptMethod, PromptProps } from './types.ts';
export { classifySelection, SelectionPrompt, type SelectionKind } from './SelectionPrompt.tsx';
