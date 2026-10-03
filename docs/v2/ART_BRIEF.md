# v2 art brief — for the art team

> **Parked for v2** (2026-10-03). See `README.md`.

**From:** the cardtable project (a private card-game table for a group of friends).
**Status:** draft for the operator to review before it goes to the team. Sections marked **[operator]**
need their decision first.

## 1. Who, what, and the terms [operator]

- **Who the art team is**, and how they are credited in the app.
- **The licence.** The app is open source (GPL-3.0) and never takes money. The assets themselves do not
  have to be GPL, but the licence must let the project host them on its own CDN (`cdn.hadoku.me`) and
  show them to its players indefinitely. A short written grant is enough; the operator decides its form.

## 2. The rules every asset must follow

- **Original work only.** No Magic: The Gathering logos, wordmarks, card frames, mana or set symbols
  drawn by us, planeswalker symbol, or imagery of WotC's worlds and characters. Mana symbols already come
  from an open icon font; nothing here replaces them.
- **No WotC card art.** The cards themselves show their printed art via a lookup the project owns; this
  brief never asks for card art.
- **Two quality tiers.** Everything has a **Simple** version (a still image or a CSS-friendly sprite, or
  nothing at all) and a **High** version (animated). Simple mode must run on a low-end laptop.

## 3. Effects and animations (High mode), by game event

Each row is fired by one of Forge's game events, which the engine already produces. Duration is a
target, not a limit; everything must be skippable (a player clicking through does not wait for it).

| # | moment | engine event | what it should feel like | target length |
| --- | --- | --- | --- | --- |
| 1 | a card is **tapped** / untapped | `GameEventCardTapped` | a quick, satisfying turn, a small dust or glint | 150 ms |
| 2 | **attack** declared | `GameEventAttackersDeclared` | the creature lunges toward the opponent's face | 400 ms |
| 3 | **combat damage** to a player | `GameEventCardDamaged` / life change | the hit lands: impact on the avatar, screen nudge | 300 ms |
| 4 | **life lost / gained** | player life change | floating number (−3 red, +2 green) rising from the avatar | 800 ms |
| 5 | **creature dies** | `GameEventCardChangeZone` (to graveyard) | the card cracks and falls into the graveyard | 500 ms |
| 6 | **spell cast** | `GameEventSpellAbilityCast` | the card flares as it lifts onto the stack, coloured by its colours | 400 ms |
| 7 | **spell resolves** | `GameEventSpellResolved` | a release of that colour's energy toward its target | 400 ms |
| 8 | **spell countered** | `GameEventSpellRemovedFromStack` | the spell shatters | 400 ms |
| 9 | **token created** | `GameEventCardChangeZone` (from nowhere) | it shimmers into existence | 400 ms |
| 10 | **counters** added/removed | `GameEventCardCounters` / `PlayerCounters` | a token pops on/off; poison is green and sickly | 250 ms |
| 11 | **a card transforms or is changed** (Magus of the Moon) | state change | a ripple that leaves the new identity showing | 500 ms |
| 12 | **coin flip** to decide who plays first | (game start) | a coin that spins and lands; already a simple CSS version in v1 | 1.5 s |
| 13 | **victory / defeat** | game over | a celebration, and a gentler defeat; over the board | 2–3 s |
| 14 | **your turn begins** | `GameEventTurnBegan` | a short banner or chime; the active player's ring glows | 600 ms |

**Sound** is in scope: one short sound per row above, mixable, with a mute that already exists.

Delivery format for High mode: **sprite sheets** (PNG/WebP with a JSON atlas, the format PixiJS reads)
or **Lottie/JSON** for vector work; the project picks the runtime in track C, so ask before committing to
a format. Particles can be specified as a reference video plus parameters instead of baked frames.

## 4. The board and its doodads (waits for the design round)

Input: the layout chosen in `BOARD_DESIGN_ROUND.md`, drawn to the pixel, with its doodad zones.

Per **board theme** (the first ship is likely three; [operator]):
- the **table**: the frame and the playing surface, at 2560×1600 and scalable down;
- **4–8 doodads** sized to their zones, each with an idle state, a "clicked" animation and a sound, and
  optionally a hidden extra after repeated clicks;
- a **Simple** version: the table as a still image, doodads as still images with no animation.

## 5. Small pieces needed regardless of the board

- **Player avatar frame** and the **active-player ring** (v1 draws a plain ring).
- **Icons**: log, settings gear, sound on/off, end turn, full control, concede, rematch, main menu.
- **Token art** for common creature tokens (Goblin, Soldier, Zombie, Spirit, Elf Warrior, Saproling,
  Thopter, Beast, Wolf). v1 uses public token printings; original art would replace them.

## 6. How to deliver

- Files to the project's CDN through the operator (never committed to the repository).
- Each asset named by the key in this brief (`fx/tap`, `fx/attack`, `board/forest/table`,
  `board/forest/doodad-owl`…), so swapping one is a one-line data change.
- A short contact sheet per batch (a PNG grid or a video) for review before upload.
