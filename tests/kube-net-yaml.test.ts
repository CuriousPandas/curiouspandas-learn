// The sandbox's YAML reader against PyYAML 6.0.3. The fixture was written by
// tests/fixtures/kube-net-yaml.py (re-run it to regenerate). Every document the
// reader accepts must read exactly as PyYAML reads it; the documents YAML 1.1
// and 1.2 disagree about (yes, on, 0777, 1e3...) and the features the reader
// lacks must be refused with a YamlError, never read some other way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAll, YamlError, dump, parse } from '../src/lib/kube-net/yaml.ts';

type Case = { src: string; ok?: unknown[]; error?: string };
const fx = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'kube-net-yaml.json'), 'utf8')) as { pyyaml: string; cases: Case[]; refuse: Case[]; fuzz: Case[] };

test('the fixture came from PyYAML 6.0.3', () => assert.equal(fx.pyyaml, '6.0.3'));

test('hand-written documents read exactly as PyYAML reads them', () => {
  for (const c of fx.cases) {
    assert.ok(c.ok, `PyYAML rejected a hand case: ${c.src}`);
    assert.deepEqual(parseAll(c.src), c.ok, c.src);
  }
});

test('ambiguous words and missing features are refused, never guessed', () => {
  for (const c of fx.refuse) {
    assert.throws(() => parseAll(c.src), YamlError, `accepted ${JSON.stringify(c.src)}, which PyYAML reads as ${JSON.stringify(c.ok)}`);
  }
  // The message says what to do, by name.
  assert.throws(() => parse('enabled: yes\n'), /"yes" means true or false to some YAML readers and a string to others; quote it/);
  assert.throws(() => parse('a: 1\na: 2\n'), /duplicate key "a"/);
});

test('400 generated documents (seeded) read exactly as PyYAML reads them', () => {
  assert.equal(fx.fuzz.length, 400);
  let n = 0;
  for (const c of fx.fuzz) {
    assert.ok(c.ok, `generator made something PyYAML rejects: ${c.src}`);
    assert.deepEqual(parseAll(c.src), c.ok, c.src);
    n++;
  }
  assert.equal(n, 400);
});

test('dump writes what parse reads back', () => {
  for (const c of [...fx.cases, ...fx.fuzz]) for (const d of c.ok ?? []) assert.deepEqual(parse(dump(d as never)), d);
});
