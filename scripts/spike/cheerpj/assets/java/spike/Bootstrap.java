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
 * Wave 15, lane B -- unpack Forge's res/ tree into a real filesystem, then start
 * Forge.
 *
 * The premise this replaces: Wave 14 assumed Forge could read res/ straight off
 * CheerpJ's /app/ mount once a couple of guards were relaxed. It cannot, and the
 * reason is structural rather than a line count -- /app/ serves files by exact
 * absolute path and has no directories at all, while Forge enumerates
 * directories from StorageReaderFolder, FSkin, CardStorageReader,
 * ForgeProfileProperties and their callers. Patching each of those is a long
 * tail with no end in sight.
 *
 * CheerpJ's OTHER mount does have directories: /files/ is backed by IndexedDB,
 * is writable, persists across reloads and lists normally. So do the unpack once
 * -- out of an archive on /app/, which ZipProbe measured as fast and
 * Range-friendly -- and hand Forge a filesystem that behaves like the one it was
 * written against.
 *
 * argv: <zip> <destRoot> <mainClass> [args...]
 *   e.g. /app/res-boot.zip /files/ forge.view.Main
 *
 * A marker file records the archive's size so a warm reload skips the unpack;
 * pass -Dspike.forceUnpack=true to redo it.
 */
public final class Bootstrap {
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

        out.println("BOOT begin zip=" + zipPath + " dest=" + destRoot + " main=" + mainClass);
        long t0 = System.nanoTime();
        unpack(out, new File(zipPath), new File(destRoot));
        long t1 = System.nanoTime();
        out.println("BOOT unpack total ms=" + ((t1 - t0) / 1_000_000L));

        // Prove the destination behaves like a filesystem before handing it over:
        // this is the whole point of the detour and a silent failure here would
        // look exactly like a Forge bug fifty frames later.
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
        Method m = Class.forName(mainClass).getMethod("main", String[].class);
        m.invoke(null, (Object) rest);
    }

    private static void unpack(PrintStream out, File zipFile, File dest) throws Exception {
        File marker = new File(dest, ".spike-unpacked");
        long expect = zipFile.length();
        if (!Boolean.getBoolean("spike.forceUnpack") && marker.isFile() && marker.length() == expect % 4096L + 1L) {
            out.println("BOOT unpack SKIPPED -- marker present (warm start)");
            return;
        }
        long tOpen = System.nanoTime();
        int files = 0, dirs = 0;
        long bytes = 0;
        try (ZipFile zip = new ZipFile(zipFile)) {
            out.println("BOOT zip open ms=" + ms(tOpen) + " entries=" + zip.size()
                    + " archiveBytes=" + expect);
            byte[] buf = new byte[64 * 1024];
            Enumeration<? extends ZipEntry> e = zip.entries();
            long tUnzip = System.nanoTime();
            while (e.hasMoreElements()) {
                ZipEntry ze = e.nextElement();
                File target = new File(dest, ze.getName());
                if (ze.isDirectory()) {
                    if (target.mkdirs()) { dirs++; }
                    continue;
                }
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && parent.mkdirs()) { dirs++; }
                try (InputStream in = zip.getInputStream(ze);
                     OutputStream os = new BufferedOutputStream(new FileOutputStream(target), 64 * 1024)) {
                    int k;
                    while ((k = in.read(buf)) > 0) { os.write(buf, 0, k); bytes += k; }
                }
                files++;
                if ((files % 500) == 0) {
                    out.println("BOOT unpack progress files=" + files + " bytes=" + bytes
                            + " ms=" + ms(tUnzip));
                }
            }
            out.println("BOOT unpack done files=" + files + " dirs=" + dirs
                    + " bytes=" + bytes + " ms=" + ms(tUnzip));
        }
        try (OutputStream os = new FileOutputStream(marker)) {
            // Content is the marker: its LENGTH is what the warm-start check reads,
            // so a half-written unpack from a previous run cannot pass for a good one.
            byte[] stamp = new byte[(int) (expect % 4096L + 1L)];
            os.write(stamp);
        }
    }

    private static long ms(long since) { return (System.nanoTime() - since) / 1_000_000L; }
}
