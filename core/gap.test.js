import test from 'node:test';
import assert from 'node:assert/strict';
import { solve, verifyCertificate, completions, previewTopup, bruteForceFunded } from './gap.js';

const lines = [
  { key: 'venue', amount: 400n },
  { key: 'food', amount: 300n },
  { key: 'travel', amount: 300n },
];
const pledges = [
  { id: 'events-dao', cap: 500n, lines: ['venue'] },
  { id: 'builders-dao', cap: 250n, lines: ['travel'] },
  { id: 'community-dao', cap: 400n, lines: ['food', 'venue'] },
];

test('worked example: 1,150 pledged, 1,000 plan, 50 short on travel', () => {
  const r = solve(lines, pledges);
  assert.equal(pledges.reduce((a, p) => a + p.cap, 0n), 1150n);
  assert.equal(r.required, 1000n);
  assert.equal(r.funded, 950n);
  assert.equal(r.gap, 50n);
  assert.equal(r.shortByLine.travel, 50n);
  assert.ok(verifyCertificate(lines, pledges, r.allocation, r.certificate).ok);
});

test('what completes it: 50 on travel or 50 anywhere; food alone never', () => {
  const c = completions(lines, pledges);
  assert.equal(c.anyLine, 50n);
  assert.equal(c.byLine.travel, 50n);
  assert.equal(c.byLine.food, null);
  assert.equal(c.byLine.venue, null);
});

test('top-up previews: 50 travel completes, 49 leaves 1, 50 food changes nothing', () => {
  assert.equal(previewTopup(lines, pledges, 50n, ['travel']).completes, true);
  assert.equal(previewTopup(lines, pledges, 49n, ['travel']).gapAfter, 1n);
  const food = previewTopup(lines, pledges, 50n, ['food']);
  assert.equal(food.gapAfter, 50n);
  assert.equal(food.used, 0n);
});

test('a completed plan allocates every line exactly', () => {
  const r = solve(lines, [...pledges, { id: 'topup:1', cap: 50n, lines: ['travel'] }]);
  assert.equal(r.gap, 0n);
  const by = {};
  for (const a of r.allocation) by[a.line] = (by[a.line] || 0n) + a.amount;
  assert.deepEqual(by, { venue: 400n, food: 300n, travel: 300n });
});

test('tampered allocations and certificates are rejected', () => {
  const r = solve(lines, pledges);
  const bad1 = r.allocation.map((a) => (a.source === 'builders-dao' ? { ...a, line: 'food' } : a));
  assert.equal(verifyCertificate(lines, pledges, bad1, r.certificate).ok, false);
  const bad2 = r.allocation.map((a) => (a.source === 'events-dao' ? { ...a, amount: a.amount + 600n } : a));
  assert.equal(verifyCertificate(lines, pledges, bad2, r.certificate).ok, false);
  const bad3 = { ...r.certificate, sourceSide: [] }; // cut of all pledges = 1,150 != 950
  assert.equal(verifyCertificate(lines, pledges, r.allocation, bad3).ok, false);
  const stale = pledges.map((p) => (p.id === 'builders-dao' ? { ...p, cap: 200n } : p));
  assert.equal(verifyCertificate(lines, stale, r.allocation, r.certificate).ok, false);
});

test('zero-gap plan needs no top-up', () => {
  const r = solve([{ key: 'venue', amount: 100n }], [{ id: 'a', cap: 100n, lines: ['venue'] }]);
  assert.equal(r.gap, 0n);
  assert.equal(completions([{ key: 'venue', amount: 100n }], [{ id: 'a', cap: 100n, lines: ['venue'] }]).anyLine, 0n);
});

test('agrees with exhaustive cut enumeration on 500 random small plans', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let t = 0; t < 500; t++) {
    const L = 1 + rnd(4), P = 1 + rnd(5);
    const ls = Array.from({ length: L }, (_, i) => ({ key: 'l' + i, amount: BigInt(rnd(500)) }));
    const ps = Array.from({ length: P }, (_, i) => ({
      id: 'p' + i, cap: BigInt(rnd(600)),
      lines: ls.filter(() => rnd(2)).map((l) => l.key),
    }));
    const r = solve(ls, ps);
    assert.equal(r.funded, bruteForceFunded(ls, ps), `case ${t}`);
    const v = verifyCertificate(ls, ps, r.allocation, r.certificate);
    assert.ok(v.ok, `case ${t}: ${v.reasons.join(', ')}`);
  }
});
