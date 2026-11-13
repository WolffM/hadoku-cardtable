// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { claimReload, releaseOf, serverReleaseIsNewer, unreadableMeansStale } from './stale-build.ts';

afterEach(() => sessionStorage.clear());

describe('comparing builds', () => {
  it('reads a release from a build, and nothing from a build that is not one', () => {
    expect(releaseOf('v0.57.0+915f1d2f7')).toEqual([0, 57, 0]);
    expect(releaseOf('v1.2.3')).toEqual([1, 2, 3]);
    expect(releaseOf('unknown')).toBeNull();
    expect(releaseOf('ci-run-42')).toBeNull();
  });

  it('only a later release is newer: semver, not string order, and never a sha on the same release', () => {
    expect(serverReleaseIsNewer('v0.56.0+91a313c62', 'v0.57.0+915f1d2f7')).toBe(true);
    expect(serverReleaseIsNewer('v0.9.0+aaaaaaaaa', 'v0.10.0+bbbbbbbbb')).toBe(true);
    expect(serverReleaseIsNewer('v0.56.3+aaaaaaaaa', 'v1.0.0+bbbbbbbbb')).toBe(true);
    expect(serverReleaseIsNewer('v0.57.0+915f1d2f7', 'v0.56.0+91a313c62')).toBe(false);
    expect(serverReleaseIsNewer('v0.56.0+91a313c62', 'v0.56.0+0123abcde')).toBe(false);
    expect(serverReleaseIsNewer('v0.56.0+91a313c62', 'unknown')).toBe(false);
    expect(serverReleaseIsNewer('unknown', 'v0.57.0+915f1d2f7')).toBe(false);
  });

  it('an unreadable frame means a stale page unless the server runs this very build', () => {
    expect(unreadableMeansStale('v0.56.0+91a313c62', 'v0.56.0+91a313c62')).toBe(false);
    expect(unreadableMeansStale('v0.56.0+91a313c62', 'v0.56.0+0123abcde')).toBe(true);
    expect(unreadableMeansStale('v0.56.0+91a313c62', 'unknown')).toBe(true);
    expect(unreadableMeansStale('v0.56.0+91a313c62', null)).toBe(true);
  });
});

describe('the reload guard', () => {
  it('claims one reload per target build per tab', () => {
    expect(claimReload('v0.57.0+915f1d2f7')).toBe(true);
    expect(claimReload('v0.57.0+915f1d2f7')).toBe(false);
    // The next release is a new target: a tab open across two releases reloads for each.
    expect(claimReload('v0.58.0+0123abcde')).toBe(true);
  });

  it('without session storage there is no way to stop a loop, so there is no reload', () => {
    const refusing = (): Storage => {
      throw new DOMException('denied', 'SecurityError');
    };
    expect(claimReload('v0.57.0+915f1d2f7', refusing)).toBe(false);
  });
});
