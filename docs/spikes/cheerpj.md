# CheerpJ go/no-go: can Forge's own desktop client run in a browser?

**Verdict: GO-WITH-COST — and the cost is a forked client, not a research risk.**

Two things are settled by measurement, and they point opposite ways.

**The brief's premise is false.** §B opens with *"If it works, it targets
`forge-gui-desktop` essentially unmodified."* It does not. The stock
`forge-gui-desktop` fat jar boots under CheerpJ and reaches
`forge.view.SplashFrame`, then dies — and the two things that kill it are
**networking** and **the filesystem**, both of which need fork changes:

- **Forge's client cannot open a socket under CheerpJ.** Not "it is slow", not
  "it needs a proxy": `new NioEventLoopGroup()` throws
  `java.lang.UnsatisfiedLinkError: Java_sun_nio_ch_EPoll_create`. CheerpJ's
  runtime ships no `sun.nio.ch` natives, so Netty's NIO transport cannot be
  constructed at all. The blocking OIO transport does not save it either.
- **`/app/` has no directories.** Files open by exact absolute path; `new
  File("/app").list()` returns **0 entries** and every intermediate directory
  reports `exists=false`. Forge finds its assets by walking directories, so
  `FSkin.java:1491` and `CardStorageReader.java:93` both fail.

**But everything that killed D7 passes here, and the two blockers land exactly
on the seam this repo already planned to cut.** Swing renders at a usable rate,
Netty's codec/buffer/pipeline layers all link, `FGameClient` constructs, and the
transport we would have to replace is the same three-method `IToServer` /
`IToClient` seam `docs/ARCHITECTURE.md` was already going to replace for P3. The
work CheerpJ forces on us is work the roadmap already contained.

| The brief asked | Result |
| --- | --- |
| (1) **Licence** — does it fit "no money, ever"? | **FITS**, on two independent grounds. Cost: an attribution credit, and the runtime must be loaded from Leaning Technologies' CDN. |
| (2) **Networking** — can Forge's client reach a server? | **NOT as shipped.** `UnsatisfiedLinkError: Java_sun_nio_ch_EPoll_create`. The documented escape hatch is a **Tailscale/WireGuard VPN**, which our Node bridge cannot terminate. Same-origin HTTP works. |
| (3) **Rendering** — usable frame rate? | **Yes, measured.** 78–322 fps (median 123) on an 800×600 Swing component; click → Java listener 9.4–32.0 ms (median 22.4). |
| (4) Does Forge's *own* desktop code run at all? | **Yes, as far as its assets let it** — `GuiDesktop`, `ExceptionHandler`, `GuiBase`, `FSkin`, `SplashFrame`, `FView`, `Singletons.initializeOnce` all execute. |
| (5) Cold start | **1.70–1.85 s** to `cheerpjInit`; **12.1–21.2 MB** of CheerpJ runtime; Forge's `main()` entered at **~10.2 s**, splash attempt at **~15.2 s**. |

Everything below is reproducible from `scripts/spike/cheerpj/`. Nothing under
`forge/` was modified or built in; the proof is at the bottom.

---

## Reproducing it

```sh
scripts/spike/cheerpj/run.sh build                  # compile the probes, stage the site
scripts/spike/cheerpj/run.sh measure net            # the networking verdict
scripts/spike/cheerpj/run.sh measure swing          # the rendering numbers

# The fs and forgejar transcripts below both quote a real skin file, so they need
# res/skins staged. Run them AFTER this build, not the plain one above.
SPIKE_WITH_SKINS=1 scripts/spike/cheerpj/run.sh build
scripts/spike/cheerpj/run.sh measure fs             # the /app/ filesystem verdict
scripts/spike/cheerpj/run.sh measure forgejar       # Forge's own Main

scripts/spike/cheerpj/run.sh serve                  # eyeball it in a real browser
```

`measure forgejar` exits **1** and that is the expected result, not a harness
fault: Forge's startup thread dies and `main()` never returns, so the page never
reaches a terminal state and the 120 s budget expires. The transcript is the
finding. Every other `measure` exits **0**.

`measure` starts its own server, drives headless Chromium at the page, and
prints one JSON blob with every number quoted here. It resolves `playwright-core`
read-only out of the repo's existing pnpm store — it installs nothing and runs no
`pnpm` command.

Three things about the harness are load-bearing and each cost a run to find:

1. **`cheerpjInit({version: 17})` is mandatory.** CheerpJ defaults to Java 8 mode
   and refuses anything above class-file major 52 with *"Required Java version 17,
   but CheerpJ is currently in Java 8 mode."* Forge is built at `--release 17`
   (`forge/pom.xml:27`).
2. **The web server must honour `Range`.** `python3 -m http.server` does not, and
   CheerpJ then refuses to start: *"HTTP server does not support the 'Range'
   header. CheerpJ cannot run."* `scripts/spike/cheerpj/serve.mjs` exists only for
   that. This is not incidental — see "what Range buys" below.
3. **Every Java `System.out` line arrives as a `console.log`**, so the harness
   hooks `console` *before* `loader.js` and stamps each line with
   `performance.now()`. Every latency here is therefore measured in one clock,
   with no JVM↔JS correlation to get wrong.

---

## Step 1 — the licence, settled before any engineering

**Read 2026-09-19 from <https://cheerpj.com/docs/licensing>.** Verbatim:

> CheerpJ Core is distributed for free with the CheerpJ Community License, which
> makes it free to use for personal projects, FOSS projects, and for technical
> evaluations.
>
> Commercial Licenses are available for any use that falls outside of the scope
> of the Community License, including any business use (with exception of
> one-person companies), redistribution and OEM use.

The Community License's own scope list, verbatim from the same page:

> You can use CheerpJ for free if you fall into any of the following categories:
>
> - Individuals, including one-person companies. For example:
>   - Any personal projects, whether they generate income or not
>   - Public-facing applications (such as games, educational applications, etc.)
>   - Commercial applications developed by one-person companies
> - Free and Open-Source Software (FOSS) projects
> - Technical evaluations

And its action-point table, verbatim:

| Use case | Action point |
| --- | --- |
| You are an individual using CheerpJ for a personal project (including one generating revenue) | Give appropriate credits |
| You are a team using CheerpJ in a FOSS project | Give appropriate credits |

**Verdict: FITS, on two independent grounds.** cardtable is a personal project by
an individual *and* a FOSS project (`LICENSE` is GPL-3.0, `docs/LICENSING.md` §1).
Either row alone qualifies. The action point in both is the same and is not
money: **"Give appropriate credits."**

"No money, ever" (`docs/LICENSING.md` §2, rule 1) is not merely compatible with
this licence — it is *the* thing the licence cares about, and the only line we
would have to hold is one we hold already and would never cross.

### Three terms that constrain the engineering, quoted

**Self-hosting the runtime is a paid feature.** Verbatim:

> The CheerpJ Community License allows unlimited, unmetered use of CheerpJ from
> the cjrtnc.leaningtech.com domain, such as its usage via npm package manager.
> For self-hosted options, see the CheerpJ Commercial License.

and

> Self hosting involves hosting the CheerpJ runtime environment within the
> company servers. If you wish to self-host CheerpJ, you will need a Commercial
> License.

So a browser-side Forge client would load **12–21 MB from a third-party CDN we do
not control**, on every cold cache, forever. That is a hard operational
dependency and it cannot be bought out of without money — which we will not
spend. Measured below; it is not hypothetical.

**The runtime announces itself.** The CheerpJ 4.3 runtime prints this to the
browser console on every boot, verbatim from a run of `run.sh measure net`:

```
 CHEERPJ COMMUNITY EDITION - FOR PERSONAL AND NON-BUSINESS USE ONLY
Any other use requires a license: https://cheerpj.com/docs/licensing
```

That satisfies nothing by itself — "Give appropriate credits" is still on us —
but it means the Community Edition is self-declaring in anything we ship.

**Technical evaluation is not the category we are in.** Verbatim:

> If an application is not seen by internal or external users, it is considered a
> technical evaluation.

This spike is one. A cardtable that friends play on is not, so the standing
qualification has to be the personal-project / FOSS rows above — which it is.
Nothing here depends on the evaluation carve-out.

### GPL-3 × a proprietary runtime — this is fine, and here is the argument

CheerpJ Core is proprietary. Forge, and therefore this whole repo, is
**GPL-3.0-or-later**. Two questions, neither of which blocks:

**Does running GPL-3 bytecode on a proprietary runtime taint anything?** No.
GPL-3 §1, from this repo's own `LICENSE:123-133`, defines a Major Component as

> a major essential component (kernel, window system, and so on) of the specific
> operating system (if any) on which the executable work runs, or a compiler used
> to produce the work, **or an object code interpreter used to run it.**

CheerpJ is an object code interpreter used to run Forge's bytecode. It is in the
same position as any proprietary JVM, and §1's Corresponding Source definition
(`LICENSE:134-145`) explicitly excludes System Libraries. Not legal advice; the
clause is quoted so the argument can be checked rather than believed.

**Would we be conveying Forge?** **Yes, and this is new.** `docs/LICENSING.md` §1
turns on the distinction that *"GPL-3 obligations attach when you convey the
software — hand someone a binary"*, and concludes that running Forge on hokon and
letting friends connect is not conveying. **Serving `forge.jar` to a browser is.**
Every player's browser downloads Forge bytecode from our origin. That is exactly
the P2 trigger `docs/LICENSING.md` already identified, arriving via a route it did
not anticipate.

The consequence is mild and the doc already prescribes it: publish this repo, or
keep the fork on a branch that can be published as-is. It is a **decision to make
rather than an accident to have** — which is the wording `docs/LICENSING.md` uses
about P2, and it applies here unchanged. Flagging it because no lane owns
`docs/LICENSING.md` this wave and this belongs in it.

---

## Step 2 — networking, which is the hard question and the one that bites

### What Forge's client actually needs

`forge/forge-gui/src/main/java/forge/gamemodes/net/client/FGameClient.java:62-66`:

```java
final EventLoopGroup group = new NioEventLoopGroup();
final Bootstrap b = new Bootstrap()
 .group(group)
 .channel(NioSocketChannel.class)
```

Netty **4.1.115.Final** (`forge/forge-gui/pom.xml:50-53`), NIO transport. NIO
means `java.nio.channels.Selector`, which on Linux means `sun.nio.ch.EPoll`.

### What CheerpJ gives it — measured, not read

`scripts/spike/cheerpj/run.sh measure net`, exit **0**. The probe runs
`forge.jar` on its classpath so these are Forge's own Netty classes:

```
STEP 1  java.nio.channels.Selector.open           FAIL  UnsatisfiedLinkError: Java_sun_nio_ch_EPoll_eventSize
    at sun.nio.ch.EPoll.<clinit>
    at sun.nio.ch.EPollSelectorImpl.<init>
    at sun.nio.ch.EPollSelectorProvider.openSelector
    at java.nio.channels.Selector.open
STEP 2  java.nio.channels.SocketChannel.open      FAIL  UnsatisfiedLinkError: Java_sun_nio_ch_Net_initIDs
    at sun.nio.ch.Net.<clinit>
STEP 3  new java.net.Socket()                      OK   java.net.Socket
STEP 4  InetAddress.getByName("127.0.0.1")         OK   /127.0.0.1
STEP 5  io.netty.util.internal.PlatformDependent   OK   hasUnsafe=true javaVersion=17 directBufferPreferred=true
STEP 6  new NioEventLoopGroup()                    FAIL  UnsatisfiedLinkError: Java_sun_nio_ch_EPoll_create
    at sun.nio.ch.EPollSelectorImpl.<init>
    at io.netty.channel.nio.NioEventLoop.openSelector
    at io.netty.channel.nio.NioEventLoop.<init>
    at io.netty.channel.nio.NioEventLoopGroup.newChild
STEP 7  new NioSocketChannel()                     FAIL  NoClassDefFoundError: Could not initialize class sun/nio/ch/Net
STEP 8  ByteBufAllocator.DEFAULT.buffer(1024)      OK   PooledUnsafeDirectByteBuf direct=true
STEP 9  new FGameClient(...)                       OK   forge.gamemodes.net.client.FGameClient
STEP 10 new OioEventLoopGroup()                    OK   io.netty.channel.oio.OioEventLoopGroup
STEP 11 new OioSocketChannel()                     FAIL  NoClassDefFoundError: Could not initialize class sun/nio/ch/Net
STEP 12 URL.openStream() same-origin               OK   read 4 bytes, magic=504b0304
STEP 13 new Socket().connect("127.0.0.1", <port>)  FAIL  NoClassDefFoundError: Could not initialize class sun/nio/ch/Net
```

Read that list carefully, because it is much better news than "sockets don't
work":

- **Steps 5, 8, 9 pass.** Netty's `PlatformDependent` initialises with
  `hasUnsafe=true` at `javaVersion=17`; the **pooled direct buffer allocator
  works**; `FGameClient` itself constructs. Netty's codec, buffer and pipeline
  layers — which is where `CompatibleObjectEncoder`/`Decoder`, `IdleStateHandler`
  and all of Forge's handlers live — are fine under CheerpJ. **Only the transport
  is missing.**
- **Step 11 kills the obvious workaround.** Netty 4.1 still ships the blocking OIO
  transport and `forge.jar` carries it
  (`io/netty/channel/socket/oio/OioSocketChannel.class`). The event loop group
  constructs (step 10), but the channel does not: since Java 13 `java.net.Socket`
  is backed by `NioSocketImpl`, which needs the same `sun.nio.ch.Net`. Swapping
  NIO→OIO does not route around this.
- **Step 3 vs step 13 is the important pair.** `new Socket()` constructs; the
  moment it `connect`s it hits `sun.nio.ch.Net`. So an unconnected socket object
  is not evidence of anything.
- **Step 12 is the one thing that works.** `URL.openStream()` to the page's own
  origin returned the real bytes — `504b0304`, the ZIP local-file-header magic of
  `probe.jar`. Same-origin HTTP from inside Java is genuinely functional.

Netty also warns, in the same transcript:

```
[WARN] NetUtilInitializations: Failed to retrieve the list of available network interfaces:
       java.net.SocketException: Operation not permitted (Socket creation failed)
[WARN] NetUtilInitializations: Failed to find the loopback interface
[WARN] MacAddressUtil: Failed to find a usable hardware address...; using random bytes
```

Non-fatal, but it confirms the shape: there is no network stack down there, only
`fetch`.

### The documented escape hatch, and why our bridge cannot terminate it

<https://cheerpj.com/docs/guides/Networking>, read 2026-09-19, is unambiguous
about what "CheerpJ supports sockets" means. Verbatim:

> CheerpJ supports different networking scenarios that are divided into two
> categories:
>
> - Same-origin HTTP/HTTPS requests using fetch seamlessly.
> - Generalized networking via Tailscale (anything else that is not HTTP(S) such
>   as opening TCP/UDP sockets).

and

> CheerpJ supports wider networking scenarios via Tailscale, which is a VPN
> technology using WebSockets and a transport layer. […] Tailscale is based on the
> WireGuard protocol.

and, on whose problem the proxy is:

> To support networking beyond same origin requests, it is necessary to host a
> proxy server. CheerpJ cannot become responsible for the user's traffic as every
> application is different and its networking traffic should be managed internally
> and according to their needs.

**This is the answer to "what shape of proxy", and it is not a shape we can
build.** The tunnel's wire format is not a framed socket protocol we could
terminate in Node — it is **WireGuard packets inside a WebSocket**, with a
Tailscale control plane doing key distribution and node authentication. There is
no `cheerpjInit` option for a plain WebSocket socket proxy: the entire networking
surface of `cheerpjInit` is five options
(<https://cheerpj.com/docs/reference/cheerpjInit>, read 2026-09-19) —
`tailscaleControlUrl`, `tailscaleDnsIp`, `tailscaleAuthKey`,
`tailscaleLoginUrlCb`, `tailscaleIpCb` — and nothing else.

To make Forge's Netty client dial hokon through CheerpJ we would have to run:

1. a **Tailscale control plane**, or self-hosted **Headscale** (the docs name it:
   *"Headscale is an open-source and self-hosted implementation of the Tailscale
   control server"*),
2. a **WebSocket-capable Tailscale relay** the browser can reach,
3. a **tailnet node on hokon** beside the Forge JVM, and
4. **per-player auth keys** minted and handed to browsers.

Our bridge is `@wolffm/rooms-server` — a Node WebSocket server speaking
Zod-validated JSON (`docs/ARCHITECTURE.md`, `packages/shared/src/protocol.ts`). It
cannot terminate WireGuard, and making it do so is not a bridge change, it is a
new piece of infrastructure with its own identity system sitting *beside* the
friend gate we are required to keep. **Answer to §B's question: no, our bridge
cannot terminate CheerpJ's socket tunnel, and it should not try.**

**A dead control plane does not degrade — it hangs.** Passing
`tailscaleControlUrl` pointing at a non-existent endpoint made `cheerpjInit`
never resolve: the run timed out at **120,206 ms** with **zero** Java output. The
Java application never starts. Reproduce with
`.../index.html?probe=net&tailscale=1`. Operationally that means a Tailscale-based
design has a hard startup dependency on a control plane being up, with no
fallback path.

### Why this is a cost and not a blocker

**We do not need a socket.** `docs/ARCHITECTURE.md` already says the transport has
to go and names the seam:

> `IToClient` is `interface IToClient extends IRemote {}` — empty — and `IRemote`
> is three methods (`send`, `sendAndWait`, `write`). Putting a browser behind Forge
> is one class implementing three methods.

In the whole of `forge-gui`, `forge-gui-desktop` and `forge-gui-mobile`, only two
files name `NioEventLoopGroup`/`NioSocketChannel`: `FGameClient` and
`FServerManager` (the server side, which stays on hokon). On the client path
`FGameClient` is the only one (`FGameClient.java:62` and `:66`), and it is itself an implementation
of `IToServer`. A CheerpJ build would replace that one class with an `IToServer`
backed by a browser `WebSocket`, reached through CheerpJ's Java↔JS interop, and
speak our JSON protocol — **the P3 bridge, which is already the plan**. Netty's
codec layer linking (step 5/8) means we could even keep Forge's framing if we
wanted; we do not.

So the networking answer is: **Forge's client can reach our server from inside
CheerpJ, through our bridge, with the transport class replaced — and cannot reach
it any other way.** The cost lands on the fork, not on the infrastructure.

**Unverified, and named so:** CheerpJ's `natives` option for implementing Java
native methods in JavaScript is present in `cheerpjInit`'s published type
signature (`natives?: { [method: string]: Function }`,
<https://cheerpj.com/docs/reference/cheerpjInit>) and the FAQ states *"Java native
methods implemented in JavaScript are supported."* **This spike did not exercise
it.** The step that would settle it is a probe class with a `native` method bound
through `cheerpjInit({natives: {...}})` that pushes bytes onto a JS `WebSocket`
and gets them back — roughly 60 lines on top of `scripts/spike/cheerpj/`, and it is
the first thing the next wave should run, because the whole GO rests on it.

---

## Step 3 — rendering, measured five times

`scripts/spike/cheerpj/run.sh measure swing`, exit **0**, five consecutive runs.
`spike.SwingProbe` paints an 800×600 `JComponent` — 40 `drawLine`s plus text per
frame, via `paintImmediately` so the count is frames actually rasterised rather
than `repaint()` calls Swing coalesced away.

| run | `cheerpjInit` | Swing `main()` | frame visible | first paint | fps | click→listener | click→repaint done |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1740 ms | 6278 ms | 9470 ms | 11574 ms | **322** | 9.4 ms | 14.2 ms |
| 2 | 1850 ms | 7266 ms | 11309 ms | 14264 ms | **78** | 32.0 ms | 37.7 ms |
| 3 | 1854 ms | 7034 ms | 10988 ms | 13660 ms | **123** | 27.8 ms | 32.8 ms |
| 4 | 1700 ms | 7156 ms | 11195 ms | 13897 ms | **114** | 22.4 ms | 28.9 ms |
| 5 | 1754 ms | 7185 ms | 11223 ms | 13885 ms | **123** | 13.7 ms | 18.5 ms |

All times are from page start, in the browser's clock.
**Median: 123 fps, click→listener 22.4 ms, click→repaint-complete 28.9 ms.**

**Read the spread honestly.** These were taken while three other wave-14 lanes
were running on this host; `/proc/loadavg` read **32.81** immediately after run 5.
Per-run load was not recorded, so the 78→322 fps spread is *attributed* to
contention rather than measured as such — what is certain is that none of it was
measured on a quiet machine, and none of it was re-run on one. Treat the median
as a conservative figure.

**What this does and does not prove.** It proves CheerpJ's Swing is not a
slideshow: a 30 ms click-to-repaint round trip is well inside what a card game
needs, and 123 fps on a non-trivial repaint is a floor, not a ceiling, because
headless Chromium was also under load. It does **not** predict Forge's frame
rate. `forge-gui-desktop` is a vastly heavier Swing tree than one `JComponent`,
and nothing in this spike rendered any of it.

### Cold start and what the browser downloads

Measured with Playwright's `request.sizes()` rather than the Resource Timing API,
because `transferSize` reports 0 cross-origin without `Timing-Allow-Origin` — the
first pass at this reported a flat 0 for the CheerpJ CDN and would have been a
fabricated number.

| run | from `cjrtnc.leaningtech.com` | from our origin | note |
| --- | --- | --- | --- |
| `measure net` | **12,107,929 B** / 74 req | 5,135,826 B / 35 req | |
| `measure swing` | **19,192,219 B** / 117 req | 2,105,983 B / 15 req | Swing pulls more JDK |
| `measure forgejar` | **21,164,267 B** / 129 req | 8,641,636 B / 54 req | Forge desktop, to the splash |

Two things follow.

**12–21 MB of third-party runtime on every cold cache**, and by licence it must
come from their CDN (self-hosting is a Commercial License feature — quoted above).
CheerpJ's own docs put this at *"typically 10–20MB for many apps"*
(<https://cheerpj.com/docs/guides/Startup-time-optimization>) and offer
`preloadResources` to parallelise it; preloading reorders the same bytes, it does
not shrink them.

**Range requests are why a 39 MB jar is survivable.** `forge.jar` is
39,686,151 B on disk, and CheerpJ pulled **8.6 MB** of it to reach the splash —
it seeks to the central directory and fetches only the classes it loads.
`SPIKE_LOG_REQUESTS=1 PORT=8731 scripts/spike/cheerpj/run.sh measure net` prints
the request transcript to stderr and shows exactly that: `bytes=0-0`, then
`bytes=39583744-39686150` (the ZIP central directory), then 128–256 KB windows
scattered through the archive. This is also why note 2 in "Reproducing it" is
load-bearing rather than incidental.

---

## Step 4 — Forge's own desktop jar, and the finding nobody had costed

`SPIKE_WITH_SKINS=1 run.sh build && run.sh measure forgejar` runs
`cheerpjRunJar('/app/forge.jar')`, i.e. `forge.view.Main` with no arguments,
straight off the shipped `~/.local/share/cardtable/forge.jar`. The `measure` exit
code is **1** — the page never reaches a terminal state because Forge's startup
thread dies and `main()` never returns. The transcript is the result:

```
10153ms  Error handling registered!
11522ms  [INFO ] GuiBase: ##########################################
11527ms  [INFO ] GuiBase: APP: Forge v.2.0.15-SNAPSHOT-09.18
11531ms  [INFO ] GuiBase: Java: 17.0.19-internal (Leaning Technologies Ltd)
11535ms  [INFO ] GuiBase: OS: Linux 1.0 cheerpj
11539ms  [INFO ] GuiBase: RAM: 2048 MB max, 1 CPUs
15205ms  FSkin > can't find skins directory!
15216ms  java.lang.ExceptionInInitializerError
15218ms  Caused by: java.lang.RuntimeException: Cannot find default skin at /app//res/skins/default/bg_splash.png
             at forge.toolbox.FSkin.loadLight
             at forge.view.SplashFrame.<init>
             at forge.view.FView.<init>
             at forge.view.FView.<clinit>
             at forge.Singletons.initializeOnce
             at forge.view.Main.main
```

**Everything up to that point ran.** `GuiBase.setInterface(new GuiDesktop())`,
`ExceptionHandler.registerErrorHandling()`, `GuiBase.logHWInfo()`,
`Singletons.initializeOnce`, `FView`, `SplashFrame`, `FSkin` — Forge's real
desktop classes, loading and executing under CheerpJ. It failed on **data**, not
on a missing capability.

And `res/skins/default/bg_splash.png` **was** being served, HTTP 200, 154,022
bytes. Which is the actual finding.

### `/app/` is a file mount with no directories

`run.sh measure fs`, exit **0**, with `res/skins` staged and
`javaProperties: ['user.dir=/app/']`:

```
user.dir=/app/
FS /app/res/skins/default/bg_splash.png  exists=true   isFile=true  len=154022  canRead=true
FS res/skins/default/bg_splash.png       exists=false  isFile=false len=0       canRead=false
FS /app/res/skins/default                exists=false  isDir=false
FS /app/res/skins                        exists=false  isDir=false
FS /app/probe.jar                        exists=true   isFile=true  len=9778    canRead=true
FS /app                                  exists=true   isDir=true   entries=0
```

Three separate facts, each with a consequence:

1. **Files open by exact absolute path.** `/app/` is a real, usable read-only
   filesystem for `java.io.File`. Good news, and the basis of any fix.
2. **Relative paths do not resolve against `user.dir`.** CheerpJ accepted
   `user.dir=/app/` (Forge's error message changed from `/files//res/…` to
   `/app//res/…`, proving it was read), but `new File("res/…")` still reports
   `exists=false`. So setting `user.dir` is **not** enough.
3. **Directories do not exist and cannot be listed.** `/app` itself is `isDir=true`
   with **`entries=0`**, and every path below it that is a directory reports
   `exists=false`. An HTTP origin has no directory listing, so CheerpJ cannot
   synthesise one.

Fact 3 is the expensive one, because **Forge finds everything by walking
directories**:

| Forge site | What it does | What happens under CheerpJ |
| --- | --- | --- |
| `forge-gui-desktop/.../FSkin.java:1491` | `new File(CACHE_SKINS_DIR).list()` | returns `null` → `"FSkin > can't find skins directory!"` at `:1493` |
| `forge-gui-desktop/.../FSkin.java:1190-1191` | `new File(preferredDir + SPLASH_BG_FILE).exists()`, `preferredDir` = `DEFAULT_SKINS_DIR` | `false` (relative path) → throws at `:1193` |
| `forge-core/.../CardStorageReader.java:93-95` | `if (!cardsfolder.isDirectory()) throw` | throws `"CardReader : constructor error -- not a directory"` **before** it ever reaches the `cardsfolder.zip` branch at `:97-101` |

The relative-path half is cheap: `GuiDesktop.getAssetsDir()`
(`forge-gui-desktop/src/main/java/forge/GuiDesktop.java:89-92`) already returns
either `""` or `"../forge-gui/"` behind a version-string test, and
`ForgeConstants.java:41` builds `RES_DIR` from it. Returning `"/app/"` for a
browser build is a one-line fork change to a method that is already a
`// FIXME: replace this hardcoded value!!`.

The directory half is not cheap, and it is the largest single item in the cost.
`CardStorageReader:93` is the wall: 132 MB of `res/cardsfolder` reached by
directory walk. Forge *does* have a zip path (`CardStorageReader:97-101`, reading
`cardsfolder/cardsfolder.zip`), and CheerpJ's Range-backed `/app/` is exactly the
substrate a `ZipFile` wants — but the `isDirectory()` guard at `:93` throws first,
and no `cardsfolder.zip` is present in `forge/forge-gui/res/` today. So the route
exists and is short, but it is a fork change plus a packaging step, not a
configuration.

**Not verified:** whether `new ZipFile("/app/cardsfolder.zip")` actually works
under CheerpJ. This spike never got past `:93` to try it. The step that would
settle it: build the zip, serve it, and run a probe that does
`new java.util.zip.ZipFile(new File("/app/cardsfolder.zip")).size()`. It is
roughly 20 lines in `scripts/spike/cheerpj/java/spike/` and it decides whether
card data in a browser costs a repack or a rewrite.

**Also note `RAM: 2048 MB max, 1 CPUs`.** CheerpJ caps the heap at 2 GB and reports
one CPU. Forge desktop's own launcher asks for `-Xmx4096m`
(`forge/forge-gui-desktop/pom.xml:20`). Whether 95,746 printings fit in 2 GB is
untested and is a real risk for a full client; it is not a risk for a *net-play*
client if the card DB stays server-side, which is the whole point of
`RemoteClientGuiGame`.

---

## Against D7, since that is the comparison this wave wants

`docs/spikes/teavm-go-no-go.md` found 30 missing APIs, dominated by
`java.util.concurrent`, and **no artifact at all** — TeaVM writes nothing on link
errors, so there was no cold-start number and no way to see the second failure
until the first was fixed.

CheerpJ has the opposite failure profile, and it is a much better one to be in:

| | TeaVM 0.15.0 (D7) | CheerpJ 4.3 (this) |
| --- | --- | --- |
| Artifact on failure | none — nothing to run | runs; fails at runtime with a stack trace |
| `java.util.concurrent.locks` | **0 classes shipped** — the killer | fine; Netty's executors construct |
| Guava `EventBus` | killed the build | untouched — full OpenJDK underneath |
| Reflection / dynamic classes | needed a 40-line policy file | works unmodified |
| Java version | classlib gaps everywhere | **Java 8, 11 and 17**; reports `17.0.19-internal` |
| What it takes to see failure N+1 | fix failure N and recompile | it already printed N, N+1 and N+2 |
| Failures found | 30 missing APIs, floor not estimate | **2 structural** (no `sun.nio.ch`, no `/app/` directories) |

TeaVM fails by *absence* — you cannot see what is next. CheerpJ fails by
*exception* — every probe above found its answer in one run, because the program
actually executes. That difference is why this spike could measure a frame rate
and D7 could not measure a cold start.

---

## What a GO costs

1. **Replace `FGameClient`'s transport.** One class implementing `IToServer`'s
   three methods over a browser `WebSocket` via CheerpJ's `natives` interop,
   speaking our JSON protocol to `@wolffm/rooms-server`. This is the P3 bridge
   with a different client end, not new architecture. **Gated on the `natives`
   probe named above.**
2. **Point Forge's assets at `/app/`.** `GuiDesktop.getAssetsDir()` returns
   `"/app/"` for a browser build. One line.
3. **Deliver `res/` without directory walks.** Package `cardsfolder.zip`, relax
   the `isDirectory()` guard at `CardStorageReader:93`, and teach `FSkin` to stop
   listing `CACHE_SKINS_DIR`. **Gated on the `ZipFile` probe named above.**
4. **Accept a permanent third-party CDN dependency** of 12–21 MB per cold cache,
   which the licence does not let us self-host and which we will not pay to
   change.
5. **Decide the conveying question** — publish the fork, per
   `docs/LICENSING.md` §1's own P2 rule, because serving `forge.jar` to browsers
   is conveying.
6. **Give appropriate credits**, as the Community License requires.

None of 1–3 is research. All three are fork changes to classes this repo was
already going to fork, with the failure point named to the line. That is the
difference between GO-WITH-COST and NO-GO, and it is why the verdict is the
former even though the brief's "essentially unmodified" premise did not survive.

---

## What was NOT verified

- **CheerpJ's `natives` JS-interop path.** Documented and present in
  `cheerpjInit`'s type signature; never exercised here. **The entire GO depends on
  it.** Settle it with a probe class carrying a `native` method bound via
  `cheerpjInit({natives: {...}})` that round-trips bytes through a JS `WebSocket`.
- **Whether a working Tailscale control plane makes `sun.nio.ch` appear.** The
  `?tailscale=1` run hung for 120,206 ms against a deliberately dead control plane
  and produced no Java output, so it settled nothing about sockets. Settle it by
  standing up Headscale, minting a pre-auth key, and re-running
  `.../index.html?probe=net&tailscale=1`. This matters less than it sounds: even a
  yes leaves our bridge unable to terminate WireGuard.
- **`new ZipFile("/app/cardsfolder.zip")` under CheerpJ.** Never reached; blocked
  by `CardStorageReader:93`. Command in the filesystem section above.
- **Forge's actual UI at any frame rate.** Nothing past `SplashFrame` ever
  rendered. The 123 fps median is `spike.SwingProbe`, one `JComponent`, and is an
  upper bound on Forge, never a prediction of it.
- **Whether 95,746 printings fit in CheerpJ's 2 GB heap.** Untested.
- **Anything on a quiet host.** `/proc/loadavg` was 32.81 throughout; three other
  wave-14 lanes were running. Re-run `measure swing` on an idle hokon for figures
  worth quoting to anyone else.
- **Any browser other than the Playwright Chromium in this repo's pnpm store**
  (`playwright-core@1.62.1`), headless.

## `forge/` is unmodified

```
$ git submodule status forge
-2ad70eb447a22efe5b80904c07188311da034a42 forge
$ git -C /home/hadoku/repos/hadoku-cardtable status --porcelain forge
$ echo $?
0
```

The leading `-` is correct: the submodule is deliberately uninitialised in this
worktree (trap 2). Every Forge source quoted here was **read** from
`/home/hadoku/repos/hadoku-cardtable/forge/`; nothing was written and nothing was
built there. The spike's own build output lives in `~/.cache/w14b-cheerpj/`, and
`SPIKE_WITH_SKINS=1` copies `res/skins` out of the vendored clone read-only.

## Toolchain, for the record

| | |
| --- | --- |
| CheerpJ | 4.3, `https://cjrtnc.leaningtech.com/4.3/loader.js` |
| CheerpJ's reported JVM | `17.0.19-internal`, vendor `Leaning Technologies Ltd`, `os.name=Linux 1.0 cheerpj` |
| JDK (probe compilation) | Temurin 21.0.12.1+1, `~/.local/opt/jdk-21.0.12.1+1`, `--release 17` → class-file major **61** |
| Browser | Playwright `chromium`, `playwright-core@1.62.1` from the repo's pnpm store, headless |
| Forge jar | `~/.local/share/cardtable/forge.jar`, 39,686,151 B, `2.0.15-SNAPSHOT-09.18`, `Main-Class: forge.view.Main` |
| Netty in that jar | 4.1.115.Final (`META-INF/io.netty.versions.properties`) |
| Forge submodule | `2ad70eb447a22efe5b80904c07188311da034a42` |
