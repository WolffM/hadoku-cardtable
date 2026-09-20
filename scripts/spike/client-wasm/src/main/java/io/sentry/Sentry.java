package io.sentry;

import io.sentry.protocol.SentryId;

/**
 * Overlay stub for io.sentry.Sentry.
 *
 * Wave 1's spike (scripts/spike/teavm/) needed five members, because it linked
 * forge-core + forge-game only. The client path reaches further: forge-gui's
 * BugReporter and forge-gui-mobile's adventure save code call captureException
 * / captureMessage / addBreadcrumb(String) as well.
 *
 * The real client is an HTTP crash reporter: useless in a browser and a large
 * classlib surface for TeaVM. This stub replaces the io.sentry:sentry artifact
 * on the classpath. Nothing under forge/ is modified - the dependency is
 * excluded in this project's pom and these classes shadow it.
 *
 * Only the members Forge actually reaches are declared, so an unexpected call
 * fails to link loudly rather than silently no-opping.
 */
public final class Sentry {
    private Sentry() {
    }

    public static void addBreadcrumb(Breadcrumb breadcrumb) {
    }

    public static void addBreadcrumb(String message) {
    }

    public static void setExtra(String key, String value) {
    }

    public static void removeExtra(String key) {
    }

    public static SentryId captureException(Throwable throwable) {
        return SentryId.EMPTY_ID;
    }

    public static SentryId captureException(Throwable throwable, Hint hint) {
        return SentryId.EMPTY_ID;
    }

    public static SentryId captureMessage(String message) {
        return SentryId.EMPTY_ID;
    }
}
