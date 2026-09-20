# CheerpJ, assets and the filesystem — Wave 15, lane B

**The gate first, because the brief said to settle it before anything else:**

> **`java.util.zip.ZipFile` WORKS under CheerpJ, on a file served from `/app/`.**
> The real `cardsfolder.zip` — 16,193,445 bytes, 33,785 entries — opens in
> **40 ms**, enumerates completely in **13–21 ms**, and decompresses 50
> scattered entries in **138–159 ms**. Two runs, the ranges are the spread
> between them; the open time was 40 ms in both. Nothing about it is marginal.

Wave 14 listed `new ZipFile("/app/cardsfolder.zip")` in its "NOT verified"
section and said everything downstream depended on it. It does not fail. The
measurement is in §1 and reproduces in about seven seconds.

**But the archive was never the hard part, and the plan built on it was wrong.**
Wave 14's §B said `res/` needed "two things": `getAssetsDir()` and relaxing a
guard at `CardStorageReader:93`. Both are real, both are fixed here — and
fixing them buys you exactly one more crash. `/app/` has no directories *at
all*, and Forge enumerates directories from far more than one place. §3 walks
the wall.

**What actually works is §4: unpack `res/` into CheerpJ's OTHER mount.**
`/files/` is IndexedDB-backed, writable, and lists directories like a real
filesystem. Unpack once out of an archive on `/app/` — using the `ZipFile`
support the gate just proved — and Forge runs against a filesystem shaped the
way it was written for. With that in place and **one** one-line Forge patch:

```
44289ms BOOT handing off to forge.view.Main
52801ms Language 'en-US' loaded successfully.
63123ms Read cards: 33785 archived files in 5 (25 parts) in same thread
```

Forge's own `SplashFrame` paints, with its real skin, and the full 33,785-card
database is loaded. That is this lane's done-when, met.

**The wall after that is not an asset problem, and §5 names it to the line:**
XStream cannot initialise under CheerpJ because
`jdk.internal.misc.Unsafe.putChar` has no native implementation. Two separate
causes, both measured, neither of them a file.

---

## 1. The gate — `ZipFile` on `/app/`

```sh
export SPIKE_CACHE=$HOME/.cache/w15b-assets
export PORT=8742
./scripts/spike/cheerpj/assets/run.sh zip          # build both archives
./scripts/spike/cheerpj/assets/run.sh build        # compile the probes
./scripts/spike/cheerpj/assets/run.sh probe-zip small
./scripts/spike/cheerpj/assets/run.sh probe-zip full
```

`spike.ZipProbe` opens the archive, enumerates every entry, decompresses one
fully, then decompresses 50 entries spread across the archive — because "the
central directory parsed" and "the deflate streams read" are different
questions and only the second is the one Forge needs.

**Full archive** (`probe-zip full`, the real `res/cardsfolder` zipped):

```
5538ms ZIP file exists=true isFile=true len=16193445 canRead=true
5596ms ZIP open OK ms=40 size=33785
5637ms ZIP entries ms=13 total=33785 dirs=29 txt=33752 first=a/a_display_of_my_dark_power.txt
5669ms ZIP read OK ms=3 entry=a/a_display_of_my_dark_power.txt declaredSize=937 charsRead=937 firstLine=Name:A Display of My Dark Power
5837ms ZIP scatter ms=159 entriesRead=50 bytes=30077
5837ms ZIP VERDICT WORKS
```

**Small archive** (400 cards, 193,331 bytes): open 7 ms, enumerate 3 ms,
scatter-read 50 entries 23 ms. Same verdict.

Two numbers worth carrying forward:

| | |
| --- | --- |
| `res/cardsfolder` on disk | **132 MB**, 33,752 `.txt` files |
| the same tree as one zip | **16.2 MB** |

The whole Magic card database is a 16 MB download. That is the single best
ratio in this project.

## 2. The three Forge patches, and which one you actually need

All three are under `scripts/spike/cheerpj/assets/patches/`, applied by GNU
`patch -p1` to a **copy** of the vendored tree in `$SPIKE_CACHE`. `forge/` is
never touched (D2).

| patch | what it does | needed? |
| --- | --- | --- |
| `0001-assets-dir-from-system-property` | `GuiDesktop.getAssetsDir()` honours `-Dforge.assetsDir` | **YES** |
| `0002-card-data-from-zip-without-directories` | `CardStorageReader` tests for the archive before the two directory guards; `collectCardFiles` returns instead of NPEing on a null `list()` | only for the `/app/`-direct route |
| `0003-language-bundles-without-a-directory-url` | `Localizer` appends the trailing slash `File.toURI()` omits | only for the `/app/`-direct route |

Reapply from a fresh copy, exit codes read directly:

```sh
export SPIKE_CACHE=$HOME/.cache/w15b-assets
FORCE=1 ./scripts/spike/cheerpj/assets/run.sh pristine
./scripts/spike/cheerpj/assets/run.sh patch-check; echo $?
```

```
== applying 0001-assets-dir-from-system-property.patch     exit=0
== applying 0002-card-data-from-zip-without-directories.patch  exit=0
== applying 0003-language-bundles-without-a-directory-url.patch exit=0
== all patches applied, aggregate exit: 0
-2ad70eb447a22efe5b80904c07188311da034a42 forge
PATCHCHECK_EXIT=0
```

`git status --porcelain -- forge` prints nothing and the submodule pin is
unchanged, before and after every run in this document.

**That "needed?" column is measured, not reasoned.** A jar built with
`PATCH_SET='0001*'` — upstream `CardStorageReader` and `Localizer`, confirmed
by the untouched `"not a directory"` string still present in
`forge/CardStorageReader.class` — boots to `Read cards:` exactly as the
three-patch jar does:

```sh
PATCH_SET='0001*' ./scripts/spike/cheerpj/assets/run.sh patch
./scripts/spike/cheerpj/assets/run.sh build-forge
./scripts/spike/cheerpj/assets/run.sh stage-forge
BOOT_WIPE=1 ./scripts/spike/cheerpj/assets/run.sh boot-files
```

So **the route that works needs one line of Forge changed.** Patches 0002 and
0003 are kept because they are the honest record of what the `/app/`-direct
route costs, and because they are correct fixes on their own terms — 0003 in
particular is an upstream bug on any mount that cannot report directories.

### `getAssetsDir()` — why it is one line

`ForgeConstants.ASSETS_DIR` is `GuiBase.getInterface().getAssetsDir()`, and
every `RES_DIR`-derived constant hangs off it. `GuiDesktop` returns `""` for a
non-`git` version string (`GuiDesktop.java:89-92`), i.e. every path Forge opens
is relative to a process working directory that a browser does not have. The
patch returns `System.getProperty("forge.assetsDir")` when it is set and is
byte-identical to upstream when it is not.

### `Localizer` — the bug Wave 14 could not have predicted

Not in the handoff's list, and it kills the boot immediately after the skin:

```
java.util.MissingResourceException: Can't find bundle for base name en-US, locale en_US
	at forge.util.Localizer.setLanguage
```

`Localizer.setLanguage` builds a `URLClassLoader` over the languages directory
with `file.toURI().toURL()`. `File.toURI()` appends the trailing slash **only
when `isDirectory()` is true**, and `URLClassLoader` treats a URL without a
trailing slash as a **jar**. On a mount that cannot report directories the
bundles are therefore looked for inside a nonexistent archive. Appending the
slash unconditionally is a no-op on a real filesystem.

## 3. Why the `/app`-direct route is a dead end

With all three patches, booting the jar straight off `/app/` gets past the
splash, past the language bundles, and then hits this:

```
java.lang.RuntimeException: StorageReaderFolder.ctor() error, Directory can't be created
	at forge.util.storage.StorageReaderFolder.<init>
	at forge.card.CardEdition$Reader.<init>
	at forge.StaticData.<init>
```

`StorageReaderFolder` is the shape of the problem, not another instance of it.
Its constructor calls `mkdirs()` and then demands `isDirectory()`; its
`readAll()` calls `listFiles(filter)` and iterates the result without a null
check; its `getSubFolders()` does the same. It is the base class for editions,
decks, quests, puzzles, precons and more. Patching it and its callers is a long
tail with no visible end, and each fix only reveals the next one — this lane
spent three build-and-boot cycles discovering exactly that, which is the
cheapest way to learn it.

**`/app/` is a read-only file mount, not a filesystem.** Wave 14 measured that
`new File("/app").list()` returns 0 entries and every intermediate directory
reports `exists=false`; this lane measured what that costs in practice. Stop
trying to make Forge tolerate it.

## 4. The route that works — unpack into `/files/`

`scripts/spike/cheerpj/assets/java/spike/Bootstrap.java` opens an archive on
`/app/`, writes every entry into `/files/`, verifies the result behaves like a
directory, and then reflectively calls `forge.view.Main.main`. CheerpJ's
`/files/` is IndexedDB-backed, writable, and enumerable.

```
20445ms BOOT verify /files/res isDir=true entries=24
20460ms BOOT verify /files/res/editions isDir=true entries=679
```

`res-boot.zip` carries the slice of `res/` a match needs. What is left out is
left out on measured size, not on a guess:

| excluded | size | why |
| --- | --- | --- |
| `adventure` | 153 MB | no match path reads it |
| `music` | 17 MB | no match path reads it |
| `languages/*` except `en-US.properties` | 59 MB total | `cardnames-*.txt` are per-locale |
| `skins/*` except `default` | 18 MB total | one skin is one skin |
| `cardsfolder` raw | 132 MB | ships as its own 16.2 MB archive, read by Forge's existing zip path |

`res/quest` (38 MB) **is** included, and only because leaving it out crashed
`VSubmenuQuestStart.getStartingWorldName` with an NPE while the home screen was
being built. That is the method by which this list was arrived at.

Result: **`res-boot.zip` = 50,279,251 bytes / 16,153 entries**, unpacking to
**71,226,313 bytes across 15,685 files and 468 directories**.

### The boot, end to end

```sh
export SPIKE_CACHE=$HOME/.cache/w15b-assets
export PORT=8742
./scripts/spike/cheerpj/assets/run.sh zip
./scripts/spike/cheerpj/assets/run.sh bootzip
./scripts/spike/cheerpj/assets/run.sh patch
./scripts/spike/cheerpj/assets/run.sh build-forge
./scripts/spike/cheerpj/assets/run.sh stage-forge
./scripts/spike/cheerpj/assets/run.sh build
BOOT_WIPE=1 BOOT_MARKER='Read cards:' ./scripts/spike/cheerpj/assets/run.sh boot-files
```

Forge is started with `user.dir=/files/`, `user.home=/files` (its profile
directories must be writable) and `forge.assetsDir=/files/`.

One run, `BOOT_MARKER=` so it runs on past the card load. Every stamp below is
from this single transcript — the timings in the cold/warm table further down
come from a different run and are not mixed in here:

```
5554ms  BOOT begin zip=/app/res-boot.zip dest=/files/ main=forge.view.Main
5648ms  BOOT zip open ms=25 entries=16153 archiveBytes=50279251
44149ms BOOT unpack done files=15685 dirs=468 bytes=71226313 ms=38470
44179ms BOOT unpack total ms=38616
44235ms BOOT verify /files/res isDir=true entries=25
44283ms BOOT verify /files/res/editions isDir=true entries=679
44289ms BOOT handing off to forge.view.Main
45367ms Error handling registered!
49218ms FSkin > can't find skins directory!
52801ms Language 'en-US' loaded successfully.
63123ms Read cards: 33785 archived files in 5 (25 parts) in same thread
82280ms Read cards: 848 files in 0 (8 parts) in same thread
```

The unpack in this particular run took 38.6 s; the wiped runs in the cold/warm
table took 29.8–31.1 s for the identical 15,685 files. That spread is real and
unexplained — same archive, same machine, same harness. Treat the unpack as
**30–39 s**, not as a single figure.

The second `Read cards:` is the token reader over `res/tokenscripts` as loose
files. `FSkin > can't find skins directory!` is cosmetic and always present:
`getSkinDirectoryNames()` returns an empty list on a null `list()` and nothing
NPEs — so the handoff's "stop `FSkin` listing `CACHE_SKINS_DIR`" turned out
**not** to be needed. `CACHE_SKINS_DIR` is under the writable profile dir, not
under `res/`.

Forge's `printf` says `ms` and passes `StopWatch.getTime(TimeUnit.SECONDS)`
(`CardStorageReader:297`). The card load is **5 seconds**, not 5 ms. That is an
upstream bug in the format string, not a measurement of ours.

`RAM: 2048 MB max, 1 CPUs` — CheerpJ reports one core, so
`ThreadUtil.isMultiCoreSystem()` is false and both card loads run "in same
thread". 33,785 cards parsed single-threaded in 5 s.

### It paints

`$SPIKE_CACHE/boot-files.png` is Forge's real `SplashFrame`: the anvil logo on
`res/skins/default/bg_splash.png`, the disclaimer text, the close button. The
skin is being read out of `/files/` and drawn by Swing in the browser.

That PNG is **not** committed and never will be — `.gitignore` refuses `*.png`
and that half of the rule is absolute. Every `boot-files` run rewrites it, so
the evidence is one command away rather than one file away.

### Cold vs warm — and `/files/` does persist

One browser, two page loads, the first with every IndexedDB database deleted
before `cheerpjInit`:

```sh
BOOT_WIPE=1 BOOT_TWICE=1 BOOT_MARKER='Read cards:' \
  ./scripts/spike/cheerpj/assets/run.sh boot-files
```

| | cold (`wipe=1`) | warm (2nd page, same browser) |
| --- | --- | --- |
| `cheerpjInit` done | 1297 ms | **43 ms** |
| `res` unpack | **29.8 s** | skipped (5 ms) |
| card database loaded | **50.7 s** | **10.8 s** |

The run reports `secondIsDistinct: true` — the two transcripts have different
`performance.now()` marks and different wall times, so the warm number is a
measurement and not an echo of the first. That check exists because the first
attempt at this used `page.reload()` and returned a second transcript
byte-identical to the first, stamps and all. That path has been deleted rather
than fixed; cold and warm are two separate page loads now.

**So the 30 s unpack is paid once per browser, not once per visit.** A
returning player is at a loaded card database in about eleven seconds.

Bytes over the wire on the cold run (`request.sizes()`, which is honest across
origins where Resource Timing is not):

| origin | bytes | requests |
| --- | --- | --- |
| the app origin (39.7 MB jar + 50.3 MB archive) | **60.5 MB** | 446 |
| `cjrtnc.leaningtech.com` (the CheerpJ runtime) | **21.4 MB** | 130 |

60.5 MB for 90 MB of jar-plus-archive: CheerpJ is Range-seeking both rather
than downloading them whole, which is the behaviour `serve.mjs` exists to
support.

## 5. The wall after the card data — and it is not a file

With `res/quest` shipped, Forge builds its home UI and dies here:

```
java.lang.ExceptionInInitializerError
Caused by: java.lang.NullPointerException
	at forge.util.IgnoringXStream.<init>
	at forge.gamemodes.quest.bazaar.QuestBazaarManager.load
	at forge.screens.bazaar.VBazaarUI.populateStalls
	at forge.view.FView.cacheUIStates
	at forge.view.FView.initialize
```

`spike.XStreamProbe` isolates it (`./run.sh probe-xstream`). There are **two**
causes and they stack:

**One — `java.vm.vendor` is null under CheerpJ.**

```
XS prop java.vm.vendor=null
XS prop java.vm.name=CheerpJ
XS prop java.vendor=Leaning Technologies Ltd
XS init com.thoughtworks.xstream.core.JVM FAILED
XS   [1] java.lang.NullPointerException: null
XS       at com.thoughtworks.xstream.core.JVM.isAndroid
XS       at com.thoughtworks.xstream.core.JVM.getMajorJavaVersion
XS       at com.thoughtworks.xstream.core.JVM.<clinit>
```

XStream calls `String.contains` on that property unguarded. CheerpJ sets
`java.vendor` but not `java.vm.vendor`. One system property fixes it.

**Two — and this one is structural.** With the property set
(`XS_VENDOR='...' ./run.sh probe-xstream`):

```
XS set java.vm.vendor=Leaning Technologies Ltd
XS init com.thoughtworks.xstream.core.JVM FAILED
XS   [0] java.lang.UnsatisfiedLinkError: Java_jdk_internal_misc_Unsafe_putChar
XS       at sun.misc.Unsafe.putChar
XS       at com.thoughtworks.xstream.converters.reflection.SunUnsafeReflectionProvider.write
XS       at com.thoughtworks.xstream.converters.reflection.SunUnsafeReflectionProvider.writeField
XS       at com.thoughtworks.xstream.core.JVM.<clinit>
```

`JVM.<clinit>` self-tests the unsafe reflection provider by writing a field.
CheerpJ ships no `Unsafe.putChar` native, and `UnsatisfiedLinkError` is an
**Error** — XStream's guard catches `Exception`, so it escapes, the `<clinit>`
fails, and the class is permanently poisoned for the life of the JVM. Every
provider then fails with `NoClassDefFoundError: Could not initialize class
com/thoughtworks/xstream/core/JVM`, including the pure-Java one that would have
worked.

Not the cause, checked so nobody re-checks it: `sun.misc.Unsafe` **exists**,
`theUnsafe` is obtainable by reflection, and `allocateInstance` works.
Setting `java.vm.vendor=The Android Project` does **not** route around it —
`JVM.<clinit>` runs the unsafe self-test regardless of vendor.

## What was NOT verified

The list is long on purpose. Three of Wave 14's four lanes produced their value
here and one of those lines is why this wave exists.

- **Forge's match UI has still never rendered.** Only `SplashFrame` paints.
  This lane produced no click-to-pixel number and did not try to; the boot dies
  in the home screen's bazaar panel, which is several screens before a match.
- **Whether a CheerpJ `natives` binding for `Java_jdk_internal_misc_Unsafe_putChar`
  fixes XStream.** Wave 14 proved user-class natives bind; whether CheerpJ will
  bind a native for a **JDK-internal** class is untested and is the single
  cheapest next probe in this area. `init.natives = { Java_jdk_internal_misc_Unsafe_putChar(lib, obj, off, ch) {...} }`
  in the harness page, then `./run.sh probe-xstream`.
- **Whether a match-only client touches XStream at all.** The failure is in
  `FView.cacheUIStates` → the quest bazaar, which our product would never show.
  A client that goes straight to a match may never construct one. Nobody has
  tried, and "delete the screens we do not use" is a different patch from
  anything in this lane.
- **Whether the excluded `res/` directories are needed.** `adventure`, `music`,
  the other skins and the other languages are excluded because no match path
  *appeared* to read them. That reasoning already failed once — `res/quest` was
  excluded on the same grounds and crashed the home screen. Treat the exclusion
  list as unproven until something runs a whole match.
- **`/files/` persistence beyond one browser session.** Measured across two page
  loads in one profile. Not measured across a browser restart, and **the
  IndexedDB quota for 71 MB was never checked** — no eviction, quota-exceeded or
  private-window behaviour was exercised. A quota refusal would turn the 30 s
  unpack into a per-visit cost and change §4's numbers completely.
- **The unpack was never measured on real hardware or a real network.** Every
  number here is headless Chromium against `127.0.0.1`. A player's disk and a
  player's latency are both absent.
- **`res-boot.zip`'s transfer was not isolated.** The 60.5 MB origin figure
  covers the jar and the archive together; how much of the 50.3 MB archive
  CheerpJ actually fetches was not measured separately.
- **Patches 0002 and 0003 are "not needed" only for the path to
  `Read cards:`.** A later code path may still walk a directory that does not
  exist under some other configuration; nothing past the card load was run
  without them.
- **The token reader was only exercised over loose files** (848 of them). Its
  zip path under CheerpJ was not tested, and `tokenscripts.zip` (219,594 bytes)
  is built by `run.sh stage-forge` but only used by the `/app/`-direct route.
- **`FSkin.loadFull` never ran.** The splash uses `loadLight`. Whether the full
  skin — sprites, fonts, the rest of the 18 MB — loads under CheerpJ is
  unknown, and it is on the path to any match UI.
- **Nothing here was run in a headed browser**, so nothing was seen by a human
  except the screenshot at `$SPIKE_CACHE/boot-files.png`.

## Files

```
scripts/spike/cheerpj/assets/
  run.sh                        this lane's driver (SPIKE_CACHE, PORT are its own)
  index.html                    this lane's harness page (?main= ?jar= ?args= ?props= ?wipe=)
  drive.mjs                     headless Chromium driver, JSON transcript
  java/spike/ZipProbe.java      the gate
  java/spike/Bootstrap.java     unpack /app/<zip> -> /files/, then hand off to Forge
  java/spike/XStreamProbe.java  the wall after the card data, isolated
  patches/*.patch               applied to a COPY; forge/ is never touched
  patches/MANIFEST              which source file each patch is regenerated from
```

The shared harness (`scripts/spike/cheerpj/{run.sh,index.html,serve.mjs,measure.mjs}`)
is not this lane's and was not edited. `serve.mjs` is executed as-is — it is the
Range-honouring server CheerpJ refuses to start without.

Nothing under `assets/` is a binary. Everything staged — archives, the patched
jar, the `res` copies — lives in `$SPIKE_CACHE` (`~/.cache/w15b-assets`),
outside the repo, and no image byte ever enters it.
