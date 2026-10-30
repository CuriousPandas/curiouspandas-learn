import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatenated, parameterised, tokenize, SqlError } from '../src/lib/websec/toysql.ts';
import { dangersOf, asText, type MNode } from '../src/lib/websec/markup.ts';

test('an ordinary name finds one panda either way', () => {
  assert.deepEqual(concatenated('Mei').rows?.map((r) => r.name), ['Mei']);
  assert.deepEqual(parameterised('Mei').rows?.map((r) => r.name), ['Mei']);
});

test("glued in, ' OR '1'='1 rewrites the question and returns every row", () => {
  const r = concatenated("' OR '1'='1");
  assert.equal(r.query, "SELECT name, role FROM pandas WHERE name = '' OR '1'='1'");
  assert.equal(r.rows?.length, 4);
});

test('a -- comment cuts off the closing quote the page added', () => {
  assert.equal(concatenated("Mei' OR 1=1 --").rows?.length, 4);
  assert.deepEqual(concatenated("Lin' --").rows?.map((r) => r.name), ['Lin']);
});

test('as a parameter the same text is just a strange name, and matches nothing', () => {
  for (const evil of ["' OR '1'='1", "Mei' OR 1=1 --"]) {
    const r = parameterised(evil);
    assert.equal(r.query, 'SELECT name, role FROM pandas WHERE name = ?');
    assert.deepEqual(r.params, [evil]);
    assert.deepEqual(r.rows, []);
  }
});

test("injection is also a correctness bug: O'Neil breaks the glued query and works as a parameter", () => {
  const glued = concatenated("O'Neil");
  assert.match(glued.error ?? '', /syntax error|unrecognized token/);
  assert.deepEqual(parameterised("O'Neil").rows?.map((r) => r.name), ["O'Neil"]);
});

test('the toy refuses a second statement rather than silently ignoring it', () => {
  assert.match(concatenated("x'; DROP TABLE pandas --").error ?? '', /one statement/);
  assert.throws(() => tokenize('1; 2'), SqlError);
});

const tag = (t: string, attrs: [string, string][] = [], children: MNode[] = []): MNode => ({ tag: t, attrs, children });

test('event handlers and javascript: links are flagged; plain formatting is not', () => {
  assert.deepEqual(dangersOf(tag('b', [], [{ text: 'hi' }])), []);
  assert.equal(dangersOf(tag('img', [['src', 'x'], ['onerror', 'steal()']]))[0].what, '<img onerror>');
  assert.match(dangersOf(tag('a', [['href', ' JavaScript:steal()']]))[0].what, /javascript:/);
  assert.equal(dangersOf(tag('p', [], [tag('svg', [['onload', 'x()']])])).length, 1, 'nested handlers are found');
  assert.match(dangersOf(tag('script', [], [{ text: 'x()' }]))[0].why, /inert/);
});

test('as text, nothing is markup', () => {
  assert.deepEqual(asText('<img src=x onerror=steal()>'), [{ text: '<img src=x onerror=steal()>' }]);
});
