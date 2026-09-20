package spike;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Wave 15, lane B -- the gate probe.
 *
 * Wave 14 left ONE thing unverified that everything else in this lane depends
 * on: `new ZipFile("/app/.../cardsfolder.zip")` was never reached, because
 * CardStorageReader:93's isDirectory() guard threw first. If java.util.zip
 * cannot open an archive off CheerpJ's Range-backed /app/ mount, then packaging
 * res/cardsfolder as a zip is wasted work and the lane says so on day one.
 *
 * This answers it without Forge in the picture at all: open the archive, count
 * its entries, and actually decompress one -- because "the central directory
 * parsed" and "the deflate stream reads" are different questions and only the
 * second one is the one Forge needs.
 *
 * argv[0] = absolute path to the zip, argv[1] = an entry name to read (optional).
 */
public final class ZipProbe {
    public static void main(String[] args) {
        PrintStream out = System.out;
        String path = args.length > 0 ? args[0] : "/app/cardsfolder.zip";
        String wanted = args.length > 1 ? args[1] : null;
        out.println("PROBE zip begin path=" + path);

        File f = new File(path);
        out.println("ZIP file exists=" + f.exists() + " isFile=" + f.isFile()
                + " len=" + f.length() + " canRead=" + f.canRead());

        ZipFile zip = null;
        try {
            long t0 = System.nanoTime();
            zip = new ZipFile(f);
            long t1 = System.nanoTime();
            out.println("ZIP open OK ms=" + ms(t0, t1) + " size=" + zip.size());

            // Enumerate: this is what CardStorageReader.getZipEntries() does.
            long t2 = System.nanoTime();
            int total = 0, txt = 0, dirs = 0;
            String first = null;
            ZipEntry pick = null;
            Enumeration<? extends ZipEntry> e = zip.entries();
            while (e.hasMoreElements()) {
                ZipEntry ze = e.nextElement();
                total++;
                if (ze.isDirectory()) { dirs++; continue; }
                if (ze.getName().endsWith(".txt")) {
                    txt++;
                    if (first == null) { first = ze.getName(); }
                    if (wanted == null && pick == null) { pick = ze; }
                    if (wanted != null && ze.getName().equals(wanted)) { pick = ze; }
                }
            }
            long t3 = System.nanoTime();
            out.println("ZIP entries ms=" + ms(t2, t3) + " total=" + total
                    + " dirs=" + dirs + " txt=" + txt + " first=" + first);

            if (pick == null) {
                out.println("ZIP read SKIPPED -- no .txt entry found");
            } else {
                long t4 = System.nanoTime();
                int bytes = 0;
                String head = null;
                try (InputStream in = zip.getInputStream(pick);
                     BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        bytes += line.length() + 1;
                        if (head == null) { head = line; }
                    }
                }
                long t5 = System.nanoTime();
                out.println("ZIP read OK ms=" + ms(t4, t5) + " entry=" + pick.getName()
                        + " declaredSize=" + pick.getSize() + " charsRead=" + bytes
                        + " firstLine=" + head);
            }

            // Random access: decompress N scattered entries, which is what a real
            // card load does. A zip that opens but cannot seek is still a no.
            if (total > 20) {
                long t6 = System.nanoTime();
                int n = 0, sum = 0;
                Enumeration<? extends ZipEntry> e2 = zip.entries();
                int i = 0;
                int stride = Math.max(1, total / 50);
                while (e2.hasMoreElements()) {
                    ZipEntry ze = e2.nextElement();
                    if (ze.isDirectory() || !ze.getName().endsWith(".txt")) { continue; }
                    if ((i++ % stride) != 0) { continue; }
                    try (InputStream in = zip.getInputStream(ze)) {
                        byte[] buf = new byte[4096];
                        int k;
                        while ((k = in.read(buf)) > 0) { sum += k; }
                    }
                    n++;
                    if (n >= 50) { break; }
                }
                long t7 = System.nanoTime();
                out.println("ZIP scatter ms=" + ms(t6, t7) + " entriesRead=" + n + " bytes=" + sum);
            }

            out.println("ZIP VERDICT WORKS");
        } catch (Throwable t) {
            out.println("ZIP VERDICT FAILED " + t.getClass().getName() + ": " + t.getMessage());
            t.printStackTrace(out);
        } finally {
            if (zip != null) {
                try { zip.close(); } catch (Throwable ignored) { /* closing a read-only probe handle */ }
            }
        }
        out.println("PROBE zip end");
        out.flush();
    }

    private static long ms(long a, long b) { return (b - a) / 1_000_000L; }
}
