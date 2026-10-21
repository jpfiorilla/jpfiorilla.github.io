import { Chord } from './types';

/** Longest window indexed. Beyond this the n-gram table grows faster than it earns. */
export const MAX_NGRAM = 8;

export type Fingerprints = {
  /** Quality, semitones up to the next root, quality, and so on; transposition-invariant. */
  interval: string;
  /** The same root motion with the qualities stripped out. */
  rootMotion: string;
  /** Motion of the sounding bass, which inversions and pedals make distinct from the roots. */
  bassMotion: string;
};

export type NgramEntry = {
  kind: keyof Fingerprints;
  value: string;
  start: number;
  length: number;
};

const soundingBass = (chord: Chord) => chord.bass ?? chord.root;

/**
 * Every interval is stored as semitones upward, mod 12. A descending semitone and an
 * ascending major seventh are the same stored motion, so a register choice never splits
 * two readings of one progression.
 */
const step = (from: number, to: number) => (to - from + 12) % 12;

const motions = (pcs: number[]) => pcs.slice(1).map((pc, i) => step(pcs[i], pc)).join(':');

export function fingerprint(chords: Chord[]): Fingerprints {
  if (chords.length === 0) throw new Error('A progression needs at least one chord');

  const roots = chords.map((chord) => chord.root.pc);

  return {
    interval: chords
      .map((chord, i) =>
        i === 0 ? chord.quality : `${step(roots[i - 1], roots[i])}:${chord.quality}`
      )
      .join(':'),
    rootMotion: motions(roots),
    bassMotion: motions(chords.map((chord) => soundingBass(chord).pc)),
  };
}

/** Every contiguous window of 2 to MAX_NGRAM chords, fingerprinted each way. This is the index. */
export function ngrams(chords: Chord[]): NgramEntry[] {
  const entries: NgramEntry[] = [];

  for (let length = 2; length <= Math.min(MAX_NGRAM, chords.length); length++) {
    for (let start = 0; start + length <= chords.length; start++) {
      const prints = fingerprint(chords.slice(start, start + length));
      for (const kind of Object.keys(prints) as Array<keyof Fingerprints>) {
        entries.push({ kind, value: prints[kind], start, length });
      }
    }
  }

  return entries;
}
