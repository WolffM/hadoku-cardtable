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
uv pip install --python $D/.venv/bin/python diffusers transformers accelerate sentencepiece soundfile huggingface_hub protobuf torchsde
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
