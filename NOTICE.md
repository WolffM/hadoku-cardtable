# Notices and attribution

## Forge

This project contains and builds upon **Forge**, an unofficial rules engine for
Magic: The Gathering.

- Upstream: <https://github.com/Card-Forge/forge>
- Copyright (C) Forge Team
- Licensed under the **GNU General Public License, version 3 or later**

Forge's source is included as a git submodule at `forge/`, pointing at the
public fork <https://github.com/WolffM/forge>. Its per-file copyright headers
are preserved unmodified. This repository as a whole is distributed under GPL-3.0;
see `LICENSE`.

## Wizards of the Coast

This project is **unofficial**, **fan-made**, and is **not affiliated with,
endorsed by, sponsored by, approved by or associated with Wizards of the Coast
LLC or Hasbro, Inc.** in any way. Nothing here is an official product, and no
statement in this repository or its interface should be read as representing
Wizards of the Coast.

Magic: The Gathering, all card names, card text, artwork, mana symbols, set
symbols, card frames and related marks are property of Wizards of the Coast LLC.
© Wizards of the Coast LLC. Card artwork is additionally the property of the
individual artists who created it. No ownership of, and no licence to, any of
this is claimed or implied by this project.

### Non-commercial, and members only

Both of these statements are load-bearing, and more so since this project began
showing card art (see below):

- **Non-commercial.** This project is free, always. It is not sold, licensed,
  monetized, advertised, sponsored or donated to, in any form, ever. There is no
  payment path of any kind and none will be added.
- **Members only.** It is not publicly available. Every page and request sits
  behind an authentication gate; there is no public tier and no anonymous
  access. Membership is free and open to anyone who signs in for it. This
  changed on 2026-10-30; this notice previously described access limited to a
  small, invited group.

### Card artwork

This project **displays card art**. It changed on 2026-09-15; this notice
previously stated that no artwork was stored or served. The specifics:

- **Where it comes from.** The browser loads card images directly from
  Scryfall's image CDN (`cards.scryfall.io`). The project can also host art on
  its own content endpoint (`cdn.hadoku.me`), but no card currently uses it.
- **How it is shown.** Card tiles show the whole card face, unmodified, so the
  artist credit and copyright line printed on each card stay legible. A few
  small views show cropped art (the stack's ability chip, deck-chooser tiles and
  a cover tile); each of those names the artist ("Illus. <artist>"). Images are
  not distorted, recoloured, filtered or watermarked.
- **No artwork is contained in this source repository.** Image bytes are never
  committed to git, and a continuous-integration check (`scripts/d13-gate.sh`)
  fails the build if any image file reaches the built application.
- **The artwork is a placeholder.** It is held behind a per-card indirection
  specifically so that it can be replaced with differently-sourced art.

**If you are a rights holder** — Wizards of the Coast, or an artist whose work
appears here — and you would prefer your artwork not be shown by this project,
it will be removed on request. Because art is resolved through a per-card
manifest, removing or repointing a specific image is a small, immediate change.

See `docs/LICENSING.md` for the full reasoning, and `docs/DECISIONS.md` **D15**
for the decision and what it rules out.

## Card data

Card data is sourced from Scryfall (<https://scryfall.com>). Scryfall is not
affiliated with, and does not endorse, this project. Card data and artwork
remain the property of Wizards of the Coast and the respective artists.

## Symbol fonts

Set symbols are from **Keyrune** (<https://keyrune.andrewgioia.com>),
copyright (c) 2019 Andrew Gioia. Keyrune's glyphs are licensed GPL 3.0 and its
prepared font files under the SIL Open Font License 1.1. Keyrune's glyphs are
redrawn by hand and distributed to identify Wizards of the Coast products; the
underlying symbols are trademarks of Wizards of the Coast, and their use here
does not indicate endorsement by Wizards of the Coast.

Mana symbols are from the **Mana** font (<https://mana.andrewgioia.com>),
copyright (c) Andrew Gioia, licensed under the SIL Open Font License 1.1 (font)
and the MIT License (CSS). All mana, tap and card type symbol images are
copyright Wizards of the Coast.

Neither font is renamed, per the SIL OFL reserved font name clause. The full
licence texts are in `apps/ui/src/symbols/LICENSE-keyrune.md` and
`apps/ui/src/symbols/LICENSE-mana.md`.

## Sound effects

Most sound-effect takes used by the sound builder (`#/sounds`, admin-gated) and, later, the game
itself were generated locally with **Stable Audio Open**, run on the operator's own hardware with no
third-party service involved.

This Stability AI Model is licensed under the Stability AI Community License, Copyright © Stability
AI Ltd. All Rights Reserved.

Powered by Stability AI.

The hand-rolled victory and defeat takes are this project's own.

Audio bytes are never committed to this repository. They are served from the cardtable server's own
data directory (`CARDTABLE_SOUNDS_DIR`) and never bundled into the UI — see
`apps/server/src/http/sounds.ts` and `scripts/sfx/import.py`.

## Music

Each colour and colour pair has match music, chosen per slot in `#/sounds/music`. Generated tracks were rendered
locally with **ACE-Step 1.5** (code and weights MIT, <https://huggingface.co/ACE-Step>; the output carries no
attribution requirement), and the soundscapes were assembled from Stable Audio Open renders (credited above). Each
take's exact model, seed and prompt is stored as its credit in the catalogue. The rest are the operator's own (added
with `scripts/sfx/add-track.py`):

- Dawnlight Sanctum (white), the operator's own track
- Tidewatch Archive (blue), the operator's own track
- Ossuary of Ambition (black), the operator's own track
- Emberfall Warpath (red), the operator's own track
- Heartwood Hollow (green), the operator's own track
- Statute of Gears (white-blue), the operator's own track
- Cipher in the Fog (blue-black), the operator's own track
- Carnival of Cinders (black-red), the operator's own track
- Stampede Rites (red-green), the operator's own track
- Conclave Bloom (green-white), the operator's own track
- Gilded Toccata (white-black), the operator's own track
- Stormforge Circuit (blue-red), the operator's own track
- Rotgarden Undercity (black-green), the operator's own track
- Legions Advance (red-white), the operator's own track
- Tidal Genesis (green-blue), the operator's own track

Like the sound effects, the audio lives in `CARDTABLE_SOUNDS_DIR` and never in this repository.

## hadoku-watchparty

The room, chat and presence layer derives from `hadoku-watchparty` (MIT).
See `docs/requests/WATCHPARTY_ROOM_MODULE.md`.
