# Sound effects — local generation

Candidate sounds for the 26 colour identities (+ colourless) and the game moments, generated with
Stable Audio Open 1.0 on the host's RTX 4090. **Audio never enters this repo:** takes are written to
`~/.local/share/cardtable-sfx/generated/<id>/`, packs live in `~/.local/share/cardtable-sfx/packs/`,
and the picked files go to `cdn.hadoku.me` with a row in `apps/ui/src/sound/cue-manifest.json`.

## Runtime (outside the repo, no host mutation, beside the JDK and Maven)

```sh
D=~/.local/opt/stable-audio
uv venv --python 3.12 $D/.venv
uv pip install --python $D/.venv/bin/python --index-url https://download.pytorch.org/whl/cu128 torch torchaudio
uv pip install --python $D/.venv/bin/python diffusers transformers accelerate sentencepiece soundfile huggingface_hub protobuf torchsde pyloudnorm
```

The model is gated on Hugging Face (accept the terms once, logged in), so downloads need a read token:
`$D/.venv/bin/hf auth login --token <token>` stores it in `~/.cache/huggingface/token`. Never a `.env`.

## Run

```sh
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/generate.py --takes 4 [--only W,UR,m-draw] [--vibes saved.json] [--offload model]
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/finish.py   # trim, fade, level-match, encode Opus
```

`prompts.json` holds the vibes inferred on the Sound Palette page
(https://claude.ai/artifact/T7VSxtbdugjktF5V1CFG5N); `--vibes` takes the operator's saved edits, which win.
Every take has a `.json` sidecar (prompt, seed, steps, cfg, model, licence), so it can be regenerated exactly.

The GPU is shared (InvokeAI and other projects' jobs hold most of it at times): `--offload model` needs about
4 GB, and an out-of-memory take waits 30 s and retries rather than failing. A rerun resumes: existing takes
are skipped.

## Import into the server (wave 50)

The builder (`#/sounds` on the deployed app, admin-gated) reads its catalogue and takes from the
server's own `CARDTABLE_SOUNDS_DIR`, never from this repo and never from the artifact. `import.py`
turns a `finished/` snapshot — a per-folder `manifest.json`, the shape `finish.py` writes — into that
directory's layout:

```sh
python3 scripts/sfx/import.py --from <finished dir> --seed <assignments.json> --to <sounds dir> [--force]
```

- `catalogue.json` is rebuilt from `--from` on every run — it describes what audio exists, not
  anything an admin edited through the builder.
- `assignments.json` is written from `--seed` only if it does not already exist; `--force`
  overwrites it. An admin's own assignments, made through the builder, must never be clobbered by a
  re-import.
- The `.ogg` files are copied into `<to>/takes/<folder>/<file>`, with the folder segment lowercased
  (`BG.land` → `bg.land`) — `apps/server/src/http/sounds.ts`'s take-serving route and
  `@hadoku/shared`'s `TAKE_FILE_RE` are lowercase-only, but a source folder carries the colour code's
  own case.
- Colour-identity names/families match `packages/shared/src/sounds.ts`'s `SOUND_MATRIX` (duplicated
  in the script, since this is a one-off Python tool with no TypeScript dependency). `m-*` folders only
  name bin rows: the builder's cells are `SOUND_ROLES` ids, so an `m-*|play` cell in `--seed` is dropped
  by the server. Library sound names and groups come from `round3.json`, read at import time.

## Round 4: role candidates (2026-10-10)

`round4.json` writes candidates for the roles in `SOUND_ROLE_GROUPS` that had no take at all, one folder
per role id (`ui.select`, `g.cast.instant`, …). Finish and import them on their own, and MERGE them into
the live catalogue so the earlier keepers stay:

```sh
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/generate.py --spec scripts/sfx/round4.json --takes 3 --seed 5000
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/finish.py --only ui.,g. --out finished-r4
python3 scripts/sfx/import.py --from ~/.local/share/cardtable-sfx/finished-r4 --to <sounds dir> --merge
```

Without `--merge`, `import.py` rebuilds `catalogue.json` from `--from` alone. Without `--only`, `finish.py`
re-finishes every folder under `generated/`, rejected rounds included.

## Music

Found tracks, not generated ones: each needs a licence that allows this use (CC0, CC-BY or similar) and
its credit in `NOTICE.md`. `add-track.py` transcodes one into the server's sounds dir and adds it to the
catalogue's Music section; then place it on `music.lobby` or `music.match` in `#/sounds`.

```sh
python3 scripts/sfx/add-track.py tavern.mp3 --name "Tavern loop" --credit "Tavern loop by …, CC-BY 4.0, https://…" --to apps/server/data/sounds
```

Audio bytes never enter this repo or the UI bundle at any point in this pipeline — `import.py` only
ever reads from a local `finished/` directory and writes to the server's data directory, both outside
git.

## Re-cutting in place

When the finishing limits change, re-cut the live takes without touching their names, groups or placements:

```sh
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/finish.py --into apps/server/data/sounds
```

Each catalogued take with a raw `.wav` under `generated/` is finished again and written over its own file; only its
`seconds` changes in `catalogue.json`. Do not use `import.py --merge` for this: it rebuilds the entries, which loses
any renames. Browsers pick the new cut up at once: `/api/sounds/audio/…` is served `no-cache` with an ETag.

## What was thrown out

The picker's **Delete** (bad) and **Shift+Delete** (broken) retire the take in hand: it leaves the catalogue and every
cell, its audio moves to `<sounds dir>/retired/`, and a line lands in `<sounds dir>/retired.jsonl` (Undo restores it).
Read that before a new batch:

```sh
python3 scripts/sfx/retired.py apps/server/data/sounds
```

Per prompt it shows how many takes were thrown out and why, and what is still kept. Mostly *broken* points at
generation or finishing; mostly *bad* at the prompt — rewrite it, or drop it from the next `roundN.json`.

## Round 5: a new round in folders older rounds share

Round 5 (2026-10-11) filled the cells left empty after the operator had heard every earlier take; every
take that was not placed was retired first (`retired.jsonl`, reason `unused`). New takes land in folders
that also hold placed ones (`g.tap/`), so:

```sh
python3 scripts/sfx/make-round5.py <empty.json>                       # round5.json from the empty cells
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/generate.py --spec scripts/sfx/round5.json --takes 3 --seed 7000
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/finish.py --min-seed 7000 --out finished-r5
python3 scripts/sfx/import.py --from ~/.local/share/cardtable-sfx/finished-r5 --to apps/server/data/sounds --add
```

`--min-seed` finishes only this round's files; `--add` appends them and keeps every entry already in the
catalogue (`--merge` replaces whole folders, which would drop placed takes and their renames).


## Round 6: what the keepers say (2026-10-11)

The operator on round 5: *"a lot of the new sounds are useless and mostly sound the same as other sounds"*, *"in
most cases bells sound bad"*, *"the bant creature sounds are just maxing out my speakers"*. Measured over every take
ever offered (the catalogue plus `retired.jsonl`), what was placed:

| Prompt style | Placed |
| --- | --- |
| a real-world field recording (frog, wolf, owl, thunder, waves, rockslide) | 8 of 9 |
| a rich, specific scene (rounds 1–3: "a detuned calliope", "a snake hiss over dark water") | 39% |
| literal foley (a sword drawn, a buckle, a key in a lock, knuckle knocks) | 11%, but most of the role picks |
| the round 4/5 template "one single hit, dry, close-mic, no reverb" | 6% |
| round 5b's ethereal swells | 1 of 90 |
| anything with a bell or a chime | 4 of 100 |

Round 5 also gave each identity one theme phrase and reused it in every cell, so a colour's spell, creature and
land were the same sound three times. Round 6 (`make-round6.py`): one concrete place per identity (the operator:
*"bant: harbour sounds"*), a different real source in every cell, the plain recording suffix, and bells, chimes
and gongs in the negative prompt. Re-run the table before the next round:

```sh
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/generate.py --spec scripts/sfx/round6.json --takes 3 --seed 8000 --offload model
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/finish.py --min-seed 8000 --out finished-r6
python3 scripts/sfx/import.py --from ~/.local/share/cardtable-sfx/finished-r6 --to apps/server/data/sounds --add
```

## Loudness

`finish.py` levels by perceived loudness (BS.1770 momentary max) with a target per kind of sound: moments −20,
game −23, interface −28, hovers −34 LUFS, before the mono downmix. RMS levelling had left a 17 dB spread
(p5 −31.9, p95 −14.6); after a `--into` re-cut, every game take is within about a dB of the others.

## Clipping (2026-10-11)

Stable Audio peaks well past full scale (2.29 on one take), and until this date every take was saved as 16-bit WAV,
which hard-clipped it: 309 of 439 live takes, from every round. Levelling then turned those takes down, so the
distortion played quietly; the operator heard it as *"like they're capping out something"*. `generate.py` saves
32-bit float now, and `--rerender <sounds dir>` renders each clipped catalogued take again from its sidecar. The
render is deterministic (the same seed matched the saved file to within 16-bit rounding), so it is the same sound
without the clipping. Then re-cut in place:

```sh
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/generate.py --rerender apps/server/data/sounds --offload model
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/finish.py --into apps/server/data/sounds
```

`--into` cuts a placed take for the role it plays (the shortest limit across its cells), so a creature take placed
on "Hover a card" is cut to a hover's 0.25 s.

## Outliers and the hover (2026-10-12)

The operator: *"lets smoothen out the 'hover' sound it's a bit harsh"* and *"normalize all the sound effects a bit
... make sure there aren't too many crazy outliers"*. Measured, three causes, all fixed in `finish.py`:

- **Stereo that cancels.** Some takes are near opposite in phase between channels; the mono downmix (ffmpeg's, after
  levelling) left them 20 dB under target. `to_mono` downmixes first and keeps the louder channel when the average
  cancels. Targets are now on the mono take (3 dB lower numbers, the same output).
- **Short hits.** A click levelled on its loudest 400 ms had its first 50 ms up to 9.5 dB over the rest. A take's
  loudest 50 ms may now sit at most `TRANSIENT_HEADROOM_DB` (4) over its target.
- **The hovers** get a 5 kHz low-pass, a raised-cosine attack and a fade over half their length, applied before
  the level is measured.

After a `--into` re-cut: every take within −6.5..+0.1 dB of its target on 400 ms, no take's 50 ms more than 4.2 dB
over (before: −22.8..+0.5, and +9.5). A take with no raw source (a hand edit) is levelled from its own file.
`momentary_max` and `short_max` use a running sum: the full convolution took minutes per take.

## Round 7 (2026-10-12)

`make-round7.py`: every empty cell and role, new Colourless and Boros lands (the operator named both), and a
second take for every sound heard often (*"at least two for each of the common ones like basic lands"*). A common
sound's prompts are siblings of the take already placed on it. Quick sounds are generated 1 s long.

```sh
python3 scripts/sfx/make-round7.py
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/generate.py --spec scripts/sfx/round7.json --takes 2 --seed 9000 --offload model
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/finish.py --min-seed 9000 --out finished-r7
python3 scripts/sfx/import.py --from ~/.local/share/cardtable-sfx/finished-r7 --to apps/server/data/sounds --add
```

## Harvest (2026-10-15)

When the operator has been through every take (*"save and rename the chosen sounds and get rid of the non-chosen
ones"*), `harvest.py` closes the pass. A placed take (or one marked keep) moves to a folder named after its cell,
`g.phase/take-1.ogg` or `u-basic/take-2.ogg`, labelled "Phase change 1" or "Island 2". The assignments and marks
follow it, and a copy goes to `~/.local/share/cardtable-sfx/chosen/`. Everything else is retired as `unused`.
`sources.json` maps each new name to the one it was generated under; `finish.py --into`, `retired.py` and
`make-round8.py` read it to find the raw render.

```sh
python3 scripts/sfx/harvest.py apps/server/data/sounds --dry-run
python3 scripts/sfx/harvest.py apps/server/data/sounds
```

## Round 8: siblings of the chosen (2026-10-15)

The picks show the operator chooses a sound, not a description of the event: a creature take plays on "Hover a
card", a clasp click on "Life gain". So a cell that repeats gets its chosen take rendered again from its own sidecar
(prompt, negative, length, steps, cfg) under new seeds: the same source, a different performance. "Repeats" is
`played.py`'s raises per game per take, 2 or more. The siblings scale from 4 to 8 with it. A reversed take (Untap)
is rendered and reversed. Mana and Their turn, still empty, get fresh prompts.

```sh
python3 scripts/sfx/played.py apps/server/data/sounds > played.json
python3 scripts/sfx/make-round8.py apps/server/data/sounds played.json
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/generate.py --spec scripts/sfx/round8.json --takes 2 --seed 11000 --offload model
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/finish.py --min-seed 11000 --out finished-r8
python3 scripts/sfx/import.py --from ~/.local/share/cardtable-sfx/finished-r8 --to apps/server/data/sounds --add
```
