import { describe, expect, it, vi } from 'vitest';

describe('app-id', () => {
  it('throws until configureShell is called, then returns the configured id', async () => {
    // The unit setup configures the shell for every file; a fresh module is the unconfigured one.
    vi.resetModules();
    const { appId, configureShell } = await import('./index.ts');
    expect(() => appId()).toThrow('ui-shell: configureShell was never called');
    configureShell({ appId: 'cardtable' });
    expect(appId()).toBe('cardtable');
  });
});
