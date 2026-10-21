import { Chord, Note, Quality } from './types';

const NATURAL_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Fold the accidental and major-seventh glyphs found in real scores onto plain ASCII. */
function normaliseGlyphs(symbol: string): string {
  return symbol
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .replace(/[Δ△∆]/g, '^');
}

/**
 * Suffixes naming a chord quality. Matched longest first, so 'min7' is never read
 * as 'min' with a stray 7 and 'm7b5' never collapses to 'm7'. No match at all is a
 * plain major triad.
 */
const QUALITY_TOKENS: Array<[string, Quality]> = (
  [
    ['maj7', 'maj7'],
    ['Maj7', 'maj7'],
    ['M7', 'maj7'],
    ['^7', 'maj7'],
    ['^', 'maj7'],
    ['min(maj7)', 'minMaj7'],
    ['m(maj7)', 'minMaj7'],
    ['mMaj7', 'minMaj7'],
    ['mM7', 'minMaj7'],
    ['m^7', 'minMaj7'],
    ['m7b5', 'halfdim7'],
    ['-7b5', 'halfdim7'],
    ['ø7', 'halfdim7'],
    ['ø', 'halfdim7'],
    ['dim7', 'dim7'],
    ['o7', 'dim7'],
    ['°7', 'dim7'],
    ['dim', 'dim'],
    ['o', 'dim'],
    ['°', 'dim'],
    ['aug', 'aug'],
    ['+', 'aug'],
    ['7sus4', 'dom7sus4'],
    ['7sus', 'dom7sus4'],
    ['sus4', 'sus4'],
    ['sus2', 'sus2'],
    ['sus', 'sus4'],
    ['min7', 'min7'],
    ['m7', 'min7'],
    ['-7', 'min7'],
    ['min6', 'min6'],
    ['m6', 'min6'],
    ['min', 'min'],
    ['m', 'min'],
    ['-', 'min'],
    ['6', 'maj6'],
    ['7', 'dom7'],
  ] as Array<[string, Quality]>
).sort((a, b) => b[0].length - a[0].length);

/**
 * A bare 9, 11 or 13 implies the seventh underneath it: C13 is a dominant, Dm9 is a
 * minor seventh with a ninth. An 'add9' or an altered 'b9' carries no such implication.
 */
const IMPLIED_SEVENTH: Partial<Record<Quality, Quality>> = {
  maj: 'dom7',
  min: 'min7',
  sus4: 'dom7sus4',
  sus2: 'dom7sus4',
};

function readNote(text: string): { note: Note; rest: string } {
  const match = /^([A-G])([#b]*)/.exec(text);
  if (!match) throw new Error(`Unrecognised note in chord symbol: "${text}"`);
  const [, letter, accidentals] = match;
  const offset = accidentals.split('').reduce((n, a) => n + (a === '#' ? 1 : -1), 0);
  return {
    note: { name: letter + accidentals, pc: (NATURAL_PC[letter] + offset + 12) % 12 },
    rest: text.slice(match[0].length),
  };
}

function readQuality(text: string): { quality: Quality; rest: string } {
  for (const [token, quality] of QUALITY_TOKENS) {
    if (text.startsWith(token)) return { quality, rest: text.slice(token.length) };
  }
  return { quality: 'maj', rest: text };
}

export function parseChord(symbol: string): Chord {
  const text = normaliseGlyphs(symbol.trim());
  const slash = text.lastIndexOf('/');
  const chordText = slash === -1 ? text : text.slice(0, slash);
  const bassText = slash === -1 ? null : text.slice(slash + 1);

  const { note: root, rest } = readNote(chordText);
  const { quality: core, rest: tail } = readQuality(rest);

  const extension = /(?:add|omit|no)\d+|[#b+-]\d+|alt|\d+/g;
  const cleaned = tail.replace(/[()]/g, '');
  const extensions = cleaned.match(extension) ?? [];
  if (cleaned.replace(extension, '') !== '') {
    throw new Error(`Unrecognised chord symbol: "${symbol}"`);
  }

  const quality =
    /^(9|11|13)$/.test(extensions[0] ?? '') && IMPLIED_SEVENTH[core]
      ? (IMPLIED_SEVENTH[core] as Quality)
      : core;

  return {
    symbol,
    root,
    quality,
    extensions,
    bass: bassText === null ? null : readNote(bassText).note,
  };
}
