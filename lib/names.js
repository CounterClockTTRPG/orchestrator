// Fantasy names per race, so an agent's name fits its portrait. The name also seeds the face.

const SYLLABLES = {
  elf: [['Ae', 'El', 'Gal', 'Lae', 'Ny', 'Sil', 'Thal', 'Yl', 'Ara', 'Fen'], ['ra', 'wen', 'dor', 'thi', 'vae', 'lan', 'ri', 'nae'], ['', 'iel', 'ith', 'or', 'a', 'yn']],
  dwarf: [['Bal', 'Dur', 'Gim', 'Thor', 'Bram', 'Hild', 'Kaz', 'Dag', 'Mor', 'Ulf'], ['in', 'ga', 'bur', 'rek', 'dun', 'ni'], ['', 'li', 'grim', 'da', 'ak']],
  orc: [['Gor', 'Ug', 'Mak', 'Thra', 'Sha', 'Kro', 'Grish', 'Baz', 'Ruk', 'Yaz'], ['nak', 'ga', 'rum', 'thuk', 'gol', 'ash'], ['', 'a', 'ok', 'uk']],
  tiefling: [['Mor', 'Zar', 'Vex', 'Nym', 'Kai', 'Lil', 'Dam', 'Ash', 'Ira', 'Sa'], ['ae', 'ith', 'ra', 'ka', 'zel', 'mon'], ['', 'is', 'eth', 'a', 'os']],
  tabaxi: [['Sun', 'Quiet', 'Five', 'Ash', 'Moon', 'Swift', 'Little', 'Smoke', 'Far', 'Bright'], [' '], ['Whisker', 'Paw', 'Shadow', 'Song', 'Feather', 'Thorn', 'Ember', 'Cloud']],
  satyr: [['Pip', 'Fen', 'Lark', 'Bram', 'Thy', 'Ori', 'Cal', 'Myr'], ['ble', 'lo', 'ri', 'an', 'ion', 'ta'], ['', 'wick', 'ander', 'e', 'us']],
  lizardfolk: [['Ssa', 'Kesh', 'Thrass', 'Ix', 'Zhak', 'Vash', 'Sliss', 'Ka'], ['ri', 'ka', 'ess', 'ith', 'ak'], ['', 'ss', 'tl', 'ax']],
  centaur: [['Che', 'Ari', 'Phe', 'Nes', 'Ky', 'Sto', 'Eu'], ['ro', 'leo', 'ma', 'so', 'thy'], ['n', 's', 'ra', 'ne', 'us']],
  human: [['Al', 'Bren', 'Cor', 'Ed', 'Ma', 'Ro', 'Ser', 'Tam', 'Wil', 'Is'], ['dric', 'wyn', 'ra', 'ena', 'mund', 'an', 'el', 'beth'], ['', 'a', 'o', 'is']],
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

/** A name for `race`, unique among `taken`. Deterministic for a given salt. */
export function pickName(race, taken, salt = '') {
  const parts = SYLLABLES[race] ?? SYLLABLES.human;
  for (let i = 0; i < 200; i++) {
    let h = hash(`${race}:${salt}:${i}`);
    const name = parts.map((list) => { const p = list[h % list.length]; h = Math.floor(h / list.length) + 7919; return p; }).join('');
    const clean = name.charAt(0).toUpperCase() + name.slice(1);
    if (!taken.has(clean)) return clean;
  }
  return `${race}-${taken.size + 1}`;
}
