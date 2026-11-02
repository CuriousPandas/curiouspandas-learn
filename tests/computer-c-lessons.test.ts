// What these six lessons state, checked against what computes it. Every code sample runs in
// the lab and in real Python, every number quoted from a formula is recomputed, and each
// lesson keeps the promises the brief asks of it. A table that drifts from its code is a
// false statement to a learner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PyProgram } from '../src/lib/py/vm.ts';
import { TRACKS } from '../src/data/tracks.ts';
import { amdahl, allInterleavings, instructionsForAdd, runLanes, lanePattern } from '../src/lib/cs/parallel.ts';
import { GREEN500_TOP, joulesPerFlop, landauer, timesLandauer, wattHoursToJoules, GEMINI_MEDIAN_WH } from '../src/lib/cs/energy.ts';
import { groverBestRounds, stateBytes } from '../src/lib/cs/qubit.ts';
import { python, runPython } from './helpers/python.ts';

python();

const LESSONS = ['tiny-compiler-parse', 'tiny-compiler-generate', 'speculation-leak', 'many-small-brains', 'energy', 'qubits'];
const read = (slug: string) => readFileSync(`src/content/lessons/computer/${slug}.mdx`, 'utf8');
// The frontmatter goes too: a source's title can say "tensor" without the lesson needing it.
const stripGoDeeper = (s: string) => s.replace(/^---[\s\S]*?\n---\n/, '').replace(/<GoDeeper[\s\S]*?<\/GoDeeper>/g, '');

for (const slug of LESSONS) {
  const src = read(slug);

  test(`${slug}: every code sample prints the same in the lab and in real Python`, () => {
    for (const m of src.matchAll(/code=\{`([\s\S]*?)`\}/g)) {
      const r = runPython(m[1]);
      const p = new PyProgram(m[1]);
      p.run();
      assert.equal(r.status, 0, r.stderr);
      assert.equal(p.status, 'done', p.error?.message);
      assert.equal(p.stdout, r.stdout, m[1]);
    }
    for (const m of src.matchAll(/```python\n([\s\S]*?)```/g)) {
      const r = runPython(m[1]);
      assert.equal(r.status, 0, `${r.stderr}\n${m[1]}`);
      assert.ok(r.stdout.length > 0, 'printed something');
    }
  });

  test(`${slug}: follows the site's writing rules`, () => {
    assert.ok(!src.includes('—'), 'no em dashes');
    assert.doesNotMatch(src, /\bsimply\b/i);
    assert.match(src, /^builds_on: \[.*\]$/m);
    assert.match(src, /<GoDeeper/);
    assert.match(src, /## What to remember/);
    assert.match(src, /<Quiz/);
    assert.match(src, /kind="trap"/);
    assert.match(src, /kind="real"/);
  });

  test(`${slug}: no quiz needs what is only in GoDeeper, and every source has a URL`, () => {
    const outside = stripGoDeeper(src);
    assert.equal((outside.match(/<Quiz/g) ?? []).length, (src.match(/<Quiz/g) ?? []).length);
    const titles = [...src.matchAll(/^ {2}- title: (.+)$/gm)];
    const urls = [...src.matchAll(/^ {4}url: (https?:\/\/\S+)$/gm)];
    assert.ok(titles.length >= 3, 'sources listed');
    assert.equal(titles.length, urls.length);
  });

  test(`${slug}: is listed as ready under its own title`, () => {
    const entry = TRACKS.find((t) => t.id === 'computer')!.lessons.find((l) => l.slug === slug)!;
    assert.equal(entry.status, 'ready');
    const title = /^title: "?(.+?)"?$/m.exec(src)![1];
    assert.equal(title, entry.title);
  });
}

test('parse: the opening sample shows what the lesson says it shows', () => {
  const r = runPython('print(-2 ** 2)\nprint((-2) ** 2)\nprint(2 ** 3 ** 2)\nprint(10 - 3 - 2)\n');
  assert.equal(r.stdout, '-4\n4\n512\n5\n');
});

test('generate: the worked listing and the dis claims hold', () => {
  const src = read('tiny-compiler-generate');
  assert.match(src, /stack: 1 6/);
  assert.match(src, /stack: 7/);
  assert.match(src, /6,000 expressions/);
  // The test it describes really does generate this many.
  assert.match(readFileSync('tests/tinycomp.test.ts', 'utf8'), /length: 6000/);
  assert.match(src, /five routes/);
});

test('many-small-brains: the table and quoted figures are the formula\'s', () => {
  const src = read('many-small-brains');
  const row = (p: number) => [8, 64, 1024].map((n) => amdahl(p, n).toFixed(2)).join(' | ');
  assert.ok(src.includes(`| 50% | ${row(0.5)} | 2 |`), row(0.5));
  assert.ok(src.includes(`| 90% | ${row(0.9)} | 10 |`), row(0.9));
  assert.ok(src.includes(`| 99% | ${row(0.99)} | 100 |`), row(0.99));
  assert.equal(amdahl(0.95, 20).toFixed(2), '10.26');
  assert.equal(amdahl(0.95, 1020).toFixed(1), '19.6');
  assert.equal(allInterleavings().length, 20);
  assert.equal(allInterleavings().filter((o) => o.final === 1).length, 18);
  assert.equal(instructionsForAdd(1000, 8), 125);
  assert.equal(runLanes(lanePattern('uniform', 1024), 8).speedup, 8);
  assert.equal(runLanes(lanePattern('alternating', 1024), 8).speedup, 4);
});

test('energy: the stated figures are the formula\'s, and the sample prints the stated limit', () => {
  const src = read('energy');
  assert.equal(landauer(300).toExponential(2), '2.87e-21');
  assert.match(src, /2\.87 × 10⁻²¹/);
  const fence = /```python\n([\s\S]*?)```/.exec(src)![1];
  assert.equal(Number(runPython(fence).stdout.trim()).toExponential(2), '2.87e-21');
  assert.equal(wattHoursToJoules(GEMINI_MEDIAN_WH).toFixed(0), '864');
  assert.match(src, /864 joules/);
  assert.ok(3 / 0.24 > 10, 'more than ten times apart');
  const flop = joulesPerFlop(GREEN500_TOP.gflopsPerWatt);
  assert.equal((flop * 1e12).toFixed(1), '13.6');
  assert.ok(flop / (64 * landauer(300)) > 70e6);
  assert.match(src, /13\.6 pJ/);
  assert.match(src, /73\.282/);
  // DRAM against the whole instruction: "roughly 20 to 40 times".
  assert.ok(1300 / 70 > 18 && 2600 / 70 < 38);
  assert.equal(timesLandauer(3.7e-12, 32)!.toPrecision(1), '4e+7');
  assert.equal((1700 / 700).toFixed(1), '2.4');
  // Overlaps with the fairness lesson's Ethereum section by link, not by repeating it.
  assert.match(src, /\/learn\/algorithms\/algorithms-and-people\//);
  assert.doesNotMatch(src, /99\.988/);
});

test('qubits: the numbers quoted come from the simulator', () => {
  const src = read('qubits');
  assert.equal(stateBytes(30), 16 * 2 ** 30);
  assert.match(src, /30 qubits take 16 GiB/);
  assert.equal(Math.round((Math.PI / 4) * Math.sqrt(1e6)), 785);
  assert.ok(Math.abs(groverBestRounds(1e6) - 785) <= 1);
  assert.match(src, /about 800 looks/);
  assert.match(src, /tries all the answers at once/);
});

test('speculation: the lab is labelled a model, and the lesson carries no exploit recipe', () => {
  const src = read('speculation-leak');
  assert.match(src, /\*\*The lab here is a model/);
  assert.match(src, /can't and mustn't/);
  // The instruction-level ingredients of a real attack have no place in this lesson.
  assert.doesNotMatch(src, /rdtsc|clflush|_mm_clflush|mfence|__asm|asm\s*\(/i);
  // Cost claims appear as a contested range, not a single figure.
  assert.match(src, /0\.28%/);
  assert.match(src, /factor of 4 or more/);
  assert.match(src, /1-20%/);
});

// The accuracy review's text findings, pinned by what went wrong, so they can't drift back.
test('review: RSA-2048 is stated at both ends of the paper\'s figure, with its time and its caveat', () => {
  const src = read('qubits');
  assert.match(src, /about 11,000 qubits taking about 43,000 days, roughly 118 years/);
  assert.match(src, /about 102,000 qubits taking 97 days/);
  assert.match(src, /"these estimates are preliminary"/);
  assert.match(src, /9,739 qubits, is for a different problem/);
  assert.equal(Math.round(43000 / 365.25), 118);
  // "as few as 10,000" under this heading, with nothing beside it, read as RSA falling to 10,000 qubits.
  assert.doesNotMatch(src, /for Shor's algorithm at cryptographic sizes/);
});

test('review: the Sycamore story reaches its latest dated claim, and the rest of qubits holds', () => {
  const src = read('qubits');
  assert.match(src, /June 2024/);
  assert.match(src, /"7 times faster than" Sycamore/);
  assert.doesNotMatch(src, /still far faster, and comparisons depend[^.]*\. But/);
  assert.match(src, /2406\.18889/);
  assert.match(src, /National Science Review/);
  // Grover works on a list with no structure, and that's what makes it Grover.
  assert.doesNotMatch(src, /only works for problems with a structure/);
  assert.doesNotMatch(read('qubits'), /makes the second amplitude negative/);
  // The draft was finalised on 27 October 2026.
  assert.match(src, /finalised in October 2026/);
  assert.match(src, /nistpubs\/ir\/2026\/NIST\.IR\.8547\.pdf/);
  assert.doesNotMatch(src, /A draft NIST report/);
});

test('review: fair summaries in the compiler and Spectre lessons', () => {
  const gen = read('tiny-compiler-generate');
  assert.doesNotMatch(gen, /every one of them/);
  assert.match(gen, /under-development version of CompCert is the only compiler we have tested/);
  assert.match(gen, /with x as 10/);
  // Which instruction carries the 14 depends on the version, so the lesson says which it saw.
  assert.match(gen, /On 3\.11\.9 that's `LOAD_CONST` of 14/);
  assert.match(gen, /`RETURN_CONST`/);
  const parse = read('tiny-compiler-parse');
  assert.doesNotMatch(parse, /Python reports the bracket/);
  assert.match(parse, /Python reports the `\*` in `1 \+ \* \(2`/);
  assert.match(parse, /didn't run Excel/);
  assert.doesNotMatch(parse, /recursive descent is one strategy among several/);
  const spec = read('speculation-leak');
  assert.doesNotMatch(spec, /chips everywhere/);
  assert.doesNotMatch(spec, /interested parties/);
  // Intel's page refused us, so nothing may be stated from it. It's a link, not a source.
  assert.match(spec, /couldn't read it/);
  assert.doesNotMatch(spec, /Lists the CVE numbers/);
  assert.doesNotMatch(spec.slice(0, spec.indexOf('\n---\n', 4)), /intel\.com/);
  assert.match(spec, /current processors exceed our levels of understanding/);
  assert.match(read('many-small-brains'), /gets little or nothing from a second core/);
});

test('review: the energy lesson counts its bits one way and keeps its units', () => {
  const src = read('energy');
  assert.doesNotMatch(src, /erases nothing logically/);
  assert.doesNotMatch(src, /no limit applies/);
  assert.match(src, /about 7 to 14 billion/);
  assert.doesNotMatch(src, /operations per watt/);
  assert.match(src, /each second for each watt/);
  assert.doesNotMatch(src, /entire system including/);
  assert.match(src, /when that bit could equally well be 0 or 1/);
  assert.match(src, /a job of a fixed number of cycles/);
  assert.match(src, /grew by 17% in 2025/);
  assert.match(readFileSync('src/components/JouleLab.astro', 'utf8'), /belongs to its own conditions/);
  // 415 to 485 TWh is the 17% the IEA reports, so its two figures agree.
  assert.equal(Math.round((485 / 415 - 1) * 100), 17);
});

test('promises to other lessons point at ones that exist and are ready', () => {
  const ready = new Set(TRACKS.flatMap((t) => t.lessons.filter((l) => l.status === 'ready').map((l) => `${t.id}/${l.slug}`)));
  for (const slug of LESSONS) {
    for (const m of read(slug).matchAll(/\]\(\/learn\/([a-z0-9-]+\/[a-z0-9-]+)\/?\)/g)) assert.ok(ready.has(m[1]), `${slug} links to ${m[1]}`);
  }
});

test('qubits and energy: complex numbers and derivations stay in GoDeeper', () => {
  const q = stripGoDeeper(read('qubits'));
  assert.doesNotMatch(q, /complex number|tensor|unitary|Bloch/i);
  const e = stripGoDeeper(read('energy'));
  assert.doesNotMatch(e, /entropy/i);
});
