/*
 * The cards that ask several seats.
 *
 * Paliano, the High City (cardsfolder/p/paliano_the_high_city.txt) and
 * Regicide (cardsfolder/r/regicide.txt): "Reveal CARDNAME as you draft it. As
 * you draft CARDNAME, the player to your right chooses a color, you choose
 * another color, then the player to your left chooses a third color." One ask
 * at a time, in that order, each offering the colours not yet chosen; the
 * chain travels in the ask's own `data`. The three are noted for the drafter
 * as Forge notes them (`LimitedPlayer.draftCard`): one entry, comma-joined.
 *
 * Deal Broker (cardsfolder/d/deal_broker.txt): "Draft CARDNAME face up.
 * Immediately after the draft, you may reveal a card in your card pool. Each
 * other player may offer you one card in their card pool in exchange. You may
 * accept any one offer." Run from `finishing`, one face-up Deal Broker at a
 * time in seat order. While offers are out, what has been offered is kept on
 * the holder's seat (a `SeatEffect`), because the offers arrive in any order.
 * An offer is shown to the holder alone; the table is told the revealed card
 * and an accepted exchange, nothing else.
 */

import type { SeatId } from '@wolffm/rooms-protocol';
import type { DraftCard } from '@hadoku/shared';
import { addEffect, ask, effectsOf, endEffect, isFaceUp, leavePool, neighbour, note, say, seatName, show, type CardActions, type Draft, type DraftAsk, type Family } from './kit.ts';

/* ── Paliano, the High City and Regicide ─────────────────────────────── */

/** Forge's colour names, in its own order (`MagicColor.Constant.ONLY_COLORS`). */
const COLORS = ['white', 'blue', 'black', 'red', 'green'] as const;

/** Ask the next seat of the chain for a colour nobody has chosen yet. */
function askColor(d: Draft, source: string, drafter: SeatId, chosen: readonly string[]): void {
  // The player to the drafter's right, the drafter, then the player to its left.
  const seats = [neighbour(d, drafter, 'right'), drafter, neighbour(d, drafter, 'left')];
  const options = COLORS.filter((c) => !chosen.includes(c)).map((c) => ({ key: c, label: `${c[0]!.toUpperCase()}${c.slice(1)}` }));
  ask(d, {
    seatId: seats[chosen.length]!,
    source,
    title: `Choose a color for ${seatName(d, drafter)}`,
    options,
    fallback: options[0]!.key,
    data: { drafter, chosen },
  });
}

const threeColors: CardActions = {
  reveal: true,
  drafted: (d, e) => askColor(d, e.card.name, e.seat, []),
  answered: (d, a, choice) => {
    const drafter = a.data?.drafter as SeatId;
    const chosen = [...(a.data?.chosen as string[]), choice];
    if (chosen.length < 3) {
      askColor(d, a.source, drafter, chosen);
      return;
    }
    note(d, drafter, a.source, chosen.join(','));
    say(d, drafter, 'noted', { detail: `${chosen.join(', ')} for ${a.source}` });
  },
};

/* ── Deal Broker ─────────────────────────────────────────────────────── */

const BROKER = 'Deal Broker';
const DEAL = 'deal';
const DECLINE = [{ key: 'no', label: 'No' }];

/** One Deal Broker's exchange while offers are out: kept on the holder's seat. */
interface Deal {
  /** The `cardId` the holder revealed. */
  revealed: string;
  /** Who offered each card, by its `cardId`. */
  offers: Record<string, SeatId>;
  /** The holders of the Deal Brokers still to run after this one. */
  queue: SeatId[];
}

const poolOf = (d: Draft, seat: SeatId): DraftCard[] => d.pools[seat] ?? [];

/** The next Deal Broker: its holder may reveal a card of its pool. */
function openBroker(d: Draft, queue: readonly SeatId[]): void {
  const [holder, ...rest] = queue;
  if (holder === undefined) return;
  ask(d, { seatId: holder, source: BROKER, title: 'Reveal a card?', cards: poolOf(d, holder).slice(), options: DECLINE, fallback: 'no', data: { step: 'reveal', queue: rest } });
}

/** Every offer is in or declined: the holder may accept one, and with none there is nothing to ask. */
function openAccept(d: Draft, holder: SeatId): void {
  const effect = effectsOf(d, holder, DEAL)[0];
  if (effect === undefined) return;
  const deal = effect.data as unknown as Deal;
  const offered = Object.entries(deal.offers).flatMap(([cardId, seat]) => poolOf(d, seat).filter((c) => c.cardId === cardId));
  if (offered.length === 0) {
    endEffect(d, holder, effect);
    openBroker(d, deal.queue);
    return;
  }
  ask(d, { seatId: holder, source: BROKER, title: 'Accept an offer?', cards: offered, options: DECLINE, fallback: 'no', data: { step: 'accept' } });
}

/**
 * The seat's notes under a card name, taken with a card of that name that has
 * just left its pool: they stay behind as well only while the seat holds
 * another card of the name.
 */
function takeNotes(d: Draft, seat: SeatId, name: string): string[] {
  const held = d.notes[seat]?.[name] ?? [];
  if (!poolOf(d, seat).some((c) => c.name === name)) delete d.notes[seat]?.[name];
  return [...held];
}

/** The two cards change pools, and what each seat noted under its card's name goes with it (Forge: `LimitedPlayer.exchangeAcceptedOffer`). */
function exchange(d: Draft, holder: SeatId, revealed: DraftCard, offerer: SeatId, offer: DraftCard): void {
  leavePool(d, holder, revealed);
  leavePool(d, offerer, offer);
  const given = takeNotes(d, holder, revealed.name);
  const got = takeNotes(d, offerer, offer.name);
  d.pools[holder] = [...poolOf(d, holder), offer];
  d.pools[offerer] = [...poolOf(d, offerer), revealed];
  for (const value of got) note(d, holder, offer.name, value);
  for (const value of given) note(d, offerer, revealed.name, value);
  say(d, holder, 'exchanged', { cards: [revealed, offer], detail: `with ${seatName(d, offerer)}` });
}

function brokerAnswered(d: Draft, a: DraftAsk, choice: string): void {
  const step = a.data?.step;
  if (step === 'reveal') {
    const holder = a.seatId;
    const queue = a.data?.queue as SeatId[];
    const card = poolOf(d, holder).find((c) => c.cardId === choice);
    if (card === undefined) {
      openBroker(d, queue);
      return;
    }
    say(d, holder, 'revealed', { cards: [card], detail: `for ${BROKER}` });
    const deal: Deal = { revealed: card.cardId, offers: {}, queue };
    addEffect(d, holder, { kind: DEAL, source: BROKER, data: { ...deal } });
    for (let seat = 0; seat < d.seatCount; seat++) {
      if (seat === holder || poolOf(d, seat).length === 0) continue;
      ask(d, {
        seatId: seat,
        source: BROKER,
        title: `Offer ${seatName(d, holder)} a card for ${card.name}?`,
        cards: poolOf(d, seat).slice(),
        options: DECLINE,
        fallback: 'no',
        data: { step: 'offer', holder },
      });
    }
    if (!offersOut(d, holder)) openAccept(d, holder);
    return;
  }
  if (step === 'offer') {
    const holder = a.data?.holder as SeatId;
    const deal = effectsOf(d, holder, DEAL)[0]?.data as unknown as Deal | undefined;
    const card = poolOf(d, a.seatId).find((c) => c.cardId === choice);
    if (deal !== undefined && card !== undefined) {
      deal.offers[card.cardId] = a.seatId;
      show(d, holder, BROKER, [card], `offered by ${seatName(d, a.seatId)}`);
    }
    if (!offersOut(d, holder)) openAccept(d, holder);
    return;
  }
  // The holder's answer to the offers.
  const holder = a.seatId;
  const effect = effectsOf(d, holder, DEAL)[0];
  if (effect === undefined) return;
  const deal = effect.data as unknown as Deal;
  endEffect(d, holder, effect);
  const offerer = deal.offers[choice];
  const revealed = poolOf(d, holder).find((c) => c.cardId === deal.revealed);
  const offer = offerer === undefined ? undefined : poolOf(d, offerer).find((c) => c.cardId === choice);
  if (offerer !== undefined && revealed !== undefined && offer !== undefined) exchange(d, holder, revealed, offerer, offer);
  openBroker(d, deal.queue);
}

/** Whether a seat has yet to answer the holder's revealed card. */
function offersOut(d: Draft, holder: SeatId): boolean {
  return d.asks.some((a) => a.source === BROKER && a.data?.step === 'offer' && a.data.holder === holder);
}

export const choices: Family = {
  cards: {
    'Paliano, the High City': threeColors,
    Regicide: threeColors,
    [BROKER]: { faceUp: true, answered: brokerAnswered },
  },
  hooks: {
    // One entry a face-up Deal Broker, in seat order: a seat holding two runs twice.
    finishing: (d) => {
      const holders: SeatId[] = [];
      for (let seat = 0; seat < d.seatCount; seat++) {
        for (const c of poolOf(d, seat)) if (c.name === BROKER && isFaceUp(d, seat, c.cardId)) holders.push(seat);
      }
      openBroker(d, holders);
    },
  },
};
