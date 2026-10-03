/**
 * Wave 35 §S follow-up, item 1 regression chase — the manager found
 * `play.spec.ts`'s "a spell resolves unattended" STILL failing 2/2 after this
 * lane's land-exclusion fix landed: five different casts (Incinerate, Magus
 * of the Moon, Ashenmoor Gouger, Magus of the Scroll, Demigod of Revenge),
 * each `left:true, arrived:false, pressed:[]` — the card leaves the hand and
 * never reaches the battlefield or graveyard, and nobody (neither browser)
 * ever presses anything.
 *
 * This reproduces a 2-mana cast (Goblin Piker, `{1}{R}`) that goes through a
 * genuine Forge "Auto" multi-source payment window — NOT `decidePay`'s own
 * 1-source shortcut, which answers directly without ever showing an "Auto"
 * button — while BOTH seats hold an untapped land left over, matching the
 * manager's own description. Every frame to both seats, every `decideStop`
 * verdict, and whether the spell ever resolves are all logged.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w35-s/work \
 *   pnpm exec vitest run apps/server/src/play/two-mana-pass.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'wave 35 §S follow-up: a 2-mana cast with lands left over, through a real Auto payment window, against real Forge'
	: `wave 35 §S follow-up: a 2-mana cast with lands left over, through a real Auto payment window, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Mana A', ['40 Mountain']), deck('Mana B', ['40 Mountain'])];

/** Every `s.sent` frame to `seat`, from `from`, as a readable line. */
function dump(sent: { seat: number; envelope: { frame: Record<string, unknown> } }[], seat: number, from = 0): string[] {
	return sent
		.slice(from)
		.filter((x) => x.seat === seat)
		.map((x) => {
			const f = x.envelope.frame;
			const m = String(f.method ?? f.kind);
			if (m === 'showPromptMessage') return `PROMPT ${JSON.stringify(f.message)}`;
			if (m === 'updateButtons') return `BUTTONS [${String(f.label1)}${f.enable1 === true ? '' : '-'}] [${String(f.label2)}${f.enable2 === true ? '' : '-'}]`;
			if (m === 'setWeaklySelectable') return `ACTIONABLE ${JSON.stringify((f.cards as { id: number }[]).map((c) => c.id))}`;
			if (m === 'clearWeaklySelectable') return 'ACTIONABLE cleared';
			if (f.kind === 'ask') return `ASK ${m} ${JSON.stringify(f)}`;
			if (m === 'message') return `MESSAGE ${JSON.stringify(f.message)}`;
			if (m === 'applyDelta' || m === 'setGameView') return m;
			return m;
		});
}

describe.skipIf(!available.ok)(title, () => {
	it(
		"a 2-mana cast through a real Auto payment window resolves without either seat pressing anything",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 35, decks: DECKS, scenario: scenarioText('two-mana-pass') });
			try {
				await finishMulligan(s);
				const logsBefore = s.logs.length;
				const sentBefore = s.sent.length;

				const piker = await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Hand').some((c) => c.name === 'Goblin Piker');
					},
					"seat 0's hand to reflect the scripted Goblin Piker",
					20_000,
				).then(() => s.zone(0, 'Hand').find((c) => c.name === 'Goblin Piker'));
				if (piker === undefined) throw new Error('no Goblin Piker in hand');

				s.select(0, piker.id);

				// Watch for the Auto window, but touch NOTHING — same as
				// `play.spec.ts`'s own "hands off, only the server" phase: the claim
				// under test is that the SERVER pays and passes, unattended.
				let sawAuto = false;
				try {
					await waitUntil(
						() => {
							s.answerAsks();
							const b0 = s.buttons(0);
							if (b0 !== null && b0.label1 === 'Auto') sawAuto = true;
							return s.zone(0, 'Battlefield').some((c) => c.name === 'Goblin Piker');
						},
						'Goblin Piker to resolve onto the battlefield, untouched',
						30_000,
					);
				} catch (e) {
					console.log('[diag] sawAuto:', sawAuto);
					console.log('[diag] seat0 prompt:', JSON.stringify(s.prompt(0)));
					console.log('[diag] seat0 buttons:', JSON.stringify(s.buttons(0)));
					console.log('[diag] seat1 prompt:', JSON.stringify(s.prompt(1)));
					console.log('[diag] seat1 buttons:', JSON.stringify(s.buttons(1)));
					console.log('[diag] seat0 hand:', JSON.stringify(s.zone(0, 'Hand')));
					console.log('[diag] seat0 battlefield:', JSON.stringify(s.zone(0, 'Battlefield')));
					console.log('[diag] auto-passed/auto-paid logs:\n' + JSON.stringify(s.logs.slice(logsBefore).filter((l) => l.evt === 'auto-passed' || l.evt === 'auto-paid'), null, 2));
					console.log('[diag] seat0 frames:\n' + dump(s.sent, 0, sentBefore).join('\n'));
					console.log('[diag] seat1 frames:\n' + dump(s.sent, 1, sentBefore).join('\n'));
					throw e;
				}

				console.log('[diag] success. sawAuto:', sawAuto);
				console.log('[diag] auto-passed/auto-paid logs:\n' + JSON.stringify(s.logs.slice(logsBefore).filter((l) => l.evt === 'auto-passed' || l.evt === 'auto-paid'), null, 2));
				expect(s.zone(0, 'Battlefield').some((c) => c.name === 'Goblin Piker')).toBe(true);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
