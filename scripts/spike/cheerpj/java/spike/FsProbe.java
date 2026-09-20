package spike;

import java.io.File;
import java.io.PrintStream;

/**
 * Wave 14, lane B -- CheerpJ filesystem probe.
 *
 * Forge's desktop entry point dies under CheerpJ at
 *   forge.toolbox.FSkin.loadLight -> "Cannot find default skin at /app//res/skins/default/bg_splash.png"
 * even with that file served and a HTTP 200 on it. That is a filesystem question,
 * not a Swing one, and it decides whether Forge's 132 MB res/ tree could ever be
 * served over /app/ -- which any GO-WITH-COST plan depends on.
 *
 * args[0] is the path to check, defaulting to the splash image.
 */
public final class FsProbe {
    public static void main(String[] args) {
        PrintStream out = System.out;
        String p = args.length > 0 ? args[0] : "res/skins/default/bg_splash.png";
        out.println("PROBE fs begin");
        out.println("user.dir=" + System.getProperty("user.dir"));
        out.println("cwd-as-file=" + new File(".").getAbsolutePath());

        show(out, new File("/app/" + p));
        show(out, new File("/app//" + p));
        show(out, new File(p));
        show(out, new File("/app/res/skins/default"));
        show(out, new File("/app/res/skins"));
        show(out, new File("/app/probe.jar"));
        show(out, new File("/app"));

        out.println("PROBE fs end");
    }

    private static void show(PrintStream out, File f) {
        try {
            String list = "";
            if (f.isDirectory()) {
                String[] kids = f.list();
                list = " entries=" + (kids == null ? "null" : String.valueOf(kids.length));
                if (kids != null && kids.length > 0) {
                    list += " first=" + kids[0];
                }
            }
            out.println("FS " + f.getPath()
                    + " exists=" + f.exists()
                    + " isFile=" + f.isFile()
                    + " isDir=" + f.isDirectory()
                    + " len=" + f.length()
                    + " canRead=" + f.canRead()
                    + list);
        } catch (Throwable t) {
            out.println("FS " + f.getPath() + " THREW " + t.getClass().getName() + ": " + t.getMessage());
        }
        out.flush();
    }
}
