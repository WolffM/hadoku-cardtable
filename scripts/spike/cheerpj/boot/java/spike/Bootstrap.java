package spike;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.Method;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Wave 16, lane A -- a FORK of
 * {@code scripts/spike/cheerpj/assets/java/spike/Bootstrap.java} (wave 15,
 * lane B).
 *
 * <p>Why a fork rather than an edit: lane B's file is the artifact that wave 15
 * reported against, three other lanes are live in this worktree, and the whole
 * point of this lane is to compare a CHANGED unpacker against the ORIGINAL one
 * at the same failure rate. Editing the original in place would destroy the
 * control. The original is untouched; only the instrumentation and the
 * {@code spike.bootFix} branches below differ, and with
 * {@code -Dspike.bootFix=off} (the default) the write path is the original
 * one line for line.
 *
 * <p>What wave 15 left open, and what this fork exists to answer: four of eight
 * cold boots never reached Forge's {@code Read cards:} marker. The unpack simply
 * stopped -- no exception, no further console output -- twice at the identical
 * offset ({@code files=14500 bytes=52097292}) and once at a different one. A
 * stall with no exception fits a quota refusal being swallowed, a dropped
 * promise inside CheerpJ's async {@code /files/} writes, or a backpressure
 * deadlock, and wave 15 could not tell them apart because nothing recorded
 * WHICH CALL the unpack was inside when it went quiet.
 *
 * <p>So: a watchdog daemon thread prints the current phase, entry and elapsed
 * in-call time every {@code spike.wdMs} milliseconds. When the transcript goes
 * silent, its last line names the call by phase. That is the instrument; the
 * quota half lives in the harness page ({@code boot/index.html}), which samples
 * {@code navigator.storage.estimate()} and hooks every IndexedDB transaction's
 * {@code abort}/{@code error}.
 *
 * argv: &lt;zip&gt; &lt;destRoot&gt; &lt;mainClass&gt; [args...]
 *   e.g. /app/res-boot.zip /files/ forge.view.Main
 *
 * System properties:
 *   spike.forceUnpack=true   redo the unpack even if the marker is present
 *   spike.wdMs=5000          watchdog tick; 0 disables the watchdog thread
 *   spike.verboseFrom=-1     print one line per entry from this entry index on
 *   spike.bootFix=off        off | preload | flush | preload,flush
 *   spike.batch=64           entries per yield, when bootFix contains flush
 *   spike.settleMs=1         sleep per yield, when bootFix contains flush
 */
public final class Bootstrap {

    /**
     * {@code spike.bootFix} selects what the unpack loop does differently. The
     * value is matched by {@code contains}, so {@code preload,flush} enables
     * both and the default {@code off} enables neither -- with neither enabled
     * this file's write path is lane B's original, line for line, which is what
     * makes "revert the fix" a flag flip rather than a rebuild.
     *
     * <p>{@code preload}: read the whole archive off {@code /app/} into the heap
     * before writing anything, and unpack from memory with a
     * {@code ZipInputStream}. The original's {@code ZipFile.getInputStream()}
     * pulls each entry's bytes over HTTP as it goes, so the original loop
     * alternates a network continuation and an IndexedDB continuation on the
     * same Java thread, thousands of times. This removes the network half.
     *
     * <p>{@code flush}: yield to the browser's event loop every
     * {@code spike.batch} entries, so an asynchronous backend gets a chance to
     * drain rather than being fed by a loop that never returns to the event
     * loop on its own.
     */
    static final String FIX_PRELOAD = "preload";
    static final String FIX_FLUSH = "flush";

    // --- watchdog state. volatile because the watchdog thread reads it. ------
    private static volatile String phase = "start";
    private static volatile String entry = "-";
    private static volatile int files = 0;
    private static volatile long bytes = 0;
    private static volatile long opStartNs = System.nanoTime();

    private static void at(String p) { phase = p; opStartNs = System.nanoTime(); }

    public static void main(String[] args) throws Exception {
        PrintStream out = System.out;
        if (args.length < 3) {
            out.println("BOOT usage: <zip> <destRoot> <mainClass> [args...]");
            return;
        }
        String zipPath = args[0];
        String destRoot = args[1];
        String mainClass = args[2];
        String[] rest = new String[Math.max(0, args.length - 3)];
        System.arraycopy(args, 3, rest, 0, rest.length);

        String fix = System.getProperty("spike.bootFix", "off");
        long wdMs = Long.getLong("spike.wdMs", 5000L);
        int verboseFrom = Integer.getInteger("spike.verboseFrom", -1);

        out.println("BOOT begin zip=" + zipPath + " dest=" + destRoot + " main=" + mainClass
                + " fix=" + fix + " wdMs=" + wdMs + " verboseFrom=" + verboseFrom
                + " batch=" + Integer.getInteger("spike.batch", 64)
                + " settleMs=" + Long.getLong("spike.settleMs", 0L));

        startWatchdog(out, wdMs);

        // spike.repeat -- the power knob, and the reason it exists.
        //
        // The measured per-boot failure rate on a quiet host is about 1 in 20,
        // which means 20 clean boots is worth almost nothing as evidence:
        // 0.95^20 = 0.36, so a third of all 20-run batches come back clean even
        // with the bug fully present. Deliberately loading the host would fix
        // the power problem and wreck a sibling lane's timing measurements, so
        // instead each run can do the unpack R times, into R separate
        // destination roots. That is R times the write operations -- the thing
        // the race is per -- for one browser launch and one CheerpJ init, i.e.
        // roughly R times the exposure for about 1.3x the wall clock.
        //
        // mainClass "none" skips the Forge handoff, which is what makes this
        // cheap: the unpack is 32 s and Forge's boot to a home screen is 100 s.
        int repeat = Math.max(1, Integer.getInteger("spike.repeat", 1));
        long t0 = System.nanoTime();
        try {
            if (repeat > 1) {
                for (int r = 0; r < repeat; r++) {
                    File d = new File(destRoot, "r" + r);
                    out.println("BOOT repeat " + (r + 1) + "/" + repeat + " dest=" + d.getPath());
                    files = 0; bytes = 0;
                    unpack(out, new File(zipPath), d, fix, verboseFrom);
                }
                out.println("BOOT ALLDONE repeats=" + repeat);
                out.flush();
                return;
            }
            unpack(out, new File(zipPath), new File(destRoot), fix, verboseFrom);
        } catch (Throwable t) {
            // The original propagates, which under CheerpJ means the page's
            // try/catch may or may not see it. Print it HERE so a failure that
            // does have a cause can never be mistaken for the silent stall.
            out.println("BOOT unpack THREW " + t.getClass().getName() + ": " + t.getMessage()
                    + " at phase=" + phase + " entry=" + entry + " files=" + files + " bytes=" + bytes);
            t.printStackTrace(out);
            out.flush();
            throw t;
        }
        long t1 = System.nanoTime();
        out.println("BOOT unpack total ms=" + ((t1 - t0) / 1_000_000L));

        // Prove the destination behaves like a filesystem before handing it over:
        // this is the whole point of the detour and a silent failure here would
        // look exactly like a Forge bug fifty frames later.
        at("verify");
        File res = new File(destRoot, "res");
        String[] kids = res.list();
        out.println("BOOT verify " + res.getPath()
                + " isDir=" + res.isDirectory()
                + " entries=" + (kids == null ? "null" : String.valueOf(kids.length)));
        File editions = new File(res, "editions");
        String[] ed = editions.list();
        out.println("BOOT verify " + editions.getPath()
                + " isDir=" + editions.isDirectory()
                + " entries=" + (ed == null ? "null" : String.valueOf(ed.length)));

        out.println("BOOT handing off to " + mainClass);
        out.flush();
        // The watchdog keeps ticking THROUGH Forge's own boot. Forge is silent
        // for tens of seconds between `Language ... loaded` and `Read cards:`,
        // and on a loaded host that gap reached ~86 s in wave 15. A driver that
        // cannot tell "Forge is working" from "the JVM is dead" has to fall back
        // on a budget, which is what made a wave-15 failure cost 900 s.
        at("forge");
        Method m = Class.forName(mainClass).getMethod("main", String[].class);
        m.invoke(null, (Object) rest);
    }

    /**
     * The instrument the wave-15 stall lacked. If CheerpJ cannot actually run a
     * second Java thread here (no cross-origin isolation is served, so a
     * SharedArrayBuffer-backed thread pool is not available), this prints
     * nothing and the run falls back to {@code spike.verboseFrom} for
     * granularity -- which is why BOTH exist. The first line it prints is its
     * own proof of life.
     */
    private static void startWatchdog(PrintStream out, long wdMs) {
        if (wdMs <= 0) { out.println("BOOT wd disabled"); return; }
        Thread t = new Thread(() -> {
            out.println("BOOT wd alive tick=" + wdMs + "ms");
            out.flush();
            while (true) {
                try { Thread.sleep(wdMs); } catch (InterruptedException e) { return; }
                out.println("BOOT wd phase=" + phase + " entry=" + entry
                        + " files=" + files + " bytes=" + bytes
                        + " inCallMs=" + ((System.nanoTime() - opStartNs) / 1_000_000L));
                out.flush();
            }
        }, "spike-watchdog");
        t.setDaemon(true);
        t.start();
    }

    private static void unpack(PrintStream out, File zipFile, File dest, String fix, int verboseFrom)
            throws Exception {
        at("marker-check");
        File marker = new File(dest, ".spike-unpacked");
        long expect = zipFile.length();
        if (!Boolean.getBoolean("spike.forceUnpack") && marker.isFile() && marker.length() == expect % 4096L + 1L) {
            out.println("BOOT unpack SKIPPED -- marker present (warm start)");
            return;
        }
        long tOpen = System.nanoTime();
        int dirs = 0;
        final boolean preload = fix.contains(FIX_PRELOAD);
        final int batch = Integer.getInteger("spike.batch", 64);
        final long settleMs = Long.getLong("spike.settleMs", 0L);
        final boolean flush = fix.contains(FIX_FLUSH);
        int sinceSettle = 0;
        byte[] buf = new byte[64 * 1024];

        // FIX_PRELOAD: pull the whole archive off /app/ into the heap FIRST, so
        // that the write loop below touches exactly one asynchronous subsystem
        // instead of two. See the class comment and docs/spikes/cheerpj-boot.md.
        byte[] archive = null;
        if (preload) {
            at("preload");
            long tPre = System.nanoTime();
            archive = readFully(zipFile, (int) expect);
            out.println("BOOT preload bytes=" + archive.length + " ms=" + ms(tPre));
        }

        long tUnzip;
        if (preload) {
            at("zip-open");
            try (java.util.zip.ZipInputStream zin =
                         new java.util.zip.ZipInputStream(new java.io.ByteArrayInputStream(archive))) {
                out.println("BOOT zip open ms=" + ms(tOpen) + " entries=(streamed)"
                        + " archiveBytes=" + expect);
                tUnzip = System.nanoTime();
                ZipEntry ze;
                at("next");
                while ((ze = zin.getNextEntry()) != null) {
                    entry = ze.getName();
                    File target = new File(dest, ze.getName());
                    if (ze.isDirectory()) {
                        at("mkdirs-entry");
                        if (target.mkdirs()) { dirs++; }
                        at("next");
                        continue;
                    }
                    at("mkdirs-parent");
                    File parent = target.getParentFile();
                    if (parent != null && !parent.isDirectory() && parent.mkdirs()) { dirs++; }
                    if (verboseFrom >= 0 && files >= verboseFrom) {
                        out.println("BOOT e" + files + " " + ze.getName() + " sz=" + ze.getSize());
                    }
                    // zin must NOT be closed per entry, so no try-with-resources
                    // around it: closeEntry() is the per-entry boundary.
                    at("open-streams");
                    try (OutputStream os = new BufferedOutputStream(new FileOutputStream(target), 64 * 1024)) {
                        int k;
                        at("copy");
                        while ((k = zin.read(buf)) > 0) {
                            at("write");
                            os.write(buf, 0, k);
                            bytes += k;
                            at("read");
                        }
                        at("close-streams");
                    }
                    files++;
                    sinceSettle++;
                    if (flush && sinceSettle >= batch) { sinceSettle = 0; settle(settleMs); }
                    if ((files % 500) == 0) {
                        at("progress");
                        out.println("BOOT unpack progress files=" + files + " bytes=" + bytes
                                + " ms=" + ms(tUnzip));
                    }
                    at("next");
                }
                at("unpack-done");
                out.println("BOOT unpack done files=" + files + " dirs=" + dirs
                        + " bytes=" + bytes + " ms=" + ms(tUnzip));
            }
        } else {
            at("zip-open");
            try (ZipFile zip = new ZipFile(zipFile)) {
                out.println("BOOT zip open ms=" + ms(tOpen) + " entries=" + zip.size()
                        + " archiveBytes=" + expect);
                at("enumerate");
                Enumeration<? extends ZipEntry> e = zip.entries();
                tUnzip = System.nanoTime();

                while (e.hasMoreElements()) {
                    at("next");
                    ZipEntry ze = e.nextElement();
                    entry = ze.getName();
                    File target = new File(dest, ze.getName());
                    if (ze.isDirectory()) {
                        at("mkdirs-entry");
                        if (target.mkdirs()) { dirs++; }
                        continue;
                    }
                    at("mkdirs-parent");
                    File parent = target.getParentFile();
                    if (parent != null && !parent.isDirectory() && parent.mkdirs()) { dirs++; }
                    if (verboseFrom >= 0 && files >= verboseFrom) {
                        out.println("BOOT e" + files + " " + ze.getName() + " sz=" + ze.getSize());
                    }
                    at("open-streams");
                    try (InputStream in = zip.getInputStream(ze);
                         OutputStream os = new BufferedOutputStream(new FileOutputStream(target), 64 * 1024)) {
                        int k;
                        at("copy");
                        while ((k = in.read(buf)) > 0) {
                            at("write");
                            os.write(buf, 0, k);
                            bytes += k;
                            at("read");
                        }
                        at("close-streams");
                    }
                    files++;
                    sinceSettle++;
                    if (flush && sinceSettle >= batch) { sinceSettle = 0; settle(settleMs); }
                    if ((files % 500) == 0) {
                        at("progress");
                        out.println("BOOT unpack progress files=" + files + " bytes=" + bytes
                                + " ms=" + ms(tUnzip));
                    }
                }
                at("unpack-done");
                out.println("BOOT unpack done files=" + files + " dirs=" + dirs
                        + " bytes=" + bytes + " ms=" + ms(tUnzip));
            }
        }
        at("marker-write");
        try (OutputStream os = new FileOutputStream(marker)) {
            // Content is the marker: its LENGTH is what the warm-start check reads,
            // so a half-written unpack from a previous run cannot pass for a good one.
            byte[] stamp = new byte[(int) (expect % 4096L + 1L)];
            os.write(stamp);
        }
    }

    /**
     * Hand the JS event loop a turn. Under CheerpJ a Java {@code Thread.sleep}
     * is what releases the browser's main thread; a tight unpack loop never
     * does, which is what lets an asynchronous backend's queue grow without an
     * opportunity to drain.
     */
    private static void settle(long settleMs) {
        at("settle");
        try { Thread.sleep(Math.max(1L, settleMs)); } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Read a file off CheerpJ's read-only {@code /app/} HTTP mount in one
     * sequential pass. Deliberately NOT {@code Files.readAllBytes}: the size is
     * known from the mount, and a single pre-sized array means one allocation
     * and no doubling copies of a 50 MB buffer inside a WebAssembly heap.
     */
    private static byte[] readFully(File f, int size) throws Exception {
        byte[] all = new byte[size];
        int off = 0;
        try (InputStream in = new java.io.FileInputStream(f)) {
            while (off < size) {
                int k = in.read(all, off, size - off);
                if (k < 0) { break; }
                off += k;
            }
        }
        if (off != size) {
            throw new java.io.IOException("short read of " + f + ": got " + off + " of " + size);
        }
        return all;
    }

    private static long ms(long since) { return (System.nanoTime() - since) / 1_000_000L; }
}
