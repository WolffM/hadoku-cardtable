import { describe, expect, it } from 'vitest';
import { parseDck } from '@hadoku/carddata';
import { serializeDraftNotes, withDraftNotes } from './draft-notes.ts';

const DECK = '[metadata]\nName=Drafted\n[Main]\n17 Island\n1 Lurking Automaton|CNS\n[Sideboard]\n1 Garbage Fire|CN2\n';

describe('serializeDraftNotes', () => {
  it('joins a card\'s notes with a comma, and pairs with " | ", as DeckSerializer does', () => {
    expect(serializeDraftNotes({ 'Lurking Automaton': ['3', '7'], 'Paliano, the High City': ['white,blue,black'], 'Paliano Vanguard': ['Human', 'Soldier'] })).toBe(
      'Lurking Automaton:3,7 | Paliano, the High City:white,blue,black | Paliano Vanguard:Human,Soldier',
    );
  });

  it('joins the four cards LimitedPlayer joins with a semicolon that way, so a noted name may hold a comma', () => {
    expect(
      serializeDraftNotes({
        'Noble Banneret': ['Borborygmos, Enraged', 'Grizzly Bears'],
        'Cogwork Grinder': ['Island', 'Island', 'Shock'],
        'Aether Searcher': ['Shock'],
        'Smuggler Captain': ['Counterspell'],
      }),
    ).toBe('Noble Banneret:Borborygmos, Enraged;Grizzly Bears | Cogwork Grinder:1;1;1 | Aether Searcher:Shock | Smuggler Captain:Counterspell');
  });

  it('writes a two-faced card\'s name both ways for the cards Forge matches by name, and once for a card it counts', () => {
    expect(serializeDraftNotes({ 'Aether Searcher': ['Delver of Secrets // Insectile Aberration'], 'Cogwork Grinder': ['Fire // Ice'] })).toBe(
      'Aether Searcher:Delver of Secrets // Insectile Aberration;Delver of Secrets | Cogwork Grinder:1',
    );
  });

  it('writes nothing for a card that noted nothing, an empty note, or a note the syntax cannot carry', () => {
    expect(serializeDraftNotes({})).toBe('');
    expect(serializeDraftNotes({ 'Animus of Predation': ['', ' '], 'Cogwork Tracker': [] })).toBe('');
    expect(serializeDraftNotes({ 'Lurking Automaton': ['3', '', '5'], 'Spire Phantasm': ['a|b', 'Shock'], 'Bad:Key': ['1'], 'Aether Searcher': ['a;b', 'Shock'] })).toBe(
      'Lurking Automaton:3,5 | Spire Phantasm:Shock | Aether Searcher:Shock',
    );
  });
});

describe('withDraftNotes', () => {
  it('writes the line at the end of [metadata] and changes nothing else', () => {
    const out = withDraftNotes(DECK, { 'Lurking Automaton': ['3'] });
    expect(out).toBe('[metadata]\nName=Drafted\nDraftNotes=Lurking Automaton:3\n[Main]\n17 Island\n1 Lurking Automaton|CNS\n[Sideboard]\n1 Garbage Fire|CN2\n');
    expect(parseDck(out).metadata.get('draftnotes')).toBe('Lurking Automaton:3');
    expect(parseDck(out).sections).toEqual(parseDck(DECK).sections);
  });

  it('replaces whatever line the text came with: the draft\'s notes are the only ones', () => {
    const forged = DECK.replace('Name=Drafted\n', 'draftnotes = Lurking Automaton:99\nName=Drafted\n');
    expect(withDraftNotes(forged, { 'Lurking Automaton': ['3'] })).toBe(withDraftNotes(DECK, { 'Lurking Automaton': ['3'] }));
    expect(withDraftNotes(forged, {})).toBe(DECK);
  });

  it('is the same text when there is nothing to change, and again when written twice', () => {
    expect(withDraftNotes(DECK, {})).toBe(DECK);
    const once = withDraftNotes(DECK, { 'Garbage Fire': ['2', '4'] });
    expect(withDraftNotes(once, { 'Garbage Fire': ['2', '4'] })).toBe(once);
  });

  it('keeps blank lines that close the section, and a file\'s own line endings', () => {
    expect(withDraftNotes('[metadata]\nName=A\n\n[Main]\n1 Shock\n', { 'Garbage Fire': ['2'] })).toBe('[metadata]\nName=A\nDraftNotes=Garbage Fire:2\n\n[Main]\n1 Shock\n');
    expect(withDraftNotes('[metadata]\r\nName=A\r\n[Main]\r\n1 Shock\r\n', { 'Garbage Fire': ['2'] })).toBe('[metadata]\r\nName=A\r\nDraftNotes=Garbage Fire:2\r\n[Main]\r\n1 Shock\r\n');
  });

  it('leaves text with no [metadata] section alone', () => {
    expect(withDraftNotes('[Main]\n1 Shock\n', { 'Garbage Fire': ['2'] })).toBe('[Main]\n1 Shock\n');
  });
});
