# The Forge jar — build, install, rebuild

`POST /api/play/matches` needs a Forge build. The server reads two paths at boot
(`apps/server/src/play/host.ts`, `jvmHostConfig`):

| env var | value | set by |
| --- | --- | --- |
| `CARDTABLE_FORGE_RES` | `<repos>/hadoku-cardtable/forge/forge-gui/res` | hadoku_site's wrapper, from `scripts/child-apps.json` `tunnel.pathEnv` |
| `CARDTABLE_FORGE_JAR` | `~/.local/share/cardtable/forge.jar` | same |

Neither is a secret and neither goes through the vault broker. If the jar is
missing the server still boots, logs one warning to stderr, and answers 503 from
that one route — nothing else changes.

## Why the jar lives outside the clone

`~/.local/share/cardtable/forge.jar` is outside every checkout on purpose, so no
deploy's `git reset --hard` or stash can touch it, and the name carries no
version so the path never changes. hadoku_site chose it; don't move it without
telling them, because their wrapper hardcodes it.

The jar is **not** in git and never will be: 38 MB, and it is a build output of
the pinned submodule.

## Per-pin jars (wave 53, ledger Y26)

**The jar is shared by CI and production, and that used to be a problem.**
w52's install at 21:58:56Z put a new engine under `d28788c`'s in-flight CI run,
which made its reds meaningless (memory `jar-install-invalidates-older-ci`): a
run can be mid-flight against one `forge` build and have the file underneath it
swapped out before it finishes.

So every installed jar now keeps its own file, named for the **full 40-char**
`forge` submodule sha it was built from, under `~/.local/share/cardtable/jars/`:

```
~/.local/share/cardtable/jars/<forge-pin>.jar
```

(Not the short form — a short sha is ambiguous across enough history, and the
rename cost is one `install -m 0644` either way.)

**CI resolves its own jar from the commit it is testing**, not from whatever is
currently installed: `git ls-tree HEAD forge | awk '{print $3}'` gives that
commit's pin, and `ci.yml`'s "Resolve the Forge jar for this commit's pin" step
(in both `forge-e2e` and `forge-jvm`) builds
`~/.local/share/cardtable/jars/<that pin>.jar`, prints the resolved path as a
`::notice::` (that line is what proves a run used the right jar), and fails the
job loudly with `::error::` if that file is missing — a new pin that nobody
has built yet reds instead of silently running an old engine.

**Production's `~/.local/share/cardtable/forge.jar` becomes a symlink** to
whichever pin's jar is current, because hadoku_site's wrapper hardcodes that
one path (`jvmHostConfig` above) and does not know about pins. Switching that
symlink and restarting production is a **deploy** — see "Switching production
to a new pin" below; it is the operator's step, not part of a routine jar
rebuild.

## Rebuilding (every time the `forge` pin moves)

This is manual by agreement — option 1 in
`docs/requests/CARDTABLE_PLAY_ENABLEMENT_REPLY.md`. No CI job builds it.

**Two hard rules.** Never build inside the vendored `forge/` tree — it must stay
pristine (D2), and a build there leaves `target/` dirs that make the submodule
dirty. And the toolchain is deliberately off `PATH`.

```sh
# 1. A scratch clone of OUR fork, at whatever the submodule is pinned to.
PIN=$(git -C ~/repos/hadoku-cardtable submodule status forge | awk '{print $1}' | tr -d '-+')
git -C ~/.cache/w7b-forge fetch origin && git -C ~/.cache/w7b-forge checkout --detach "$PIN"
git -C ~/.cache/w7b-forge status --porcelain     # must be empty

# 2. Build with the off-PATH toolchain. `clean` is NOT optional across a pin
#    move: an incremental build can re-package stale classes from the previous
#    checkout and produce a jar that passes step 3 while missing other changes.
export JAVA_HOME=~/.local/opt/jdk-21.0.12.1+1
export PATH="$JAVA_HOME/bin:$HOME/.local/opt/apache-maven-3.9.16/bin:$PATH"
cd ~/.cache/w7b-forge
mvn -q -pl forge-gui-desktop -am clean package -DskipTests -Dmaven.test.skip=true

# 3. Verify the artifact carries BOTH fork commits before installing it.
JAR=~/.cache/w7b-forge/forge-gui-desktop/target/forge-gui-desktop-*-jar-with-dependencies.jar
unzip -p $JAR forge/view/Main.class | strings | grep -qx server        # `forge server` exists
unzip -p $JAR forge/view/Main.class | strings | grep -qi sentry && echo 'STOP: Sentry still in'

# 4. Install it under its OWN pin — never overwrite forge.jar directly.
mkdir -p ~/.local/share/cardtable/jars
install -m 0644 $JAR ~/.local/share/cardtable/jars/$PIN.jar
java -jar ~/.local/share/cardtable/jars/$PIN.jar server --help   # prints the usage, exits
sha256sum ~/.local/share/cardtable/jars/$PIN.jar                 # keep this line with the install record
```

Installing under `jars/$PIN.jar` is enough for CI (it resolves the pin itself —
see "Per-pin jars" above) and leaves production untouched. Switching what
production actually runs is a separate, deliberate step — next.

## Switching production to a new pin

This is a deploy, not a build step: it changes what the live server runs while
players may be mid-match. **The operator does this, not a lane or a wave
manager.**

```sh
# 1. A match in progress must not be cut off.
curl -s localhost:9008/health/busy   # must say {"busy":false}

# 2. Atomic symlink switch — never `rm` then `ln`, which has a gap with no
#    forge.jar on disk at all.
ln -sfn ~/.local/share/cardtable/jars/$PIN.jar ~/.local/share/cardtable/forge.jar
ls -la ~/.local/share/cardtable/forge.jar   # confirm it now points at $PIN.jar

# 3. Restart through mgmt-api, NEVER raw pm2 (services/mgmt-api/CLAUDE.md).
curl -s -X POST http://127.0.0.1:4000/api/cardtable/restart
```

### What a good restart looks like

`~/.pm2/logs/cardtable-out.log` gains a spare JVM, and the warning in
`cardtable-error.log` is **absent**:

```
{"svc":"cardtable-play","evt":"jvm-spawned","id":"spare-…","pid":…,"spare":true}
{"svc":"cardtable-play","evt":"spare-warm","id":"spare-…","bootMs":4074}
```

A bad one keeps saying, on stderr:

```
[cardtable] play: no Forge (CARDTABLE_FORGE_JAR does not exist: …) — POST /api/play/matches answers 503
```

Those two messages distinguish the two failures: `is not set` means the wrapper
did not pass the var (hadoku_site's side), `does not exist` means the jar is not
where we put it (ours).

## Step 3 is not optional

The fork carries exactly two commits on top of upstream, and a jar built from
the wrong tree fails in ways that are quiet rather than loud:

- `1f19a230` strips the Sentry DSN. Built without it, **our crashes are reported
  to the upstream Forge project**, which is someone else's error budget and our
  stack traces.
- `2ad70eb4` implements `forge server`. Built without it, the jar takes the
  argument and runs the desktop path, which on a headless host fails somewhere
  less obvious than "unknown command".

Neither shows up as a build error, which is why the check greps the compiled
class rather than trusting the checkout.
