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
~/.local/opt/stable-audio/.venv/bin/python scripts/sfx/generate.py --takes 4 [--only W,UR,m-draw] [--vibes saved.json]
```

`prompts.json` holds the vibes inferred on the Sound Palette page
(https://claude.ai/artifact/T7VSxtbdugjktF5V1CFG5N); `--vibes` takes the operator's saved edits, which win.
Every take has a `.json` sidecar (prompt, seed, steps, cfg, model, licence), so it can be regenerated exactly.
