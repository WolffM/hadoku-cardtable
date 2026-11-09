/**
 * The operator, 2026-11-09: Jace, Architect of Thought's +1 met two attackers and drew two chips
 * that looked one. A trigger that acts on what set it off without targeting it (Jace's effect,
 * `Defined$ TriggeredAttackerLKICopy`) carries nothing in `StackItemView` that says which creature
 * each copy is for, so the bridge sends it beside the packet (`PlayBridge.stackTriggeredByJson`, and
 * `triggeredBy` on a waiting trigger) and the stack points each chip at its own card.
 *
 * Hellrider stands in for any such trigger: "Whenever a creature you control attacks, Hellrider deals
 * 1 damage to the player or planeswalker it's attacking" — two attackers, two triggers, each read off
 * its own attacker. It is summoning sick so it does not attack itself. Both seats are told, since
 * both attackers are on the battlefield.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/triggered-by.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from "vitest";

import {
  available,
  deck,
  finishMulligan,
  startScenario,
  toDeclareAttackers,
  waitUntil,
  type Scenario,
} from "./scenario.js";

const title = available.ok
  ? "triggered-by: two of one attack trigger each name their own attacker, against real Forge"
  : "triggered-by: two of one attack trigger each name their own attacker — SKIPPED: " +
    available.reason;

const DECKS: [string, string] = [
  deck("Mountains", ["40 Mountain"]),
  deck("Forests", ["40 Forest"]),
];

const STATE = [
  "turn=1",
  "activeplayer=human",
  "activephase=MAIN1",
  "humanlife=20",
  "ailife=20",
  "humanhand=",
  "humanbattlefield=Hellrider|SummonSick;Grizzly Bears;Hill Giant;Mountain",
  "humanlibrary=Mountain;Mountain;Mountain;Mountain;Mountain;Mountain",
  "humangraveyard=",
  "aihand=",
  "aibattlefield=Forest",
  "ailibrary=Forest;Forest;Forest;Forest;Forest;Forest",
  "aigraveyard=",
].join("\n");

type Payload = {
  stackTriggeredBy?: [number, number][];
  pendingTriggers?: { triggeredBy?: number[] }[];
};

/** Every `[stackItemId, cardId]` pair `seat` was sent, and every card a waiting trigger named. */
function triggeredBy(
  s: Scenario,
  seat: number,
): { pairs: [number, number][]; waiting: number[] } {
  const payloads = s.sent
    .filter((x) => x.seat === seat && x.envelope.frame.kind === "notify")
    .map(
      (x) =>
        (x.envelope.frame as unknown as { payload?: Payload }).payload ?? {},
    );
  return {
    pairs: payloads.flatMap((p) => p.stackTriggeredBy ?? []),
    waiting: payloads.flatMap((p) =>
      (p.pendingTriggers ?? []).flatMap((t) => t.triggeredBy ?? []),
    ),
  };
}

describe.skipIf(!available.ok)(title, () => {
  it("Hellrider with Grizzly Bears and Hill Giant attacking: two triggers on the stack, one per attacker, told to both seats", async () => {
    if (!available.ok) return;
    const s = await startScenario(available.config, {
      seed: 91,
      decks: DECKS,
      scenario: STATE,
    });
    try {
      await finishMulligan(s);
      await waitUntil(
        () => {
          s.answerAsks();
          return ["Grizzly Bears", "Hill Giant"].every((name) =>
            s.zone(0, "Battlefield").some((c) => c.name === name && !c.sick),
          );
        },
        "the scenario’s attackers on the battlefield",
        30_000,
        s,
      );
      const bears = s
        .zone(0, "Battlefield")
        .find((c) => c.name === "Grizzly Bears")!;
      const giant = s
        .zone(0, "Battlefield")
        .find((c) => c.name === "Hill Giant")!;
      const hellrider = s
        .zone(0, "Battlefield")
        .find((c) => c.name === "Hellrider")!;

      await toDeclareAttackers(s, 0);
      s.select(0, bears.id);
      s.select(0, giant.id);
      await waitUntil(
        () => {
          s.answerAsks();
          return s.buttons(0)?.label2 === "Call Back";
        },
        "both attackers to be declared",
        10_000,
        s,
      );
      s.ok(0);

      await waitUntil(
        () => {
          s.answerAsks();
          return [0, 1].every(
            (seat) =>
              new Set(triggeredBy(s, seat).pairs.map(([, card]) => card))
                .size === 2,
          );
        },
        "both seats to be told each trigger’s attacker",
        30_000,
        s,
      );

      for (const seat of [0, 1]) {
        const { pairs, waiting } = triggeredBy(s, seat);
        console.log(
          `[triggered-by.jvm] seat ${seat}: stack ${JSON.stringify(pairs)}; waiting ${JSON.stringify(waiting)}; bears #${bears.id}, giant #${giant.id}, hellrider #${hellrider.id}`,
        );
        const byItem = new Map<number, Set<number>>();
        for (const [item, card] of pairs)
          byItem.set(item, new Set([...(byItem.get(item) ?? []), card]));
        const items = [...byItem.values()];
        expect(
          items,
          `seat ${seat}: two stack items, each set off by one card`,
        ).toHaveLength(2);
        for (const cards of items) expect(cards.size).toBe(1);
        expect(
          new Set(items.flatMap((c) => [...c])),
          `seat ${seat}: one for each attacker, never Hellrider itself`,
        ).toEqual(new Set([bears.id, giant.id]));
        for (const card of waiting)
          expect(
            [bears.id, giant.id],
            `seat ${seat}: a waiting trigger names an attacker`,
          ).toContain(card);
      }
    } finally {
      await s.stop();
    }
  }, 120_000);
});
