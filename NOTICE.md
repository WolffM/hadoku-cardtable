# Notices and attribution

## Forge

This project contains and builds upon **Forge**, an unofficial rules engine for
Magic: The Gathering.

- Upstream: <https://github.com/Card-Forge/forge>
- Copyright (C) Forge Team
- Licensed under the **GNU General Public License, version 3 or later**

Forge's source is vendored under `forge/`. Its per-file copyright headers are
preserved unmodified. This repository as a whole is distributed under GPL-3.0;
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

### Non-commercial, and private

Both of these statements are load-bearing, and more so since this project began
hosting card art (see below):

- **Non-commercial.** This project is not sold, licensed, monetized, advertised,
  sponsored or donated to, in any form, ever. There is no payment path of any
  kind and none will be added.
- **Private.** It is not publicly available. Access is limited to a small,
  invited group behind an authentication gate; there is no public tier, no open
  signup and no anonymous access.

### Card artwork

This project **does host card art**, on its own content-delivery endpoint at
`cdn.hadoku.me`. That changed on 2026-09-15; this notice previously stated that
no artwork was stored or served, and that is no longer true. The specifics,
stated plainly rather than summarised:

- **What is served is the whole, unmodified card face.** Images are not cropped,
  distorted, stretched, recoloured, filtered, watermarked or altered in any way.
  The artist credit and the copyright line printed on each card are therefore
  present and legible in every image this project displays, which is how
  attribution is carried. Storage is content-addressed by SHA-256, so any
  alteration would be a different object.
- **No artwork is contained in this source repository.** Image bytes are never
  committed to git, and a continuous-integration check (`scripts/d13-gate.sh`)
  fails the build if any image file reaches the built application.
- **The application's own origin serves no image bytes.** Images are fetched by
  the browser from `cdn.hadoku.me` or from `cards.scryfall.io`.
- **The artwork is a placeholder.** It is held behind a per-card indirection
  specifically so that it can be replaced with differently-sourced art, and the
  intent is to replace it.
- **An asymmetry, named because it is real:** the application is
  authentication-gated, but `cdn.hadoku.me` is not. Uploading to it requires
  authorisation; reading from it is public. An image stored there is therefore
  retrievable by anyone who knows its SHA-256 URL, even though the application
  that uses it is private. This was understood and accepted when the decision
  was made; it is recorded here rather than glossed over.

**If you are a rights holder** — Wizards of the Coast, or an artist whose work
appears here — and you would prefer your artwork not be hosted by this project,
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
copyright (c) Andrew Gioia, licensed under the SIL Open Font License 1.1.
All mana, tap and card type symbol images are copyright Wizards of the Coast.

Neither font is renamed, per the SIL OFL reserved font name clause.

## hadoku-watchparty

The room, chat and presence layer derives from `hadoku-watchparty` (MIT).
See `docs/requests/WATCHPARTY_ROOM_MODULE.md`.
