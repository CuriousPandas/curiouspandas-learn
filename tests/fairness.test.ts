// Fairness Lab. The arithmetic is held to real Python, and to the published
// COMPAS table the lesson's code lab prints. The mission's claim that no pair of
// thresholds satisfies all three measures is exhaustive, so if the invented data
// changes and a pair appears, this fails rather than the lesson quietly lying.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CHANCE, DATASETS, FairnessLab, compare, equationNote, fprFromEquation, rates, search, TOLERANCE, type Group } from '../src/lib/cs/fairness.ts';
import { FAIRNESS_MISSION } from '../src/lib/cs/fairness-missions.ts';

function findPython(): string {
  for (const c of ['python3', 'python']) {
    const r = spawnSync(c, ['-c', 'print(1)'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '1') return c;
  }
  throw new Error('No Python 3 found; this test compares against the real interpreter and cannot pass without it');
}
const PY = findPython();

test('every rate at every threshold matches Python\'s exact fractions', () => {
  const r = spawnSync(PY, ['-I', '-c', `
import json, sys
from fractions import Fraction as F
out = []
for g in json.load(sys.stdin):
    row = []
    for t in range(1, 12):
        people = sum(l["people"] for l in g["levels"]); wrong = sum(l["wrong"] for l in g["levels"])
        fl = [l for i, l in enumerate(g["levels"]) if i + 1 >= t]
        flagged = sum(l["people"] for l in fl); fw = sum(l["wrong"] for l in fl)
        row.append([float(F(wrong, people)), float(F(flagged - fw, people - wrong)), float(F(wrong - fw, wrong)), float(F(fw, flagged)) if flagged else None])
    out.append(row)
print(json.dumps(out))`], { encoding: 'utf8', input: JSON.stringify(DATASETS.flatMap((d) => [d.a, d.b])) });
  assert.equal(r.status, 0, r.stderr);
  const real = JSON.parse(r.stdout);
  DATASETS.flatMap((d) => [d.a, d.b]).forEach((g, i) => {
    for (let t = 1; t <= 11; t++) {
      const m = rates(g, t), [base, fpr, fnr, ppv] = real[i][t - 1];
      assert.ok(Math.abs(m.base - base) < 1e-12);
      assert.ok(Math.abs(m.fpr - fpr) < 1e-12);
      assert.ok(Math.abs(m.fnr - fnr) < 1e-12);
      if (ppv === null) assert.equal(m.ppv, null); else assert.ok(Math.abs(m.ppv! - ppv) < 1e-12);
    }
  });
});

test('the invented data is what the lab says it is', () => {
  for (const d of DATASETS) for (const g of [d.a, d.b]) {
    assert.equal(g.levels.reduce((n, l) => n + l.people, 0), 1000, `${d.id} ${g.name} should be 1,000 people`);
    // Same chance at each score: exact, no rounding hiding in the counts.
    g.levels.forEach((l, i) => assert.ok(Math.abs(l.wrong - l.people * CHANCE[i]) < 1e-9, `${d.id} ${g.name} score ${i + 1}`));
  }
  assert.notEqual(rates(DATASETS[0].a, 6).base, rates(DATASETS[0].b, 6).base);
  assert.equal(rates(DATASETS[1].a, 6).base, rates(DATASETS[1].b, 6).base);
});

test('Chouldechova\'s equation holds at every threshold, on every dataset', () => {
  for (const d of DATASETS) for (const g of [d.a, d.b]) for (let t = 1; t <= 11; t++) {
    const r = rates(g, t), v = fprFromEquation(r);
    if (r.ppv === null) { assert.equal(v, null); continue; }
    assert.ok(Math.abs(v! - r.fpr) < 1e-12, `${g.name} t=${t}: ${v} vs ${r.fpr}`);
  }
});

test('the equation holds on ProPublica\'s published counts, and both sides\' numbers come from one table', () => {
  // How We Analyzed the COMPAS Recidivism Algorithm, general recidivism, Low vs High.
  const table = { black: { fineLow: 990, fineHigh: 805, wrongLow: 532, wrongHigh: 1369 }, white: { fineLow: 1139, fineHigh: 349, wrongLow: 461, wrongHigh: 505 } };
  const r = (t: typeof table.black) => {
    const people = t.fineLow + t.fineHigh + t.wrongLow + t.wrongHigh, wrong = t.wrongLow + t.wrongHigh;
    return { base: wrong / people, fpr: t.fineHigh / (t.fineLow + t.fineHigh), fnr: t.wrongLow / wrong, ppv: t.wrongHigh / (t.wrongHigh + t.fineHigh), notHigh: t.wrongLow / (t.wrongLow + t.fineLow) };
  };
  const b = r(table.black), w = r(table.white);
  const near = (x: number, y: number, d = 0.005) => assert.ok(Math.abs(x - y) < d, `${x} vs ${y}`);
  // ProPublica's figures.
  near(b.fpr, 0.4485, 0.0001); near(w.fpr, 0.2345, 0.0001); near(b.fnr, 0.2799, 0.0001); near(w.fnr, 0.4772, 0.0001);
  near(b.ppv, 0.63); near(w.ppv, 0.59);
  // Northpointe's, from the same counts: "37% vs. 41%", "35% vs. 29%", base rates 0.51 and 0.39.
  near(1 - b.ppv, 0.37); near(1 - w.ppv, 0.41); near(b.notHigh, 0.35); near(w.notHigh, 0.29);
  near(b.base, 0.51); near(w.base, 0.39);
  near(fprFromEquation(b)!, b.fpr, 1e-9);
  near(fprFromEquation(w)!, w.fpr, 1e-9);
});

test('no pair of thresholds gets all three on the different-base-rate data; the same-base-rate data has some', () => {
  const diff = search(DATASETS[0]);
  assert.equal(diff.tried, 121);
  assert.equal(diff.hits.length, 0, `unexpected pairs: ${JSON.stringify(diff.hits)}`);
  const same = search(DATASETS[1]);
  assert.ok(same.hits.length >= 10);
  assert.ok(same.hits.some((h) => h.ta === h.tb));
});

test('nobody flagged is undefined, not equal', () => {
  const p = compare(DATASETS[0], 11, 11);
  assert.equal(rates(DATASETS[0].a, 11).ppv, null);
  assert.equal(p.ppvGap, null);
  assert.equal(p.all, false);
  assert.equal(p.fprGap, 0, 'the error rates do match, which is why that alone can\'t pass');
});

test('the lesson\'s stated numbers at a shared threshold of 6', () => {
  const a = rates(DATASETS[0].a, 6), b = rates(DATASETS[0].b, 6);
  assert.deepEqual([a.base, b.base], [0.32, 0.61]);
  assert.equal(a.wronglyFlagged, 71);
  assert.equal(b.wronglyFlagged, 185);
  assert.ok(b.fpr > a.fpr);
  assert.ok(a.fnr > b.fnr);
});

test('the mission plays from its hints, and flagging everyone or nobody doesn\'t pass', () => {
  const m = FAIRNESS_MISSION.steps;
  const s = FAIRNESS_MISSION.setup();
  assert.ok(!m.some((st) => st.done(s)), 'no step is born done');
  s.lab.set(6, 6);
  assert.ok(m[0].done(s));
  // Equal extremes don't count as evening things out.
  s.lab.set(1, 1);
  assert.ok(!m[1].done(s));
  s.lab.set(11, 11);
  assert.ok(!m[1].done(s));
  s.lab.set(1, 11);
  assert.ok(!m[1].done(s));
  // A real pair does. Found, not hard-coded, so a data change can't strand the step.
  let found = false;
  for (let ta = 2; ta <= 10 && !found; ta++) for (let tb = 2; tb <= 10; tb++) {
    if (ta === tb) continue;
    const ra = rates(DATASETS[0].a, ta), rb = rates(DATASETS[0].b, tb);
    if (Math.abs(ra.fpr - rb.fpr) <= TOLERANCE && ra.fpr > 0.03 && ra.fpr < 0.97) { s.lab.set(ta, tb); found = true; break; }
  }
  assert.ok(found, 'some pair must equalise the false-positive rates');
  assert.ok(m[1].done(s));
  s.lab.runSearch();
  assert.ok(m[2].done(s));
  assert.ok(!m[3].done(s), 'different base rates can\'t satisfy this step');
  s.lab.use('same');
  s.lab.set(6, 6);
  assert.ok(m[3].done(s));
  assert.ok(m.every((st) => st.done(s)), 'earlier steps stay done');
});

test('flagging everyone used to finish the last step: on the same-base-rate data, thresholds of 1 and 1 made all three "match"', () => {
  const lab = new FairnessLab();
  lab.use('same');
  lab.set(1, 1);
  assert.equal(compare(lab.dataset, 1, 1).all, true, 'the rates do match, which is why this has to be refused by name');
  assert.equal(lab.sawAllEqual, false);
  lab.set(11, 11);
  assert.equal(lab.sawAllEqual, false, 'nor does flagging nobody');
  lab.set(1, 5);
  assert.equal(lab.sawAllEqual, false);
  lab.set(5, 5);
  assert.equal(lab.sawAllEqual, true);
});

test('the debrief said "flagged more innocent people" in the higher-base-rate group, which is false in counts at thresholds the mission accepts', () => {
  const d = DATASETS[0];
  // Every shared threshold step one accepts: the share is always higher in B.
  let accepted = 0;
  for (let t = 1; t <= 11; t++) {
    const lab = new FairnessLab();
    lab.set(t, t);
    if (!lab.sawSameScoreGap) continue;
    accepted++;
    assert.ok(rates(d.b, t).base > rates(d.a, t).base, 'B is the higher base rate');
    assert.ok(rates(d.b, t).fpr > rates(d.a, t).fpr, `the share at ${t}`);
  }
  assert.equal(accepted, 7, 'thresholds 2 to 8');
  // The counts go the other way at 2, tie at 3, and agree at 6.
  assert.deepEqual([rates(d.a, 2).wronglyFlagged, rates(d.b, 2).wronglyFlagged], [490, 371]);
  assert.deepEqual([rates(d.a, 3).wronglyFlagged, rates(d.b, 3).wronglyFlagged], [337, 337]);
  assert.deepEqual([rates(d.a, 6).wronglyFlagged, rates(d.b, 6).wronglyFlagged], [71, 185]);
  assert.match(FAIRNESS_MISSION.debrief, /a larger share of the innocent people/);
  assert.doesNotMatch(FAIRNESS_MISSION.debrief, /more innocent people/);
});

test('the impossibility has corners, and the lesson\'s worked corner is real', () => {
  // Counts as [positives, negatives, flagged positives, flagged negatives].
  const of = ([pos, neg, tp, fp]: number[]) => ({ base: pos / (pos + neg), fpr: fp / neg, fnr: (pos - tp) / pos, ppv: tp + fp ? tp / (tp + fp) : null });
  // The lesson's corner: predictive value exactly 100%, different base rates, all three equal.
  const a = of([50, 50, 25, 0]), b = of([30, 70, 15, 0]);
  assert.notEqual(a.base, b.base);
  assert.deepEqual([a.ppv, a.fpr, a.fnr], [1, 0, 0.5]);
  assert.deepEqual([b.ppv, b.fpr, b.fnr], [1, 0, 0.5]);
  assert.equal(fprFromEquation(a), 0, 'and the equation holds there');
  assert.equal(fprFromEquation(b), 0);
  // Predictive value 0 also matches, and there the equation is undefined rather than wrong.
  const c = of([50, 50, 0, 25]), d = of([30, 70, 0, 35]);
  assert.deepEqual([c.ppv, c.fpr, c.fnr], [0, 0.5, 1]);
  assert.deepEqual([d.ppv, d.fpr, d.fnr], [0, 0.5, 1]);
  assert.equal(fprFromEquation(c), null);
  // Anywhere strictly between, equal predictive value and false negatives force the false positives apart.
  for (const ppv of [0.1, 0.5, 0.63, 0.99]) for (const fnr of [0, 0.3, 0.9]) {
    const x = fprFromEquation({ base: 0.51, ppv, fnr })!, y = fprFromEquation({ base: 0.39, ppv, fnr })!;
    assert.ok(x > 0 && y > 0 && Math.abs(x - y) > 1e-9, `ppv ${ppv} fnr ${fnr}`);
  }
});

test('the debrief says equal base rates only make it possible: other spreads of scores, same base rate, come apart', () => {
  const g = (name: string, people: number[]): Group => ({ name, levels: people.map((n, i) => ({ people: n, wrong: n * CHANCE[i] })) });
  const a = g('A', [100, 100, 100, 100, 100, 100, 100, 100, 100, 100]), b = g('B', [0, 0, 0, 0, 500, 500, 0, 0, 0, 0]);
  assert.ok(Math.abs(rates(a, 6).base - rates(b, 6).base) < 1e-12, 'the same base rate');
  const d = { id: 'spread', label: '', a, b };
  assert.equal(compare(d, 6, 6).all, false);
  assert.ok(compare(d, 6, 6).fprGap > 0.1);
  assert.equal(DATASETS[1].a.levels.every((l, i) => l.people === DATASETS[1].b.levels[i].people), true, 'the lab\'s own same-base-rate groups are identical, as its label says');
});

test('the line under the table used to say "undefined and undefined. It always agrees with the table" when nobody was flagged', () => {
  const d = DATASETS[0];
  assert.match(equationNote(rates(d.a, 11), rates(d.b, 11)), /nothing to work from/);
  assert.match(equationNote(rates(d.a, 5), rates(d.b, 11)), /nothing to work from/);
  for (let ta = 1; ta <= 10; ta++) for (let tb = 1; tb <= 10; tb++) {
    const a = rates(d.a, ta), b = rates(d.b, tb);
    const line = equationNote(a, b);
    assert.ok(line.includes(`${(a.fpr * 100).toFixed(1)}% and ${(b.fpr * 100).toFixed(1)}%`), line);
  }
});

test('step one needs the two groups on one threshold, on the different-base-rate data', () => {
  const fresh = new FairnessLab();
  fresh.use('same');
  fresh.set(5, 5);
  assert.equal(fresh.sawSameScoreGap, false);
  const extremes = new FairnessLab();
  extremes.set(1, 1);
  extremes.set(11, 11);
  assert.equal(extremes.sawSameScoreGap, false, 'flagging everyone or nobody shows no gap worth reading');
});
