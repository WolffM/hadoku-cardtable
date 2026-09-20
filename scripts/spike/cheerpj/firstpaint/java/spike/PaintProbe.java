package spike;

import javax.swing.*;
import java.awt.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;

/**
 * Wave 15, lane D -- the click-to-pixel target.
 *
 * This is NOT a rendering benchmark. It exists so the measurement rig has
 * something whose repaint-on-click behaviour is known exactly, so that the rig
 * itself can be validated (including its FAILURE modes) before it is pointed at
 * Forge's real UI, where nothing is known.
 *
 * Differences from Wave 14's spike.SwingProbe, all deliberate:
 *
 *  - No busy repaint loop. SwingProbe animates for 5 s, which means a
 *    pixel-diff rig aimed at it would see change that no click caused and
 *    report a latency of "0 ms". A quiet canvas is a precondition for a
 *    pre-click baseline to mean anything.
 *  - Each click TOGGLES to a new high-contrast state, so the n-th click changes
 *    pixels relative to the state the (n-1)-th click left behind. A probe that
 *    latches one colour measures exactly one click and then silently reports
 *    nothing for the other 39.
 *  - mode=nolistener installs no mouse listener at all. That is the rig's
 *    negative control: the clicks are delivered, the canvas is live, and
 *    nothing repaints. A rig that still prints a number is broken.
 *  - It prints a build id it was compiled with, so a measurement can be tied to
 *    a specific build rather than to whatever jar happened to be staged.
 *
 * Tags (the harness page timestamps every System.out line with
 * performance.now(), so all latencies stay in ONE clock):
 *
 *   PAINT-MAIN      main() entered
 *   PAINT-FRAME     setVisible(true) returned
 *   PAINT-READY     quiet, painted, ready to be clicked
 *   PAINT-CLICK n   the Java mouse listener fired (n = the new state)
 *   PAINT-DONE n    the repaint that click caused finished rasterising
 */
public final class PaintProbe {
    private static volatile int state = 0;
    private static volatile boolean repaintPending = false;

    public static void main(String[] args) throws Exception {
        final String buildId = args.length > 0 ? args[0] : "unknown";
        final String mode = args.length > 1 ? args[1] : "normal";

        System.out.println("PAINT-MAIN build=" + buildId + " mode=" + mode
                + " java.version=" + System.getProperty("java.version")
                + " headless=" + GraphicsEnvironment.isHeadless());

        final JFrame frame = new JFrame("cheerpj-firstpaint-probe");
        final Panel panel = new Panel();
        frame.getContentPane().add(panel);
        frame.setSize(800, 600);
        frame.setUndecorated(true);   // no title bar: the whole display is the panel
        frame.setVisible(true);
        System.out.println("PAINT-FRAME visible " + panel.getWidth() + "x" + panel.getHeight());

        // Rasterise once, synchronously, so "ready" means "there are pixels on
        // the canvas" and not "a repaint has been requested".
        panel.paintImmediately(0, 0, panel.getWidth(), panel.getHeight());

        // mode=release exists because the comparison demands it. streaming.md:
        // "Forge's Swing UI acts on the mouse RELEASE, so the button hold time
        // passes straight into the number", and its 63.7 ms is press->pixel
        // with a 50 ms hold, i.e. ~13.7 ms of release->pixel. A probe that acts
        // on the PRESS produces a press->pixel number with no hold inside it,
        // which is a different quantity wearing the same name. Both are
        // measured and the sweep over --hold shows which edge each one tracks.
        if (!"nolistener".equals(mode)) {
            final boolean onRelease = "release".equals(mode);
            panel.addMouseListener(new MouseAdapter() {
                private void act(MouseEvent e, String edge) {
                    state++;
                    repaintPending = true;
                    System.out.println("PAINT-CLICK " + state + " edge=" + edge
                            + " at " + e.getX() + "," + e.getY());
                    panel.repaint();
                }
                @Override public void mousePressed(MouseEvent e) { if (!onRelease) act(e, "press"); }
                @Override public void mouseReleased(MouseEvent e) { if (onRelease) act(e, "release"); }
            });
        }

        if ("noise".equals(mode)) {
            // The rig's third negative control: a canvas that moves on its own.
            // Wave 14's spike.SwingProbe has exactly this shape (it busy-paints
            // for 5 s), and a pixel-diff rig aimed at a moving canvas will find
            // "change" a few microseconds after any press and report a
            // spectacular latency that is entirely an artefact. The rig must
            // reject every rep here as NOISY-BASELINE instead.
            final Thread noise = new Thread(() -> {
                try {
                    while (true) {
                        state++;
                        panel.repaint();
                        Thread.sleep(30);
                    }
                } catch (InterruptedException ignored) { }
            });
            noise.setDaemon(true);
            noise.start();
        }

        // Let anything Swing queued at startup drain, so the pre-click baseline
        // the rig takes is genuinely quiet.
        Thread.sleep(700);
        System.out.println("PAINT-READY build=" + buildId + " mode=" + mode
                + " size=" + panel.getWidth() + "x" + panel.getHeight());
    }

    private static final class Panel extends JComponent {
        @Override protected void paintComponent(Graphics g) {
            final Graphics2D g2 = (Graphics2D) g;
            final int w = getWidth(), h = getHeight();
            final int s = state;

            // Two well-separated colours so a change is unambiguous at any
            // reasonable pixel-diff threshold, and so a half-drawn frame cannot
            // read as "unchanged".
            g2.setColor((s % 2 == 0) ? new Color(16, 24, 48) : new Color(224, 96, 32));
            g2.fillRect(0, 0, w, h);

            // Some real drawing work so this is not one fillRect the backend can
            // trivialise into a clear colour.
            g2.setColor(Color.WHITE);
            for (int i = 0; i < 40; i++) {
                g2.drawLine(0, i * 15, w, (i * 37 + s * 11) % Math.max(1, h));
            }
            g2.drawString("state " + s, 20, 30);

            if (repaintPending) {
                repaintPending = false;
                System.out.println("PAINT-DONE " + s);
            }
        }
    }
}
