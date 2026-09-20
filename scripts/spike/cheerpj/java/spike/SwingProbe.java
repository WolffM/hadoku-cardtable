package spike;

import javax.swing.*;
import java.awt.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;

/**
 * Wave 14, lane B -- CheerpJ Swing rendering probe.
 *
 * Deliberately small: this measures the FLOOR, i.e. what CheerpJ's Swing costs
 * before Forge's own 100k-line desktop UI is anywhere near it. A number from
 * here is an upper bound on Forge's frame rate, never a prediction of it.
 *
 * Every line it prints starts with a tag the harness page greps for. The harness
 * timestamps each console line with performance.now(), so latencies are measured
 * in the BROWSER's clock and there is no JVM/JS clock correlation to get wrong.
 *
 *   SWING-MAIN      main() entered
 *   SWING-FRAME     JFrame.setVisible(true) returned
 *   SWING-PAINT n   the n-th paintComponent completed
 *   SWING-FPS a/b   a frames painted in b ms of a busy repaint loop
 *   SWING-READY     ready for a click at the coordinates it prints
 *   SWING-CLICK     a mouse listener fired
 *   SWING-CLICKPAINT the repaint caused by that click completed
 */
public final class SwingProbe {
    private static volatile int paints = 0;
    private static volatile boolean clicked = false;

    public static void main(String[] args) throws Exception {
        System.out.println("SWING-MAIN java.version=" + System.getProperty("java.version")
                + " headless=" + GraphicsEnvironment.isHeadless());

        final JFrame frame = new JFrame("cheerpj-swing-probe");
        final Panel panel = new Panel();
        frame.getContentPane().add(panel);
        frame.setSize(800, 600);
        frame.setVisible(true);
        System.out.println("SWING-FRAME visible");

        // Busy repaint loop. paintImmediately bypasses Swing's coalescing, so the
        // count is frames actually rasterised rather than repaint() calls merged.
        long t0 = System.currentTimeMillis();
        int n = 0;
        while (System.currentTimeMillis() - t0 < 5000) {
            panel.tick++;
            panel.paintImmediately(0, 0, panel.getWidth(), panel.getHeight());
            n++;
        }
        long dt = System.currentTimeMillis() - t0;
        System.out.println("SWING-FPS " + n + "/" + dt + " frames=" + n + " ms=" + dt
                + " fps=" + (n * 1000L / Math.max(1, dt)));

        panel.addMouseListener(new MouseAdapter() {
            @Override public void mousePressed(MouseEvent e) {
                System.out.println("SWING-CLICK at " + e.getX() + "," + e.getY());
                clicked = true;
                panel.repaint();
            }
        });
        System.out.println("SWING-READY click-target 400,300");
    }

    private static final class Panel extends JComponent {
        int tick = 0;

        @Override protected void paintComponent(Graphics g) {
            Graphics2D g2 = (Graphics2D) g;
            g2.setColor(clicked ? Color.RED : new Color(20, 20 + (tick % 200), 60));
            g2.fillRect(0, 0, getWidth(), getHeight());
            g2.setColor(Color.WHITE);
            // Text + a few shapes so this is not a single fillRect the backend can trivialise.
            for (int i = 0; i < 40; i++) {
                g2.drawLine(0, i * 15, getWidth(), (i * 37 + tick) % getHeight());
            }
            g2.drawString("tick " + tick, 20, 30);
            paints++;
            if (paints <= 3) System.out.println("SWING-PAINT " + paints);
            if (clicked) {
                System.out.println("SWING-CLICKPAINT");
                clicked = false;
            }
        }
    }
}
