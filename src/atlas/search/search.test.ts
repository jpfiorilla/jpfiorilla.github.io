import { parseChord } from '../chords/parseChord';
import { buildIndex, search, IndexedPassage } from './search';
import zelda from '../data/zeldas-lullaby.json';

const read = (symbols: string) => symbols.trim().split(/\s+/).map(parseChord);

/** The analysis John typed up, loaded from the file it lives in on disk. */
const zeldaPassages: IndexedPassage[] = zelda.analyses[0].passages.map((passage) => ({
  id: `${zelda.id}:${passage.id}`,
  work: zelda.title,
  label: passage.label,
  chords: passage.chords.map((chord) => parseChord(chord.symbol)),
}));

/** A synthetic control, so a cross-work match has something to match against. */
const controlPassage: IndexedPassage = {
  id: 'control:ii-V-I-in-D',
  work: 'Reference progressions',
  label: 'ii-V-I in D major',
  chords: read('Em7 A7 D^'),
};

const index = buildIndex([...zeldaPassages, controlPassage]);

describe('search : the thing this is all for', () => {
  test('finds a ii-V in another key from the one written in Zelda', () => {
    const hits = search(index, read('Dm7 G7'), { kinds: ['interval'] });
    const passages = hits.map((hit) => hit.passageId);

    expect(passages).toContain('kondo-zeldas-lullaby:b');
    expect(passages).toContain('control:ii-V-I-in-D');
  });

  test('reports where in the passage the match sits', () => {
    const [hit] = search(index, read('Em7 A7'), { kinds: ['interval'] }).filter(
      (h) => h.passageId === 'control:ii-V-I-in-D'
    );
    expect(hit).toMatchObject({ start: 0, length: 2, chords: ['Em7', 'A7'] });
  });

  test('finds the opening cell recurring inside the A section', () => {
    const hits = search(index, read('C F#dim/C C F#dim/C'), { kinds: ['interval'] }).filter(
      (hit) => hit.passageId === 'kondo-zeldas-lullaby:a'
    );

    expect(hits.map((hit) => hit.start)).toEqual([0, 8]);
  });

  test('matches the descending chromatic bass on bass motion alone', () => {
    const hits = search(index, read('G/B Bbdim7 Am7'), { kinds: ['bassMotion'] });
    expect(hits.map((hit) => hit.passageId)).toContain('kondo-zeldas-lullaby:a');
  });

  test('ranks a longer, more specific match above a looser one', () => {
    const hits = search(index, read('Dm7 G7'));
    expect(hits[0].kind).toBe('interval');
  });

  test('returns nothing for a progression the archive has never seen', () => {
    expect(search(index, read('C#aug Fsus2 Bb7#11'))).toEqual([]);
  });
});
