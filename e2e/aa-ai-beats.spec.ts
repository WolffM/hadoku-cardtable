/**
 * The other seat's turn draws every beat, whoever plays it — the Forge AI as much as a person.
 *
 * The operator, 2026-10-19: *"i notice that animations are largely skipped when the forge-ai is
 * playing"*; *"they attack me and i dont even see their creatures do the attack because everything
 * happens so fast"*. The production log said why: on the defender's screen a whole AI turn arrived as
 * one drawn view (`m-dfc6932a95be`, turn 8: seq 192→209 in one render, its land, three attacks and
 * the untaps; seq 212→222, a planeswalker cast together with the combat damage), where a person's
 * attack is drawn one declaration at a time and its blow seconds later.
 *
 * Scenario `aa-ai-turn`: seat 1 casts Ravenous Chupacabra (it destroys alice's tapped Grizzly Bears),
 * then attacks with Hill Giant and Gray Ogre; alice can do nothing, so her every stop passes. Fast
 * Mode off, as the operator plays. On alice's screen, from a MutationObserver (wall clock):
 *
 * - the cast: seat 1's spell stands on the stack before it resolves;
 * - the death: the Bears' departure is drawn;
 * - the attack: the attackers are drawn attacking for a beat before any of them rams;
 * - the blow: the ram is drawn, and alice's life moves only once it has set off;
 * - the views: no one drawn view holds both the attack and its blow;
 * - the turn: alice's "Your turn" comes once the blow is over, not with it (the operator, 2026-10-20:
 *   the turn banner waits until the AI's attack animation finishes) — on its last tenth, as every frame
 *   behind a beat does (the operator, 2026-10-28: "unlock" on the last ~10% of an animation).
 *
 * Once against the Forge AI, once against bob playing the same turn by hand (the control). `[aa]`
 * lines are the evidence: the marks, every view alice's screen drew with the roles it sounded, and when
 * each frame of the turn reached her socket.
 */
import { expect, test, type Page } from '@playwright/test';

import { messages, type Friend } from './play/browser.ts';
import { castUntilOnStack, enabledOk, handCardNamed, makeTitled, ownNamed, passOverStack, pressOffered, serverLog, stackCount } from './play/board.ts';
import { passToDeclareAttackers } from './play/combat.ts';
import { answerPrompt } from './play/prompts.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { turnFastModeOff } from './play/prefs.ts';
import { startScenarioMatch, startScenarioVsAi } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const SCENARIO = 'aa-ai-turn';

/** How long the attackers must be drawn attacking before the first ram sets off. */
const ATTACK_SEEN_MS = 500;
/** How long seat 1's spell must stand on the stack before it resolves. */
const CAST_SEEN_MS = 400;

/** When each mark first appeared on alice's page (epoch ms), and the last life her counter read. */
interface Marks {
  spellOn?: number;
  spellOff?: number;
  death?: number;
  attack?: number;
  ram?: number;
  ramGone?: number;
  crash?: number;
  life?: number;
  /** alice's "Your turn" cue. */
  cue?: number;
  lifeNow?: string;
}

async function recordMarks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const marks: Record<string, number | string> = {};
    (window as unknown as { __aaMarks: typeof marks }).__aaMarks = marks;
    const first = (key: string, present: boolean): void => {
      if (present && marks[key] === undefined) marks[key] = Date.now();
    };
    const look = (): void => {
      const spell = document.querySelector('[data-placed-spell]:not([data-mine])') !== null;
      first('spellOn', spell);
      if (marks.spellOn !== undefined && !spell) first('spellOff', true);
      first('death', document.querySelector('[data-departure]') !== null);
      first('attack', document.querySelector('.seat:not([data-viewer]) li.board-card[data-attacking]') !== null);
      const ramming = document.querySelector('.board-ram') !== null;
      first('ram', ramming);
      if (marks.ram !== undefined && !ramming) first('ramGone', true);
      first('crash', document.querySelector('.effect-crash') !== null);
      first('cue', document.querySelector('[data-testid="turn-cue"]') !== null);
      const life = document.querySelector('[data-player-face][data-viewer] [data-testid="life"]')?.textContent ?? null;
      if (life !== null && life !== '20') first('life', true);
      if (life !== null) marks.lifeNow = life;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    look();
  });
}

const marksOf = (page: Page): Promise<Marks> => page.evaluate(() => (window as unknown as { __aaMarks: Marks }).__aaMarks);

function relative(zero: number, at: object): Record<string, number | string | null> {
  return Object.fromEntries(Object.entries(at).map(([k, v]) => [k, typeof v === 'number' ? v - zero : ((v as string | undefined) ?? null)]));
}

/** Every view seat 0's screen drew and sounded: `prevSeq→seq roles`. */
function drawnViews(stack: PlayStack): { prevSeq: number; seq: number; roles: string }[] {
  return serverLog(stack)
    .filter((r) => r.evt === 'client' && r.seat === 0 && r.kind === 'sound' && r.why === 'view')
    .map((r) => ({ prevSeq: Number(r.prevSeq), seq: Number(r.seq), roles: String(r.roles) }));
}

/** What a delta packet changes, in brief: each object's changed property names, `Phase`, `Life` and `Attacking` with their values. */
function deltaGist(packet: Record<string, unknown> | undefined): string {
  if (packet === undefined) return '';
  const out: string[] = [];
  for (const arm of ['newObjects', 'objectDeltas']) {
    for (const [key, obj] of Object.entries((packet[arm] ?? {}) as Record<string, Record<string, { v?: unknown }>>)) {
      if (key.startsWith('_') || typeof obj !== 'object') continue;
      const props = Object.keys(obj).filter((k) => !k.startsWith('_'));
      const shown = props.map((k) => (['Phase', 'Life', 'Attacking', 'Zone', 'Turn'].includes(k) ? `${k}=${JSON.stringify(obj[k]?.v)}` : k));
      out.push(`${arm === 'newObjects' ? '+' : ''}${String(obj._type)}/${String(obj._id)}:${shown.join(',')}`);
    }
  }
  return out.join(' ');
}

/** When each state frame of the turn reached alice's socket, ms after `zero`, with its method. */
function frameArrivals(alice: Friend, zero: number): string {
  return messages(alice)
    .filter((m) => m.dir === 'in' && m.kind === 's2c' && m.t >= zero)
    .map((m) => {
      const env = m.msg as { cursor?: { seq?: number }; frame?: { method?: string; kind?: string; payload?: { packet?: Record<string, unknown> } } };
      return `${m.t - zero}:${env.frame?.method ?? env.frame?.kind ?? '?'}#${env.cursor?.seq ?? '?'}${env.frame?.method === 'applyDelta' ? `{${deltaGist(env.frame.payload?.packet)}}` : ''}`;
    })
    .join(' ');
}

/** The turn is over on alice's screen: her life moved, the blow is drawn and gone, and the board has been still a moment. */
async function turnDrawn(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const m = await marksOf(page);
        return m.life !== undefined && m.ramGone !== undefined && Date.now() - m.ramGone > 1_500;
      },
      { timeout: 60_000, intervals: [250], message: "seat 1's attack was drawn on alice's screen: her life moved and the ram came and went" },
    )
    .toBe(true);
}

function judge(stack: PlayStack, marks: Marks, who: string): void {
  expect(marks.spellOn, `${who}: seat 1's spell was drawn on the stack`).toBeDefined();
  expect(marks.spellOff, `${who}: and left it`).toBeDefined();
  expect(marks.spellOff! - marks.spellOn!, `${who}: the spell stood on the stack before it resolved`).toBeGreaterThanOrEqual(CAST_SEEN_MS);
  expect(marks.death, `${who}: the Bears' death was drawn`).toBeDefined();
  expect(marks.attack, `${who}: the attackers were drawn attacking`).toBeDefined();
  expect(marks.ram, `${who}: an attacker rammed`).toBeDefined();
  expect(marks.ram! - marks.attack!, `${who}: the attack was on screen before the ram set off`).toBeGreaterThanOrEqual(ATTACK_SEEN_MS);
  expect(marks.crash, `${who}: the blow landed`).toBeDefined();
  expect(marks.life! , `${who}: alice's life held until the ram set off`).toBeGreaterThan(marks.ram!);
  expect(Number(marks.lifeNow), `${who}: alice took the Giant's and the Ogre's 5`).toBe(15);
  const folded = drawnViews(stack).filter((v) => /g\.attack@opp/.test(v.roles) && /g\.(charge|crash|damage-player)@opp/.test(v.roles));
  expect(folded, `${who}: no one view drew the attack and its blow together`).toEqual([]);
}

function evidence(stack: PlayStack, alice: Friend, marks: Marks, zero: number, who: string): void {
  console.log(`[aa] marks ${who} ${JSON.stringify(relative(zero, marks))}`);
  console.log(`[aa] views ${who} ${drawnViews(stack).map((v) => `${v.prevSeq}->${v.seq}[${v.roles}]`).join(' ')}`);
  const beats = serverLog(stack).filter((r) => r.evt === 'client' && r.seat === 0 && r.kind === 'effect');
  console.log(`[aa] beats ${who} ${beats.map((r) => JSON.stringify({ ...r, t: undefined, evt: undefined, matchId: undefined, participantId: undefined, seat: undefined, kind: undefined })).join(' ')}`);
  console.log(`[aa] frames ${who} resyncs=${alice.captures.filter((c) => c.dir === 'out' && c.text.includes('"forge:resync"')).length} ${frameArrivals(alice, zero)}`);
}

test(titled("the Forge AI's turn draws every beat: its creature's cast, the death it causes, its attack, the ram and the life"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let alice: Friend | null = null;
  try {
    let zero = 0;
    ({ alice } = await startScenarioVsAi(browser, stack, SCENARIO, {
      fastMode: false,
      beforeKeep: async (f) => {
        await expect
          .poll(() => serverLog(stack).some((r) => r.evt === 'client' && r.kind === 'info' && r.seat === 0 && r.fastMode === false), {
            timeout: 10_000,
            message: 'alice plays with Fast Mode off',
          })
          .toBe(true);
        await recordMarks(f.page);
        zero = Date.now();
      },
    }));
    const page = alice.page;
    try {
      await turnDrawn(page);
      await expect
        .poll(async () => (await marksOf(page)).cue !== undefined, { timeout: 20_000, intervals: [250], message: "alice's turn began on her screen" })
        .toBe(true);
    } finally {
      evidence(stack, alice, await marksOf(alice.page), zero, 'ai');
    }
    const marks = await marksOf(alice.page);
    judge(stack, marks, 'vs the AI');
    expect(marks.cue!, 'vs the AI: "Your turn" came on the ram’s last tenth, not with it').toBeGreaterThanOrEqual(marks.ram! + 0.9 * (marks.ramGone! - marks.ram!));
    const turnWithBlow = drawnViews(stack).filter((v) => /g\.turn-mine/.test(v.roles) && /g\.(charge|crash|damage-player)/.test(v.roles));
    expect(turnWithBlow, 'vs the AI: no one view drew the blow and the turn after it together').toEqual([]);
  } finally {
    await alice?.context.close();
    await stack.stop();
  }
});

test(titled('the same turn played by a person draws the same beats (the control)'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, SCENARIO);
    const { alice, bob } = seated;
    await turnFastModeOff(alice.page, stack, 0);
    await turnFastModeOff(bob.page, stack, 1);
    await recordMarks(alice.page);
    const zero = Date.now();
    try {
      // bob casts the Chupacabra, its arrival destroys alice's Bears.
      const chupacabra = await handCardNamed(bob.page, 'Ravenous Chupacabra');
      expect(chupacabra, 'bob holds Ravenous Chupacabra').toBeDefined();
      const bears = bob.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]').filter({ hasText: 'Grizzly Bears' });
      await castUntilOnStack(bob.page, stack, chupacabra!, [bears]);
      // Priority passed only while something is on the stack: an OK on an empty stack would pass bob's main phase.
      const deadline = Date.now() + 45_000;
      while ((await bears.count()) > 0 || (await stackCount(bob.page)) > 0) {
        expect(Date.now(), 'the Chupacabra resolved and its arrival destroyed the Bears').toBeLessThan(deadline);
        await pressOffered(bears);
        for (const page of [bob.page, alice.page]) {
          await answerPrompt(page);
          await passOverStack(page);
        }
        await bob.page.waitForTimeout(100);
      }
      // bob attacks with both.
      const attackers = [...(await ownNamed(bob.page, 'Hill Giant')), ...(await ownNamed(bob.page, 'Gray Ogre'))];
      expect(attackers, "bob's two attackers").toHaveLength(2);
      await passToDeclareAttackers(bob.page);
      for (const id of attackers) {
        const card = bob.page.locator(`[data-board-card="${id}"]`);
        const box = (await card.boundingBox())!;
        await bob.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(card, `Forge declared ${id} attacking`).toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
      }
      await enabledOk(bob.page).click();
      await expect
        .poll(
          async () => {
            for (const page of [bob.page, alice.page]) if ((await enabledOk(page).count()) > 0 && (await marksOf(alice.page)).life === undefined) await enabledOk(page).click().catch(() => undefined);
            return (await marksOf(alice.page)).life !== undefined;
          },
          { timeout: 30_000, intervals: [200], message: "bob's attack reached combat damage" },
        )
        .toBe(true);
      await turnDrawn(alice.page);
    } finally {
      evidence(stack, alice, await marksOf(alice.page), zero, 'human');
    }
    judge(stack, await marksOf(alice.page), 'vs a person');
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
