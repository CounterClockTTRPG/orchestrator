import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickName, presentationFor, RACES } from '../lib/names.js';
import { themedName, presentationOfName, theme } from '../web/themes.js';
import { generate } from '../vendor/portraitgen/index.js';

// An agent's name and its portrait agree: no Aisha with a man's face.

test('a role look that settles the presentation wins', () => {
  assert.equal(presentationFor('stout dwarf with a braided beard', 's'), 'masculine');
  assert.equal(presentationFor('elf woman with a hood', 's'), 'feminine');
  const drawn = new Set(Array.from({ length: 40 }, (_, i) => presentationFor('elf with a hood', `q:${i}`)));
  assert.deepEqual([...drawn].sort(), ['feminine', 'masculine']);
});

test('themed names follow the presentation, and the portrait keeps it', () => {
  for (const t of ['modern', 'scifi']) {
    for (let i = 0; i < 150; i++) {
      const p = presentationFor('human in a t-shirt', `q:${i}`, theme(t).presentations);
      const name = themedName(t, new Set(), `q:${i}`, p);
      const implied = presentationOfName(t, name);
      if (p === 'androgynous') assert.equal(implied, undefined, `${name} should be a neutral name`);
      else if (implied) assert.equal(implied, p, `${name} is ${implied}, the portrait ${p}`);
      assert.equal(generate({ theme: t, seed: name, describe: 'human in a t-shirt', presentation: p }).presentation, p);
    }
  }
  assert.equal(presentationOfName('modern', 'Aisha'), 'feminine');
  assert.equal(presentationOfName('modern', 'Tom B.'), 'masculine');
  assert.equal(presentationOfName('modern', 'Alex'), undefined);
});

test('fantasy names take gendered endings where the race has them', () => {
  for (const race of RACES) {
    const f = pickName(race, new Set(), 'x', 'feminine');
    const m = pickName(race, new Set(), 'x', 'masculine');
    assert.match(f, /^[A-Z]/);
    assert.match(m, /^[A-Z]/);
  }
  assert.match(pickName('elf', new Set(), 'x', 'feminine'), /(iel|ith|a|wyn|ae)$/);
  assert.match(pickName('elf', new Set(), 'x', 'masculine'), /(or|ion|dil|as|an)$/);
});
