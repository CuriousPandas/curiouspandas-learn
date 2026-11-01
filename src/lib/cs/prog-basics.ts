// Code lab missions for the first half of Programming from Zero. Same rule as
// src/lib/cs/missions.ts: a step judges behaviour on inputs the learner never saw.
//
// The first four lessons come before `def`, so there is no function for checkCases to
// call. checkInputs does the same job for a whole program: it changes the variables at
// the top and runs it again, so print(15) can't pass a mission about working out a share.
// That is also the honest stand-in for input(), which this sandbox doesn't have.
//
// Imports from missions.ts are types only: that file spreads this one.

import type { CodeMission, CodeState } from './missions.ts';
import { checkCases, toPy, type RunResult } from '../py/lab.ts';
import { PyProgram } from '../py/vm.ts';
import { PyBuiltin, PyList, eq, repr, type Val } from '../py/values.ts';

const blank = (): CodeState => ({ runs: [], growth: [] });
const lastRun = (s: CodeState) => s.runs.at(-1);

export type Verdict = { ok: boolean; why: string };
export type InputCase = { set: Record<string, string>; want?: string; wantNum?: number };

const tidy = (s: string) => s.split('\n').map((l) => l.trimEnd()).join('\n').trim();
// The last number anywhere in what it printed, so print(share, "each") and f"£{share}" are
// right answers. Reading only the last word refused those and passed "Each pays 15": the rule
// was invisible, and "it printed 15.0 each; expected 15" read as a complaint about the .0.
const lastNumber = (out: string) => {
  const found = out.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi);
  return found ? Number(found.at(-1)) : undefined;
};
const describe = (set: Record<string, string>) => Object.entries(set).map(([k, v]) => `${k} = ${v}`).join(' and ');

/**
 * Replaces the first top-level `name = ...` for each input and runs the program. Column
 * zero only: an indented assignment is the program's own working, not its input. A
 * program with no such line says so, because silently keeping the old value would judge
 * the wrong input.
 */
export function withInputs(src: string, set: Record<string, string>): string | { missing: string } {
  let out = src.replace(/\r\n/g, '\n');
  for (const [name, value] of Object.entries(set)) {
    const re = new RegExp(`^${name}[ \\t]*=(?!=).*$`, 'm');
    if (!re.test(out)) return { missing: name };
    // A function, not a string: a $ in the value must stay a $.
    out = out.replace(re, () => `${name} = ${value}`);
  }
  return out;
}

export function checkInputs(r: RunResult | undefined, cases: InputCase[]): Verdict {
  if (!r) return { ok: false, why: '' };
  if (r.status !== 'done') return { ok: false, why: 'The program has to finish without an error first.' };
  for (const c of cases) {
    const src = withInputs(r.src, c.set);
    if (typeof src !== 'string') return { ok: false, why: `Keep the line that starts ${src.missing} = at the top: the check changes it to try other values.` };
    const p = new PyProgram(src, { maxOps: 500_000 });
    p.run();
    const label = `With ${describe(c.set)}`;
    if (p.status === 'budget' || p.status === 'output') return { ok: false, why: `${label}, it never finished.` };
    if (p.status !== 'done') return { ok: false, why: `${label}, it stopped with ${p.error?.type}: ${p.error?.message}` };
    const got = tidy(p.stdout), shown = got ? `printed ${JSON.stringify(got)}` : 'printed nothing, and no error said so';
    if (c.wantNum !== undefined) {
      const n = lastNumber(got);
      // A tolerance, not text: bill * (1 / people) is just as right as bill / people,
      // and the two can differ in the last digit.
      if (n === undefined || Math.abs(n - c.wantNum) > 1e-9) return { ok: false, why: `${label}, it ${shown}; expected ${c.wantNum} as the last number it prints.` };
    } else if (got !== c.want) return { ok: false, why: `${label}, it ${shown}; expected ${JSON.stringify(c.want)}.` };
  }
  return { ok: true, why: `Passed ${cases.length} checks.` };
}

export type CallCase = { args: unknown[]; want: unknown };

/**
 * For results where repr would fail a right answer: {'a': 1, 'b': 2} and {'b': 2, 'a': 1}
 * are equal dictionaries, and a learner who built theirs in another order is correct.
 */
export function checkEqual(r: RunResult | undefined, fn: string, cases: CallCase[]): Verdict {
  if (!r) return { ok: false, why: '' };
  if (r.status !== 'done') return { ok: false, why: 'The program has to finish without an error first.' };
  for (const c of cases) {
    const shown = `${fn}(${c.args.map((a) => repr(toPy(a))).join(', ')})`;
    const p = new PyProgram(r.src, { maxOps: 500_000 });
    p.run();
    const got = p.call(fn, c.args.map(toPy));
    if (!got.ok) return { ok: false, why: `${shown} raised ${got.error.type}: ${got.error.message}` };
    const want = toPy(c.want);
    if (!eq(got.value, want)) return { ok: false, why: `${shown} returned ${repr(got.value)}; expected ${repr(want)}` };
  }
  return { ok: true, why: `Passed ${cases.length} checks.` };
}

/** Calls fn and reports whether the list it was given has changed. */
export function leavesArgumentAlone(r: RunResult, fn: string, args: unknown[]): Verdict {
  const p = new PyProgram(r.src, { maxOps: 500_000 });
  p.run();
  const given: Val[] = args.map(toPy), before = given.map((v) => repr(v));
  const got = p.call(fn, given);
  if (!got.ok) return { ok: false, why: `${fn} raised ${got.error.type}: ${got.error.message}` };
  const after = given.map((v) => repr(v));
  if (after.join() !== before.join()) return { ok: false, why: `${fn}(${before.join(', ')}) returned ${repr(got.value)}, and the list it was given is now ${after.join(', ')}.` };
  return { ok: true, why: 'The list it was given did not change.' };
}

type Step = CodeMission['steps'][number] & { witness?: boolean };

/**
 * A step that asks to see the bug go wrong. It isn't the goal, it's how you find out why the
 * goal matters, so a learner who went straight to a correct program has lost nothing and must
 * not be stuck. 13 of 14 fix-first attempts in the review were: the output was right, no step
 * ticked, nothing said why, and the only way forward was to put the bug back. So credit() ticks
 * these once every real fix in the mission passes, and until then says plainly what it wants.
 */
const watch = (text: string, hint: string, done: Step['done']): Step => ({ text, hint, done, witness: true });

function credit(m: CodeMission): CodeMission {
  const steps = m.steps as Step[], fixes = steps.filter((st) => !st.witness);
  return {
    ...m,
    steps: steps.map((st, i) => {
      if (!st.witness) return st;
      return {
        text: st.text, hint: st.hint,
        done: (s: CodeState) => st.done(s) || (s.runs.length > 0 && fixes.every((f) => f.done(s))),
        // Only once there has been a run this step could have ticked on and didn't: while the
        // previous step has only just ticked, saying "this hasn't happened" would be noise.
        why: (s: CodeState) => (s.runs.length > i ? 'This step wants to see the original go wrong. Press Reset code and follow it, or go straight on to the fix: a finished program ticks this as well.' : ''),
      };
    }),
  };
}

const inputStep = (text: string, hint: string, cases: InputCase[]) => ({
  text, hint,
  done: (s: CodeState) => checkInputs(lastRun(s), cases).ok,
  why: (s: CodeState) => (lastRun(s) ? checkInputs(lastRun(s), cases).why : ''),
});
const caseStep = (text: string, hint: string, fn: string, cases: { args: unknown[]; want: string }[]) => ({
  text, hint,
  done: (s: CodeState) => { const r = lastRun(s); return !!r && checkCases(r, fn, cases).ok; },
  why: (s: CodeState) => { const r = lastRun(s); return r ? checkCases(r, fn, cases).why : ''; },
});
const equalStep = (text: string, hint: string, fn: string, cases: CallCase[]) => ({
  text, hint,
  done: (s: CodeState) => checkEqual(lastRun(s), fn, cases).ok,
  why: (s: CodeState) => (lastRun(s) ? checkEqual(lastRun(s), fn, cases).why : ''),
});

const failedWith = (s: CodeState, type: string) => s.runs.some((r) => r.error?.type === type);
const afterError = (s: CodeState) => {
  const last = s.runs.at(-1);
  return !!last && last.status === 'done' && last.stdout.trim().length > 0 && s.runs.some((r) => r.status === 'error');
};

// ---- Cases. tests/prog-basics-missions.test.ts runs a reference solution through real Python
// on every one of these, so a wrong expected value can't fail a right answer.

export const SHARE_CASES: InputCase[] = [
  { set: { bill: '60', people: '4' }, wantNum: 15 }, { set: { bill: '90', people: '4' }, wantNum: 22.5 },
  { set: { bill: '100', people: '8' }, wantNum: 12.5 }, { set: { bill: '7', people: '2' }, wantNum: 3.5 }, { set: { bill: '9', people: '3' }, wantNum: 3 },
];
export const AGE_CASES: InputCase[] = [
  { set: { age_text: '"41"' }, wantNum: 42 }, { set: { age_text: '"7"' }, wantNum: 8 }, { set: { age_text: '"100"' }, wantNum: 101 }, { set: { age_text: '"0"' }, wantNum: 1 },
];
// 13 and 18 are where people write > for >=. 8 is the age the starter forgot.
export const TICKET_CASES: InputCase[] = [
  { set: { age: '0' }, want: 'child' }, { set: { age: '8' }, want: 'child' }, { set: { age: '12' }, want: 'child' }, { set: { age: '13' }, want: 'teen' },
  { set: { age: '17' }, want: 'teen' }, { set: { age: '18' }, want: 'adult' }, { set: { age: '30' }, want: 'adult' }, { set: { age: '200' }, want: 'adult' },
];
export const LEAP_EASY_CASES: InputCase[] = [
  { set: { year: '2024' }, want: 'leap' }, { set: { year: '2023' }, want: 'not leap' }, { set: { year: '2028' }, want: 'leap' }, { set: { year: '2021' }, want: 'not leap' },
];
export const LEAP_CASES: InputCase[] = [
  ...LEAP_EASY_CASES, { set: { year: '1900' }, want: 'not leap' }, { set: { year: '2000' }, want: 'leap' }, { set: { year: '2100' }, want: 'not leap' }, { set: { year: '2400' }, want: 'leap' }, { set: { year: '1996' }, want: 'leap' },
];
export const COUNTDOWN_CASES: InputCase[] = [
  { set: { n: '5' }, want: '5\n4\n3\n2\n1\nGo!' }, { set: { n: '3' }, want: '3\n2\n1\nGo!' }, { set: { n: '1' }, want: '1\nGo!' }, { set: { n: '0' }, want: 'Go!' },
];
export const SUM_CASES: InputCase[] = [
  { set: { n: '10' }, wantNum: 55 }, { set: { n: '1' }, wantNum: 1 }, { set: { n: '3' }, wantNum: 6 }, { set: { n: '100' }, wantNum: 5050 }, { set: { n: '0' }, wantNum: 0 },
];
// Whole-number answers, so c * 9 / 5 + 32 and c * 1.8 + 32 agree to the last digit:
// tests/prog-basics-missions.test.ts checks that both pass.
export const FAHRENHEIT_CASES = [
  { args: [0], want: '32.0' }, { args: [100], want: '212.0' }, { args: [-40], want: '-40.0' }, { args: [10], want: '50.0' }, { args: [20], want: '68.0' }, { args: [25], want: '77.0' },
];
export const IS_LEAP_CASES = [
  { args: [2024], want: 'True' }, { args: [2023], want: 'False' }, { args: [1900], want: 'False' }, { args: [2000], want: 'True' }, { args: [2100], want: 'False' }, { args: [1996], want: 'True' },
];
export const DAYS_CASES = [
  { args: [2024], want: '366' }, { args: [2023], want: '365' }, { args: [1900], want: '365' }, { args: [2000], want: '366' },
];
export const REMOVE_CASES = [
  { args: [[1, 1, 2], 1], want: '[2]' }, { args: [[5, 1, 7], 1], want: '[5, 7]' }, { args: [[], 1], want: '[]' }, { args: [[1, 1, 1, 1], 1], want: '[]' },
  { args: [[2, 2, 3, 2, 2], 2], want: '[3]' }, { args: [[1, 2, 3], 9], want: '[1, 2, 3]' }, { args: [['a', 'a', 'b'], 'a'], want: "['b']" },
  // Order kept and other duplicates kept: sorted(set(items) - {target}) passed everything above.
  { args: [[7, 3, 7, 1], 1], want: '[7, 3, 7]' },
];
export const BONUS_CASES = [
  { args: [[1, 2, 3]], want: '[2, 3, 4]' }, { args: [[]], want: '[]' }, { args: [[10]], want: '[11]' }, { args: [[0, 0]], want: '[1, 1]' }, { args: [[-1, 5]], want: '[0, 6]' },
];
export const COUNT_CASES: CallCase[] = [
  { args: [[]], want: {} }, { args: [['tea']], want: { tea: 1 } }, { args: [['tea', 'milk', 'tea']], want: { tea: 2, milk: 1 } },
  { args: [['a', 'b', 'a', 'c', 'a', 'b']], want: { a: 3, b: 2, c: 1 } }, { args: [['x', 'x', 'x']], want: { x: 3 } },
];
export const ORDER_CASES: CallCase[] = [
  { args: [[]], want: {} }, { args: [[{ name: 'Mei', amount: 5 }]], want: { Mei: 5 } },
  { args: [[{ name: 'Mei', amount: 5 }, { name: 'Bo', amount: 2 }, { name: 'Mei', amount: 3 }]], want: { Mei: 8, Bo: 2 } },
  { args: [[{ name: 'Ana', amount: 1 }, { name: 'Ana', amount: 1 }, { name: 'Ana', amount: 1 }]], want: { Ana: 3 } },
];
// [3, 1] twice catches an unsorted set turned into a list: this sandbox's sets keep the
// order things went in, so one list out of order wouldn't, depending on which side & walks.
// Duplicates catch the plain nested loop in the starter.
export const COMMON_CASES = [
  { args: [[3, 1], [3, 1]], want: '[1, 3]' }, { args: [[3, 1], [1, 3]], want: '[1, 3]' }, { args: [[1, 2, 3], [2, 3, 4]], want: '[2, 3]' }, { args: [[], [1]], want: '[]' }, { args: [[1], []], want: '[]' },
  { args: [[1, 1, 2], [1, 1]], want: '[1]' }, { args: [[5, 6], [7, 8]], want: '[]' }, { args: [['b', 'a'], ['a', 'b', 'c']], want: "['a', 'b']" },
];
export const TIDY_CASES = [
  { args: ['  Mei@Example.COM '], want: "'mei@example.com'" }, { args: ['a@b.c'], want: "'a@b.c'" }, { args: ['   '], want: "''" }, { args: ['X@Y.Z\n'], want: "'x@y.z'" }, { args: [''], want: "''" },
];
export const WORD_CASES = [
  { args: ['the cat sat', 'cat'], want: '1' }, { args: ['concatenate cat', 'cat'], want: '1' }, { args: ['CAT cat Cat', 'cat'], want: '3' }, { args: ['', 'cat'], want: '0' },
  { args: ['dog dog', 'cat'], want: '0' }, { args: ['catcat cat', 'cat'], want: '1' }, { args: ['one  two   one', 'one'], want: '2' }, { args: ['Cat', 'CAT'], want: '1' },
];

const PROG_A_RAW: Record<string, CodeMission> = {
  // This one's steps are the lesson: it asks for the break by name, and a finished program
  // isn't the point of it. So none of them is a witness, and the last needs the error to have happened.
  'prog-first-hello': {
    id: 'prog-first-hello', title: 'Your first program, and your first error', xp: 30, setup: blank,
    starter: `print("Hello, panda")
`,
    steps: [
      { text: 'Press Run. Look at the Output box', hint: 'The Run button is under the code', done: (s) => s.runs.some((r) => r.status === 'done' && r.stdout.trim().length > 0) },
      { text: 'Change the words between the quotes to anything you like, then press Run again', hint: 'print("I wrote this")', done: (s) => s.runs.some((r) => r.status === 'done' && r.stdout.trim().length > 0 && r.stdout.trim() !== 'Hello, panda') },
      { text: 'Now break it on purpose. Rub out the t in print, so it says prin, and press Run', hint: 'prin("I wrote this")', done: (s) => failedWith(s, 'NameError') },
      { text: 'Read the red message. It names the kind of error, the line, and the word it did not recognise. The dark box under it is Python\'s own report of the same error. Put the t back and press Run', hint: 'print("I wrote this")', done: afterError },
    ],
    debrief: 'You wrote a program, ran it, broke it and fixed it using only what the error told you. NameError means Python met a word it had no meaning for. It did not guess that prin was a typing slip, because it does exactly what the text says. Everyone who writes code reads messages like that one. It is information, not a telling-off.',
  },
  'prog-first-countdown': {
    id: 'prog-first-countdown', title: 'Out of order', xp: 40, setup: blank,
    starter: `print("Go!")
print(3)
prin(2)
print(1)
`,
    steps: [
      watch('Before you press Run, say what you expect to see. Then press Run, and compare', 'Look at the Output box as well as the red message', (s) => failedWith(s, 'NameError')),
      {
        text: 'Make it print 3, then 2, then 1, then Go!, each on its own line',
        hint: 'Fix the word on line 3, then move the "Go!" line to the bottom',
        done: (s) => { const r = lastRun(s); return !!r && r.status === 'done' && tidy(r.stdout) === '3\n2\n1\nGo!'; },
        why: (s) => { const r = lastRun(s); return r && r.status === 'done' && tidy(r.stdout) !== '3\n2\n1\nGo!' ? `It printed ${JSON.stringify(tidy(r.stdout))}; expected "3\\n2\\n1\\nGo!" (\\n marks a new line).` : ''; },
      },
    ],
    debrief: 'Two things to keep. Python runs from the top, one line at a time, so the order of the lines is the order of what happens. And when it reached the bad line it had already done the lines above it: "Go!" and 3 were printed before it stopped. Output followed by an error tells you how far the program got.',
  },
  'prog-vals-share': {
    id: 'prog-vals-share', title: 'Where did the two pounds go?', xp: 50, setup: blank,
    starter: `bill = 60
people = 4
share = bill // people
print(share)
`,
    steps: [
      watch('Run it. Four people paying 15 each covers a bill of 60, so this looks right', 'Press Run', (s) => s.runs.some((r) => r.status === 'done' && tidy(r.stdout) === '15')),
      watch('Change the bill to 90 and run it. Multiply the answer by 4. Is that 90?', 'bill = 90', (s) => s.runs.some((r) => r.status === 'done' && tidy(r.stdout) === '22')),
      inputStep('Fix it, so the share is right for any bill and any number of people. Keep the bill and people lines at the top: the check changes them', 'One character. // throws the remainder away, and / keeps it', SHARE_CASES),
    ],
    debrief: 'No error appeared, because // did exactly what it means: divide, then round down to a whole number. The program was wrong without saying so, and only on some inputs, which is why the first run looked fine. The check tried bills you never saw. That is the habit to take away: a program that is right for the numbers you tried may not be right.',
  },
  'prog-vals-age': {
    id: 'prog-vals-age', title: 'Text that looks like a number', xp: 50, setup: blank,
    starter: `age_text = "41"
next_year = age_text + 1
print(next_year)
`,
    steps: [
      watch('Run it, and read the error. Which two types is it refusing to add?', 'Press Run', (s) => failedWith(s, 'TypeError')),
      inputStep('Make it print the age next year, for any age_text. Keep age_text as a string in quotes, because that is what you would get from a real input', 'int(age_text) turns the text into a whole number', AGE_CASES),
    ],
    debrief: 'To you, "41" and 41 look the same. To Python one is two characters of text and the other is a number, and + means different things for each. Real Python\'s input() always hands you text, so this conversion is something you will write again and again. If you tried age_text + "1", it ran without an error and gave you 411, which is the worse kind of wrong.',
  },
  'prog-dec-ticket': {
    id: 'prog-dec-ticket', title: 'The else you forgot', xp: 60, setup: blank,
    starter: `age = 30
if age >= 18:
    print("adult")
elif age >= 13:
    print("teen")
`,
    steps: [
      watch('Run it. It prints adult, which is right for 30', 'Press Run', (s) => s.runs.some((r) => r.status === 'done' && tidy(r.stdout) === 'adult')),
      watch('Change age to 8 and run it. Look closely at what happens, and what does not', 'age = 8', (s) => s.runs.some((r) => r.status === 'done' && tidy(r.stdout) === '')),
      inputStep('Fix it, so every age prints exactly one word: child under 13, teen from 13 to 17, adult from 18 up', 'Add an else: on its own line under the elif block, then an indented print("child")', TICKET_CASES),
    ],
    debrief: 'With age 8, neither test was true, so neither line ran, and the program ended normally with no output and no error. Python did not forget anyone: you did not say what to do. The check tried 12, 13, 17 and 18 too, because the edges are where a > that should have been >= hides. When you write an if, ask what happens to everything it does not catch.',
  },
  'prog-dec-leap': {
    id: 'prog-dec-leap', title: 'Is it a leap year?', xp: 70, setup: blank,
    starter: `year = 2024
if year % 4 = 0:
    print("leap")
else:
    print("not leap")
`,
    steps: [
      watch('Run it, and read the whole message. Python has a guess about what you meant', 'Press Run', (s) => s.runs.some((r) => r.error?.type === 'SyntaxError' && /Maybe you meant/.test(r.error.message))),
      inputStep('Fix that one character. It should now print leap for a year that divides by 4 and not leap otherwise. Keep the year line at the top', 'if year % 4 == 0:', LEAP_EASY_CASES),
      inputStep('Now the real rule. A year divisible by 100 is not a leap year, unless it is also divisible by 400. So 1900 is not, and 2000 is', 'if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0):', LEAP_CASES),
    ],
    debrief: 'One = stores a value and == asks a question, and Python refuses the first where a question belongs. C does not refuse it, and that is the 2003 story at the top of this lesson. Your first fix looked finished, and it is right for every year from 1901 to 2099. A check on a handful of ordinary years would never catch 1900. The rule\'s rare cases are the ones worth testing by name.',
  },
  'prog-loop-stuck': {
    id: 'prog-loop-stuck', title: 'The line that changed nothing', xp: 60, setup: blank,
    starter: `n = 5
while n > 0:
    print(n)
    n - 1
print("Go!")
`,
    steps: [
      watch('Run it. Then press Step a few times and watch n in the Variables panel', 'If it is still going, press Stop. This page also stops it by itself', (s) => s.runs.some((r) => r.status === 'budget' || r.status === 'output' || r.status === 'stopped')),
      inputStep('Fix the one line that does nothing, so it counts down and then prints Go!. Keep n = at the top: the check tries other starting numbers', 'n - 1 works out a value and throws it away. n = n - 1 stores it', COUNTDOWN_CASES),
    ],
    debrief: 'n - 1 is a perfectly good calculation. Python did it, got 4, and threw the answer away, so n stayed 5 and the test stayed true for ever. No error appears, because nothing is wrong with any single line. When a loop will not stop, find the value the test depends on and watch whether it changes. Real Python has no step limit, and it would run until you pressed Ctrl+C.',
  },
  'prog-loop-sum': {
    id: 'prog-loop-sum', title: 'Off by one', xp: 60, setup: blank,
    starter: `n = 10
total = 0
for i in range(1, n):
    total = total + i
print(total)
`,
    steps: [
      watch('Run it. This should add up 1 to 10, and that makes 55. What did you get? Press Step and find the number it never reaches', 'Press Run, then Step', (s) => s.runs.some((r) => r.status === 'done' && tidy(r.stdout) === '45')),
      inputStep('Fix it, so it adds up 1 to n for any n. Keep n = at the top', 'range stops before its end, so the end has to be one past the last number you want', SUM_CASES),
    ],
    debrief: 'range(1, n) stops before n, so the last number was missing and the total was short by exactly n. There was no error, just a plausible number. If you checked 1 to 3 by hand you would catch it straight away: small cases you can do in your head are the cheapest test there is. Did you use n * (n + 1) // 2 instead? That passes too, because the check only looks at what the program does.',
  },
  'prog-fn-fahrenheit': {
    id: 'prog-fn-fahrenheit', title: 'It printed the answer. That is not the same', xp: 60, setup: blank,
    starter: `def to_fahrenheit(c):
    print(c * 9 / 5 + 32)

to_fahrenheit(100)
`,
    steps: [
      watch('Run it. It prints 212.0, the boiling point of water, so it looks finished', 'Press Run', (s) => s.runs.some((r) => r.status === 'done' && /212/.test(r.stdout))),
      {
        text: 'Now the check calls your function and looks at what comes back. Make it hand the answer back instead of printing it',
        hint: 'return c * 9 / 5 + 32',
        done: (s) => fahrenheitProblem(s) === '',
        why: (s) => (lastRun(s) ? fahrenheitProblem(s) : ''),
      },
    ],
    debrief: 'print shows a value to a person, and return hands a value to the code that called the function. A function that only prints gives its caller None, so nothing else in the program can use the answer: to_fahrenheit(100) + 1 would be a TypeError. You will see print and return mixed up constantly, including in your own code, because on screen they can look identical.',
  },
  'prog-fn-leap': {
    id: 'prog-fn-leap', title: 'One job, one name', xp: 70, setup: blank,
    starter: `def is_leap(year):
    if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0):
        return True

def days_in_year(year):
    # Use is_leap here.
    return 365

print(is_leap(2024), days_in_year(2024))
`,
    steps: [
      watch('Run it. One answer is right and one is wrong', 'Press Run', (s) => s.runs.some((r) => r.status === 'done' && /True 365/.test(r.stdout))),
      caseStep('is_leap gives True or nothing. Make it return False for a year that is not a leap year. Try print(is_leap(2023)) first and see what it gives now', 'Add return False as the last line of the function', 'is_leap', IS_LEAP_CASES),
      {
        text: 'Now make days_in_year give 366 in a leap year and 365 otherwise, by calling is_leap',
        hint: 'if is_leap(year):',
        done: (s) => daysProblem(s) === '',
        why: (s) => (lastRun(s) ? daysProblem(s) : ''),
      },
    ],
    debrief: 'The function with no return False handed back None, Python\'s word for nothing. It looks harmless, because None counts as false in an if. It is also the else you forgot, one more time. And days_in_year does not know the leap year rule. It asks is_leap, so if that rule ever has to change, it changes in one place. That is what a function is for.',
  },
  'prog-list-remove': {
    id: 'prog-list-remove', title: 'Sawing off the branch', xp: 60, setup: blank,
    starter: `def remove_all(items, target):
    for x in items:
        if x == target:
            items.remove(x)
    return items

print(remove_all([5, 1, 7], 1))
`,
    steps: [
      watch('Run it. It takes the 1 out, and the answer is right', 'Press Run', (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes('[5, 7]'))),
      watch('Change the last line to print(remove_all([1, 1, 2], 1)) and run it. Then press Step, and watch which items x actually visits', 'print(remove_all([1, 1, 2], 1))', (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes('[1, 2]'))),
      caseStep('Fix it, so every copy of target goes, wherever they are', 'Build a new list: start with result = [], append each item that is not target, then return result', 'remove_all', REMOVE_CASES),
    ],
    debrief: 'The loop walks along by position. Removing an item slides everything after it one place left, so the loop\'s next position skips an item. There is no error, and it only goes wrong when two matches sit next to each other, so a test with one match passes. The Python tutorial\'s advice is the fix you probably used: loop over a copy, or build a new list.',
  },
  'prog-list-default': {
    id: 'prog-list-default', title: 'The basket that remembered', xp: 70, setup: blank,
    starter: `def add_item(item, basket=[]):
    basket.append(item)
    return basket

print(add_item("tea"))
print(add_item("milk"))
`,
    steps: [
      watch('Run it. Two separate calls, with no basket passed in. Why is the tea still there?', 'Press Run', (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes("['tea', 'milk']"))),
      {
        text: 'Fix it. With no basket given, each call starts an empty one. With a basket given, the item goes on the end of that one',
        hint: 'def add_item(item, basket=None): then, inside, if basket is None: basket = []',
        done: (s) => defaultProblem(s) === '',
        why: (s) => (lastRun(s) ? defaultProblem(s) : ''),
      },
    ],
    debrief: 'The default value is created once, when def runs, not once per call. So every call that leaves basket out shares the same single list, and append changes that list. Numbers and strings can\'t be changed, so a default of 0 or "" is safe, which is why this surprises people the first time they use a list. None as the default, then a new list inside, is what Python\'s own FAQ recommends.',
  },
  'prog-list-copy': {
    id: 'prog-list-copy', title: 'Two names, one list', xp: 70, setup: blank,
    starter: `def with_bonus(scores):
    result = scores
    for i in range(len(scores)):
        result[i] = result[i] + 1
    return result

mine = [1, 2, 3]
theirs = with_bonus(mine)
print(theirs)
print(mine)
`,
    steps: [
      watch('Run it. theirs is right. Now look at mine, which nobody meant to change', 'Press Run', (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes('[2, 3, 4]\n[2, 3, 4]'))),
      {
        text: 'Fix it, so with_bonus returns a new list and leaves the one it was given alone',
        hint: 'result = scores makes a second name for the same list. result = scores[:] makes a copy',
        done: (s) => bonusProblem(s) === '',
        why: (s) => (lastRun(s) ? bonusProblem(s) : ''),
      },
    ],
    debrief: 'result = scores copied nothing. It gave the same list a second name, and mine was a third name for it the moment the function was called. Every change through one name shows through the others. A copy with [:], list() or .copy() is one way out, and building a new list with append is another. Copying only goes one level down, and the Go Deeper section shows what that means.',
  },
  'prog-map-count': {
    id: 'prog-map-count', title: 'Counting with a dictionary', xp: 70, setup: blank,
    starter: `def count_words(words):
    counts = {}
    for w in words:
        counts[w] = counts[w] + 1
    return counts

print(count_words(["tea", "milk", "tea"]))
`,
    steps: [
      watch('Run it, and read the KeyError. Which word is it, and why does that word have no entry yet?', 'Press Run', (s) => failedWith(s, 'KeyError')),
      equalStep('Fix it, so a word seen for the first time counts as 1', 'counts.get(w, 0) gives 0 for a word not there yet', 'count_words', COUNT_CASES),
    ],
    debrief: 'Reading a key that is not there is an error, and that is a good thing: an empty answer would look like a real one. The first time you see a word it has no entry, so you need a first-time rule. Either ask with in, or use .get with a default. The check compares dictionaries by what they hold, not the order you built them in, because two dictionaries with the same pairs are equal.',
  },
  'prog-map-orders': {
    id: 'prog-map-orders', title: 'Records in, totals out', xp: 80, setup: blank,
    starter: `def totals(orders):
    result = {}
    # Each order is a record, like {"name": "Mei", "amount": 5}.
    # Add up the amounts for each name.
    return result

print(totals([
    {"name": "Mei", "amount": 5},
    {"name": "Bo", "amount": 2},
    {"name": "Mei", "amount": 3},
]))
`,
    steps: [
      watch('Run it. It prints an empty dictionary, with no error. An empty result reads as "no orders", which is false', 'Press Run', (s) => s.runs.some((r) => r.status === 'done' && /\{\}/.test(r.stdout))),
      equalStep('Write it. A record is a dictionary, so order["name"] is the name and order["amount"] is the amount', 'for order in orders: then result[order["name"]] = result.get(order["name"], 0) + order["amount"]', 'totals', ORDER_CASES),
    ],
    debrief: 'That is a list of records going in and a map coming out, which is the shape of a great many real programs. Each record uses a dictionary with fixed keys, and the result uses a dictionary whose keys come from the data. Same type, two different jobs.',
  },
  'prog-set-common': {
    id: 'prog-set-common', title: 'What is on both lists?', xp: 70, setup: blank,
    starter: `def in_both(a, b):
    result = []
    for x in a:
        for y in b:
            if x == y:
                result.append(x)
    return result

print(in_both([1, 1, 2], [1, 1]))
`,
    steps: [
      watch('Run it. Is 1 really on the answer four times?', 'Press Run', (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes('[1, 1, 1, 1]'))),
      caseStep('Fix it. Return each value on both lists once, smallest first', 'sorted(set(a) & set(b))', 'in_both', COMMON_CASES),
    ],
    debrief: 'A set holds each value once, so duplicates vanish without you writing a line for it, and & keeps what two sets share. sorted matters here. A set makes no promise about order, so anything that has to come out in a certain order needs saying so, and sorted always hands back a list.',
  },
  'prog-text-tidy': {
    id: 'prog-text-tidy', title: 'The string that would not change', xp: 60, setup: blank,
    starter: `def tidy_email(s):
    s.strip()
    s.lower()
    return s

print("[" + tidy_email("  Mei@Example.COM ") + "]")
`,
    steps: [
      watch('Run it. Both methods ran, and no error appeared. Did anything change?', 'Press Run', (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes('Mei@Example.COM'))),
      {
        // New lines as well as spaces, in the words: it tests 'X@Y.Z\\n', and a step that only
        // said "spaces" failed s.strip(" ") with a character this lesson hasn't explained yet.
        text: 'Fix it, so tidy_email returns the address in lower case, with any spaces or new lines around it gone',
        hint: 's = s.strip() keeps the new string that strip made. With nothing in its brackets, strip takes spaces and new lines off both ends',
        done: (s) => { const r = lastRun(s); return !!r && checkCases(r, 'tidy_email', TIDY_CASES).ok; },
        why: (s) => {
          const r = lastRun(s);
          if (!r) return '';
          const why = checkCases(r, 'tidy_email', TIDY_CASES);
          return !why.ok && why.why.includes('\\n') ? `${why.why} (\\n is how a new line looks inside quote marks.)` : why.why;
        },
      },
    ],
    debrief: 'Strings can\'t be changed, so no string method changes the one you have. The ones that produce text make a new string and hand it back, and if you don\'t keep it, it is gone. That is why s.strip() on its own line does nothing you can see, and why no error warns you. Lists are the other way round: items.sort() changes the list and hands back None. When a line seems to do nothing, ask which of those two it is.',
  },
  'prog-text-count': {
    id: 'prog-text-count', title: 'Is "cat" in "concatenate"?', xp: 70, setup: blank,
    starter: `def count_word(text, word):
    return text.count(word)

print(count_word("my cat can concatenate", "cat"))
`,
    steps: [
      watch('Run it. There is one cat in that sentence. What did it say?', 'Press Run', (s) => s.runs.some((r) => r.status === 'done' && /^2\s*$/.test(r.stdout))),
      caseStep('Fix it: count whole words only, ignoring capitals. Words here are separated by spaces, and there is no punctuation to worry about', 'Lower-case both, use .split() to get the words, then compare each one or use .count on the list', 'count_word', WORD_CASES),
    ],
    debrief: 'text.count looks for letters in a row, and it has no idea what a word is. .split() gives you the words, and lower() makes capitals stop mattering. Real text has commas, and hyphens, and apostrophes, and this version would miss "cat," with a comma. What counts as a word is a decision you have to make, and text is full of those.',
  },
};

export const PROG_A_MISSIONS: Record<string, CodeMission> = Object.fromEntries(Object.entries(PROG_A_RAW).map(([k, m]) => [k, credit(m)]));

function fahrenheitProblem(s: CodeState): string {
  const r = lastRun(s);
  if (!r) return 'not run';
  const values = checkCases(r, 'to_fahrenheit', FAHRENHEIT_CASES);
  if (!values.ok) return values.why;
  // The mission is print against return, so a function doing both hasn't learned the difference.
  const p = new PyProgram(r.src, { maxOps: 500_000 });
  p.run();
  const before = p.stdout.length;
  p.call('to_fahrenheit', [0n]);
  return p.stdout.length > before ? 'to_fahrenheit(0) hands back the right answer, and it prints something as well. Take the print out of the function: whoever called it decides what to show.' : '';
}

function daysProblem(s: CodeState): string {
  const r = lastRun(s);
  if (!r) return 'not run';
  const values = checkCases(r, 'days_in_year', DAYS_CASES);
  if (!values.ok) return values.why;
  // Behaviour, not text: swap is_leap for one that always gives the same answer, and see
  // whether days_in_year follows. A copy of the rule pasted in would get every year right.
  for (const [always, year, want] of [[true, 2023n, '366'], [false, 2024n, '365']] as const) {
    const p = new PyProgram(r.src, { maxOps: 500_000 });
    p.run();
    p.globals.vars.set('is_leap', new PyBuiltin('is_leap', () => always));
    const got = p.call('days_in_year', [year]);
    if (!got.ok) return `With is_leap replaced, days_in_year(${year}) raised ${got.error.type}: ${got.error.message}`;
    if (repr(got.value) !== want) return `days_in_year gets the right answers without asking is_leap: with is_leap changed to always say ${always ? 'True' : 'False'}, days_in_year(${year}) still gave ${repr(got.value)}. Call is_leap instead of repeating the rule.`;
  }
  return '';
}

function defaultProblem(s: CodeState): string {
  const r = lastRun(s);
  if (!r) return 'not run';
  if (r.status !== 'done') return 'The program has to finish without an error first.';
  const p = new PyProgram(r.src, { maxOps: 500_000 });
  p.run();
  const empty = new PyList(), full = new PyList(['x']);
  // In one run, because shared state is what a mutable default is. The baskets are kept here,
  // so the check sees what happens to the caller's list and not just what comes back. An empty
  // one matters most: if not basket and basket or [] both drop it, and they pass everything else.
  const script: { args: Val[]; shown: string; want: string; kept?: PyList; wantKept?: string }[] = [
    { args: ['a'], shown: "add_item('a')", want: "['a']" },
    { args: ['b'], shown: "add_item('b')", want: "['b']" },
    { args: ['c', empty], shown: "add_item('c', basket), with an empty basket,", want: "['c']", kept: empty, wantKept: "['c']" },
    { args: ['c', full], shown: "add_item('c', basket), with ['x'] as the basket,", want: "['x', 'c']", kept: full, wantKept: "['x', 'c']" },
    { args: ['d'], shown: "add_item('d')", want: "['d']" },
  ];
  for (const c of script) {
    const got = p.call('add_item', c.args);
    if (!got.ok) return `${c.shown} raised ${got.error.type}: ${got.error.message}`;
    if (repr(got.value) !== c.want) return `${c.shown} returned ${repr(got.value)}; expected ${c.want}.`;
    if (c.kept && repr(c.kept) !== c.wantKept) return `${c.shown} returned the right list, and left the basket it was given as ${repr(c.kept)}. The item has to go on the end of that one. An empty basket is still a basket: it counts as false, so test for None, not for nothing.`;
  }
  return '';
}

function bonusProblem(s: CodeState): string {
  const r = lastRun(s);
  if (!r) return 'not run';
  if (r.status !== 'done') return 'The program has to finish without an error first.';
  const values = checkCases(r, 'with_bonus', BONUS_CASES);
  if (!values.ok) return values.why;
  const alone = leavesArgumentAlone(r, 'with_bonus', [[1, 2, 3]]);
  return alone.ok ? '' : alone.why;
}
