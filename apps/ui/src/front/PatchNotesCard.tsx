/*
 * The banner's "Patch notes" card (`docs/planning/wave77-2026-10-27.md` §A): the newest
 * `docs/releases/v*.md`, bundled at build time — no server route, because the notes already ship
 * in this repo. "Older" opens the release list in `docs/`'s own GitHub view, since there is no
 * in-app release index to link instead.
 */

import { GITHUB_REPO_URL } from '../chrome/HeaderLinks.tsx';
import { newestVersion, parseReleaseNotes, versionOfPath, type ParsedRelease } from './patchNotes.ts';

// Vite bundles every match eagerly, as raw text, at build time (no server round trip for the notes).
const RELEASE_FILES = import.meta.glob('../../../../docs/releases/v*.md', { query: '?raw', eager: true, import: 'default' }) as Record<string, string>;

/** Every release this build shipped with, parsed. Computed once per build, not per render. */
function allReleases(): ParsedRelease[] {
  const out: ParsedRelease[] = [];
  for (const [path, markdown] of Object.entries(RELEASE_FILES)) {
    const version = versionOfPath(path);
    if (version === null) continue;
    const parsed = parseReleaseNotes(markdown, version);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export function PatchNotesCard() {
  const releases = allReleases();
  const newest = newestVersion(releases.map((r) => r.version));
  const release = releases.find((r) => r.version === newest) ?? null;

  return (
    <section className="front-card front-card--patch-notes" data-testid="front-patch-notes">
      <header className="front-card__head">
        <h3 className="front-card__title">Patch notes</h3>
        {release !== null && <span className="front-card__version">{release.version}</span>}
      </header>
      {release === null ? (
        <p className="front-card__empty">No releases yet.</p>
      ) : (
        <>
          <p className="front-card__release-title">{release.title}</p>
          <ul className="front-card__bullets">
            {release.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </>
      )}
      <div className="front-card__foot-links">
        <a className="front-card__link" href={`${GITHUB_REPO_URL}/tree/main/docs/releases`} target="_blank" rel="noopener noreferrer">
          Read all
        </a>
        <a className="front-card__link" href={`${GITHUB_REPO_URL}/tree/main/docs/releases`} target="_blank" rel="noopener noreferrer">
          Older
        </a>
      </div>
    </section>
  );
}
