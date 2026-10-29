// The attention lesson makes three claims a learner can see in the widget;
// these pin them so a change to the hand-set vectors cannot quietly break the
// story the lesson tells.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokens, attentionRow, attentionMatrix, SENTENCES } from '../src/lib/attention/toy.ts';

const argmax = (xs: number[]) => xs.indexOf(Math.max(...xs));

test('every row is a probability distribution and never looks ahead', () => {
  const t = tokens(SENTENCES.hungry);
  for (const [i, row] of attentionMatrix(t).entries()) {
    assert.ok(Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-9, `row ${i} sums to 1`);
    for (let j = i + 1; j < row.length; j++) assert.equal(row[j], 0, `row ${i} sees future token ${j}`);
  }
});

test('"it" cannot decide yet: panda and bamboo get equal weight', () => {
  const t = tokens(SENTENCES.hungry);
  const i = t.findIndex((x) => x.text === 'it');
  const row = attentionRow(t, i);
  const panda = row[t.findIndex((x) => x.text === 'panda')];
  const bamboo = row[t.findIndex((x) => x.text === 'bamboo')];
  assert.ok(Math.abs(panda - bamboo) < 1e-12);
  assert.ok(panda > 0.25, 'and together they dominate the row');
});

test('the last word settles it: hungry looks at panda, tasty looks at bamboo', () => {
  for (const [key, want] of [['hungry', 'panda'], ['tasty', 'bamboo']] as const) {
    const t = tokens(SENTENCES[key]);
    const row = attentionRow(t, t.length - 1);
    assert.equal(t[argmax(row)].text, want, `${key} -> ${t[argmax(row)].text}`);
  }
});

test('more sharpness concentrates the weight', () => {
  const t = tokens(SENTENCES.tasty);
  const last = t.length - 1;
  assert.ok(Math.max(...attentionRow(t, last, 3)) > Math.max(...attentionRow(t, last, 1)));
  assert.ok(Math.max(...attentionRow(t, last, 0.2)) < Math.max(...attentionRow(t, last, 1)));
});
