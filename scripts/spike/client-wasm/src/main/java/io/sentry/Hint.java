package io.sentry;

/**
 * Overlay stub for io.sentry.Hint.
 *
 * forge-gui-mobile's adventure save code (SaveFileData:321) builds one, calls
 * set(String, Object) on it and hands it to Sentry.captureException.
 */
public final class Hint {
    public Hint() {
    }

    public void set(String name, Object hint) {
    }
}
