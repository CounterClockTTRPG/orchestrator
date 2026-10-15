import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raceOf, pickName, RACES } from '../lib/names.js';

test('raceOf reads whole words only', () => {
  assert.equal(raceOf('elf with a hood'), 'elf');
  assert.equal(raceOf('elven archer'), 'elf');
  assert.equal(raceOf('stout dwarf with a braided beard'), 'dwarf');
  assert.equal(raceOf('orc warrior'), 'orc');
  assert.equal(raceOf('tabaxi rogue'), 'tabaxi');
  assert.equal(raceOf('a force of nature on the shelf'), 'human');
  assert.equal(raceOf(''), 'human');
});

test('pickName is deterministic and avoids taken names', () => {
  const a = pickName('elf', new Set(), 'q1:0');
  assert.equal(pickName('elf', new Set(), 'q1:0'), a);
  const b = pickName('elf', new Set([a]), 'q1:0');
  assert.notEqual(b, a);
  for (const race of RACES) assert.match(pickName(race, new Set(), 's'), /^[A-Z]/);
});
