/** Pitch class: 0 = C, 1 = C#/Db, … 11 = B. */
export type PitchClass = number;

/** A note name as written on the page; spelling is preserved, matching is by pitch class. */
export type Note = {
  name: string;
  pc: PitchClass;
};

export type Quality =
  | 'maj'
  | 'min'
  | 'dim'
  | 'aug'
  | 'sus2'
  | 'sus4'
  | 'dom7sus4'
  | 'maj6'
  | 'min6'
  | 'maj7'
  | 'min7'
  | 'dom7'
  | 'dim7'
  | 'halfdim7'
  | 'minMaj7'
  | 'aug7';

export type Chord = {
  /** The symbol exactly as it was written. */
  symbol: string;
  root: Note;
  quality: Quality;
  /** Added tones and alterations, in written order: '9', '#11', 'b13', 'add9'. */
  extensions: string[];
  /** Slash bass, or null when the chord is in root position. */
  bass: Note | null;
};
