/*
 * One row per Forge ask method: what KIND of answer it takes, and the
 * testids that answer reads. `apps/ui/src/play/live/prompt-driver.ts` (jsdom,
 * synchronous `fireEvent`) and `e2e/play/prompts.ts` (Playwright, async
 * locators) drive the SAME fourteen prompt components from two environments
 * whose APIs are not shape-compatible, so the DOM-walking code stays
 * separate in each — but both used to carry their OWN copy of which method
 * takes which shape, and their own two `SELF_ANSWERING` sets (T7). This is
 * plain data, no DOM: a `kind` tag plus the handful of testids every kind
 * reads, so a rename or a method's shape changing is a one-place edit.
 */

/**
 * `showConfirmDialog`'s own bar (`ConfirmPrompt.tsx`) is the one caller that
 * does NOT draw a `[data-testid="prompt-option"]` row — it is a fixed
 * two-button `.confirm__button` pair, selected by `data-default` the same
 * way. Every other kind below is `PromptShell`'s own machinery.
 */
export type AnswerKind =
  | 'bar-default'
  | 'default-option'
  | 'input'
  | 'choice-or-cancel'
  | 'tick-until-submittable'
  | 'auto-then-submit'
  | 'increment-until-submittable'
  | 'order-until-submittable'
  | 'submit-only'
  | 'self-answering';

/**
 * Method → kind, for every method either driver answers. `tempShowZones` and
 * `openZones` (`ZonePrompts.tsx`) answer themselves on mount — nobody
 * clicks them — which `e2e/play/prompts.ts` used to be the only one to say
 * out loud as its own `SELF_ANSWERING` set; `prompt-driver.ts` got the same
 * result for free from its switch's `default`, which is also where every
 * OTHER unlisted method still lands (so an ask this table has not caught up
 * with yet is left alone, not mis-answered).
 */
export const ANSWER_KIND: Readonly<Record<string, AnswerKind>> = {
  showConfirmDialog: 'bar-default',
  confirm: 'default-option',
  showOptionDialog: 'default-option',
  showInputDialog: 'input',
  getAbilityToPlay: 'choice-or-cancel',
  getChoices: 'tick-until-submittable',
  chooseSingleEntityForEffect: 'tick-until-submittable',
  chooseEntitiesForEffect: 'tick-until-submittable',
  assignCombatDamage: 'auto-then-submit',
  assignGenericAmount: 'increment-until-submittable',
  order: 'order-until-submittable',
  manipulateCardList: 'submit-only',
  sideboard: 'submit-only',
  tempShowZones: 'self-answering',
  openZones: 'self-answering',
};

/** Every method this table answers on its own, with no click (`ANSWER_KIND`'s own note). */
export const SELF_ANSWERING: ReadonlySet<string> = new Set(
  Object.entries(ANSWER_KIND)
    .filter(([, kind]) => kind === 'self-answering')
    .map(([method]) => method),
);

/** The testids every kind above reads, named once. */
export const ANSWER_TESTID = {
  option: 'prompt-option',
  choice: 'prompt-choice',
  input: 'prompt-input',
  cancel: 'prompt-cancel',
  submit: 'prompt-submit',
  auto: 'prompt-auto',
  orderSource: 'order-source',
} as const;
