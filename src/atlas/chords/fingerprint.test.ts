import { parseChord } from './parseChord';
import { fingerprint, ngrams } from './fingerprint';

const read = (symbols: string) => symbols.trim().split(/\s+/).map(parseChord);

describe('fingerprint : interval', () => {
  test('reads qualities and the semitones between roots', () => {
    expect(fingerprint(read('Dm7 G7 C^')).interval).toBe('min7:5:dom7:5:maj7');
  });

  test('is identical for the same progression in another key', () => {
    const inC = fingerprint(read('Dm7 G7 C^')).interval;
    expect(fingerprint(read('Em7 A7 D^')).interval).toBe(inC);
    expect(fingerprint(read('Cm7 F7 Bb^')).interval).toBe(inC);
  });

  test('is not fooled by enharmonic respelling', () => {
    expect(fingerprint(read('C#m7 F#7 B^')).interval).toBe(fingerprint(read('Dbm7 Gb7 Cb^')).interval);
  });

  test('distinguishes progressions that differ only in quality', () => {
    expect(fingerprint(read('Dm7 G7 C^')).interval).not.toBe(fingerprint(read('D7 G7 C^')).interval);
  });
});

describe('fingerprint : root motion', () => {
  test('is quality-blind, so it finds the shape alone', () => {
    expect(fingerprint(read('Dm7 G7 C^')).rootMotion).toBe('5:5');
    expect(fingerprint(read('D7 Gm C6')).rootMotion).toBe('5:5');
  });

  test('canonicalises every interval as semitones upward, mod 12', () => {
    // G down to F is the same stored motion as G up to F, so a voicing choice
    // never splits two readings of the same progression.
    expect(fingerprint(read('G F')).rootMotion).toBe('10');
  });
});

describe('fingerprint : bass motion', () => {
  test('follows the sounding bass, not the root, through inversions', () => {
    const zeldaOpening = read('C F#dim/C C F#dim/C');
    expect(fingerprint(zeldaOpening).bassMotion).toBe('0:0:0');
    expect(fingerprint(zeldaOpening).rootMotion).toBe('6:6:6');
  });

  test('exposes a chromatic descent that the roots hide', () => {
    const line = read('G/B Bbdim7 Am7 D');
    expect(fingerprint(line).bassMotion).toBe('11:11:5');
    expect(fingerprint(line).rootMotion).toBe('3:11:5');
  });

  test('falls back to the root when no bass is written', () => {
    const progression = read('Dm7 G7 C^');
    expect(fingerprint(progression).bassMotion).toBe(fingerprint(progression).rootMotion);
  });
});

describe('fingerprint : edges', () => {
  test('gives a single chord its quality and no motion', () => {
    expect(fingerprint(read('C^'))).toEqual({ interval: 'maj7', rootMotion: '', bassMotion: '' });
  });

  test('refuses an empty progression', () => {
    expect(() => fingerprint([])).toThrow();
  });
});

describe('ngrams', () => {
  test('emits every window of two or more chords, for each fingerprint kind', () => {
    const entries = ngrams(read('Dm7 G7 C^'));
    // windows: [0,2] [1,2] [0,3] : three windows, three kinds each
    expect(entries).toHaveLength(9);
    expect(entries).toContainEqual({ kind: 'interval', value: 'min7:5:dom7:5:maj7', start: 0, length: 3 });
    expect(entries).toContainEqual({ kind: 'interval', value: 'dom7:5:maj7', start: 1, length: 2 });
    expect(entries).toContainEqual({ kind: 'rootMotion', value: '5', start: 0, length: 2 });
  });

  test('caps the window length so a long passage does not explode the index', () => {
    const long = read('C Dm Em F G Am Bdim C Dm Em');
    expect(Math.max(...ngrams(long).map((e) => e.length))).toBe(8);
  });
});
