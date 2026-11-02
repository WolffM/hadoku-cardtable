import { describe, expect, it } from 'vitest';

import { browseNeighbours, poolNeighbours } from './deckNeighbours.ts';
import type { FormatFamily, TableFormat } from './tables.ts';

const era = (id: string, family: FormatFamily): TableFormat => ({ id, name: id, effective: id, sets: [], banned: [], cardCount: 0, source: 'era', family });
const formats: TableFormat[] = [
  era('2023-05-29', 'standard'),
  era('2025-06-30', 'standard'),
  era('2024-04-19', 'standard'),
  era('modern-2024', 'modern'),
  era('modern-2025', 'modern'),
  era('legacy-2025', 'legacy'),
  { ...era('free', 'standard'), source: 'free' },
];

describe('the deck lists one press away', () => {
  it('a pool: the years either side on its tab, then each other tab’s newest', () => {
    expect(poolNeighbours(formats, '2024-04-19')).toEqual(['2025-06-30', '2023-05-29', 'modern-2025', 'legacy-2025']);
  });

  it('the newest year has one neighbour on its tab', () => {
    expect(poolNeighbours(formats, '2025-06-30')).toEqual(['2024-04-19', 'modern-2025', 'legacy-2025']);
  });

  it('a pool no tab lists (Free pick’s own row) has only the tabs’ openings', () => {
    expect(poolNeighbours(formats, 'nowhere')).toEqual(['2025-06-30', 'modern-2025', 'legacy-2025']);
  });

  it('Free pick browsing a year: the years beside it, then the other tabs as they open', () => {
    expect(browseNeighbours(formats, { family: 'modern', era: 'modern-2024' })).toEqual([
      { family: 'modern', era: 'modern-2025' },
      { family: 'standard', era: '' },
      { family: 'legacy', era: '' },
    ]);
  });

  it('Free pick on My decks: every format tab', () => {
    expect(browseNeighbours(formats, { family: 'mine', era: '' }).map((b) => b.family)).toEqual(['standard', 'modern', 'legacy']);
  });
});
