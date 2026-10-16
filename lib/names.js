// Fantasy names per race and presentation, so an agent's name fits its portrait. The name also seeds the face.

import { describe as parseDescription } from '../vendor/portraitgen/describe.js';

// [first, middle, last] syllables. A { feminine, masculine } part carries the gender where the race's names have one.
const SYLLABLES = {
  elf: [['Ae', 'El', 'Gal', 'Lae', 'Ny', 'Sil', 'Thal', 'Yl', 'Ara', 'Fen'], ['ra', 'wen', 'dor', 'thi', 'vae', 'lan', 'ri', 'nae'],
    { feminine: ['iel', 'ith', 'a', 'wyn', 'ae'], masculine: ['or', 'ion', 'dil', 'as', 'an'] }],
  dwarf: [['Bal', 'Dur', 'Gim', 'Thor', 'Bram', 'Hild', 'Kaz', 'Dag', 'Mor', 'Ulf'], ['in', 'ga', 'bur', 'rek', 'dun', 'ni'],
    { feminine: ['da', 'hild', 'ra', 'dis', 'wyn'], masculine: ['li', 'grim', 'ak', 'in', 'or'] }],
  orc: [['Gor', 'Ug', 'Mak', 'Thra', 'Sha', 'Kro', 'Grish', 'Baz', 'Ruk', 'Yaz'], ['nak', 'ga', 'rum', 'thuk', 'gol', 'ash'],
    { feminine: ['a', 'ka', 'ga', 'sha'], masculine: ['ok', 'uk', 'ug', 'ash'] }],
  tiefling: [['Mor', 'Zar', 'Vex', 'Nym', 'Kai', 'Lil', 'Dam', 'Ash', 'Ira', 'Sa'], ['ae', 'ith', 'ra', 'ka', 'zel', 'mon'],
    { feminine: ['is', 'a', 'ia', 'ith'], masculine: ['os', 'eth', 'on', 'ak'] }],
  tabaxi: [['Sun', 'Quiet', 'Five', 'Ash', 'Moon', 'Swift', 'Little', 'Smoke', 'Far', 'Bright'], [' '], ['Whisker', 'Paw', 'Shadow', 'Song', 'Feather', 'Thorn', 'Ember', 'Cloud']],
  satyr: [['Pip', 'Fen', 'Lark', 'Bram', 'Thy', 'Ori', 'Cal', 'Myr'], ['ble', 'lo', 'ri', 'an', 'ion', 'ta'],
    { feminine: ['e', 'a', 'ia', 'ette'], masculine: ['wick', 'ander', 'us', 'o'] }],
  lizardfolk: [['Ssa', 'Kesh', 'Thrass', 'Ix', 'Zhak', 'Vash', 'Sliss', 'Ka'], ['ri', 'ka', 'ess', 'ith', 'ak'], ['', 'ss', 'tl', 'ax']],
  centaur: [['Che', 'Ari', 'Phe', 'Nes', 'Ky', 'Sto', 'Eu'], ['ro', 'leo', 'ma', 'so', 'thy'],
    { feminine: ['ne', 'ra', 'a', 'is'], masculine: ['n', 's', 'us', 'on'] }],
  human: [['Al', 'Bren', 'Cor', 'Ed', 'Ma', 'Ro', 'Ser', 'Tam', 'Wil', 'Is'],
    { feminine: ['wyn', 'ra', 'ena', 'el', 'beth'], masculine: ['dric', 'mund', 'ric', 'bert', 'win'] },
    { feminine: ['', 'a', 'e'], masculine: ['', 'o', 'us'] }],
};

export const RACES = Object.keys(SYLLABLES);
/** The races Guild picks for new characters; tieflings and satyrs are only drawn when a role asks for one. */
export const CAST_RACES = RACES.filter((r) => r !== 'tiefling' && r !== 'satyr');

/** The race named in a portraitgen description, defaulting to human. */
export function raceOf(describe = '') {
  const d = describe.toLowerCase();
  if (/\b(elf|elves|elven|elvish)\b/.test(d)) return 'elf';
  if (/\bdwar(f|ves|ven)\b/.test(d)) return 'dwarf';
  return RACES.find((r) => new RegExp(`\\b${r}s?\\b`).test(d)) ?? 'human';
}

export function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return h >>> 0;
}

/**
 * A name for `race` that fits `presentation` (androgynous or none: either kind), unique among `taken`.
 * Deterministic for a given salt.
 */
export function pickName(race, taken, salt = '', presentation) {
  const parts = SYLLABLES[race] ?? SYLLABLES.human;
  for (let i = 0; i < 200; i++) {
    let h = hash(`${race}:${salt}:${i}`);
    const kind = presentation === 'feminine' || presentation === 'masculine' ? presentation : h % 2 ? 'feminine' : 'masculine';
    const pick = (part) => {
      const list = Array.isArray(part) ? part : part[kind];
      const p = list[h % list.length];
      h = Math.floor(h / list.length) + 7919;
      return p;
    };
    const name = parts.map(pick).join('');
    const clean = name.charAt(0).toUpperCase() + name.slice(1);
    if (!taken.has(clean)) return clean;
  }
  return `${race}-${taken.size + 1}`;
}

/**
 * How an agent presents in its portrait (masculine, feminine or androgynous), chosen before its name so the two
 * match. A role look that settles it (a beard, "old man", "woman") wins; otherwise it is drawn from `choices`.
 */
export function presentationFor(describe, salt, choices = ['feminine', 'masculine']) {
  const forced = parseDescription(describe ?? '').options.presentation;
  return forced ?? choices[hash(`presentation:${salt}`) % choices.length];
}
