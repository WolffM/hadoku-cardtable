import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadSpellCopiers, parseCardScript } from './spell-copiers.js';

/* Forge's own scripts, verbatim but for the Oracle and AI lines (`res/cardsfolder`). */
const TWINCAST = `Name:Twincast
ManaCost:U U
Types:Instant
A:SP$ CopySpellAbility | ValidTgts$ Instant,Sorcery | TargetType$ Spell | MayChooseTarget$ True | SpellDescription$ Copy target instant or sorcery spell. You may choose new targets for the copy.`;
const LUTRI = `Name:Lutri, the Spellchaser
ManaCost:1 UR UR
Types:Legendary Creature Elemental Otter
K:Flash
T:Mode$ ChangesZone | ValidCard$ Card.Self+wasCastByYou | Origin$ Any | Destination$ Battlefield | Execute$ TrigCopy | TriggerDescription$ When CARDNAME enters, if you cast it, copy target instant or sorcery spell you control.
SVar:TrigCopy:DB$ CopySpellAbility | ValidTgts$ Instant.YouCtrl,Sorcery.YouCtrl | TgtPrompt$ Select target instant or sorcery spell you control | MayChooseTarget$ True`;
const STRIONIC = `Name:Strionic Resonator
ManaCost:2
Types:Artifact
A:AB$ CopySpellAbility | Cost$ 2 T | TargetType$ Triggered.YouCtrl | ValidTgts$ Card,Emblem | TgtPrompt$ Choose target triggered ability you control | MayChooseTarget$ True | SpellDescription$ Copy target triggered ability you control.`;
const STORM = `Name:Thousand-Year Storm
Types:Enchantment
T:Mode$ SpellCast | ValidCard$ Instant,Sorcery | ValidActivatingPlayer$ You | Execute$ TrigCopy | TriggerZones$ Battlefield | TriggerDescription$ Whenever you cast an instant or sorcery spell, copy it.
SVar:TrigCopy:DB$ CopySpellAbility | Defined$ TriggeredSpellAbility | Amount$ X | MayChooseTarget$ True`;
const GANDALF = `Name:Gandalf the Grey
Types:Legendary Creature Avatar Wizard
T:Mode$ SpellCast | ValidCard$ Instant,Sorcery | ValidActivatingPlayer$ You | TriggerZones$ Battlefield | Execute$ TrigCharm | TriggerDescription$ Whenever you cast an instant or sorcery spell, ABILITY
SVar:TrigCharm:DB$ Charm | Choices$ DBCopy
SVar:DBCopy:DB$ CopySpellAbility | ValidTgts$ Instant.YouCtrl,Sorcery.YouCtrl | TargetType$ Spell | MayChooseTarget$ True`;
const IZZET = `Name:Izzet Guildmage
Types:Creature Human Wizard
A:AB$ CopySpellAbility | Cost$ 2 U | ValidTgts$ Instant.YouCtrl+cmcLE2 | TargetType$ Spell | AILogic$ Once | MayChooseTarget$ True | SpellDescription$ Copy target instant spell you control with mana value 2 or less.`;
const RETURN_THE_FAVOR = `Name:Return the Favor
Types:Instant
A:SP$ Charm | Choices$ DBCopy,DBChangeTarget | MinCharmNum$ 1 | CharmNum$ 2
SVar:DBCopy:DB$ CopySpellAbility | ModeCost$ 1 | TargetType$ Activated,Triggered,Instant,Sorcery | ValidTgts$ Card,Emblem | MayChooseTarget$ True
SVar:DBChangeTarget:DB$ ChangeTargets | ModeCost$ 1 | TargetType$ SpellAbility.singleTarget | ValidTgts$ Card,Emblem`;

describe('parseCardScript', () => {
	it('reads a copy that is cast, one reached through an enters trigger, and one that is activated', () => {
		expect(parseCardScript(TWINCAST)).toEqual([{ name: 'Twincast', copies: [{ via: 'cast', validTgts: ['Instant', 'Sorcery'], targetType: ['Spell'] }] }]);
		expect(parseCardScript(LUTRI)).toEqual([{ name: 'Lutri, the Spellchaser', copies: [{ via: 'cast', validTgts: ['Instant.YouCtrl', 'Sorcery.YouCtrl'], targetType: null }] }]);
		expect(parseCardScript(IZZET)[0]?.copies).toEqual([{ via: 'activate', validTgts: ['Instant.YouCtrl+cmcLE2'], targetType: ['Spell'] }]);
		expect(parseCardScript(RETURN_THE_FAVOR)[0]?.copies).toEqual([{ via: 'cast', validTgts: ['Card', 'Emblem'], targetType: ['Activated', 'Triggered', 'Instant', 'Sorcery'] }]);
	});

	it('leaves out an ability-only copy, a copy with no target, and a copy only another spell triggers', () => {
		expect(parseCardScript(STRIONIC)).toEqual([]);
		expect(parseCardScript(STORM)).toEqual([]);
		expect(parseCardScript(GANDALF)).toEqual([]);
	});

	it('names each face of a two-faced card by its own name', () => {
		const split = `Name:Refuse\nTypes:Instant\nA:SP$ DealDamage | ValidTgts$ Any | NumDmg$ 3\nALTERNATE\nName:Cooperate\nTypes:Instant\nA:SP$ CopySpellAbility | ValidTgts$ Instant,Sorcery | TargetType$ Spell`;
		expect(parseCardScript(split).map((f) => f.name)).toEqual(['Cooperate']);
	});
});

const RES = process.env.CARDTABLE_FORGE_RES ?? '';
const CARDS = join(RES, 'cardsfolder');

describe.skipIf(RES === '' || !existsSync(CARDS))('loadSpellCopiers over Forge’s own cardsfolder (CARDTABLE_FORGE_RES)', () => {
	it('marks Lutri, Twincast, Reverberate and Dualcaster Mage, and not Strionic Resonator', async () => {
		const index = await loadSpellCopiers(CARDS);
		for (const name of ['Lutri, the Spellchaser', 'Twincast', 'Reverberate', 'Dualcaster Mage']) expect(index.get(name)?.length, name).toBeGreaterThan(0);
		expect(index.has('Strionic Resonator')).toBe(false);
		console.log(`[cp] spell copiers indexed: ${index.size}`);
	});
});
