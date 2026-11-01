// Every mission in the second half of Programming from Zero, played start to finish the
// way a learner would, and judged the way the panel judges it: every step, against the
// latest run, in order. The readable-code mission could never finish. Its last step
// changed a rate that its first two steps still demanded, so finishing step 3 cleared all
// three ticks, the debrief stayed hidden and 60 XP couldn't be earned, while the test for
// it checked each step on its own and passed. So here a tick may never be lost on the way,
// and all of them must hold at once at the end.
//
// The list of missions is read from the lessons, so a new mission can't be left out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROG_MISSIONS, TICKET_PRICE } from '../src/lib/cs/prog-missions.ts';
import { judgeSuite } from '../src/lib/cs/prog-testing.ts';
import { summarise } from '../src/lib/py/lab.ts';
import { PyProgram } from '../src/lib/py/vm.ts';
import { LINUX_MISSIONS } from '../src/lib/shell/missions.ts';

const LESSONS = ['input-and-errors', 'debugging', 'your-first-tests', 'readable-code', 'recursion', 'real-program', 'shell-scripts', 'whose-code'];
const read = (slug: string) => readFileSync(join(import.meta.dirname, '..', 'src', 'content', 'lessons', 'programming', `${slug}.mdx`), 'utf8');
const inLessons = LESSONS.flatMap((slug) => [...read(slug).matchAll(/mission="([^"]+)"/g)].map((m) => m[1]));

type Stage = string | { src: string; stdin?: string[] };

/** What the panel shows: done only in order, every step judged on the latest state. */
function ticks(steps: { done: (s: never) => boolean }[], s: unknown) {
  let n = 0;
  for (const st of steps) { if (!st.done(s as never)) break; n++; }
  return n;
}

function playCode(id: string, stages: Stage[]) {
  const m = PROG_MISSIONS[id];
  assert.ok(m, `no mission ${id}`);
  const s = { runs: [] as ReturnType<typeof summarise>[], growth: [] };
  const seen: number[] = [];
  for (const one of stages) {
    const { src, stdin } = typeof one === 'string' ? { src: one, stdin: m.stdin } : { src: one.src, stdin: one.stdin ?? m.stdin };
    const p = new PyProgram(src, { stdin, given: m.given });
    p.run();
    s.runs.push(summarise(p, src));
    seen.push(ticks(m.steps as never, s));
  }
  return { seen, total: m.steps.length, s, m };
}

const ASK = (last: string) => `def ask_age():
    while True:
        text = input("How old are you? ")
        try:
            age = int(text)
        except ValueError:
            print("Please type a whole number.")
            continue
        if 0 <= age <= 150:
            return age
        print("That can't be right.")

${last}
`;
const ASK_NO_RANGE = ASK('print("You are", ask_age())').replace('if 0 <= age <= 150:', 'if True:');

const REFACTOR_START = PROG_MISSIONS['prog-readable-refactor'].starter!;
const RENAMED = REFACTOR_START.replace('def f(d, r):', 'def late_fee(due_day, returned_day):').replace('x = r - d', 'x = returned_day - due_day').replace('print(f(10, 15))', 'print(late_fee(10, 15))').replace('print(f(10, 50))', 'print(late_fee(10, 50))');
const WITH_DAYS_LATE = `def days_late(due_day, returned_day):
    return max(0, returned_day - due_day)

def late_fee(due_day, returned_day):
    days = days_late(due_day, returned_day)
    if days > 30:
        return 30 * 25 + (days - 30) * 50
    return days * 25

print(late_fee(10, 15))
print(late_fee(10, 50))
`;
const NEW_RATE = `FIRST_RATE = 30
${WITH_DAYS_LATE.replace('return 30 * 25 +', 'return 30 * FIRST_RATE +').replace('return days * 25', 'return days * FIRST_RATE')}`;

const TICKET_ALL = `assert ticket_price(30) == 10
assert ticket_price(3) == 0
assert ticket_price(10) == 5
assert ticket_price(70) == 6
assert ticket_price(4) == 0
assert ticket_price(5) == 5
assert ticket_price(17) == 5
assert ticket_price(18) == 10
assert ticket_price(64) == 10
assert ticket_price(65) == 6
print("all tests passed")
`;

const TRIP_PARTS = {
  parse: `def parse_expense(line, people):
    words = line.split()
    if len(words) < 2:
        raise ValueError(f"can't read: {line}")
    if words[0] not in people:
        raise ValueError(f"nobody called {words[0]} is on this trip")
    return (words[0], to_cents(words[1]))
`,
  balances: `def balances(people, expenses):
    total = sum([cents for name, cents in expenses])
    share = total // len(people)
    extra = total % len(people)
    balance = {}
    for i, person in enumerate(people):
        balance[person] = -share
        if i < extra:
            balance[person] -= 1
    for name, cents in expenses:
        balance[name] += cents
    return balance
`,
  settle: `def settle(balance):
    left = balance.copy()
    payments = []
    while True:
        owed = max(left, key=lambda p: left[p])
        owes = min(left, key=lambda p: left[p])
        if left[owed] == 0:
            return payments
        amount = min(left[owed], -left[owes])
        payments.append((owes, owed, amount))
        left[owed] -= amount
        left[owes] += amount
`,
};
const TRIP = PROG_MISSIONS['prog-real-trip'].starter!;
const tripWith = (...code: string[]) => TRIP.replace('def test_parse_expense():', `${code.join('\n')}\ndef test_parse_expense():`);

const REC = PROG_MISSIONS['prog-rec-trees'].starter!;
const REC_FIXED = REC.replace('result + total(box)', 'result + total(item)');
const DEBUG_H = PROG_MISSIONS['prog-debug-hypothesis'].starter!;
const SWALLOW = PROG_MISSIONS['prog-errors-swallow'].starter!;
const TRACE = PROG_MISSIONS['prog-debug-traceback'].starter!;
const STEP = PROG_MISSIONS['prog-debug-step'].starter!;
const FIRST = PROG_MISSIONS['prog-tests-first'].starter!;
const CATCH = PROG_MISSIONS['prog-whose-catch'].starter!;

const CODE_PLAYS: Record<string, Stage[]> = {
  'prog-errors-ask': [PROG_MISSIONS['prog-errors-ask'].starter!, ASK_NO_RANGE, ASK('print("You are", ask_age())')],
  'prog-errors-swallow': [SWALLOW, SWALLOW.replace('except Exception', 'except ValueError'), SWALLOW.replace('except Exception', 'except ValueError').replace('total = totl + int(line)', 'total = total + int(line)')],
  'prog-debug-traceback': [TRACE, TRACE.replace('return price', 'return float(price)')],
  'prog-debug-step': [STEP, STEP.replace('    return best\n', '    return max(best, current)\n')],
  'prog-debug-hypothesis': [DEBUG_H, `${DEBUG_H}print(without_negatives([-1, -2, -3]))\n`, 'def without_negatives(items):\n    keep = []\n    for x in items:\n        if x >= 0:\n            keep.append(x)\n    return keep\n\nprint(without_negatives([1, -2, -3, 4]))\n'],
  'prog-tests-first': [FIRST, FIRST.replace('    # Write an assert here. What should 200 at 50 percent off cost?\n    pass\n', '    assert price_after_discount(200, 50) == 100\n')],
  'prog-tests-mutants': [PROG_MISSIONS['prog-tests-mutants'].starter!, TICKET_ALL],
  'prog-readable-refactor': [REFACTOR_START, RENAMED, WITH_DAYS_LATE, NEW_RATE],
  'prog-rec-trees': [REC, REC_FIXED, `${REC_FIXED}\ndef depth(box):\n    deepest = 0\n    for item in box:\n        if isinstance(item, list):\n            deepest = max(deepest, depth(item))\n    return deepest + 1\n`],
  'prog-real-trip': [TRIP, tripWith(TRIP_PARTS.parse), tripWith(TRIP_PARTS.parse, TRIP_PARTS.balances), tripWith(TRIP_PARTS.parse, TRIP_PARTS.balances, TRIP_PARTS.settle), { src: tripWith(TRIP_PARTS.parse, TRIP_PARTS.balances, TRIP_PARTS.settle), stdin: ['Mo, Jo', 'Mo 10 lunch', 'done'] }],
  'prog-whose-catch': [CATCH, `${CATCH}assert remove_duplicates([1, 2, 1]) == [1, 2]\n`, `${CATCH}assert remove_duplicates([1, 2, 1]) == [1, 2]\na = [1, 1]\nremove_duplicates(a)\nassert a == [1, 1]\n`],
  'prog-whose-fix': ['def remove_duplicates(items):\n    """Return the list with duplicates removed, keeping the first of each."""\n    seen = []\n    for x in items:\n        if x not in seen:\n            seen.append(x)\n    return seen\n\nprint(remove_duplicates([1, 2, 1]))\n'],
};

const SHELL_PLAYS: Record<string, string[]> = {
  'prog-shell-report': [
    `echo 'grep 500$ access.log | cut -d " " -f 1 | sort | uniq -c | sort -rn | head -1' > report.sh`,
    'bash report.sh', 'chmod u+x report.sh', './report.sh',
    `echo 'grep 500$ "$1" | cut -d " " -f 1 | sort | uniq -c | sort -rn | head -1' > report.sh`, './report.sh access.log',
  ],
  'prog-shell-silent': ['cat cleanup.sh', './cleanup.sh', 'ls', `echo 'cd cache && rm -r * && echo "cache cleaned"' > cleanup.sh`, 'bash cleanup.sh', 'echo $?'],
};

test('every mission in these lessons has a play here: nothing is passing because it was left out', () => {
  assert.ok(inLessons.length >= 14, `only ${inLessons.length} missions found in the lessons`);
  assert.deepEqual([...inLessons].sort(), [...Object.keys(CODE_PLAYS), ...Object.keys(SHELL_PLAYS)].sort());
});

for (const [id, stages] of Object.entries(CODE_PLAYS)) {
  test(`${id}: played start to finish, it ends with every step ticked at once and never loses one`, () => {
    const { seen, total } = playCode(id, stages);
    assert.equal(seen.at(-1), total, `stopped at step ${seen.at(-1)! + 1} of ${total}; ticks after each stage: ${seen.join(', ')}`);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `a tick was lost at stage ${i + 1}: ${seen.join(', ')}`);
    if (stages.length > 1) assert.ok(seen[0] < total, 'the first stage must not finish the mission');
  });
}

for (const [id, lines] of Object.entries(SHELL_PLAYS)) {
  test(`${id}: played start to finish, it ends with every step ticked at once and never loses one`, () => {
    const m = LINUX_MISSIONS[id];
    const s = m.setup();
    const seen = lines.map((line) => { s.sh.run(line); return ticks(m.steps as never, s); });
    assert.equal(seen.at(-1), m.steps.length, `ticks after each line: ${seen.join(', ')}`);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `a tick was lost at "${lines[i]}": ${seen.join(', ')}`);
  });
}

// ---- the named failures

const finishes = (id: string, stages: Stage[]) => { const { seen, total } = playCode(id, stages); return seen.at(-1) === total; };
const reached = (id: string, stages: Stage[]) => playCode(id, stages).seen.at(-1)!;

test('R1: the refactor can be finished in stages, or in one go with the new rate from the start', () => {
  assert.deepEqual(playCode('prog-readable-refactor', [RENAMED, WITH_DAYS_LATE, NEW_RATE]).seen, [1, 2, 3]);
  assert.equal(reached('prog-readable-refactor', [NEW_RATE]), 3);
});

test('R1: missing one copy of the old rate still fails, at the step that is about it', () => {
  const oneMissed = NEW_RATE.replace('return days * FIRST_RATE', 'return days * 25');
  assert.equal(reached('prog-readable-refactor', [oneMissed]), 2);
  const otherMissed = NEW_RATE.replace('return 30 * FIRST_RATE +', 'return 30 * 25 +');
  assert.equal(reached('prog-readable-refactor', [otherMissed]), 2);
  // Some other rate entirely was never the rule, before or after.
  assert.equal(reached('prog-readable-refactor', [NEW_RATE.replace('FIRST_RATE = 30', 'FIRST_RATE = 40')]), 0);
});

test('R5: a days_late that is defined and never called does not pass "have late_fee use it"', () => {
  const unused = `def days_late(due_day, returned_day):\n    return max(0, returned_day - due_day)\n\n${RENAMED}`;
  assert.equal(reached('prog-readable-refactor', [unused]), 1);
  const { m, s } = playCode('prog-readable-refactor', [unused]);
  assert.match(m.steps[1].why!(s as never), /isn't using it/);
  // Called with keywords, as the lesson's own version could be, still counts.
  assert.equal(reached('prog-readable-refactor', [WITH_DAYS_LATE.replace('days_late(due_day, returned_day)\n    if', 'days_late(due_day=due_day, returned_day=returned_day)\n    if')]), 2);
});

test('E1: a program that gives up after three tries and makes up an age does not pass', () => {
  const start = PROG_MISSIONS['prog-errors-ask'].starter!;
  const givesUp = `def ask_age():
    for i in range(3):
        try:
            age = int(input())
            if 0 <= age <= 150:
                return age
        except ValueError:
            pass
    return 0

print("You are", ask_age())
`;
  assert.equal(reached('prog-errors-ask', [start, givesUp]), 1);
});

test('E2: except Exception passes the lab, so the debrief must not say "you caught only ValueError"', () => {
  const start = PROG_MISSIONS['prog-errors-ask'].starter!;
  const wide = ASK('print("You are", ask_age())').replace('except ValueError', 'except Exception');
  assert.ok(finishes('prog-errors-ask', [start, wide]), 'the debrief says this passes');
  assert.doesNotMatch(PROG_MISSIONS['prog-errors-ask'].debrief, /You caught only ValueError/);
});

test('E3: a better last line passes, and a prompt holding the number can\'t fool it', () => {
  const start = PROG_MISSIONS['prog-errors-ask'].starter!;
  assert.ok(finishes('prog-errors-ask', [start, ASK('print("You are", ask_age(), "years old")')]));
  assert.ok(finishes('prog-errors-ask', [start, ASK('age = ask_age()\nprint("You are", age)\nprint("Thanks!")')]));
  // Accepts -3 and prints it. The prompt says 150, and that must not count as an answer of 150.
  const noRange = ASK('print("You are", ask_age())').replace('if 0 <= age <= 150:', 'if True:').replace('"How old are you? "', '"Age, 0 to 150: "');
  assert.equal(reached('prog-errors-ask', [start, noRange]), 2);
  // -41 is not 41.
  const negated = ASK('print("You are", -ask_age())');
  assert.equal(reached('prog-errors-ask', [start, negated]), 1);
});

test('D1: the unmodified starter does not tick the step that asks for a new print', () => {
  assert.equal(reached('prog-debug-hypothesis', [DEBUG_H]), 0);
  // A new print on the still-broken function does.
  assert.equal(reached('prog-debug-hypothesis', [DEBUG_H, `${DEBUG_H}print(without_negatives([-1, -2, -3]))\n`]), 1);
  // Skipping straight to the fix doesn't, and the panel says why rather than sitting there.
  const fixed = 'def without_negatives(items):\n    return [x for x in items if x >= 0]\nprint(without_negatives([1, -2, -3, 4]))\n';
  const { seen, m, s } = playCode('prog-debug-hypothesis', [DEBUG_H, fixed]);
  assert.equal(seen.at(-1), 0);
  assert.match(m.steps[0].why!(s as never), /still broken/);
});

test('D2: repeating the broken loop any small number of times does not pass', () => {
  const repeated = (n: number) => `def without_negatives(items):\n    for t in range(${n}):\n        for x in items:\n            if x < 0:\n                items.remove(x)\n    return items\n`;
  const ready = `${DEBUG_H}print(without_negatives([-1, -2, -3]))\n`;
  for (const n of [2, 4, 8]) assert.equal(reached('prog-debug-hypothesis', [ready, repeated(n)]), 1, `${n} passes`);
  // The mission's comment says nine passes clear its longest list, and that this is a
  // limit of the check. Hold it to what it says.
  assert.equal(reached('prog-debug-hypothesis', [ready, repeated(9)]), 2);
  // Looping until nothing is left to remove is slow and correct, and passes.
  const until = 'def without_negatives(items):\n    while min(items + [0]) < 0:\n        items.remove(min(items))\n    return items\n';
  assert.equal(reached('prog-debug-hypothesis', [ready, until]), 2);
});

test('T1: correct tests of the discount pass on the hidden fixed function', () => {
  for (const check of ['price_after_discount(10, 25) == 7.5', 'price_after_discount(200, 50) == 100', 'price_after_discount(19.99, 50) == 9.995', 'price_after_discount(99, 10) == 89.1']) {
    const src = FIRST.replace('    # Write an assert here. What should 200 at 50 percent off cost?\n    pass\n', `    assert ${check}\n`);
    assert.ok(finishes('prog-tests-first', [FIRST, src]), check);
  }
});

test('T3: the suites that used to finish the mission no longer do', () => {
  const start = PROG_MISSIONS['prog-tests-mutants'].starter!;
  // Exactly on the upper edges and nowhere else: missed age < 4, age < 17 and age < 64.
  const oneSide = 'assert ticket_price(0) == 0\nassert ticket_price(5) == 5\nassert ticket_price(18) == 10\nassert ticket_price(65) == 6\n';
  assert.equal(reached('prog-tests-mutants', [start, oneSide]), 5);
  const j = judgeSuite(oneSide, TICKET_PRICE);
  assert.deepEqual([j.caught.edgeAt4, j.caught.edgeAt17, j.caught.edgeAt64], [false, false, false]);
  // Loose inequalities at both sides of every edge: can't see a wrong price.
  const loose = 'assert ticket_price(0) < 5\nassert ticket_price(4) < 5\nassert ticket_price(5) > 0\nassert ticket_price(17) < 10\nassert ticket_price(18) > 5\nassert ticket_price(64) > 6\nassert ticket_price(65) < 10\n';
  assert.equal(reached('prog-tests-mutants', [start, loose]), 6);
  assert.equal(judgeSuite(loose, TICKET_PRICE).caught.seniorPays7, false);
});

test('T3: what the lesson says about which tests kill what', () => {
  const alive = (tests: string) => Object.entries(judgeSuite(tests, TICKET_PRICE).caught).filter(([, k]) => !k).map(([n]) => n).sort();
  assert.deepEqual(Object.keys(TICKET_PRICE.broken).length, 13);
  // One adult: kills only the version that overcharges adults.
  assert.equal(alive('assert ticket_price(30) == 10\n').length, 12);
  assert.ok(!alive('assert ticket_price(30) == 10\n').includes('adultPays11'));
  // One test in the middle of each band: the six edge mutants live.
  assert.deepEqual(alive('assert ticket_price(3) == 0\nassert ticket_price(10) == 5\nassert ticket_price(30) == 10\nassert ticket_price(70) == 6\n'), ['edgeAt17', 'edgeAt18', 'edgeAt4', 'edgeAt5', 'edgeAt64', 'edgeAt65']);
  // Thirteen is a sample, as the debrief says: these tests all pass on a version wrong only at 40.
  const wrongAt40 = TICKET_PRICE.correct.replace('def ticket_price(age):\n', 'def ticket_price(age):\n    if age == 40:\n        return 0\n');
  const p = new PyProgram(TICKET_ALL, { given: wrongAt40 });
  p.run();
  assert.equal(p.status, 'done');
});

test('T4: the debrief no longer says each mutant has one small change, since some drop a whole rule', () => {
  assert.doesNotMatch(PROG_MISSIONS['prog-tests-mutants'].debrief, /each with one small change/);
  assert.match(PROG_MISSIONS['prog-tests-mutants'].debrief, /thirteen broken ones/);
});

const PROPORTIONAL = `def settle(balance):
    owed = [p for p in balance if balance[p] > 0]
    owes = [p for p in balance if balance[p] < 0]
    total = sum([balance[p] for p in owed])
    payments = []
    for a in owes:
        for b in owed:
            amount = -balance[a] * balance[b] // total
            if amount > 0:
                payments.append((a, b, amount))
    left = balance.copy()
    for a, b, c in payments:
        left[a] += c
        left[b] -= c
    for a in owes:
        for b in owed:
            if left[a] < 0 and left[b] > 0:
                c = min(-left[a], left[b])
                payments.append((a, b, c))
                left[a] += c
                left[b] -= c
    return payments
`;
const ONE_CENT = `def settle(balance):
    left = balance.copy()
    payments = []
    while True:
        owed = [p for p in left if left[p] > 0]
        owes = [p for p in left if left[p] < 0]
        if not owed:
            return payments
        payments.append((owes[0], owed[0], 1))
        left[owes[0]] += 1
        left[owed[0]] -= 1
`;

test('P1: any payments that reach 0 count, as the lesson says: more than the fewest, or a cent at a time', () => {
  const run = (settle: string) => reached('prog-real-trip', [TRIP, tripWith(TRIP_PARTS.parse, TRIP_PARTS.balances, settle)]);
  assert.equal(run(PROPORTIONAL), 4, 'a correct settle that splits each debt in proportion was refused by a hidden cap');
  assert.equal(run(ONE_CENT), 4, 'the visible test demanded one exact list, which stopped this one');
});

test('P1: settle is still held to what it says: wrong sums, a payment to yourself, and each reason is given', () => {
  const run = (settle: string) => playCode('prog-real-trip', [TRIP, tripWith(TRIP_PARTS.parse, TRIP_PARTS.balances, settle)]);
  const none = run('def settle(balance):\n    return []\n');
  assert.equal(none.seen.at(-1), 3);
  assert.match(none.m.steps[3].why!(none.s as never), /aren't at 0/);
  const selfPay = run(`def settle(balance):\n    first = list(balance)[0]\n    return ${'['}(first, first, 1)] + (${TRIP_PARTS.settle.split('\n').slice(1).join('\n').length ? 'real_settle(balance)' : ''})\n${TRIP_PARTS.settle.replace('def settle', 'def real_settle')}`);
  assert.equal(selfPay.seen.at(-1), 3);
  assert.match(selfPay.m.steps[3].why!(selfPay.s as never), /paying themselves/);
  const negative = run(TRIP_PARTS.settle.replace('payments.append((owes, owed, amount))', 'payments.append((owed, owes, -amount))'));
  assert.equal(negative.seen.at(-1), 3);
  assert.match(negative.m.steps[3].why!(negative.s as never), /positive whole number/);
});

test('W1: the mission debrief makes no claim of how the code was made that the site contradicts', () => {
  const debrief = PROG_MISSIONS['prog-whose-catch'].debrief;
  assert.doesNotMatch(debrief, /by hand|Nobody ran an AI/);
  assert.match(debrief, /written with AI help/);
  // Anywhere else in these lessons or missions that a how-it-was-made claim could creep in.
  const everything = LESSONS.map(read).join('\n') + Object.values(PROG_MISSIONS).map((m) => m.debrief).join('\n') + Object.values(LINUX_MISSIONS).map((m) => m.debrief).join('\n');
  assert.doesNotMatch(everything, /wrote (it|this|them) by hand|hand-written|handwritten|no AI was|done by hand/i);
});

test('W11: the starter doesn\'t point at an example in the description, because there isn\'t one', () => {
  assert.doesNotMatch(CATCH, /example in the description/);
  assert.doesNotMatch(read('whose-code'), /example in its description/);
});

test('W12: a set comprehension is wrong on real Python, so it can\'t pass here, and it says why', () => {
  const setComp = 'def remove_duplicates(items):\n    return list({x for x in items})\n';
  const r = playCode('prog-whose-fix', [setComp]);
  assert.equal(r.seen.at(-1), 0);
  assert.match(r.m.steps[0].why!(r.s as never), /promise no order/);
});

// These started as "the sandbox can't do this yet" messages. The engine gained both,
// and a message saying otherwise would have told a learner a right answer was missing.
test('W12: dict.fromkeys is a correct fix and passes; {*items} is a set and does not', () => {
  const fromkeys = playCode('prog-whose-fix', ['def remove_duplicates(items):\n    return list(dict.fromkeys(items))\n\nremove_duplicates([1])\n']);
  assert.equal(fromkeys.seen.at(-1), 1);
  const star = playCode('prog-whose-fix', ['def remove_duplicates(items):\n    return list({*items})\n']);
  assert.equal(star.seen.at(-1), 0, 'looks right only because this sandbox keeps set order');
  assert.match(star.m.steps[0].why!(star.s as never), /Real Python's sets promise no order/);
});

// ---- the shell missions' hidden machines

const silent = (lines: string[]) => {
  const m = LINUX_MISSIONS['prog-shell-silent'];
  const s = m.setup();
  for (const l of lines) s.sh.run(l);
  return ticks(m.steps as never, s);
};

test('S10: a fix that names the files it saw, or deletes the folder itself, does not pass', () => {
  assert.equal(silent(['./cleanup.sh', `echo 'cd cache && rm a.tmp b.tmp' > cleanup.sh`, 'bash cleanup.sh', 'echo $?']), 1, 'names the files on show');
  assert.equal(silent(['./cleanup.sh', `echo 'rm -r cache && echo "cache cleaned"' > cleanup.sh`, 'bash cleanup.sh', 'echo $?']), 1, 'deletes the folder it was meant to empty');
  // Folders inside it have to go as well, which rm -r * does and rm * doesn't.
  assert.equal(silent(['./cleanup.sh', `echo 'cd cache && rm *' > cleanup.sh`, 'bash cleanup.sh', 'echo $?']), 1, 'leaves a folder behind');
});

test('S4: the hint uses "$1", in quotes, the way the lesson says to', () => {
  const report = LINUX_MISSIONS['prog-shell-report'];
  assert.match(report.steps[3].hint!, /"\$1"/);
});
