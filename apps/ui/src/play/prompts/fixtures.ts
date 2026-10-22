/*
 * The committed prompt fixtures, and where each one's shape came from.
 *
 * ## Every ask frame here is SYNTHETIC
 *
 * No blocking ask has been captured from a real match yet. The Tier C harness
 * (`scripts/spike/tierc/`) records the STATE channel only: its receiving GUI
 * (`CapturePhase.CapturingGui`) overrides `applyDelta`, `handleGameEvents`,
 * `openView` and `setGameView`, and nothing that blocks. Capturing asks needs
 * a GUI that records `getChoices`, `order`, … and a seat Forge treats as human,
 * which is an edit to that tooling — not this lane's to make. So each frame
 * below was written by hand, and each says which Forge call site its shape and
 * wording were taken from (paths under `forge/`, at `2ad70eb4`).
 *
 * What IS real:
 *
 * - **Every card and player id** is from the committed real match
 *   (`../fixtures/tierc-game1-seq1-27.json`, turn 14): 99 is Alice's
 *   Vulshok War Boar, 21 Bob's Fire Urchin, 67 Goblin Replica, and so on. The
 *   lookup every test uses is folded from that stream, so names are Forge's,
 *   not ours, and the combat-damage ask's `lethal` (Goblin Replica 2, War Boar
 *   5) and `trample` (Fire Urchin) are copied from that state.
 *   The SITUATIONS are hypothetical — Fire Urchin never attacked into Goblin
 *   Replica and the War Boar in that game.
 * - **Forge's strings, where Forge has one**: dialog titles from
 *   `forge-gui/res/languages/en-US.properties`, ability and trigger text from
 *   `forge-gui/res/cardsfolder/`. Where the call site takes its text from an
 *   effect's script and we wrote it instead, `source` says "ours".
 * - **The sideboard pools** are a real bundled Forge deck, parsed by
 *   `@hadoku/carddata/dck`'s `parseDck` with nothing edited:
 *   `forge-gui/res/adventure/Shandalar Old Border/decks/standard/wc00_jon_finkel.dck`
 *   (60 main, 15 sideboard).
 *
 * **Since Wave 10 these shapes are also met live.** `../live/prompts.jvm.test.ts`
 * drives two real Forge matches until the engine has asked eleven of the
 * fourteen methods here, each answered by these components; that suite's
 * header says which cards make Forge ask what. Not met live: `showOptionDialog`
 * (no production caller), `chooseEntitiesForEffect` (Forge uses a card Input
 * instead unless an option sits outside the pointable zones) and `sideboard`
 * (the bridge answers it itself). The frames here are still the synthetic
 * ones — the live asks are not committed as fixtures.
 *
 * Every frame must parse under `@hadoku/forge-wire`'s `ServerFrameSchema`;
 * `fixtures.test.ts` holds that, and holds that all fourteen methods have one.
 */

import { parseServerFrame } from '@hadoku/forge-wire';

import { foldPackets } from '../fold.ts';
import { loadPackets, PLAY_FIXTURES } from '../fixtures.ts';
import { lookupFromState, withAbilityLabels, type PromptLookup } from './lookup.ts';
import type { AskOf, PromptMethod } from './types.ts';

import assignCombatDamage from './fixtures/assignCombatDamage.json';
import assignGenericAmount from './fixtures/assignGenericAmount.json';
import assignGenericAmountMana from './fixtures/assignGenericAmount-mana.json';
import chooseEntitiesForEffect from './fixtures/chooseEntitiesForEffect.json';
import chooseSingleEntityForEffect from './fixtures/chooseSingleEntityForEffect.json';
import confirm from './fixtures/confirm.json';
import confirmOkOnly from './fixtures/confirm-ok-only.json';
import getAbilityToPlay from './fixtures/getAbilityToPlay.json';
import getChoices from './fixtures/getChoices.json';
import getChoicesReveal from './fixtures/getChoices-reveal.json';
import manipulateCardList from './fixtures/manipulateCardList.json';
import openZones from './fixtures/openZones.json';
import order from './fixtures/order.json';
import showInputDialog from './fixtures/showInputDialog.json';
import showOptionDialog from './fixtures/showOptionDialog.json';
import sideboard from './fixtures/sideboard.json';
import tempShowZones from './fixtures/tempShowZones.json';

export interface PromptFixture {
  /** Path under `fixtures/`, so a failure names a real file. */
  file: string;
  method: PromptMethod;
  /** Always `'synthetic'` today — see the module header. */
  origin: 'synthetic';
  /** The Forge call site (and strings) the frame's shape was taken from. */
  source: string;
  raw: unknown;
}

export const PROMPT_FIXTURES: readonly PromptFixture[] = [
  {
    file: 'tempShowZones.json',
    method: 'tempShowZones',
    origin: 'synthetic',
    source:
      'PlayerControllerHuman.java:953-958 (reveal of a zone: tempShowZones(getLocalPlayerView(), updates)); ' +
      'answered per CMatchUI.java:584-609',
    raw: tempShowZones,
  },
  {
    file: 'getAbilityToPlay.json',
    method: 'getAbilityToPlay',
    origin: 'synthetic',
    source:
      'PlayerControllerHuman.java:224; host is Pyrite Spellbomb (id 108), whose two abilities are ' +
      'cardsfolder/p/pyrite_spellbomb.txt:4-5. Ability ids 9001/9002 are invented — no SpellAbilityView is on the wire',
    raw: getAbilityToPlay,
  },
  {
    file: 'assignCombatDamage.json',
    method: 'assignCombatDamage',
    origin: 'synthetic',
    source:
      'PlayerControllerHuman.java:283-305 (two blockers, trampler, defender present); ' +
      'Bob’s Fire Urchin 21 (Trample), pumped to 5 power, blocked by Goblin Replica 67 and Vulshok War Boar 99, ' +
      'attacking Alice (1)',
    raw: assignCombatDamage,
  },
  {
    file: 'assignGenericAmount.json',
    method: 'assignGenericAmount',
    origin: 'synthetic',
    source:
      'PlayerControllerHuman.java:2449-2466 (divided damage: every target max = amount, atLeastOne true, ' +
      'label lblDamage lower-cased). No card in the captured match divides damage, so the source (Ral’s Dispersal, 17) ' +
      'is an arbitrary real card',
    raw: assignGenericAmount,
  },
  {
    file: 'assignGenericAmount-mana.json',
    method: 'assignGenericAmount',
    origin: 'synthetic',
    source:
      'PlayerControllerHuman.java:340-355 (specifyManaCombo: color keys, max per color, atLeastOne false, label "mana"). ' +
      'Forge keys it by MagicColor.Color; the bridge sends each colour mask',
    raw: assignGenericAmountMana,
  },
  {
    file: 'showOptionDialog.json',
    method: 'showOptionDialog',
    origin: 'synthetic',
    source:
      'IGuiGame.java:172 signature only — no production caller of IGuiGame.showOptionDialog exists at 2ad70eb4 ' +
      '(the one call is HeadlessStartupTest.java:275). Wording is ours',
    raw: showOptionDialog,
  },
  {
    file: 'showInputDialog.json',
    method: 'showInputDialog',
    origin: 'synthetic',
    source:
      'RecordActionsMacroSystem.java:355-357 (numeric, initial "1"; strings lblHowManyTimesToRepeatSequence, ' +
      'lblRepeatActionSequence). Forge passes null inputOptions; the wire carries []',
    raw: showInputDialog,
  },
  {
    file: 'confirm.json',
    method: 'confirm',
    origin: 'synthetic',
    source:
      'PlayerControllerHuman.java:798-826 (confirmTrigger: lblUseTriggeredAbilityOf + CardView.toString + trigger text); ' +
      'Fire Urchin trigger from cardsfolder/f/fire_urchin.txt',
    raw: confirm,
  },
  {
    file: 'confirm-ok-only.json',
    method: 'confirm',
    origin: 'synthetic',
    source: 'PlayerControllerHuman.java:1882 (a one-option confirm: ImmutableList.of(lblOK)); question text is ours',
    raw: confirmOkOnly,
  },
  {
    file: 'getChoices.json',
    method: 'getChoices',
    origin: 'synthetic',
    source:
      'PlayerControllerHuman.java:1963 (chooseColors: getChoices(message, min, max, colors)); message is lblChooseAColor, ' +
      'option labels are ours (the bridge renders `display`)',
    raw: getChoices,
  },
  {
    file: 'getChoices-reveal.json',
    method: 'getChoices',
    origin: 'synthetic',
    source: 'PlayerControllerHuman.java:2595 (min -1, max -1: a display-only list; message is lblActionFromPlayerDeck + lblRemoved)',
    raw: getChoicesReveal,
  },
  {
    file: 'order.json',
    method: 'order',
    origin: 'synthetic',
    source:
      'PlayerControllerHuman.java:2313-2315 (lblSelectOrderForSimultaneousAbilities / lblResolveFirst, 0, 0, ' +
      'showRememberCheckbox true); trigger text from cardsfolder',
    raw: order,
  },
  {
    file: 'sideboard.json',
    method: 'sideboard',
    origin: 'synthetic',
    source:
      'PlayerControllerHuman.java:235-276 via Match.java:278 (message = player name); pools are ' +
      'adventure/Shandalar Old Border/decks/standard/wc00_jon_finkel.dck through parseDck, unedited',
    raw: sideboard,
  },
  {
    file: 'chooseSingleEntityForEffect.json',
    method: 'chooseSingleEntityForEffect',
    origin: 'synthetic',
    source: 'PlayerControllerHuman.java:612 (not optional, no delayed reveal); title is ours',
    raw: chooseSingleEntityForEffect,
  },
  {
    file: 'chooseEntitiesForEffect.json',
    method: 'chooseEntitiesForEffect',
    origin: 'synthetic',
    source: 'PlayerControllerHuman.java:652 (min 0, max 2, with a DelayedReveal of the three graveyard cards); title is ours',
    raw: chooseEntitiesForEffect,
  },
  {
    file: 'manipulateCardList.json',
    method: 'manipulateCardList',
    origin: 'synthetic',
    source:
      'PlayerControllerHuman.java:1011 (arrangeForMove, lblMoveCardstoToporBbottomofLibrary, top and bottom OK, ' +
      'not anywhere). The five "library" cards are Bob’s real hand ids, standing in for a library the fixture trimmed',
    raw: manipulateCardList,
  },
  {
    file: 'openZones.json',
    method: 'openZones',
    origin: 'synthetic',
    source: 'TargetSelection.java:178-182 (players with valid targets, zones of the targets, backupLastZones true)',
    raw: openZones,
  },
];

/** Every fixture for one method, parsed and typed. */
export function asksFor<M extends PromptMethod>(method: M): AskOf<M>[] {
  return PROMPT_FIXTURES.filter((f) => f.method === method).map(
    (f) => parseServerFrame(f.raw, `prompts/fixtures/${f.file}`) as AskOf<M>,
  );
}

/** The first fixture for one method. */
export function askFor<M extends PromptMethod>(method: M): AskOf<M> {
  const [ask] = asksFor(method);
  if (ask === undefined) throw new Error(`no prompt fixture for ${method}`);
  return ask;
}

/**
 * The two ability labels `getAbilityToPlay.json` needs — Forge's
 * `SpellAbility.toString()` for Pyrite Spellbomb's abilities
 * (`cardsfolder/p/pyrite_spellbomb.txt:4-5`, cost then description). Not on the
 * wire: see `lookup.ts`.
 */
const FIXTURE_ABILITY_LABELS: Readonly<Record<number, string>> = {
  9001: '{1}, Sacrifice Pyrite Spellbomb: Draw a card.',
  9002: '{R}, Sacrifice Pyrite Spellbomb: It deals 2 damage to any target.',
};

/** Names and combat facts from the real match the fixtures' ids come from. */
export function fixtureLookup(): PromptLookup {
  const { state } = foldPackets(loadPackets(PLAY_FIXTURES[0]!));
  return withAbilityLabels(lookupFromState(state), FIXTURE_ABILITY_LABELS);
}
