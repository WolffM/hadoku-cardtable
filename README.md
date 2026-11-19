# hadoku-cardtable

**Guide:** [overview](docs/guide/index.md) · [features](docs/guide/features.md) · [contributing](docs/guide/contributing.md) · [history](docs/guide/history.md) · [trivia](docs/guide/trivia.md)

Cube drafting and casual Magic: The Gathering, free for every signed-in
member — a fork of [Forge](https://github.com/Card-Forge/forge) for the
rules engine, with the room, chat and lobby layer coming from a private
companion repo in place of Forge's own online infrastructure. Unofficial,
unaffiliated, and non-commercial — see [`NOTICE.md`](NOTICE.md).

## Dev environment variables

[contributing.md](docs/guide/contributing.md#run-it-locally) has the
clone-and-run steps; these tune the local dev server itself:

| env var | default | what for |
| --- | --- | --- |
| `CARDTABLE_DEV_PORT` | `9300` | the port to open; the server takes the next one |
| `CARDTABLE_DEV_TIER` | `admin` | `friend` to see the app as a player does |
| `CARDTABLE_FORGE_JAR`, `CARDTABLE_FORGE_RES` | built | a Forge jar and `res/` you already have |
| `CARDTABLE_DEV_NO_FORGE` | unset | `1` to skip Forge entirely |
| `CARDTABLE_JAVA` | `JAVA_HOME`, then `PATH` | the JDK 21 `java` to run Forge with |

## Licence

**GPL-3.0-or-later**, inherited from Forge — see [`LICENSE`](LICENSE),
[`NOTICE.md`](NOTICE.md), and [`docs/LICENSING.md`](docs/LICENSING.md) for what
that does and doesn't require, plus the separate and more important question of
Wizards of the Coast's IP.

No money changes hands anywhere in the app, and there is no public or
anonymous access to it — every route is gated at member tier and up. It
carries an "unofficial, not affiliated with or endorsed by Wizards of the
Coast" disclaimer. Mana and set symbols come from the third-party Keyrune
and Mana fonts (licence texts in `games/magic/ui/src/symbols/`).
