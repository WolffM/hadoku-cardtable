package io.sentry;

/**
 * Overlay stub for io.sentry.Sentry.
 *
 * forge-game calls Sentry from 10 engine files (GameAction, AbilityFactory,
 * AbilityUtils, Card, CardState, CardFactoryUtil, CardCopyService,
 * KeywordInstance, TriggerHandler, ManaEffect). The real client is an HTTP
 * crash reporter: useless in a browser and a large classlib surface for TeaVM.
 *
 * This stub replaces the io.sentry:sentry artifact on the classpath. Nothing
 * under forge/ is modified — the dependency is excluded in this project's pom
 * and these classes shadow it.
 *
 * Only the five members forge-game actually uses are declared; anything else
 * would fail to compile here rather than silently no-op.
 */
public final class Sentry {
    private Sentry() {
    }

    public static void addBreadcrumb(Breadcrumb breadcrumb) {
    }

    public static void setExtra(String key, String value) {
    }

    public static void removeExtra(String key) {
    }
}
