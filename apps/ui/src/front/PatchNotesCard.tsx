/*
 * The banner's "Patch notes" card (`docs/planning/wave77-2026-10-27.md` §A): the newest
 * `docs/releases/v*.md`, bundled at build time — no server route, because the notes already ship
 * in this repo. "Read all" opens every bundled release, newest first, in a modal on the site.
 */

import { Fragment, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { Modal } from '../components/Modal.tsx';
import { creditRuns, fittingBullets, newestFirst, parseReleaseNotes, versionOfPath, type ParsedRelease } from './patchNotes.ts';

// Vite bundles every match eagerly, as raw text, at build time (no server round trip for the notes).
const RELEASE_FILES = import.meta.glob('../../../../docs/releases/v*.md', { query: '?raw', eager: true, import: 'default' }) as Record<string, string>;

/** Every release this build shipped with, parsed, newest first. Computed once per build, not per render. */
const RELEASES: ParsedRelease[] = (() => {
  const out: ParsedRelease[] = [];
  for (const [path, markdown] of Object.entries(RELEASE_FILES)) {
    const version = versionOfPath(path);
    if (version === null) continue;
    const parsed = parseReleaseNotes(markdown, version);
    if (parsed !== null) out.push(parsed);
  }
  return newestFirst(out);
})();

/** A bullet's `**bold**` lead drawn bold, each credited name marked as the Discord post marks it; everything else as plain text. */
function inline(text: string): ReactNode {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{credits(part.replace(/\*(.+?)\*/g, '$1'))}</Fragment>));
}

function credits(text: string): ReactNode {
  return creditRuns(text).map((run, i) => (run.credit ? <span key={i} className="patch-notes__credit">{run.text}</span> : <Fragment key={i}>{run.text}</Fragment>));
}

/**
 * As many of the list's bullets as the card has room for, the rest hidden whole, never cut in half.
 * Hidden by `visibility`, so hiding one moves nothing and the measure never chases itself.
 */
function useFittingBullets(): RefObject<HTMLUListElement | null> {
  const ref = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const list = ref.current;
    if (list === null) return;
    const fit = (): void => {
      const items = [...list.children] as HTMLElement[];
      const shown = fittingBullets(
        items.map((li) => li.getBoundingClientRect().bottom),
        list.getBoundingClientRect().bottom,
      );
      items.forEach((li, i) => (li.style.visibility = i < shown ? '' : 'hidden'));
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(list);
    return () => observer?.disconnect();
  }, []);
  return ref;
}

export function PatchNotesCard() {
  const [open, setOpen] = useState(false);
  const release = RELEASES[0] ?? null;
  const bulletsRef = useFittingBullets();

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
          <ul className="front-card__bullets" ref={bulletsRef} data-testid="front-patch-notes-bullets">
            {release.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
          <div className="front-card__foot">
            <button type="button" className="button front-card__more" data-testid="front-patch-notes-read-all" onClick={() => setOpen(true)}>
              Read all
            </button>
          </div>
        </>
      )}
      {open && (
        <Modal title="Patch notes" testId="front-patch-notes-modal" wide onClose={() => setOpen(false)}>
          <div className="patch-notes">
            {RELEASES.map((r) => (
              <article key={r.version} className="patch-notes__release">
                <h4 className="patch-notes__title">
                  <span className="patch-notes__version">{r.version}</span>
                  {r.title}
                </h4>
                {r.summary !== '' && <p className="patch-notes__summary">{r.summary}</p>}
                {r.sections.map((s) => (
                  <section key={s.heading}>
                    <h5 className="patch-notes__section">{s.heading}</h5>
                    <ul className="patch-notes__bullets">
                      {s.bullets.map((b, i) => (
                        <li key={i}>{inline(b)}</li>
                      ))}
                    </ul>
                  </section>
                ))}
              </article>
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}
