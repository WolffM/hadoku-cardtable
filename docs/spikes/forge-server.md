# The fork becomes ours — the Sentry DSN, and `forge server`

Wave 7, lane B. The first Java this project has ever committed, and the
submodule pin's first move off stock upstream.

Lane B's own run logs were written to a tmpfs scratchpad, which does not
survive a reboot and is therefore not a handoff. This file is the manager's
record: every claim below was **re-run by the manager** after the lane
reported, from the artifacts the lane left behind, and each command is given
with its exit code read directly.

## What landed

`WolffM/forge`, branch `cardtable/w7-server-mode`, two commits off the old pin
`2cd497cf`:

| sha | subject |
| --- | --- |
| `1f19a230` | Do not report this fork's crashes to the Forge project |
| `2ad70eb4` | Implement `forge server`: host a lobby with no window |

```console
$ git ls-remote https://github.com/WolffM/forge.git 'refs/heads/cardtable/w7-server-mode' ; echo $?
2ad70eb447a22efe5b80904c07188311da034a42	refs/heads/cardtable/w7-server-mode
0
$ git -C forge diff --stat 2cd497cf..2ad70eb4
 .../src/main/java/forge/view/DedicatedServer.java  | 215 +++++++++++++++++++++
 .../src/main/java/forge/view/Main.java             |  33 ++--
 2 files changed, 231 insertions(+), 17 deletions(-)
```

Two files, both inside the lane's one owned directory. `DedicatedServer.java`
carries Forge's standard GPL-3 header verbatim (D2); no file the lane did not
change was reformatted.

The submodule pin here moved in its own commit, `6f3aa7b`, whose diff is one
line — the gitlink — and nothing else.

## The DSN is deleted, not blanked

Upstream `Main.java:65` called `Sentry.init` **before** it read the mode
argument, and its callback *re-filled* the DSN whenever external configuration
left it empty:

```java
// these belong to sentry.properties, but somehow some OS/Zip tool discards it?
if (options.getDsn() == null || options.getDsn().isEmpty())
    options.setDsn("https://87bc8d329e49441895502737c069067b@sentry.asgardsrealm.net/3");
```

So no environment variable, no property and no config file could switch it off.
A dedicated server would have posted this fork's unattended crashes to the
Forge project's own Sentry. The whole `Sentry.init(...)` block is gone, along
with the two imports that existed only to feed it (`io.sentry.Sentry`,
`forge.util.BuildInfo`). Blanking the DSN would have been the one change
upstream's own code undoes.

### The mutation test: the check bites

The control is "the DSN is not in the shipped bytes". Reverted side and
restored side are two separately compiled `Main.class` files — upstream's, from
the read-only build tree still pinned at `2cd497c`, and ours:

```console
$ javap -p -c -constants -cp <2cd497c fat jar> forge.view.Main | grep -c   'asgardsrealm'   # 1
$ javap -p -c -constants -cp <2cd497c fat jar> forge.view.Main | grep -ci  'sentry'         # 12
$ javap -p -c -constants -cp <2ad70eb4 fat jar> forge.view.Main | grep -c  'asgardsrealm'   # 0
$ javap -p -c -constants -cp <2ad70eb4 fat jar> forge.view.Main | grep -ci 'sentry'         # 0
```

The reverted side still holds the literal
`https://87bc8d329e49441895502737c069067b@sentry.asgardsrealm.net/3` as a
constant in the class file. **reverted 1 / restored 0** on the DSN,
**reverted 12 / restored 0** on the string "sentry". A grep that returns 0 on
both sides would have proved nothing; this one returns 12 on the side where the
bug is.

Source-side, at the new pin:

```console
$ grep -n 'asgardsrealm' forge/forge-gui-desktop/src/main/java/forge/view/Main.java ; echo $?
1                                   # no output
$ grep -in 'sentry' forge/forge-gui-desktop/src/main/java/forge/view/Main.java
63:        // Upstream calls Sentry.init() here with the Forge project's own hardcoded DSN, and refills
68:        // Sentry.init() anywhere in this entry point, io.sentry's static API stays a no-op, so the
71:        // forge-gui-desktop/sentry.properties still carries the same DSN. It is inert without an
```

Three hits, all comments explaining what was removed and why. The brief asked
that `grep -n 'Sentry.init'` show the DSN *gone rather than blanked*: it is
gone, and what the grep still finds is prose.

### Left behind, on purpose, and flagged

`forge-gui-desktop/sentry.properties` still carries the same DSN, and
`forge-gui-desktop/pom.xml:450,560` copy it into the distribution zip. It is
**inert**: the Java SDK has no auto-initialisation, so with no `init()` call
nothing reads it, and it is not in the fat jar at all —

```console
$ jar tf <2ad70eb4 fat jar> > jarlist.txt ; echo $?          # 0, 24846 entries
$ grep -c 'sentry.properties' jarlist.txt ; echo $?          # 0, exit 1
```

Deleting it is a one-line change to a file outside lane B's row, so the lane
flagged it rather than reaching for it. **Follow-up owed.** What is still
unproven: whether it reaches an end user's classpath in the packaged *zip*, as
opposed to the fat jar. `unzip -l forge-gui-desktop/target/forge-*.zip | grep
sentry.properties` on a `mvn -P release` build settles that.

## `case "server":` hosts a real lobby, headless

`Main.java:111` used to print `"Dedicated server mode.\nNot implemented."`. It
now calls `DedicatedServer.start(args)`. Options: `-p <port>` (default
`NET_PORT` 36743), `-t <seconds>`, `--upnp`, `-h`.

UPnP defaults to `ASK`, which opens a **modal dialog** from inside
`startServer()` — fatal in a headless process — so the server forces `NEVER`
unless `--upnp` is passed. That decision is the lane's, and it is recorded in
the class.

### The manager's own re-run

Not the lane's transcript — this is the manager starting the server from the
lane's built jar, with the Sentry environment explicitly cleared and Sentry's
own debug logging turned *on*, which is the setting that would print a DSN if
one were initialised:

```console
$ env -u SENTRY_DSN -u SENTRY_DEBUG java -Djava.awt.headless=true -Dsentry.debug=true \
      -cp <2ad70eb4 fat jar> forge.view.Main server -p 51799 -t 25
...
17:41:57 [INFO ] FServerManager: Starting Multiplayer Server
Dedicated server listening on port 51799 (hosting=true, upnpMapped=false, seats=2)
Running for 25 s, then stopping.
Stopped.
Shutting down.

$ ss -ltnp | grep ':51799'
LISTEN 0 4096 0.0.0.0:51799 0.0.0.0:* users:(("java",pid=3582511,fd=60))

SERVER_EXIT=0
$ grep -ci 'sentry\|dsn' server.log ; echo $?
0
1
```

A real `NioServerSocketChannel` bound to a real port, under
`-Djava.awt.headless=true`, exiting 0, with **zero** Sentry or DSN lines in the
whole run.

The lane additionally drove a real `FGameClient` against it and was seated —
`lobby update: slot=1 slots=2`, seat 0 `LOCAL` "Gerry", seat 1 `REMOTE`
"w7b-probe", with the server logging `Decoded LoginEvent in 115 ms (131 bytes
compressed)` and `[chat/SYSTEM] w7b-probe joined the lobby.` — then `kill -INT`
→ exit 130 and the port released. That transcript was not independently re-run
by the manager; the bind, the clean exit and the DSN absence above were.

### What it does NOT do

**It hosts a lobby. It does not start a match.** Seat 0 of a `ServerGameLobby`
is `LOCAL`, and `FServerManager.getGui(0)` answers a LOCAL seat with
`GuiBase.getInterface().getNewGuiGame()` — a Swing GUI a headless process
cannot supply. Seating slot 0 with an AI, or teaching the lobby to have no
local seat, is the next piece of work. The lane did not guess at it, and said
so. Settle it with
`server.updateSlot(0, UpdateLobbyPlayerEvent.create(LobbySlotType.AI, …))` plus
two ready clients, then `lobby.startGame()`.

## The pin moved, and every count still holds

`forge/` is now pinned at `2ad70eb4`. Every number `docs/` cites was measured
at `2cd497c`, so all of them were re-derived at the new pin — by the lane, and
again by the manager, with the anchored greps `CLAUDE.md` mandates:

| | at `2ad70eb4` | expected |
| --- | --- | --- |
| `ProtocolMethod` `Mode.SERVER` | **45** | 45 |
| `ProtocolMethod` `Mode.CLIENT` | **15** | 15 |
| naive `grep -c 'Mode\.'` (the trap) | **61** | 61 |
| `ApiType` constants | **202** | 202 |
| `ApiType` distinct effect classes | **199** | 199 |
| `res/cube/*.dck` | **95** | 95 |
| `res/draft/*.draft` | **94** | 94 |

Unchanged, as they must be: the diff touches only `forge/view/`.

## The vendored tree is pristine

Nothing was built in `forge/`. Lane B worked in a separate copy at
`~/.cache/w7b-forge`; lane A's copy at `~/.cache/w1-spike/forge` was untouched
and is still at `2cd497c`.

```console
$ assert_forge_pristine        # sourced from scripts/spike/itoclient/run.sh, unedited
forge/ pristine: 0 tracked changes, 0 target/ dirs (both checked).
$ echo $?
0
```

Both halves matter. `git status --porcelain` alone cannot see build output
there — Forge's own `.gitignore` line 33 covers `target` — which is how six
`target/` dirs survived a "pristine" check in Wave 6.

## Decisions and open ends

- **Branched from the pin, not the fork's master.** `WolffM/forge` master is
  `994c5d9e`, 65 commits ahead of `2cd497c`. Basing on the pin keeps the bump to
  exactly our two commits and keeps every documented count valid. Syncing the
  fork to upstream is a separate decision for the operator.
- **`2ad70eb4` lives only on `cardtable/w7-server-mode`.** If that branch is
  deleted before it is merged into the fork's master, the pin becomes
  unreachable. Merging the branch on `WolffM/forge` settles it, and is worth
  doing.
- **Wave 6's `itoclient` spike was not re-run at the new pin.** It builds from a
  copy and does not touch `forge/view/`, so the change cannot affect it — but
  that is a reading, not a run. `FORGE_DIR=<a copy> bash
  scripts/spike/itoclient/run.sh all ; echo $?` settles it.
