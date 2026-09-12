package io.sentry;

/** Overlay stub for io.sentry.Breadcrumb. See {@link Sentry}. */
public final class Breadcrumb {
    private final String message;

    public Breadcrumb(String message) {
        this.message = message;
    }

    public String getMessage() {
        return message;
    }

    public void setData(String key, Object value) {
    }
}
