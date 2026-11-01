// The first algorithm lessons' code. Every program a lesson prints runs here through
// the sandbox and through real Python, and each mission's expected answers come from
// a real Python tool rather than from the same reasoning that wrote the mission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PyProgram } from '../src/lib/py/vm.ts';
import { classify, measureGrowth, runAll, toPy } from '../src/lib/py/lab.ts';
import { repr } from '../src/lib/py/values.ts';
import { CODE_MISSIONS, type CodeState } from '../src/lib/cs/missions.ts';
import { BRACKET_CASES, FIND_CASES, PARCEL_CASES, ZUNE_CASES, findShape } from '../src/lib/cs/alg-foundations.ts';

function findPython(): string {
  for (const c of ['python3', 'python']) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return c;
  }
  throw new Error('No Python 3 found; these tests compare against the real interpreter and cannot pass without it');
}
const PY = findPython();
function python(src: string, input = ''): string {
  const r = spawnSync(PY, ['-I', '-X', 'utf8', '-c', src], { encoding: 'utf8', input, maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.replace(/\r\n/g, '\n');
}

const play = (name: string, ...moves: ((s: CodeState) => void)[]) => {
  const m = CODE_MISSIONS[name], s = m.setup();
  return moves.map((mv) => { mv(s); return m.steps.map((st) => st.done(s)); });
};
const list = (n: number) => [Array.from({ length: n }, (_, i) => i)];
const ran = (src: string) => (s: CodeState) => { s.runs.push(runAll(src)); };
const measured = (src: string, fn: string, sizes: number[]) => (s: CodeState) => {
  s.runs.push(runAll(src));
  const points = measureGrowth(src, fn, sizes, list);
  s.growth.push({ src, fn, points, shape: classify(points) });
};

// ---- every code lab in these lessons, against real Python -----------------

const LESSONS = ['what-is-an-algorithm', 'arrays-and-lists', 'stacks-and-queues', 'searching'];
const labPrograms = (slug: string) => {
  const text = readFileSync(join('src/content/lessons/algorithms', `${slug}.mdx`), 'utf8');
  return [...text.matchAll(/<CodeLab code=\{`([\s\S]*?)`\}/g)].map((m) => m[1].replace(/\\`/g, '`').replace(/\\\\/g, '\\'));
};

test('each lesson is really being read: the pattern finds its code labs', () => {
  assert.ok(readdirSync('src/content/lessons/algorithms').includes('searching.mdx'));
  assert.ok(labPrograms('what-is-an-algorithm').length >= 3);
  assert.ok(labPrograms('arrays-and-lists').length >= 1);
  assert.ok(labPrograms('stacks-and-queues').length >= 2);
});

for (const slug of LESSONS) {
  test(`${slug}: its code labs print the same in the sandbox and in real Python`, () => {
    for (const src of labPrograms(slug)) {
      const p = new PyProgram(src);
      p.run();
      assert.notEqual(p.status, 'budget', src);
      const r = spawnSync(PY, ['-I', '-X', 'utf8', '-c', src], { encoding: 'utf8' });
      assert.equal(p.stdout, r.stdout.replace(/\r\n/g, '\n'), `stdout differs for:\n${src}`);
      const realErr = (r.stderr ?? '').trim().split(/\r?\n/).at(-1)?.split(':')[0] ?? '';
      assert.equal(p.error?.type ?? '', realErr, `error differs for:\n${src}`);
    }
  });
}

test('the numbers the lessons state about their labs are the ones the labs print', () => {
  const out = (slug: string, marker: string) => {
    const src = labPrograms(slug).find((p) => p.includes(marker));
    assert.ok(src, `no lab with ${marker} in ${slug}`);
    return python(src);
  };
  assert.match(out('what-is-an-algorithm', 'bottles'), /^1 bottles of beer on the wall/m);
  assert.equal(out('what-is-an-algorithm', 'sorted'), "['Banana', 'apple', 'cherry']\n0 2 2 4\n");
  assert.equal(out('what-is-an-algorithm', 'put_a'), '111 111\n111 222\n');
  assert.equal(out('arrays-and-lists', 'add_front'), '[10, [20, [30, None]]]\n30\n');
  assert.equal(out('stacks-and-queues', 'simulate'), 'oldest first: (21, 39)\nnewest first: (60, 0)\n');
  const text = readFileSync('src/content/lessons/algorithms/stacks-and-queues.mdx', 'utf8');
  assert.match(text, /gives 21 useful answers and 39 wasted/);
  assert.match(text, /gives 60 useful answers/);
});

for (const name of ['alg-what-last-day', 'alg-lists-newest-first', 'alg-stack-brackets', 'alg-queue-parcel', 'alg-search-halving']) {
  test(`${name}: the starter prints the same in the sandbox and in real Python`, () => {
    const src = CODE_MISSIONS[name].starter!;
    assert.equal(runAll(src).stdout, python(src));
  });
  test(`${name}: no step is done before anything ran`, () => {
    const m = CODE_MISSIONS[name], s = m.setup();
    assert.ok(m.steps.every((st) => !st.done(s)));
  });
}

// ---- the last day of a leap year ------------------------------------------

const ZUNE = CODE_MISSIONS['alg-what-last-day'].starter!;
const hang = (day: number) => ZUNE.replace('year_from_days(10000)', `year_from_days(${day})`);

test('the code hangs on the last day of a leap year and on no other, checked against datetime', () => {
  // The blog post that reproduces this code does not say how `days` is produced.
  // Counting 1 January 1980 as day 1 is the reading that puts the hang on 31
  // December 2008, the date Microsoft reported. Zero-based would put it on 1 January.
  const dates = python(`
import datetime
start = datetime.date(1980, 1, 1)
for d in range(1, 12001):
    x = start + datetime.timedelta(days=d - 1)
    print(d, x.year, x.month, x.day)
`).trim().split('\n').map((l) => l.split(' ').map(Number));
  for (const [d, y, mo, da] of dates) {
    const stuck = (() => {
      let days = d, year = 1980;
      const leap = (v: number) => v % 4 === 0 && (v % 100 !== 0 || v % 400 === 0);
      while (days > 365) {
        if (leap(year)) { if (days > 366) { days -= 366; year += 1; } else return true; }
        else { days -= 365; year += 1; }
      }
      return false;
    })();
    const lastDayOfLeapYear = mo === 12 && da === 31 && y % 4 === 0;
    assert.equal(stuck, lastDayOfLeapYear, `day ${d} is ${y}-${mo}-${da}`);
  }
  assert.deepEqual(dates[10592], [10593, 2008, 12, 31]);
  assert.deepEqual(dates[9999], [10000, 2007, 5, 18]);
});

test("the mission's expected years are what datetime says", () => {
  const real = python(`
import datetime, json, sys
for c in json.load(sys.stdin):
    print((datetime.date(1980, 1, 1) + datetime.timedelta(days=c["args"][0] - 1)).year)
`, JSON.stringify(ZUNE_CASES)).trim().split('\n');
  ZUNE_CASES.forEach((c, i) => assert.equal(c.want, real[i], `day ${c.args[0]}`));
});

test('the sandbox stops the hang, and the frame shows the stuck values the mission reads', () => {
  const r = runAll(hang(10593));
  assert.equal(r.status, 'budget');
  const frame = r.program.view().find((f) => f.vars.some((v) => v.name === 'days'))!;
  assert.equal(frame.vars.find((v) => v.name === 'days')?.value, '366');
  assert.equal(frame.vars.find((v) => v.name === 'year')?.value, '2008');
});

test('mission: the real fix passes; fixes that only stop the hang do not', () => {
  const fixed = ZUNE.replace('                year += 1\n        else:', '                year += 1\n            else:\n                break\n        else:');
  assert.notEqual(fixed, ZUNE);
  assert.deepEqual(play('alg-what-last-day', ran(ZUNE), ran(hang(10593)), ran(fixed)), [[true, false, false], [true, true, false], [true, true, true]]);
  const third = (src: string) => play('alg-what-last-day', ran(ZUNE), ran(hang(10593)), ran(src))[2][2];
  assert.equal(third(ZUNE.replace('if days > 366:', 'if days >= 366:')), false, 'calls the last day of 1980 the first of 1981');
  assert.equal(third(ZUNE.replace('while days > 365:', 'while days > 366:')), false, 'stops the hang, gets 1 January wrong after a non-leap year');
  assert.equal(third(ZUNE.replace('def year_from_days(days):\n', 'def year_from_days(days):\n    if days == 10593:\n        return 2008\n')), false, 'hard-coding the famous day leaves the other leap years hanging');
  assert.equal(third(ZUNE), false, 'the unfixed code hangs in a hidden case, and must not be read as a pass');
});

test('mission: an unrelated endless loop does not count as finding the bug', () => {
  const [, hung] = play('alg-what-last-day', ran(ZUNE), ran('while True:\n    pass\n'));
  assert.equal(hung[1], false);
  // A day that doesn't hang never gets there, whatever it prints.
  const [, normal] = play('alg-what-last-day', ran(ZUNE), ran(hang(10592)));
  assert.equal(normal[1], false);
  // Any leap year's last day is the same discovery.
  const [, other] = play('alg-what-last-day', ran(ZUNE), ran(hang(366)));
  assert.equal(other[1], true);
});

// ---- newest first -----------------------------------------------------------

test('mission: inserting at the front is quadratic; a route that moves nothing passes; a fast wrong answer does not', () => {
  const m = CODE_MISSIONS['alg-lists-newest-first'], sizes = [200, 400, 800, 1600];
  const start = m.starter!;
  const appendReverse = start.replace('timeline.insert(0, e)', 'timeline.append(e)').replace('    return timeline', '    timeline.reverse()\n    return timeline');
  const [a, b, c] = play('alg-lists-newest-first', ran(start), measured(start, 'newest_first', sizes), measured(appendReverse, 'newest_first', sizes));
  assert.deepEqual([a, b, c], [[true, false, false], [true, true, false], [true, true, true]]);
  const linked = `def newest_first(events):
    head = None
    for e in events:
        head = [e, head]
    out = []
    while head is not None:
        out.append(head[0])
        head = head[1]
    return out
`;
  const route = (src: string) => play('alg-lists-newest-first', ran(start), measured(start, 'newest_first', sizes), measured(src, 'newest_first', sizes))[2][2];
  assert.equal(route(linked), true, 'a real linked list is a correct route');
  assert.equal(route('def newest_first(events):\n    return events[::-1]\n'), true);
  assert.equal(route('def newest_first(events):\n    out = []\n    for e in events:\n        out.append(e)\n    return out\n'), false, 'linear and in the wrong order');
  assert.equal(route(start), false, 'unchanged');
});

// ---- brackets ---------------------------------------------------------------

const BRACKETS = `def balanced(text):
    pairs = {")": "(", "]": "[", "}": "{"}
    stack = []
    for ch in text:
        if ch in "([{":
            stack.append(ch)
        if ch in ")]}":
            if len(stack) == 0 or stack.pop() != pairs[ch]:
                return False
    return len(stack) == 0
`;

test('mission: a stack passes, the depth counter does not, and the cases hold in real Python', () => {
  const m = CODE_MISSIONS['alg-stack-brackets'];
  assert.deepEqual(play('alg-stack-brackets', ran(m.starter!), ran(BRACKETS)), [[true, false], [true, true]]);
  const real = python(`${BRACKETS}
import json, sys
for c in json.load(sys.stdin):
    print(balanced(c["args"][0]))
`, JSON.stringify(BRACKET_CASES)).trim().split('\n');
  BRACKET_CASES.forEach((c, i) => assert.equal(c.want, real[i], JSON.stringify(c.args)));
  // Tracks which kind is open but not the order, so ([)] gets through.
  const kinds = BRACKETS.replace('if len(stack) == 0 or stack.pop() != pairs[ch]:', 'if pairs[ch] not in stack:\n                return False\n            stack.remove(pairs[ch])\n            if False:');
  assert.equal(play('alg-stack-brackets', ran(m.starter!), ran(kinds))[1][1], false, 'a bag of openers is not a stack');
  assert.equal(play('alg-stack-brackets', ran(m.starter!), ran('def balanced(text):\n    return True\n'))[1][1], false);
});

// ---- the queue ---------------------------------------------------------------

const PARCEL_SIZES = [100, 200, 400, 800];
const HEAD = `def pass_the_parcel(players):
    queue = []
    for p in players:
        queue.append(p)
    head = 0
    out = []
    while head < len(queue):
        queue.append(queue[head])
        head += 1
        if head < len(queue):
            out.append(queue[head])
            head += 1
    return out
`;
const TWO_LISTS = `def pass_the_parcel(players):
    inbox = []
    for p in players:
        inbox.append(p)
    outbox = []
    def take():
        if len(outbox) == 0:
            while len(inbox) > 0:
                outbox.append(inbox.pop())
        return outbox.pop()
    out = []
    while len(inbox) + len(outbox) > 0:
        inbox.append(take())
        out.append(take())
    return out
`;

test("the mission's expected orders are what collections.deque gives", () => {
  const real = python(`
import json, sys
from collections import deque
for c in json.load(sys.stdin):
    q = deque(c["args"][0]); out = []
    while q:
        q.append(q.popleft()); out.append(q.popleft())
    print(repr(out))
`, JSON.stringify(PARCEL_CASES)).trim().split('\n');
  PARCEL_CASES.forEach((c, i) => assert.equal(c.want, real[i], JSON.stringify(c.args)));
});

test('mission: pop(0) is quadratic; an index and two lists are linear; both pass; wrong orders do not', () => {
  const m = CODE_MISSIONS['alg-queue-parcel'], start = m.starter!;
  const route = (src: string) => play('alg-queue-parcel', ran(start), measured(start, 'pass_the_parcel', PARCEL_SIZES), measured(src, 'pass_the_parcel', PARCEL_SIZES));
  const first = route(HEAD);
  assert.deepEqual(first, [[true, false, false], [true, true, false], [true, true, true]]);
  assert.equal(route(TWO_LISTS)[2][2], true, 'two lists are a correct queue');
  assert.equal(classify(measureGrowth(start, 'pass_the_parcel', PARCEL_SIZES, list)), 'quadratic');
  // Both fixes must run the same in real Python, not only in the sandbox.
  for (const src of [HEAD, TWO_LISTS]) assert.equal(python(`${src}\nprint(pass_the_parcel(list(range(50))))`), runAll(`${src}\nprint(pass_the_parcel(list(range(50))))`).stdout);
  // Tempting: pop() from the end is fast, and it is a stack, not a queue.
  assert.equal(route(start.replaceAll('queue.pop(0)', 'queue.pop()'))[2][2], false, 'fast and last-in-first-out');
  // Returning the input in some order is linear and did no queueing at all.
  assert.equal(route('def pass_the_parcel(players):\n    return list(players)\n')[2][2], false);
  assert.equal(route(start)[2][2], false, 'unchanged');
});

// ---- searching ---------------------------------------------------------------

const BINARY = `def find(items, target):
    low = 0
    high = len(items) - 1
    while low <= high:
        mid = (low + high) // 2
        if items[mid] < target:
            low = mid + 1
        elif items[mid] > target:
            high = mid - 1
        else:
            return mid
    return -1

def worst(items):
    return find(items, len(items))
`;
const SEARCH_SIZES = [1000, 10_000, 100_000];

test("the search cases agree with real bisect", () => {
  const real = python(`
import bisect, json, sys
for c in json.load(sys.stdin):
    a, x = c["args"]
    i = bisect.bisect_left(a, x)
    print(i if i < len(a) and a[i] == x else -1)
`, JSON.stringify(FIND_CASES)).trim().split('\n');
  FIND_CASES.forEach((c, i) => assert.equal(c.want, real[i], JSON.stringify(c.args)));
});

test('mission: a scan is linear, binary search logarithmic and right; off-by-ones and shortcuts do not pass', () => {
  const m = CODE_MISSIONS['alg-search-halving'], start = m.starter!;
  const route = (src: string) => play('alg-search-halving', ran(start), measured(start, 'worst', SEARCH_SIZES), measured(src, 'worst', SEARCH_SIZES));
  assert.deepEqual(route(BINARY), [[true, false, false], [true, true, false], [true, true, true]]);
  assert.equal(findShape(BINARY), 'logarithmic');
  assert.equal(findShape(start), 'linear');
  // The classic slips, each of which passes the visible examples or nearly so.
  assert.equal(route(BINARY.replace('while low <= high:', 'while low < high:'))[2][2], false, 'misses a target left in a one-item range');
  assert.equal(route(BINARY.replace('low = mid + 1', 'low = mid'))[2][2], false, 'never finishes when two items remain');
  // Fast on the learner's measurement and still a scan underneath.
  const shortcut = start.replace('def find(items, target):\n', 'def find(items, target):\n    if len(items) == 0 or target > items[-1]:\n        return -1\n');
  assert.equal(findShape(shortcut), 'linear', 'the hidden measurement must see through an early exit');
  assert.equal(route(shortcut)[2][2], false);
  assert.equal(route(start.replace('for i in range(len(items)):\n        if items[i] == target:\n            return i\n    return -1', 'if target in items:\n        return items.index(target)\n    return -1'))[2][2], false, 'in and index are scans too');
  assert.equal(route(BINARY.replace('return -1', 'return 0'))[2][2], false);
  // Fast, wrong, and proud of it.
  assert.equal(route('def find(items, target):\n    return -1\n\ndef worst(items):\n    return find(items, 0)\n')[2][2], false);
});

test('binary search is Python here too: the sandbox and real Python agree on every case', () => {
  const calls = FIND_CASES.map((c) => `print(find(${c.args.map((a) => repr(toPy(a))).join(', ')}))`).join('\n');
  const src = `${BINARY}\n${calls}\n`;
  assert.equal(runAll(src).stdout, python(src));
});
