/*
 * Offered: the battlefield cards a seat's board draws clickable right now, sent to the
 * match's other screens so the stack's ability chips keep clear of them there too. The
 * operator, 2026-11-02: *"we should avoid blocking the opponents playable cards as well."*
 * Each screen places its own chips (`apps/ui/src/play/live/placed.ts`'s `settleStack`),
 * so the other seat's clickable cards have to reach it.
 *
 * What crosses: battlefield card ids, and nothing about why they can be clicked (a target,
 * an ability, an attacker). The server keeps only ids that every other seat sees face up
 * on a battlefield (`games/magic/server/src/play/visibility.ts`'s `faceUpOnBattlefield`), so a
 * hand card or a face-down permanent never crosses: a manifested card that may be turned
 * face up would say it is a creature card.
 */
import { z } from 'zod';

export const OFFERED_EVENT = 'forge:offered';

export const OfferedSchema = z
  .object({
    matchId: z.string().min(1),
    type: z.literal('offered'),
    /** The sender's clickable battlefield cards, by id. */
    cards: z.array(z.number().int().nonnegative()).max(256),
  })
  .strict();
export type OfferedMessage = z.output<typeof OfferedSchema>;

/** Server → the match's other sockets: the cards that may cross, stamped with the seat they came from. */
export const OfferedEchoSchema = OfferedSchema.extend({ seat: z.number().int().min(0) }).strict();
export type OfferedEcho = z.output<typeof OfferedEchoSchema>;

/** A socket sending more than this in one second is a client bug; the rest of that second is dropped. */
export const OFFERED_MAX_PER_SECOND = 20;
