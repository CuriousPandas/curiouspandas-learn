// Each mission played from its starter to a fix, then attacked: the tempting wrong answer
// must not pass, and a different correct approach must. A learner with another right
// answer who gets failed is told something false, and a shortcut that passes teaches nothing.
//
// Expected values are held to real Python: a reference solution runs through the real
// interpreter on every hidden case, so a wrong `want` can't fail a right answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_MISSIONS, type CodeState } from '../src/lib/cs/missions.ts';
import {
  AGE_CASES, BONUS_CASES, COMMON_CASES, COUNTDOWN_CASES, COUNT_CASES, DAYS_CASES, FAHRENHEIT_CASES, IS_LEAP_CASES, LEAP_CASES, LEAP_EASY_CASES, ORDER_CASES, REMOVE_CASES, SHARE_CASES, SUM_CASES, TICKET_CASES, TIDY_CASES, WORD_CASES,
  PROG_A_MISSIONS, checkEqual, checkInputs, withInputs, type CallCase, type InputCase,
} from '../src/lib/cs/prog-basics.ts';
import { runAll, summarise, toPy } from '../src/lib/py/lab.ts';
import { PyProgram } from '../src/lib/py/vm.ts';
import { repr } from '../src/lib/py/values.ts';
import { python, runPython } from './helpers/python.ts';

python();

const state = (): CodeState => ({ runs: [], growth: [] });
const act = (s: CodeState, ...programs: string[]) => { for (const p of programs) s.runs.push(runAll(p)); return s; };
const steps = (id: string, s: CodeState) => CODE_MISSIONS[id].steps.map((st) => st.done(s));
const lastStep = (id: string, s: CodeState) => CODE_MISSIONS[id].steps.at(-1)!.done(s);
const starter = (id: string) => CODE_MISSIONS[id].starter!;

/** Plays a mission's earlier steps with what the lesson asks for, then checks a final program. */
function passes(id: string, setup: string[], program: string) {
  const s = act(state(), ...setup, program);
  return lastStep(id, s);
}
function accept(id: string, setup: string[], programs: string[]) {
  for (const p of programs) {
    const s = act(state(), ...setup, p);
    const why = CODE_MISSIONS[id].steps.at(-1)!.why?.(s);
    assert.ok(lastStep(id, s), `${id} should accept:\n${p}\nbut said: ${why}`);
    // Whatever the mission accepts must also run on real Python.
    const r = runPython(p);
    assert.equal(r.status, 0, `real Python rejects what ${id} accepted:\n${p}\n${r.stderr}`);
    assert.equal(s.runs.at(-1)!.stdout, r.stdout, `${id}: lab and real Python differ on\n${p}`);
  }
}
function reject(id: string, setup: string[], programs: string[]) {
  for (const p of programs) assert.ok(!passes(id, setup, p), `${id} should not accept:\n${p}`);
}

test('every mission has a unique prog- id, a starter, and a debrief', () => {
  const ids = Object.keys(PROG_A_MISSIONS);
  assert.equal(ids.length, 18);
  for (const [k, m] of Object.entries(PROG_A_MISSIONS)) {
    assert.equal(k, m.id);
    assert.match(k, /^prog-/);
    assert.ok(m.starter, k);
    assert.ok(m.debrief.length > 80, k);
    assert.ok(m.steps.length >= 2, k);
    assert.ok(!m.debrief.includes('—'), `${k}: em dash`);
    // Nothing is done before the learner has run anything.
    for (const st of m.steps) assert.equal(st.done(state()), false, `${k}: "${st.text}" is done with no runs`);
  }
});

test('checkInputs: changes the input, judges what comes out, and explains in words', () => {
  assert.deepEqual(withInputs('n = 1\nprint(n)', { n: '5' }), 'n = 5\nprint(n)');
  assert.deepEqual(withInputs('print(1)', { n: '5' }), { missing: 'n' });
  assert.equal(withInputs('n == 1\nn = 2', { n: '5' }), 'n == 1\nn = 5', '== is not an assignment');
  assert.equal(withInputs('def f():\n    n = 1\nn = 2', { n: '5' }), 'def f():\n    n = 1\nn = 5', 'an indented assignment is not the input');
  const hard = checkInputs(runAll('n = 3\nprint(6)'), SUM_CASES);
  assert.equal(hard.ok, false);
  assert.match(hard.why, /With n = 10, it printed "6"; expected 55/);
  assert.match(checkInputs(runAll('print(55)'), SUM_CASES).why, /Keep the line that starts n =/);
  assert.match(checkInputs(runAll('print(1 / 0)'), SUM_CASES).why, /has to finish/);
  assert.match(checkInputs(runAll('n = 3\nif n == 10:\n    print(1 / 0)\nprint(55)'), SUM_CASES).why, /stopped with ZeroDivisionError/);
  assert.match(checkInputs(runAll('n = 1\nwhile n != 1 or n == 1 and n > 5 or n == 10:\n    pass\nprint(1)'), SUM_CASES).why, /never finished/);
  assert.match(checkInputs(runAll('n = 3\nif n != 3:\n    print(55)'), [{ set: { n: '3' }, want: 'x' }]).why, /printed nothing, and no error said so/);
  assert.equal(checkInputs(undefined, SUM_CASES).ok, false, 'no run is not a pass');
});

test('checkEqual: dictionaries compare by contents, not by the order they were built in', () => {
  const r = runAll('def f():\n    return {"b": 2, "a": 1}');
  assert.equal(checkEqual(r, 'f', [{ args: [], want: { a: 1, b: 2 } }]).ok, true);
  assert.match(checkEqual(r, 'f', [{ args: [], want: { a: 1 } }]).why, /returned \{'b': 2, 'a': 1\}; expected \{'a': 1\}/);
});

test('prog-first-hello: nearly impossible to fail, and it does make you read an error', () => {
  const id = 'prog-first-hello';
  const s = act(state(), starter(id));
  assert.deepEqual(steps(id, s), [true, false, false, false]);
  act(s, 'print("anything at all")');
  assert.deepEqual(steps(id, s), [true, true, false, false]);
  act(s, 'prin("anything at all")');
  assert.deepEqual(steps(id, s), [true, true, true, false]);
  act(s, 'print("anything at all")');
  assert.deepEqual(steps(id, s), [true, true, true, true]);
  // Any wording counts, in any language, and either kind of quote.
  for (const words of ['print("你好")', "print('hi')", 'print(42)']) assert.equal(steps(id, act(state(), starter(id), words))[1], true, words);
  // Printing nothing at all isn't a changed message.
  assert.equal(steps(id, act(state(), starter(id), 'x = 1'))[1], false);
  // Another way into a NameError is fine: any misspelling is the same lesson.
  assert.equal(steps(id, act(state(), starter(id), 'print("x")', 'Print("x")', 'print("x")'))[3], true);
  // A syntax error doesn't tick "broke the name": the next step talks about the word it didn't recognise.
  assert.equal(steps(id, act(state(), starter(id), 'print("x")', 'print("x'))[2], false);
});

test('prog-first-countdown: fixing the typo alone is not enough, and printing numbers or strings both pass', () => {
  const id = 'prog-first-countdown';
  const s = act(state(), starter(id));
  assert.deepEqual(steps(id, s), [true, false]);
  assert.match(s.runs[0].stdout, /Go!\n3\n/, 'the lines above the bad one have already printed, as the debrief says');
  const setup = [starter(id)];
  accept(id, setup, ['print(3)\nprint(2)\nprint(1)\nprint("Go!")\n', 'print("3")\nprint("2")\nprint("1")\nprint("Go!")', 'for n in [3, 2, 1]:\n    print(n)\nprint("Go!")']);
  reject(id, setup, ['print("Go!")\nprint(3)\nprint(2)\nprint(1)\n', 'print(3)\nprint(2)\nprint(1)', 'print(3)\nprin(2)\nprint(1)\nprint("Go!")']);
});

const SHARE = ['bill = 60\npeople = 4\nshare = bill // people\nprint(share)\n', 'bill = 90\npeople = 4\nshare = bill // people\nprint(share)\n'];
test('prog-vals-share: the starter is silently wrong on a bill it never shows', () => {
  const id = 'prog-vals-share';
  assert.deepEqual(steps(id, act(state(), starter(id))), [true, false, false]);
  assert.deepEqual(steps(id, act(state(), ...SHARE)), [true, true, false]);
  accept(id, SHARE, [
    'bill = 60\npeople = 4\nshare = bill / people\nprint(share)',
    'bill = 60\npeople = 4\nprint(bill / people)',
    'bill = 60\npeople = 4\nprint(bill * (1 / people))',
    'bill = 60\npeople = 4\nshare = bill / people\nprint("Each pays", share)',
    'bill=60\npeople=4\nprint(float(bill) / people)',
    // The original failure: a word after the number was refused, with "printed 15.0 each;
    // expected 15", and only a word before it passed.
    'bill = 60\npeople = 4\nshare = bill / people\nprint(share, "each")',
    'bill = 60\npeople = 4\nshare = bill / people\nprint(f"£{share}")',
    'bill = 60\npeople = 4\nshare = bill / people\nprint("£", share)',
  ]);
  reject(id, SHARE, [
    'bill = 60\npeople = 4\nprint(15)',
    'bill = 60\npeople = 4\nprint(bill // people)',
    'bill = 60\npeople = 4\nprint(bill / 4)',
    'bill = 60\npeople = 4\nprint(round(bill / people))',
    'bill = 60\npeople = 4\nprint(float(bill // people))',
    'people = 4\nprint(60 / people)',
    'bill = 60\npeople = 4\nprint(bill % people)',
  ]);
});

const AGE_SETUP = ['age_text = "41"\nnext_year = age_text + 1\nprint(next_year)\n'];
test('prog-vals-age: the conversion is what passes, and joining text does not', () => {
  const id = 'prog-vals-age';
  assert.deepEqual(steps(id, act(state(), starter(id))), [true, false]);
  accept(id, AGE_SETUP, [
    'age_text = "41"\nnext_year = int(age_text) + 1\nprint(next_year)',
    'age_text = "41"\nage = int(age_text)\nage += 1\nprint(age)',
    'age_text = "41"\nprint(float(age_text) + 1)',
    'age_text = "41"\nprint(f"{int(age_text) + 1}")',
    'age_text = "41"\nprint(int(age_text) + 1, "next year")',
  ]);
  reject(id, AGE_SETUP, [
    'age_text = "41"\nprint(age_text + "1")',
    'age_text = "41"\nprint(42)',
    'age_text = "41"\nprint(int(age_text))',
    'age_text = "41"\nprint(int(age_text + "1"))',
    'age_text = 41\nprint(age_text + 1)',
  ]);
});

const TICKET = ['age = 30\nif age >= 18:\n    print("adult")\nelif age >= 13:\n    print("teen")\n', 'age = 8\nif age >= 18:\n    print("adult")\nelif age >= 13:\n    print("teen")\n'];
test('prog-dec-ticket: the empty result is a step of its own, and the edges are checked', () => {
  const id = 'prog-dec-ticket';
  assert.deepEqual(steps(id, act(state(), ...TICKET)), [true, true, false]);
  accept(id, TICKET, [
    'age = 30\nif age >= 18:\n    print("adult")\nelif age >= 13:\n    print("teen")\nelse:\n    print("child")\n',
    'age = 30\nif age < 13:\n    print("child")\nelif age < 18:\n    print("teen")\nelse:\n    print("adult")\n',
    'age = 30\nif age >= 13:\n    if age >= 18:\n        print("adult")\n    else:\n        print("teen")\nelse:\n    print("child")\n',
    'age = 30\nif age <= 12:\n    print("child")\nif 13 <= age <= 17:\n    print("teen")\nif age > 17:\n    print("adult")\n',
    'age = 30\nword = "child"\nif age >= 13:\n    word = "teen"\nif age >= 18:\n    word = "adult"\nprint(word)\n',
  ]);
  reject(id, TICKET, [
    'age = 30\nprint("adult")',
    'age = 30\nif age > 18:\n    print("adult")\nelif age > 13:\n    print("teen")\nelse:\n    print("child")\n',
    'age = 30\nif age >= 13:\n    print("teen")\nelif age >= 18:\n    print("adult")\nelse:\n    print("child")\n',
    'age = 30\nif age >= 18:\n    print("adult")\nelif age >= 13:\n    print("teen")\nprint("child")\n',
    'age = 30\nif age >= 18:\n    print("adult")\nelse:\n    print("child")\n',
  ]);
});

const LEAP4 = 'year = 2024\nif year % 4 == 0:\n    print("leap")\nelse:\n    print("not leap")\n';
test('prog-dec-leap: the = error comes first, then a %4 rule that looks finished, then the real rule', () => {
  const id = 'prog-dec-leap';
  const s = act(state(), starter(id));
  assert.deepEqual(steps(id, s), [true, false, false]);
  act(s, LEAP4);
  assert.deepEqual(steps(id, s), [true, true, false], 'right for ordinary years, and not finished');
  const setup = [starter(id)];
  accept(id, setup, [
    'year = 2024\nif year % 4 == 0 and (year % 100 != 0 or year % 400 == 0):\n    print("leap")\nelse:\n    print("not leap")\n',
    'year = 2024\nif year % 400 == 0:\n    print("leap")\nelif year % 100 == 0:\n    print("not leap")\nelif year % 4 == 0:\n    print("leap")\nelse:\n    print("not leap")\n',
    'year = 2024\nif year % 4 != 0 or (year % 100 == 0 and year % 400 != 0):\n    print("not leap")\nelse:\n    print("leap")\n',
  ]);
  reject(id, setup, [
    LEAP4,
    'year = 2024\nif year % 4 == 0 and year % 100 != 0:\n    print("leap")\nelse:\n    print("not leap")\n',
    'year = 2024\nprint("leap")',
  ]);
});

test('debrief claim: the %4 rule is right for every year from 1901 to 2099, and wrong either side', () => {
  const r = runPython('import calendar\nf = lambda y: (y % 4 == 0) == calendar.isleap(y)\nprint(all(f(y) for y in range(1901, 2100)), f(1900), f(2100))');
  assert.equal(r.stdout.trim(), 'True False False');
});

const STUCK = ['n = 5\nwhile n > 0:\n    print(n)\n    n - 1\nprint("Go!")\n'];
test('prog-loop-stuck: the stuck run is recognised, and only a countdown that follows n passes', () => {
  const id = 'prog-loop-stuck';
  const s = act(state(), starter(id));
  assert.ok(['budget', 'output'].includes(s.runs[0].status), s.runs[0].status);
  assert.deepEqual(steps(id, s), [true, false]);
  accept(id, STUCK, [
    'n = 5\nwhile n > 0:\n    print(n)\n    n = n - 1\nprint("Go!")\n',
    'n = 5\nwhile n > 0:\n    print(n)\n    n -= 1\nprint("Go!")\n',
    'n = 5\nfor i in range(n, 0, -1):\n    print(i)\nprint("Go!")\n',
  ]);
  reject(id, STUCK, [
    'n = 5\nprint(5)\nprint(4)\nprint(3)\nprint(2)\nprint(1)\nprint("Go!")',
    'n = 5\nwhile n >= 0:\n    print(n)\n    n = n - 1\nprint("Go!")\n',
    'n = 5\nwhile n > 1:\n    print(n)\n    n = n - 1\nprint("Go!")\n',
    'n = 5\nprint("Go!")',
  ]);
});

const SUM = ['n = 10\ntotal = 0\nfor i in range(1, n):\n    total = total + i\nprint(total)\n'];
test('prog-loop-sum: off by one fails, and a formula is as welcome as a loop', () => {
  const id = 'prog-loop-sum';
  assert.deepEqual(steps(id, act(state(), starter(id))), [true, false]);
  accept(id, SUM, [
    'n = 10\ntotal = 0\nfor i in range(1, n + 1):\n    total = total + i\nprint(total)\n',
    'n = 10\ntotal = 0\nfor i in range(n + 1):\n    total += i\nprint(total)\n',
    'n = 10\nprint(n * (n + 1) // 2)',
    'n = 10\nprint(sum(range(1, n + 1)))',
    'n = 10\ntotal = 0\ni = 1\nwhile i <= n:\n    total += i\n    i += 1\nprint(total)\n',
    'n = 10\nprint(n * (n + 1) / 2)',
  ]);
  reject(id, SUM, [
    'n = 10\nprint(55)',
    'n = 10\ntotal = 0\nfor i in range(n):\n    total = total + i\nprint(total)\n',
    'n = 10\ntotal = 0\nfor i in range(1, n):\n    total = total + i\nprint(total + 10)\n',
    'n = 10\ntotal = 0\nfor i in range(1, n + 1):\n    total = i\nprint(total)\n',
  ]);
});

test('debrief claim: range(1, n) falls short by exactly n', () => {
  assert.equal(runPython('print(all(sum(range(1, n + 1)) - sum(range(1, n)) == n for n in range(0, 500)))').stdout.trim(), 'True');
});

test('prog-fn-fahrenheit: printing the right answer is the failure the mission is about', () => {
  const id = 'prog-fn-fahrenheit';
  const s = act(state(), starter(id));
  assert.deepEqual(steps(id, s), [true, false]);
  assert.match(CODE_MISSIONS[id].steps[1].why!(s), /returned None; expected 32\.0/);
  const setup = [starter(id)];
  accept(id, setup, [
    'def to_fahrenheit(c):\n    return c * 9 / 5 + 32\n',
    'def to_fahrenheit(c):\n    return c * 1.8 + 32\n',
    'def to_fahrenheit(c):\n    return 32 + (9 / 5) * c\n',
    'def to_fahrenheit(c):\n    f = c * 9 / 5\n    f = f + 32\n    return f\nprint(to_fahrenheit(100))\n',
  ]);
  reject(id, setup, [
    'def to_fahrenheit(c):\n    print(c * 9 / 5 + 32)\n',
    // "Instead of printing it": a function doing both passed, in the original.
    'def to_fahrenheit(c):\n    print(c * 9 / 5 + 32)\n    return c * 9 / 5 + 32\n',
    'def to_fahrenheit(c):\n    print(c)\n    return c * 9 / 5 + 32\n',
    'def to_fahrenheit(c):\n    return 212.0\n',
    'def to_fahrenheit(c):\n    return (c + 32) * 9 / 5\n',
    'def to_fahrenheit(c):\n    return str(c * 9 / 5 + 32)\n',
  ]);
});

const IS_LEAP = 'def is_leap(year):\n    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)\n\n';
test('prog-fn-leap: None for False is caught, and days_in_year is judged on what it gives', () => {
  const id = 'prog-fn-leap';
  const s = act(state(), starter(id));
  assert.deepEqual(steps(id, s), [true, false, false]);
  assert.match(CODE_MISSIONS[id].steps[1].why!(s), /is_leap\(2023\) returned None; expected False/);
  const setup = [starter(id)];
  accept(id, setup, [
    `${IS_LEAP}def days_in_year(year):\n    if is_leap(year):\n        return 366\n    return 365\n`,
    `${IS_LEAP}def days_in_year(year):\n    return 366 if is_leap(year) else 365\n`,
    `${IS_LEAP}def days_in_year(year):\n    days = 365\n    if is_leap(year):\n        days += 1\n    return days\n`,
    'def is_leap(year):\n    if year % 400 == 0:\n        return True\n    if year % 100 == 0:\n        return False\n    return year % 4 == 0\n\ndef days_in_year(year):\n    return 365 + is_leap(year)\n',
  ]);
  reject(id, setup, [
    `${IS_LEAP}def days_in_year(year):\n    return 365\n`,
    `def is_leap(year):\n    return year % 4 == 0\n\ndef days_in_year(year):\n    return 366 if is_leap(year) else 365\n`,
    `${IS_LEAP}def days_in_year(year):\n    print(366 if is_leap(year) else 365)\n`,
    // The original failure: "by calling is_leap", and a pasted copy of the rule passed.
    `${IS_LEAP}def days_in_year(year):\n    if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0):\n        return 366\n    return 365\n`,
  ]);
  const copied = act(state(), `${IS_LEAP}def days_in_year(year):\n    return 366 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 365\n`);
  assert.match(CODE_MISSIONS[id].steps[2].why!(copied), /without asking is_leap/);
});

const REMOVE = ['def remove_all(items, target):\n    for x in items:\n        if x == target:\n            items.remove(x)\n    return items\n\nprint(remove_all([5, 1, 7], 1))\n', 'def remove_all(items, target):\n    for x in items:\n        if x == target:\n            items.remove(x)\n    return items\n\nprint(remove_all([1, 1, 2], 1))\n'];
test('prog-list-remove: the loop that removes as it goes fails, whichever fix you prefer passes', () => {
  const id = 'prog-list-remove';
  assert.deepEqual(steps(id, act(state(), ...REMOVE)), [true, true, false]);
  accept(id, REMOVE, [
    'def remove_all(items, target):\n    result = []\n    for x in items:\n        if x != target:\n            result.append(x)\n    return result\n',
    'def remove_all(items, target):\n    return [x for x in items if x != target]\n',
    'def remove_all(items, target):\n    for x in items[:]:\n        if x == target:\n            items.remove(x)\n    return items\n',
    'def remove_all(items, target):\n    while target in items:\n        items.remove(target)\n    return items\n',
    'def remove_all(items, target):\n    for i in range(len(items) - 1, -1, -1):\n        if items[i] == target:\n            items.pop(i)\n    return items\n',
  ]);
  reject(id, REMOVE, [
    REMOVE[0],
    'def remove_all(items, target):\n    if target in items:\n        items.remove(target)\n    return items\n',
    'def remove_all(items, target):\n    return [2]\n',
    'def remove_all(items, target):\n    return sorted(set(items) - {target})\n',
  ]);
});

test('debrief claim: removing while looping goes wrong exactly when two matches sit side by side', () => {
  // Every list of 0s and 1s up to length 9, on real Python.
  const r = runPython(`
ok = True
for k in range(0, 10):
    for n in range(2 ** k):
        items = [(n >> i) & 1 for i in range(k)]
        got = list(items)
        for x in got:
            if x == 1:
                got.remove(x)
        wrong = got != [v for v in items if v != 1]
        adjacent = any(items[i] == 1 and items[i + 1] == 1 for i in range(k - 1))
        ok = ok and wrong == adjacent
print(ok)`);
  assert.equal(r.stdout.trim(), 'True');
});

const DEFAULT = ['def add_item(item, basket=[]):\n    basket.append(item)\n    return basket\n\nprint(add_item("tea"))\nprint(add_item("milk"))\n'];
test('prog-list-default: the shared default fails, and it takes two calls in one run to show it', () => {
  const id = 'prog-list-default';
  assert.deepEqual(steps(id, act(state(), starter(id))), [true, false]);
  // Pins why this mission can't use checkCases: it starts a fresh program per case, so
  // the shared list would look fine on every one of them.
  accept(id, DEFAULT, [
    'def add_item(item, basket=None):\n    if basket is None:\n        basket = []\n    basket.append(item)\n    return basket\n',
    'def add_item(item, basket=None):\n    if basket == None:\n        basket = []\n    basket.append(item)\n    return basket\n',
    'def add_item(item, basket=None):\n    basket = [] if basket is None else basket\n    basket += [item]\n    return basket\n',
  ]);
  const WRONG_FIXES = [
    // The original failures. Each passed before, because the check's only basket wasn't empty
    // and it read only what came back. The first two drop an empty basket the caller passed.
    'def add_item(item, basket=None):\n    if not basket:\n        basket = []\n    basket.append(item)\n    return basket\n',
    'def add_item(item, basket=None):\n    basket = basket or []\n    basket.append(item)\n    return basket\n',
    // These never touch the given basket at all.
    'def add_item(item, basket=[]):\n    return basket + [item]\n',
    'def add_item(item, basket=None):\n    if basket is None:\n        basket = []\n    return basket + [item]\n',
    'def add_item(item, basket=()):\n    return list(basket) + [item]\n',
    'def add_item(item, basket=None):\n    return (basket or []) + [item]\n',
    'def add_item(item, basket=None):\n    if basket is None:\n        basket = []\n    basket = basket[:]\n    basket.append(item)\n    return basket\n',
  ];
  reject(id, DEFAULT, [
    DEFAULT[0],
    ...WRONG_FIXES,
    'def add_item(item, basket=[]):\n    basket = []\n    basket.append(item)\n    return basket\n',
    'def add_item(item):\n    return [item]\n',
    'def add_item(item, basket=None):\n    basket.append(item)\n    return basket\n',
  ]);
  // It has to say what's wrong, in words.
  const dropped = act(state(), DEFAULT[0], WRONG_FIXES[0]);
  assert.match(CODE_MISSIONS[id].steps[1].why!(dropped), /left the basket it was given as \[\]/);
});

const COPY = ['def with_bonus(scores):\n    result = scores\n    for i in range(len(scores)):\n        result[i] = result[i] + 1\n    return result\n\nmine = [1, 2, 3]\ntheirs = with_bonus(mine)\nprint(theirs)\nprint(mine)\n'];
test('prog-list-copy: right answers from the wrong list fail, and every kind of copy passes', () => {
  const id = 'prog-list-copy';
  const s = act(state(), starter(id));
  assert.deepEqual(steps(id, s), [true, false]);
  assert.match(CODE_MISSIONS[id].steps[1].why!(s), /and the list it was given is now \[2, 3, 4\]/);
  const body = '    for i in range(len(result)):\n        result[i] = result[i] + 1\n    return result\n';
  accept(id, COPY, [
    `def with_bonus(scores):\n    result = scores[:]\n${body}`,
    `def with_bonus(scores):\n    result = list(scores)\n${body}`,
    `def with_bonus(scores):\n    result = scores.copy()\n${body}`,
    'def with_bonus(scores):\n    return [s + 1 for s in scores]\n',
    'def with_bonus(scores):\n    result = []\n    for s in scores:\n        result.append(s + 1)\n    return result\n',
  ]);
  reject(id, COPY, [
    COPY[0],
    `def with_bonus(scores):\n    result = scores\n    result = result\n${body}`,
    'def with_bonus(scores):\n    return scores[:]\n',
    'def with_bonus(scores):\n    for i in range(len(scores)):\n        scores[i] += 1\n    return scores[:]\n',
  ]);
});

const COUNT = ['def count_words(words):\n    counts = {}\n    for w in words:\n        counts[w] = counts[w] + 1\n    return counts\n'];
test('prog-map-count: a dictionary built in a different order is still right', () => {
  const id = 'prog-map-count';
  assert.deepEqual(steps(id, act(state(), starter(id))), [true, false]);
  accept(id, COUNT, [
    'def count_words(words):\n    counts = {}\n    for w in words:\n        counts[w] = counts.get(w, 0) + 1\n    return counts\n',
    'def count_words(words):\n    counts = {}\n    for w in words:\n        if w in counts:\n            counts[w] += 1\n        else:\n            counts[w] = 1\n    return counts\n',
    'def count_words(words):\n    return {w: words.count(w) for w in words}\n',
    'def count_words(words):\n    counts = {}\n    for w in sorted(words):\n        counts[w] = counts.get(w, 0) + 1\n    return counts\n',
    'def count_words(words):\n    counts = {}\n    for w in reversed(words):\n        counts.setdefault(w, 0)\n        counts[w] += 1\n    return counts\n',
  ]);
  reject(id, COUNT, [
    COUNT[0],
    'def count_words(words):\n    counts = {}\n    for w in words:\n        counts[w] = 1\n    return counts\n',
    'def count_words(words):\n    return {"tea": 2, "milk": 1}\n',
    'def count_words(words):\n    return len(words)\n',
  ]);
});

const ORDERS = ['def totals(orders):\n    result = {}\n    return result\n\nprint(totals([]))\n'];
test('prog-map-orders: the empty starter is not a pass, even though it prints a plausible {}', () => {
  const id = 'prog-map-orders';
  const s = act(state(), starter(id));
  assert.deepEqual(steps(id, s), [true, false]);
  accept(id, ORDERS, [
    'def totals(orders):\n    result = {}\n    for order in orders:\n        name = order["name"]\n        result[name] = result.get(name, 0) + order["amount"]\n    return result\n',
    'def totals(orders):\n    result = {}\n    for o in orders:\n        if o["name"] not in result:\n            result[o["name"]] = 0\n        result[o["name"]] += o["amount"]\n    return result\n',
  ]);
  reject(id, ORDERS, [
    ORDERS[0],
    'def totals(orders):\n    result = {}\n    for o in orders:\n        result[o["name"]] = o["amount"]\n    return result\n',
    'def totals(orders):\n    return orders\n',
  ]);
});

const COMMON = ['def in_both(a, b):\n    result = []\n    for x in a:\n        for y in b:\n            if x == y:\n                result.append(x)\n    return result\n\nprint(in_both([1, 1, 2], [1, 1]))\n'];
test('prog-set-common: an unsorted set does not pass, though it can look sorted here', () => {
  const id = 'prog-set-common';
  assert.deepEqual(steps(id, act(state(), starter(id))), [true, false]);
  accept(id, COMMON, [
    'def in_both(a, b):\n    return sorted(set(a) & set(b))\n',
    'def in_both(a, b):\n    return sorted(set(a).intersection(b))\n',
    'def in_both(a, b):\n    result = []\n    for x in a:\n        if x in b and x not in result:\n            result.append(x)\n    result.sort()\n    return result\n',
    'def in_both(a, b):\n    return sorted({x for x in a if x in b})\n',
  ]);
  reject(id, COMMON, [
    COMMON[0],
    'def in_both(a, b):\n    return list(set(a) & set(b))\n',
    'def in_both(a, b):\n    return list(set(b) & set(a))\n',
    'def in_both(a, b):\n    return sorted([x for x in a if x in b])\n',
    'def in_both(a, b):\n    return sorted(set(a) | set(b))\n',
  ]);
});

const TIDY = ['def tidy_email(s):\n    s.strip()\n    s.lower()\n    return s\n'];
test('prog-text-tidy: calling the methods and dropping the results fails', () => {
  const id = 'prog-text-tidy';
  assert.deepEqual(steps(id, act(state(), starter(id))), [true, false]);
  accept(id, TIDY, [
    'def tidy_email(s):\n    s = s.strip()\n    s = s.lower()\n    return s\n',
    'def tidy_email(s):\n    return s.strip().lower()\n',
    'def tidy_email(s):\n    return s.lower().strip()\n',
    'def tidy_email(s):\n    clean = s.strip()\n    return clean.lower()\n',
  ]);
  reject(id, TIDY, [
    TIDY[0],
    'def tidy_email(s):\n    return s.strip()\n',
    'def tidy_email(s):\n    return s.lower()\n',
    'def tidy_email(s):\n    return s.replace(" ", "")\n',
    'def tidy_email(s):\n    return "mei@example.com"\n',
  ]);
  // The step asked about spaces, and failed these with a \n this lesson hadn't explained yet.
  // They still don't pass, so the step now says new lines, and the reason says what \n is.
  for (const p of ['def tidy_email(s):\n    return s.strip(" ").lower()\n', 'def tidy_email(s):\n    return s.replace(" ", "").lower()\n']) {
    const s = act(state(), TIDY[0], p);
    assert.equal(lastStep(id, s), false, p);
    assert.match(CODE_MISSIONS[id].steps[1].why!(s), /is how a new line looks/, p);
  }
  assert.match(CODE_MISSIONS[id].steps[1].text, /spaces or new lines/);
});

const WORD = ['def count_word(text, word):\n    return text.count(word)\n'];
test('prog-text-count: str.count is the tempting shortcut and it does not pass', () => {
  const id = 'prog-text-count';
  assert.deepEqual(steps(id, act(state(), starter(id))), [true, false]);
  accept(id, WORD, [
    'def count_word(text, word):\n    return text.lower().split().count(word.lower())\n',
    'def count_word(text, word):\n    n = 0\n    for w in text.split():\n        if w.lower() == word.lower():\n            n += 1\n    return n\n',
    'def count_word(text, word):\n    words = text.lower().split(" ")\n    return words.count(word.lower())\n',
    'def count_word(text, word):\n    return len([w for w in text.split() if w.lower() == word.lower()])\n',
  ]);
  reject(id, WORD, [
    WORD[0],
    'def count_word(text, word):\n    return text.lower().count(word.lower())\n',
    'def count_word(text, word):\n    return text.split().count(word)\n',
    'def count_word(text, word):\n    return text.lower().split().count(word)\n',
    'def count_word(text, word):\n    return 1\n',
  ]);
});

// ---- Ground truth. Each table of expected answers, against a reference through real Python.

function realInputs(reference: string, cases: InputCase[]) {
  for (const c of cases) {
    const src = withInputs(reference, c.set);
    assert.equal(typeof src, 'string', `${reference} has no input line for ${JSON.stringify(c.set)}`);
    const r = runPython(src as string);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    if (c.wantNum !== undefined) assert.ok(Math.abs(Number(out) - c.wantNum) < 1e-9, `${JSON.stringify(c.set)}: real Python printed ${out}, table says ${c.wantNum}`);
    else assert.equal(out, c.want, JSON.stringify(c.set));
  }
}
function realCalls(reference: string, fn: string, cases: { args: unknown[]; want: string }[]) {
  for (const c of cases) {
    const call = `print(repr(${fn}(${c.args.map((a) => repr(toPy(a))).join(', ')})))`;
    const r = runPython(`${reference}\n${call}\n`);
    assert.equal(r.status, 0, `${call}\n${r.stderr}`);
    assert.equal(r.stdout.trim(), c.want, call);
  }
}
function realEqual(reference: string, fn: string, cases: CallCase[]) {
  for (const c of cases) {
    const call = `${fn}(${c.args.map((a) => repr(toPy(a))).join(', ')})`;
    const r = runPython(`${reference}\nprint(${call} == ${repr(toPy(c.want))})\n`);
    assert.equal(r.status, 0, `${call}\n${r.stderr}`);
    assert.equal(r.stdout.trim(), 'True', `${call} is not ${repr(toPy(c.want))} on real Python`);
  }
}

test('real Python agrees with every expected answer in the mission tables', () => {
  realInputs('bill = 1\npeople = 1\nprint(bill / people)', SHARE_CASES);
  realInputs('age_text = "1"\nprint(int(age_text) + 1)', AGE_CASES);
  realInputs('age = 1\nprint("child" if age < 13 else "teen" if age < 18 else "adult")', TICKET_CASES);
  // calendar.isleap, the standard library's own answer: not a copy of the rule under test.
  realInputs('import calendar\nyear = 1\nprint("leap" if calendar.isleap(year) else "not leap")', LEAP_CASES);
  realInputs('import calendar\nyear = 1\nprint("leap" if calendar.isleap(year) else "not leap")', LEAP_EASY_CASES);
  realInputs('n = 1\nwhile n > 0:\n    print(n)\n    n = n - 1\nprint("Go!")', COUNTDOWN_CASES);
  realInputs('n = 1\nprint(sum(range(1, n + 1)))', SUM_CASES);
  realCalls('def to_fahrenheit(c):\n    return c * 9 / 5 + 32', 'to_fahrenheit', FAHRENHEIT_CASES);
  realCalls('def to_fahrenheit(c):\n    return c * 1.8 + 32', 'to_fahrenheit', FAHRENHEIT_CASES);
  realCalls('import calendar\ndef is_leap(y):\n    return calendar.isleap(y)', 'is_leap', IS_LEAP_CASES);
  realCalls('import calendar\ndef days_in_year(y):\n    return (calendar.datetime.date(y + 1, 1, 1) - calendar.datetime.date(y, 1, 1)).days', 'days_in_year', DAYS_CASES);
  realCalls('def remove_all(items, target):\n    return [x for x in items if x != target]', 'remove_all', REMOVE_CASES);
  realCalls('def with_bonus(s):\n    return [x + 1 for x in s]', 'with_bonus', BONUS_CASES);
  realEqual('import collections\ndef count_words(w):\n    return dict(collections.Counter(w))', 'count_words', COUNT_CASES);
  realEqual('import collections\ndef totals(orders):\n    c = collections.Counter()\n    for o in orders:\n        c[o["name"]] += o["amount"]\n    return dict(c)', 'totals', ORDER_CASES);
  realCalls('def in_both(a, b):\n    return sorted(set(a) & set(b))', 'in_both', COMMON_CASES);
  realCalls('def tidy_email(s):\n    return s.strip().lower()', 'tidy_email', TIDY_CASES);
  realCalls('def count_word(text, word):\n    return text.lower().split().count(word.lower())', 'count_word', WORD_CASES);
});

test('a mission step that looks at the last run judges the code on screen, not an earlier version that passed', () => {
  const id = 'prog-fn-fahrenheit';
  const good = 'def to_fahrenheit(c):\n    return c * 9 / 5 + 32\n';
  const s = act(state(), starter(id), good);
  assert.equal(lastStep(id, s), true);
  act(s, 'def to_fahrenheit(c):\n    return 0\n');
  assert.equal(lastStep(id, s), false);
});

// ---- Start to finish. Each mission played as the lesson asks, with the panel's own rule:
// a step shows done only if every step before it is done, on the state as it is now. Another
// lesson's mission turned out to be impossible to finish, because a later step changed the
// state an earlier one was re-judged on, and step-by-step checks can't see that.

const panel = (id: string, s: CodeState) => {
  let ok = true;
  return CODE_MISSIONS[id].steps.map((st) => (ok = ok && st.done(s)));
};
const ticks = (id: string, s: CodeState) => panel(id, s).filter(Boolean).length;
const LEAP_DAYS = `${IS_LEAP}def days_in_year(year):\n    return 366 if is_leap(year) else 365\n\nprint(is_leap(2024), days_in_year(2024))\n`;
const PLAYS: Record<string, { walk: string[]; fix: string }> = {
  'prog-first-hello': { walk: ['print("I wrote this")', 'prin("I wrote this")'], fix: 'print("I wrote this")' },
  'prog-first-countdown': { walk: [], fix: 'print(3)\nprint(2)\nprint(1)\nprint("Go!")\n' },
  'prog-vals-share': { walk: [SHARE[1]], fix: 'bill = 90\npeople = 4\nshare = bill / people\nprint(share)\n' },
  'prog-vals-age': { walk: [], fix: 'age_text = "41"\nnext_year = int(age_text) + 1\nprint(next_year)\n' },
  'prog-dec-ticket': { walk: [TICKET[1]], fix: 'age = 8\nif age >= 18:\n    print("adult")\nelif age >= 13:\n    print("teen")\nelse:\n    print("child")\n' },
  'prog-dec-leap': { walk: [LEAP4], fix: 'year = 2024\nif year % 4 == 0 and (year % 100 != 0 or year % 400 == 0):\n    print("leap")\nelse:\n    print("not leap")\n' },
  'prog-loop-stuck': { walk: [], fix: 'n = 5\nwhile n > 0:\n    print(n)\n    n = n - 1\nprint("Go!")\n' },
  'prog-loop-sum': { walk: [], fix: 'n = 10\ntotal = 0\nfor i in range(1, n + 1):\n    total = total + i\nprint(total)\n' },
  'prog-fn-fahrenheit': { walk: [], fix: 'def to_fahrenheit(c):\n    return c * 9 / 5 + 32\n\nprint(to_fahrenheit(100))\n' },
  'prog-fn-leap': { walk: [`${IS_LEAP}def days_in_year(year):\n    return 365\n\nprint(is_leap(2024), days_in_year(2024))\n`], fix: LEAP_DAYS },
  'prog-list-remove': { walk: [REMOVE[1]], fix: 'def remove_all(items, target):\n    result = []\n    for x in items:\n        if x != target:\n            result.append(x)\n    return result\n\nprint(remove_all([1, 1, 2], 1))\n' },
  'prog-list-default': { walk: [], fix: 'def add_item(item, basket=None):\n    if basket is None:\n        basket = []\n    basket.append(item)\n    return basket\n\nprint(add_item("tea"))\nprint(add_item("milk"))\n' },
  'prog-list-copy': { walk: [], fix: 'def with_bonus(scores):\n    result = scores[:]\n    for i in range(len(scores)):\n        result[i] = result[i] + 1\n    return result\n\nmine = [1, 2, 3]\ntheirs = with_bonus(mine)\nprint(theirs)\nprint(mine)\n' },
  'prog-map-count': { walk: [], fix: 'def count_words(words):\n    counts = {}\n    for w in words:\n        counts[w] = counts.get(w, 0) + 1\n    return counts\n\nprint(count_words(["tea", "milk", "tea"]))\n' },
  'prog-map-orders': { walk: [], fix: 'def totals(orders):\n    result = {}\n    for order in orders:\n        result[order["name"]] = result.get(order["name"], 0) + order["amount"]\n    return result\n\nprint(totals([{"name": "Mei", "amount": 5}]))\n' },
  'prog-set-common': { walk: [], fix: 'def in_both(a, b):\n    return sorted(set(a) & set(b))\n\nprint(in_both([1, 1, 2], [1, 1]))\n' },
  'prog-text-tidy': { walk: [], fix: 'def tidy_email(s):\n    return s.strip().lower()\n\nprint("[" + tidy_email("  Mei@Example.COM ") + "]")\n' },
  'prog-text-count': { walk: [], fix: 'def count_word(text, word):\n    return text.lower().split().count(word.lower())\n\nprint(count_word("my cat can concatenate", "cat"))\n' },
};

test('the table of plays covers every mission in this file', () => {
  assert.deepEqual(Object.keys(PLAYS).sort(), Object.keys(PROG_A_MISSIONS).sort());
});

for (const [id, play] of Object.entries(PLAYS)) {
  test(`${id}: played start to finish, every step ends up ticked at once, and none unticks along the way`, () => {
    const s = state();
    let before = 0;
    for (const program of [starter(id), ...play.walk, play.fix]) {
      act(s, program);
      const now = ticks(id, s);
      assert.ok(now >= before, `${id}: ${now} ticked after ${before}, on\n${program}`);
      before = now;
    }
    assert.deepEqual(panel(id, s), CODE_MISSIONS[id].steps.map(() => true), id);
    const r = runPython(play.fix);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.runs.at(-1)!.stdout, r.stdout, `${id}: the solution differs from real Python`);
  });
}

// The original failure: 13 of 14 fix-first attempts stuck, with right output and no message.
for (const [id, play] of Object.entries(PLAYS)) {
  if (id === 'prog-first-hello') continue; // Its steps are the lesson: it asks for the break by name.
  test(`${id}: someone who fixes it before ever running the broken version isn't stuck`, () => {
    assert.deepEqual(panel(id, act(state(), play.fix)), CODE_MISSIONS[id].steps.map(() => true), id);
  });
}

test('prog-first-hello really does need the break: a finished program alone ticks nothing past step 2', () => {
  assert.deepEqual(panel('prog-first-hello', act(state(), 'print("I wrote this")')), [true, true, false, false]);
});

test('a "see it go wrong" step that hasn\'t happened says what it wants, and a half-done fix earns no credit', () => {
  const share = act(state(), 'bill = 60\npeople = 4\nprint(bill / 4)\n');
  assert.deepEqual(panel('prog-vals-share', share), [false, false, false]);
  assert.match(CODE_MISSIONS['prog-vals-share'].steps[0].why!(share), /Press Reset code/);
  // No credit from a right answer to one step while another fix is still wrong.
  const partial = act(state(), `def is_leap(year):\n    if year % 4 == 0:\n        return True\n\ndef days_in_year(year):\n    return 366 if is_leap(year) else 365\n`);
  assert.equal(CODE_MISSIONS['prog-fn-leap'].steps[0].done(partial), false);
  // And nothing nags before there has been a run to judge, or straight after the step before ticked.
  assert.equal(CODE_MISSIONS['prog-vals-share'].steps[0].why!(state()), '');
  assert.equal(CODE_MISSIONS['prog-vals-share'].steps[1].why!(act(state(), starter('prog-vals-share'))), '');
});

test('prog-loop-stuck: pressing Stop, as its hint says to, counts as seeing it run', () => {
  const id = 'prog-loop-stuck';
  const s = state();
  const p = new PyProgram(starter(id));
  p.run(1000);
  p.stop();
  assert.equal(p.status, 'stopped');
  s.runs.push(summarise(p, starter(id)));
  assert.deepEqual(panel(id, s), [true, false]);
});

test('an endless loop in one hidden input is reported in words, and stops', () => {
  const v = checkInputs(runAll('n = 1\nwhile n == 3:\n    pass\nprint(n)'), [{ set: { n: '3' }, wantNum: 3 }]);
  assert.equal(v.ok, false);
  assert.match(v.why, /With n = 3, it never finished/);
});
