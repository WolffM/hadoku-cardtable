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
import { ConfirmPrompt, ShowInputDialogPrompt, ShowOptionDialogPrompt } from './DialogPrompts.tsx';
import { ManipulateCardListPrompt } from './ManipulateCardListPrompt.tsx';
import { OrderPrompt } from './OrderPrompt.tsx';
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
  confirm: ConfirmPrompt,
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
  lookup: PromptLookup;
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
  return createElement(component, props);
}

export { PROMPT_METHODS, LANE_B_METHOD, checkedReply, PromptAnswerError } from './types.ts';
export type { AskOf, PromptMethod, PromptProps, ReplyOf } from './types.ts';
export { EMPTY_LOOKUP, lookupFromState, withAbilityLabels, type PromptLookup } from './lookup.ts';
export { DEFENDER_SENTINEL } from './rules.ts';
