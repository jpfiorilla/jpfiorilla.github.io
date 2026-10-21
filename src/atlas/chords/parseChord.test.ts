import { parseChord } from './parseChord';

describe('parseChord : roots', () => {
  test('parses a bare major triad, keeping the written spelling', () => {
    expect(parseChord('C')).toEqual({
      symbol: 'C',
      root: { name: 'C', pc: 0 },
      quality: 'maj',
      extensions: [],
      bass: null,
    });
  });
});

describe('parseChord : accidentals', () => {
  test('reads sharps and flats in the root, as sharps or flats', () => {
    expect(parseChord('F#').root).toEqual({ name: 'F#', pc: 6 });
    expect(parseChord('Bb').root).toEqual({ name: 'Bb', pc: 10 });
    expect(parseChord('Eb').root).toEqual({ name: 'Eb', pc: 3 });
  });

  test('accepts unicode ♯ and ♭ and normalises them to # and b', () => {
    expect(parseChord('F♯').root).toEqual({ name: 'F#', pc: 6 });
    expect(parseChord('B♭').root).toEqual({ name: 'Bb', pc: 10 });
  });
});

describe('parseChord : qualities', () => {
  test('reads minor sevenths', () => {
    expect(parseChord('Am7').quality).toBe('min7');
    expect(parseChord('Dm7').quality).toBe('min7');
    expect(parseChord('Emin7').quality).toBe('min7');
    expect(parseChord('E-7').quality).toBe('min7');
  });

  test('reads dominant sevenths', () => {
    expect(parseChord('G7').quality).toBe('dom7');
    expect(parseChord('Eb7').quality).toBe('dom7');
  });

  test('reads minor triads', () => {
    expect(parseChord('Am').quality).toBe('min');
    expect(parseChord('Bbmin').quality).toBe('min');
  });
});

describe('parseChord : major sevenths', () => {
  test('reads the caret shorthand as a major seventh, with or without the 7', () => {
    expect(parseChord('C^').quality).toBe('maj7');
    expect(parseChord('F^').quality).toBe('maj7');
    expect(parseChord('C^7').quality).toBe('maj7');
  });

  test('reads the other major-seventh spellings', () => {
    for (const symbol of ['Cmaj7', 'CMaj7', 'CM7', 'CΔ7', 'C△7', 'CΔ']) {
      expect(parseChord(symbol).quality).toBe('maj7');
    }
  });

  test('does not mistake a bare major triad for a major seventh', () => {
    expect(parseChord('C').quality).toBe('maj');
  });
});

describe('parseChord : diminished and augmented', () => {
  test('keeps the diminished triad distinct from the diminished seventh', () => {
    expect(parseChord('F#dim').quality).toBe('dim');
    expect(parseChord('Bbdim7').quality).toBe('dim7');
  });

  test('reads the circle shorthands for diminished', () => {
    for (const symbol of ['F#o', 'F#°']) expect(parseChord(symbol).quality).toBe('dim');
    for (const symbol of ['Bbo7', 'Bb°7']) expect(parseChord(symbol).quality).toBe('dim7');
  });

  test('reads half-diminished as its own quality, however it is written', () => {
    for (const symbol of ['Bø', 'Bø7', 'Bm7b5', 'B-7b5']) {
      expect(parseChord(symbol).quality).toBe('halfdim7');
    }
  });

  test('reads augmented triads', () => {
    expect(parseChord('Caug').quality).toBe('aug');
    expect(parseChord('C+').quality).toBe('aug');
  });
});

describe('parseChord : slash bass', () => {
  test('separates the sounding bass from the root', () => {
    expect(parseChord('F#dim/C')).toEqual({
      symbol: 'F#dim/C',
      root: { name: 'F#', pc: 6 },
      quality: 'dim',
      extensions: [],
      bass: { name: 'C', pc: 0 },
    });
  });

  test('handles a plain triad over a non-root bass', () => {
    const chord = parseChord('G/B');
    expect(chord.root).toEqual({ name: 'G', pc: 7 });
    expect(chord.quality).toBe('maj');
    expect(chord.bass).toEqual({ name: 'B', pc: 11 });
  });

  test('leaves bass null when the chord is in root position', () => {
    expect(parseChord('Am7').bass).toBeNull();
  });
});

describe('parseChord : extensions and alterations', () => {
  test('collects alterations in the order they were written', () => {
    expect(parseChord('A7b13').quality).toBe('dom7');
    expect(parseChord('A7b13').extensions).toEqual(['b13']);
    expect(parseChord('C^7#11').extensions).toEqual(['#11']);
    expect(parseChord('G7b9#11').extensions).toEqual(['b9', '#11']);
  });

  test('treats an upper number as an extension over the seventh core', () => {
    expect(parseChord('Dm9').quality).toBe('min7');
    expect(parseChord('Dm9').extensions).toEqual(['9']);
    expect(parseChord('G13').quality).toBe('dom7');
    expect(parseChord('G13').extensions).toEqual(['13']);
  });

  test('keeps added tones distinct from extensions of a seventh chord', () => {
    expect(parseChord('Cadd9').quality).toBe('maj');
    expect(parseChord('Cadd9').extensions).toEqual(['add9']);
  });

  test('reads sixths as their own quality', () => {
    expect(parseChord('C6').quality).toBe('maj6');
    expect(parseChord('Am6').quality).toBe('min6');
  });

  test('reads suspensions and the minor-major seventh', () => {
    expect(parseChord('Csus4').quality).toBe('sus4');
    expect(parseChord('Csus2').quality).toBe('sus2');
    expect(parseChord('G7sus4').quality).toBe('dom7sus4');
    expect(parseChord('Cm(maj7)').quality).toBe('minMaj7');
    expect(parseChord('CmMaj7').quality).toBe('minMaj7');
  });
});

describe('parseChord : rejecting typos', () => {
  test('rejects a note letter that does not exist', () => {
    expect(() => parseChord('H')).toThrow(/H/);
  });

  test('rejects an empty symbol', () => {
    expect(() => parseChord('')).toThrow();
  });

  test('rejects a bass note that does not exist', () => {
    expect(() => parseChord('G/H')).toThrow(/H/);
  });

  test('rejects leftover characters rather than silently dropping them', () => {
    expect(() => parseChord('Cmm')).toThrow(/Cmm/);
    expect(() => parseChord('Dm7xyz')).toThrow(/Dm7xyz/);
  });

  test('accepts every symbol in the Zelda chart without throwing', () => {
    const symbols = ['C', 'F#dim/C', 'G/B', 'Bbdim7', 'Am7', 'D', 'F^', 'Em7', 'Dm7', 'C^', 'Eb7', 'G7'];
    for (const symbol of symbols) expect(() => parseChord(symbol)).not.toThrow();
  });
});
