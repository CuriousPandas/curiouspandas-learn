// Plays each Programming from Zero mission the way a learner might: the honest
// solution must pass, and each tempting shortcut must not. A check that passes
// because nothing happened is a bug, so every mission is also played doing nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PROG_MISSIONS, REMOVE_DUPLICATES, TICKET_PRICE, TRIP_STDIN } from '../src/lib/cs/prog-missions.ts';
import { judgeSuite, runSuite } from '../src/lib/cs/prog-testing.ts';
import { summarise } from '../src/lib/py/lab.ts';
import { PyProgram } from '../src/lib/py/vm.ts';
import { LINUX_MISSIONS } from '../src/lib/shell/missions.ts';

type S = { runs: ReturnType<typeof summarise>[]; growth: never[] };
function play(id: string, ...programs: (string | { src: string; stdin?: string[] })[]) {
  const m = PROG_MISSIONS[id];
  assert.ok(m, `no mission ${id}`);
  const s: S = { runs: [], growth: [] };
  for (const one of programs) {
    const { src, stdin } = typeof one === 'string' ? { src: one, stdin: m.stdin } : { src: one.src, stdin: one.stdin ?? m.stdin };
    const p = new PyProgram(src, { stdin, given: m.given });
    p.run();
    s.runs.push(summarise(p, src));
  }
  return { steps: () => {
    // Shown done only in order, as the mission panel does.
    let ok = true;
    return m.steps.map((st) => (ok = ok && st.done(s as never)));
  }, count: () => { let n = 0; for (const st of m.steps) { if (!st.done(s as never)) break; n++; } return n; } };
}
const allDone = (id: string, ...p: Parameters<typeof play> extends [string, ...infer R] ? R : never) => {
  const g = play(id, ...p);
  assert.equal(g.count(), PROG_MISSIONS[id].steps.length, `${id}: stopped at step ${g.count() + 1}: ${PROG_MISSIONS[id].steps[g.count()]?.text}`);
};
const stopsAt = (id: string, step: number, ...p: Parameters<typeof play> extends [string, ...infer R] ? R : never) => {
  assert.equal(play(id, ...p).count(), step, `${id} should stop after ${step} steps`);
};

test('nothing done: no mission ticks any step before the learner has run something', () => {
  for (const [id, m] of Object.entries(PROG_MISSIONS)) {
    assert.equal(m.steps[0].done({ runs: [], growth: [] } as never), false, `${id} ticked with no run`);
  }
});

test('every program a mission starts from really does what its first step says', () => {
  // These have no "run it and look" step: their first step is already the work. In the
  // hypothesis mission that work is a new print of your own, since the starter ticking it
  // meant the part it asks for was never judged.
  const firstStepIsTheWork = new Set(['prog-readable-refactor', 'prog-whose-fix', 'prog-debug-hypothesis']);
  for (const [id, m] of Object.entries(PROG_MISSIONS)) {
    if (!m.starter || firstStepIsTheWork.has(id)) continue;
    assert.equal(play(id, m.starter).steps()[0], true, `${id}: the starter does not reach step 1`);
  }
});

// ---- input-and-errors

const ASK_GOOD = `def ask_age():
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

print("You are", ask_age())
`;

test('asking for an age: a loop passes, and made-up answers do not', () => {
  allDone('prog-errors-ask', PROG_MISSIONS['prog-errors-ask'].starter!, ASK_GOOD);
  // Handles forty, then falls over on the other hidden input.
  const once = `def ask_age():
    try:
        return int(input("How old are you? "))
    except ValueError:
        return int(input("How old are you? "))

print("You are", ask_age())
`;
  const defaulting = `def ask_age():
    try:
        return int(input("How old are you? "))
    except ValueError:
        return 41

print("You are", ask_age())
`;
  const printed = 'print("You are 41")\n';
  const noRange = ASK_GOOD.replace('if 0 <= age <= 150:', 'if True:');
  for (const wrong of [once, defaulting, printed]) stopsAt('prog-errors-ask', 1, PROG_MISSIONS['prog-errors-ask'].starter!, wrong);
  stopsAt('prog-errors-ask', 2, PROG_MISSIONS['prog-errors-ask'].starter!, noRange);
});

const SWALLOW_GOOD = `def total_cents(lines):
    total = 0
    for line in lines:
        try:
            total = total + int(line)
        except ValueError:
            pass
    return total

print(total_cents(["250", "oops", "100"]))
`;

test('the swallowed error: narrowing is required, and fixing only the typo does not pass', () => {
  const start = PROG_MISSIONS['prog-errors-swallow'].starter!;
  allDone('prog-errors-swallow', start, SWALLOW_GOOD);
  // Right answers, still catching everything: the next typo disappears the same way.
  stopsAt('prog-errors-swallow', 1, start, SWALLOW_GOOD.replace('except ValueError', 'except Exception'));
  stopsAt('prog-errors-swallow', 1, start, SWALLOW_GOOD.replace('except ValueError', 'except'));
  stopsAt('prog-errors-swallow', 1, start, SWALLOW_GOOD.replace('except ValueError', 'except (ValueError, TypeError)'));
  // Narrowed, typo still there: it is loud now, and step 3 is still ahead.
  stopsAt('prog-errors-swallow', 2, start, start.replace('except Exception', 'except ValueError'));
  // The visible answer, printed: not a function that works.
  stopsAt('prog-errors-swallow', 1, start, 'def total_cents(lines):\n    return 350\nprint(350)\n');
});

// ---- debugging

test('debugging: the fix at the cause passes, and the fix at the crash site does not', () => {
  const start = PROG_MISSIONS['prog-debug-traceback'].starter!;
  allDone('prog-debug-traceback', start, start.replace('return price', 'return float(price)'));
  stopsAt('prog-debug-traceback', 1, start, start.replace('t = t + p', 't = t + float(p)'));
  stopsAt('prog-debug-traceback', 1, start, 'def report(lines):\n    return 6.5\nprint(6.5)\n');
});

test('debugging: special-casing the visible input does not pass', () => {
  const start = PROG_MISSIONS['prog-debug-step'].starter!;
  const fixed = start.replace('    return best\n', '    return max(best, current)\n');
  allDone('prog-debug-step', start, fixed);
  const special = start.replace('    best = 0\n', '    if items == ["a", "a", "b", "b", "b"]:\n        return 3\n    best = 0\n');
  stopsAt('prog-debug-step', 1, start, special);
  stopsAt('prog-debug-step', 1, start, start.replace('    return best\n', '    return best + 1\n'));
  // Right on the visible failure and wrong on an empty list.
  stopsAt('prog-debug-step', 1, start, start.replace('    return best\n', '    return max(best, current, 1)\n'));

  const h = PROG_MISSIONS['prog-debug-hypothesis'].starter!;
  const guess = `${h}print(without_negatives([-1, -2, -3]))\n`;
  allDone('prog-debug-hypothesis', h, guess, 'def without_negatives(items):\n    keep = []\n    for x in items:\n        if x >= 0:\n            keep.append(x)\n    return keep\nprint(without_negatives([1, -2, -3, 4]))\n');
  allDone('prog-debug-hypothesis', h, guess, 'def without_negatives(items):\n    return [x for x in items if x >= 0]\n');
  // Looping twice papers over two negatives in a row and not three.
  const twice = 'def without_negatives(items):\n    for x in items:\n        if x < 0:\n            items.remove(x)\n    for x in items:\n        if x < 0:\n            items.remove(x)\n    return items\n';
  stopsAt('prog-debug-hypothesis', 1, guess, twice);
  stopsAt('prog-debug-hypothesis', 1, guess, h.replace('return items', 'return [1, 4]'));
});

// ---- your first tests

test('a first test: fails on the bug and passes once fixed. assert False does not count', () => {
  const start = PROG_MISSIONS['prog-tests-first'].starter!;
  const good = start.replace('    # Write an assert here. What should 200 at 50 percent off cost?\n    pass\n', '    assert price_after_discount(200, 50) == 100\n');
  allDone('prog-tests-first', start, good);
  stopsAt('prog-tests-first', 1, start, start.replace('    pass\n', '    assert False\n'));
  stopsAt('prog-tests-first', 1, start, start.replace('    pass\n', '    raise AssertionError("fail")\n'));
  stopsAt('prog-tests-first', 1, start, start.replace('    pass\n', '    assert True\n'));
  // Passes on the bug: this test encodes the bug.
  stopsAt('prog-tests-first', 1, start, start.replace('    pass\n', '    assert price_after_discount(200, 50) == 150\n'));
});

const STRONG_TESTS = `def test_prices():
    assert ticket_price(30) == 10
    assert ticket_price(3) == 0
    assert ticket_price(10) == 5
    assert ticket_price(70) == 6

def test_edges():
    assert ticket_price(4) == 0
    assert ticket_price(5) == 5
    assert ticket_price(17) == 5
    assert ticket_price(18) == 10
    assert ticket_price(64) == 10
    assert ticket_price(65) == 6

test_prices()
test_edges()
print("all tests passed")
`;

test('mutation testing: real tests catch every mutant and the vacuous ones catch none', () => {
  const none = (src: string) => {
    const j = judgeSuite(src, TICKET_PRICE);
    return Object.values(j.caught).filter(Boolean).length;
  };
  allDone('prog-tests-mutants', PROG_MISSIONS['prog-tests-mutants'].starter!, STRONG_TESTS);
  const j = judgeSuite(STRONG_TESTS, TICKET_PRICE);
  assert.ok(j.passesOnCorrect && j.callsIt);
  assert.deepEqual(Object.values(j.caught), Object.keys(TICKET_PRICE.broken).map(() => true));
  for (const [what, vacuous] of Object.entries({
    'nothing at all': '',
    'assert True': 'assert True\n',
    'a call with nothing checked': 'ticket_price(30)\nticket_price(5)\nticket_price(18)\nticket_price(65)\n',
    'compared with itself': 'assert ticket_price(5) == ticket_price(5)\nassert ticket_price(18) == ticket_price(18)\n',
    'printing, not checking': 'print(ticket_price(5))\nprint(ticket_price(18))\nprint(ticket_price(65))\n',
    'a test never called': 'def test_edge():\n    assert ticket_price(5) == 5\n    assert ticket_price(18) == 10\n',
    'assert swallowed': 'try:\n    assert ticket_price(5) == 5\n    assert ticket_price(18) == 10\n    assert ticket_price(65) == 6\nexcept AssertionError:\n    pass\n',
    'caught everything': 'try:\n    assert ticket_price(5) == 5\nexcept Exception:\n    print("ok")\n',
    'its own copy of the function': 'def ticket_price(age):\n    return 10\nassert ticket_price(30) == 10\nassert ticket_price(5) == 10\n',
  })) assert.equal(none(vacuous), 0, what);
  // Truthiness catches only the version that hands back 0 where the real one doesn't.
  assert.ok(none('assert ticket_price(30)\nassert ticket_price(5)\n') <= 1);
  // A test that fails on the correct function isn't a test: fails on everything.
  assert.equal(judgeSuite('assert False\n', TICKET_PRICE).passesOnCorrect, false);
  assert.equal(judgeSuite('assert ticket_price(5) == 0\n', TICKET_PRICE).passesOnCorrect, false);
  // Happy-path tests are not enough to finish: they stop before the edges.
  const happy = 'assert ticket_price(30) == 10\nassert ticket_price(3) == 0\nassert ticket_price(10) == 5\nassert ticket_price(70) == 6\n';
  stopsAt('prog-tests-mutants', 2, happy);
  stopsAt('prog-tests-mutants', 0, 'assert True\n');
  stopsAt('prog-tests-mutants', 0, 'assert ticket_price(5) == 0\n');
  // A mutant that loops forever fails the suite rather than hanging the page.
  assert.equal(runSuite('ticket_price(30)\n', 'def ticket_price(age):\n    while True:\n        pass\n').passed, false);
});

// ---- readable code

test('the refactor: behaviour is what passes, and missing one copy of the old rate does not', () => {
  const start = PROG_MISSIONS['prog-readable-refactor'].starter!;
  const good = `FIRST_RATE = 30
LATER_RATE = 50
FIRST_DAYS = 30

def days_late(due_day, returned_day):
    return max(0, returned_day - due_day)

def late_fee(due_day, returned_day):
    days = days_late(due_day, returned_day)
    if days > FIRST_DAYS:
        return FIRST_DAYS * FIRST_RATE + (days - FIRST_DAYS) * LATER_RATE
    return days * FIRST_RATE

print(late_fee(10, 15))
`;
  // Each step on its own. tests/prog-missions-finish.test.ts plays them together, which
  // is what this test never did when the mission couldn't be finished.
  const renamed = start.replace('def f(d, r):', 'def late_fee(due_day, returned_day):').replace('x = r - d', 'x = returned_day - due_day').replace('print(f(10, 15))', 'print(late_fee(10, 15))').replace('print(f(10, 50))', 'print(late_fee(10, 50))');
  assert.equal(play('prog-readable-refactor', start).count(), 0);
  assert.equal(play('prog-readable-refactor', renamed).count(), 1);
  const m = PROG_MISSIONS['prog-readable-refactor'];
  const at = (src: string) => { const p = new PyProgram(src); p.run(); return { runs: [summarise(p, src)], growth: [] } as never; };
  assert.equal(m.steps[2].done(at(good)), true);
  const oneCopyMissed = good.replace('return FIRST_DAYS * FIRST_RATE + (days - FIRST_DAYS) * LATER_RATE', 'return FIRST_DAYS * 25 + (days - FIRST_DAYS) * LATER_RATE');
  assert.equal(m.steps[2].done(at(oneCopyMissed)), false);
  // A days_late that goes negative is a different function, even if late_fee copes.
  assert.equal(m.steps[1].done(at(renamed.replace('def late_fee', 'def days_late(due_day, returned_day):\n    return returned_day - due_day\n\ndef late_fee'))), false);
});

// ---- recursion

test('recursion: the fix must move towards the end, and answers are checked on hidden shapes', () => {
  const start = PROG_MISSIONS['prog-rec-trees'].starter!;
  const fixed = start.replace('result + total(box)', 'result + total(item)');
  const depth = `${fixed}
def depth(box):
    deepest = 0
    for item in box:
        if isinstance(item, list):
            deepest = max(deepest, depth(item))
    return deepest + 1
print(depth([1, [2, [3]]]))
`;
  allDone('prog-rec-trees', start, depth);
  stopsAt('prog-rec-trees', 2, start, fixed);
  // Counting brackets gives the wrong answer on [[], []]: it says 3.
  stopsAt('prog-rec-trees', 2, start, `${fixed}\ndef depth(box):\n    return str(box).count("[")\n`);
});

// ---- the whole program

export const TRIP_SOLUTION = `
def parse_expense(line, people):
    words = line.split()
    if len(words) < 2:
        raise ValueError(f"can't read: {line}")
    if words[0] not in people:
        raise ValueError(f"nobody called {words[0]} is on this trip")
    return (words[0], to_cents(words[1]))

def balances(people, expenses):
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

def settle(balance):
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
`;
const swapIn = (starter: string, code: string) => {
  // The learner writes these over the stubs: here the stubs simply get redefined,
  // ahead of the tests, which is the same program as far as behaviour goes.
  return starter.replace('def test_parse_expense():', `${code}\ndef test_parse_expense():`);
};
const STARTER = PROG_MISSIONS['prog-real-trip'].starter!;

test('who owes whom: runs on real input and prints what a person would want', () => {
  const src = swapIn(STARTER, TRIP_SOLUTION);
  const p = new PyProgram(src, { stdin: TRIP_STDIN });
  p.run();
  assert.equal(p.status, 'done', p.error?.message);
  assert.equal(p.stdout, 'Who is on the trip? \nSkipped line 4: not an amount: lots\nSpent 132.50 between 3 people.\nCai pays Ana 32.16\nBen pays Ana 13.67\n');
  allDone('prog-real-trip', STARTER, { src, stdin: TRIP_STDIN.toSpliced(1, 0, 'Ben 4.00 coffee') });
});

test('who owes whom: a run on the unchanged example does not count as using it', () => {
  stopsAt('prog-real-trip', 4, STARTER, { src: swapIn(STARTER, TRIP_SOLUTION), stdin: TRIP_STDIN });
});

test('who owes whom: each stage has to be really right, not just pass the visible tests', () => {
  const stages = (parse: string, bal: string, setl: string) => swapIn(STARTER, `${parse}\n${bal}\n${setl}`);
  const [, , parseGood, balGood, setGood] = /^([\s\S]*?)(def parse_expense[\s\S]*?)(def balances[\s\S]*?)(def settle[\s\S]*)$/.exec(TRIP_SOLUTION)!;
  // Passes the visible test, which only tries one name that is missing and one amount.
  const parseNoAmountCheck = 'def parse_expense(line, people):\n    words = line.split()\n    if words[0] not in people:\n        raise ValueError("who?")\n    return (words[0], int(float(words[1]) * 100))\n';
  stopsAt('prog-real-trip', 1, STARTER, stages(parseNoAmountCheck, balGood, setGood));
  // Divides evenly on the visible example, then loses cents when it can't.
  const balLoses = 'def balances(people, expenses):\n    total = sum([c for n, c in expenses])\n    share = total // len(people)\n    b = {}\n    for p in people:\n        b[p] = -share\n    for n, c in expenses:\n        b[n] += c\n    return b\n';
  stopsAt('prog-real-trip', 2, STARTER, stages(parseGood, balLoses, setGood));
  // Hard-coded to the visible tests.
  const setFake = 'def settle(balance):\n    if balance == {"Ana": 500, "Ben": -500}:\n        return [("Ben", "Ana", 500)]\n    return []\n';
  stopsAt('prog-real-trip', 3, STARTER, stages(parseGood, balGood, setFake));
  // Everyone pays the biggest creditor regardless: right sums, too many payments or an overpayment.
  const setPairwise = 'def settle(balance):\n    p = []\n    for a in balance:\n        for b in balance:\n            if balance[a] < 0 and balance[b] > 0:\n                p.append((a, b, 1))\n    return p\n';
  stopsAt('prog-real-trip', 3, STARTER, stages(parseGood, balGood, setPairwise));
});

test('the float warning in the starter is true in real Python', () => {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const r = spawnSync(py, ['-I', '-c', 'print(int(float("19.99") * 100))'], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '1998');
  const p = new PyProgram('print(int(float("19.99") * 100))');
  p.run();
  assert.equal(p.stdout.trim(), '1998');
});

// ---- whose code

test('catching the plausible bug: the visible example passes, and only a real test gets through', () => {
  const start = PROG_MISSIONS['prog-whose-catch'].starter!;
  const strong = `${start}\nassert remove_duplicates([1, 2, 1]) == [1, 2]\na = [1, 1]\nremove_duplicates(a)\nassert a == [1, 1]\n`.replace('print("all tests passed")\n', '') + 'print("all tests passed")\n';
  allDone('prog-whose-catch', start, strong);
  stopsAt('prog-whose-catch', 1, start, `${start}assert remove_duplicates([1, 1]) == [1]\n`);
  stopsAt('prog-whose-catch', 1, start, `${start}assert False\n`);
  stopsAt('prog-whose-catch', 1, start, `${start}assert remove_duplicates([5]) == [5]\n`);
  const j = judgeSuite(start, REMOVE_DUPLICATES);
  assert.ok(j.passesOnCorrect && j.callsIt && !j.caught.plausible, 'the starting test must not catch it');
  stopsAt('prog-whose-catch', 2, start, `${start}assert remove_duplicates([1, 2, 1]) == [1, 2]\n`);
});

test('fixing it: order, repeats and the caller\'s list all count', () => {
  const start = PROG_MISSIONS['prog-whose-fix'].starter!;
  allDone('prog-whose-fix', REMOVE_DUPLICATES.correct);
  stopsAt('prog-whose-fix', 0, start);
  stopsAt('prog-whose-fix', 0, REMOVE_DUPLICATES.broken.changesInput);
  // Keeps order here only because this sandbox's sets happen to iterate in insertion
  // order. Real Python's don't promise that, so the mission must not bless it.
  stopsAt('prog-whose-fix', 0, 'def remove_duplicates(items):\n    return list(set(items))\n');
  allDone('prog-whose-fix', 'def remove_duplicates(items):\n    seen = set()\n    out = []\n    for x in items:\n        if x not in seen:\n            seen.add(x)\n            out.append(x)\n    return out\n');
  stopsAt('prog-whose-fix', 0, 'def remove_duplicates(items):\n    return [1, 2]\n');
});

// ---- the shell script missions

const shellState = (id: string, lines: string[]) => {
  const m = LINUX_MISSIONS[id];
  const s = m.setup();
  for (const l of lines) s.sh.run(l);
  let n = 0;
  for (const st of m.steps) { if (!st.done(s)) break; n++; }
  return { n, s, total: m.steps.length };
};
const REPORT = `echo 'grep 500$ access.log | cut -d " " -f 1 | sort | uniq -c | sort -rn | head -1' > report.sh`;
const REPORT_ARG = `echo 'grep 500$ $1 | cut -d " " -f 1 | sort | uniq -c | sort -rn | head -1' > report.sh`;

test('saving a one-liner: the script is judged on a log the learner never saw', () => {
  assert.equal(shellState('prog-shell-report', []).n, 0);
  const done = shellState('prog-shell-report', [REPORT, 'bash report.sh', 'chmod u+x report.sh', './report.sh', REPORT_ARG, './report.sh access.log']);
  assert.equal(done.n, done.total);
  // Prints the answer it saw on this machine.
  assert.equal(shellState('prog-shell-report', ['echo \'echo "      3 10.0.4.17"\' > report.sh', 'bash report.sh']).n, 0);
  // chmod 777 runs too, and lets anyone rewrite it.
  assert.equal(shellState('prog-shell-report', [REPORT, 'bash report.sh', 'chmod 777 report.sh', './report.sh']).n, 2);
  // Double quotes: $1 is expanded by echo, before the script exists, and is empty. The
  // saved script now reads no file at all, so even its first step stops being true.
  assert.equal(shellState('prog-shell-report', [REPORT, 'bash report.sh', 'chmod u+x report.sh', './report.sh', `echo "grep 500$ $1 | cut -d ' ' -f 1 | sort | uniq -c | sort -rn | head -1" > report.sh`, './report.sh access.log']).n, 0);
  // Still names access.log, so it reads the wrong file.
  assert.equal(shellState('prog-shell-report', [REPORT, 'bash report.sh', 'chmod u+x report.sh', './report.sh']).n, 3);
});

test('the silent script: it really destroys the sandbox home, and only a real fix passes', () => {
  const first = shellState('prog-shell-silent', ['cat cleanup.sh', './cleanup.sh']);
  assert.equal(first.n, 1);
  assert.equal(first.s.sh.status, 0);
  assert.match(first.s.sh.lastOut, /cache cleaned/);
  assert.equal(first.s.sh.fs.lookup('/home/panda/notes.txt', first.s.sh.user), undefined);
  const good = shellState('prog-shell-silent', ['./cleanup.sh', `echo 'cd cache && rm -r * && echo "cache cleaned"' > cleanup.sh`, 'bash cleanup.sh', 'echo $?']);
  assert.equal(good.n, good.total);
  const orExit = shellState('prog-shell-silent', ['./cleanup.sh', `echo 'cd cache || exit 1' > cleanup.sh`, `echo 'rm -r *' >> cleanup.sh`, 'bash cleanup.sh', 'echo $?']);
  assert.equal(orExit.n, orExit.total);
  for (const [what, line] of Object.entries({
    'same script': `echo 'cd cashe' > cleanup.sh`,
    'keeps the typo, safely': `echo 'cd cashe && rm -r *' > cleanup.sh`,
    'does nothing': `echo 'echo "cache cleaned"' > cleanup.sh`,
    'an empty script': `echo '' > cleanup.sh`,
    'hides the failure': `echo 'rm -rf cache/*' > cleanup.sh`,
    'always succeeds': `echo 'cd cache && rm -r * ; exit 0' > cleanup.sh`,
  })) assert.equal(shellState('prog-shell-silent', ['./cleanup.sh', line, 'bash cleanup.sh', 'echo $?']).n, 1, what);
  // The silent original, reinstated.
  assert.equal(shellState('prog-shell-silent', ['./cleanup.sh', `echo 'cd cache' > cleanup.sh`, `echo 'rm -r *' >> cleanup.sh`, 'bash cleanup.sh']).n, 1);
});

test('a script with a real hard stop: exit inside a list, and cd stays in the script', () => {
  const m = LINUX_MISSIONS['prog-shell-silent'];
  const s = m.setup();
  s.sh.run(`echo 'cd /tmp' > where.sh`);
  s.sh.run('bash where.sh');
  assert.equal(s.sh.cwd, '/home/panda');
  // Refused by name: "command not found" would say real bash lacks these.
  for (const line of ['set -e', 'NAME=panda', 'if true; then echo x; fi', 'for x in a; do echo x; done', 'exit', '[ 1 -eq 1 ]', 'echo $(pwd)', 'echo "${x:?}"', 'echo "$@"', 'sleep $(echo 1) &']) {
    const out = s.sh.run(line);
    assert.equal(out.some((l) => l.kind === 'err'), true, `${line} should be refused`);
    assert.equal(out.some((l) => /command not found/.test(l.text)), false, line);
    assert.equal(out.some((l) => l.kind === 'out' && /\$\(|\$\{|\$@/.test(l.text)), false, `${line} printed itself`);
  }
});
