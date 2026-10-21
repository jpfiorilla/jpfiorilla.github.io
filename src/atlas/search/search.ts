import { Chord } from '../chords/types';
import { Fingerprints, fingerprint, ngrams } from '../chords/fingerprint';

export type IndexedPassage = {
  id: string;
  work: string;
  label: string;
  chords: Chord[];
};

export type Hit = {
  passageId: string;
  work: string;
  label: string;
  kind: keyof Fingerprints;
  value: string;
  start: number;
  length: number;
  /** The matched chords as they were written, for display next to the query. */
  chords: string[];
};

export type ProgressionIndex = {
  passages: Map<string, IndexedPassage>;
  byValue: Map<string, Hit[]>;
};

const ALL_KINDS: Array<keyof Fingerprints> = ['interval', 'rootMotion', 'bassMotion'];

/** A quality-bearing match beats a bare shape match. */
const KIND_RANK: Record<keyof Fingerprints, number> = { interval: 0, rootMotion: 1, bassMotion: 2 };

/** Root motion and bass motion produce identically shaped values, so the kind is part of the key. */
const key = (kind: keyof Fingerprints, value: string) => `${kind} ${value}`;

export function buildIndex(passages: IndexedPassage[]): ProgressionIndex {
  const byValue = new Map<string, Hit[]>();

  for (const passage of passages) {
    for (const entry of ngrams(passage.chords)) {
      const hit: Hit = {
        passageId: passage.id,
        work: passage.work,
        label: passage.label,
        kind: entry.kind,
        value: entry.value,
        start: entry.start,
        length: entry.length,
        chords: passage.chords
          .slice(entry.start, entry.start + entry.length)
          .map((chord) => chord.symbol),
      };

      const bucket = byValue.get(key(entry.kind, entry.value));
      if (bucket) bucket.push(hit);
      else byValue.set(key(entry.kind, entry.value), [hit]);
    }
  }

  return { passages: new Map(passages.map((passage) => [passage.id, passage])), byValue };
}

export function search(
  index: ProgressionIndex,
  query: Chord[],
  options: { kinds?: Array<keyof Fingerprints> } = {}
): Hit[] {
  const prints = fingerprint(query);

  return (options.kinds ?? ALL_KINDS)
    .flatMap((kind) => index.byValue.get(key(kind, prints[kind])) ?? [])
    .sort(
      (a, b) =>
        b.length - a.length ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        a.passageId.localeCompare(b.passageId) ||
        a.start - b.start
    );
}
