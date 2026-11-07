/**
 * The one identifier a game states about itself to the shell. Every storage
 * key, custom event name and chat prefix the shell writes is built from it, so
 * the values a game wrote before the shell existed do not change.
 */
let configured: string | undefined;

export function configureShell(config: { appId: string }): void {
  configured = config.appId;
}

export function appId(): string {
  if (configured === undefined) throw new Error('ui-shell: configureShell was never called');
  return configured;
}
