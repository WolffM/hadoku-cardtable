# Challenge fidelity — next steps

Challenge rooms (2026-11-08) replay a real MTGO Challenge: the real field, each AI on its real
player's list, the creator playing their chosen player's list, round 1 the event's own
quarterfinals. The operator asked how far the games themselves can feel like the real ones —
"at minimum the opening hands, maybe the draw steps".

## What the data can and cannot give

The source (fbettega/MTG_decklistcache, `decks/tournament-*/tournament.json`) holds decklists,
final standings, and the top-8 pairings with their scores (`"Result": "2-0-0"`). Checked
2026-11-08. MTGO publishes no game logs, so nobody's real opening hand, mulligan or draw is
knowable. Showing one would be inventing it; we do not.

## 1. History beside the replay (data we already have)

- The table and the bracket show the real result: *History: TeaW1thRum won 2–0*.
- The result screen says whether the player kept or rewrote it.
- A room option for the AI-vs-AI matches: settle them **as they really went** (instant, the
  real bracket) or play them out (today's behaviour, the default).

No engine work. About a day.

## 2. The same deal for everyone (seeded libraries)

Every replay of, say, QF1 game 1 deals the same opening hands and the same library order, from a
seed of (event, round, pairing, game). "Ozymandias17's QF1 hand" becomes one shared, comparable
thing.

The catch is in Forge (verified 2026-11-08): every random choice — shuffles, coin flips, the
AI's own choices — draws from one global stream, `forge-core/.../util/MyRandom.java`
(`SecureRandom`, replaceable through `setRandom`); the library shuffle is
`forge-game/.../player/Player.java:1611`. Seeding that one stream breaks the moment an AI
decision differs: every later draw shifts.

The fix, in our fork: a seeded stream **per player for library order and shuffles only**.

- The opening order is the seed's, so the opening hand and every draw match until someone
  deviates.
- A shuffle effect (fetchland, tutor) reshuffles from that player's own stream, so two replays
  that shuffle the same number of times still agree.
- Deviating changes *when* a card comes off the top, never the library's order itself.

Proof needed in real Forge: a JVM test that one seed deals identical hands and draws across two
runs, and that an AI's different choice leaves the other player's library untouched.

## Order

Land Challenges; then 1; then 2.
