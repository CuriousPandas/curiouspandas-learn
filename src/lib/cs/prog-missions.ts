// Code-lab missions for the second half of Programming from Zero. Same rule as
// src/lib/cs/missions.ts: a step judges what the program does on inputs the learner
// never saw, never the words they typed. A fix that special-cases the visible input
// has to fail, and tests/prog-practice-missions.test.ts plays each tempting shortcut to
// be sure that it does. Steps are re-judged on the latest run every time the panel
// refreshes, so a later step must never make an earlier one false:
// tests/prog-missions-finish.test.ts plays every mission to the end to hold that.

import type { Mission } from '../missions.ts';
import { checkCases, toPy, type GrowthPoint, type GrowthShape, type RunResult } from '../py/lab.ts';
import { PyProgram } from '../py/vm.ts';
import { parse } from '../py/parser.ts';
import { PyDict, PyList, PyTuple, dictSet, repr as reprOf, type Val } from '../py/values.ts';
import { judgeSuite, type UnderTest } from './prog-testing.ts';

type State = { runs: RunResult[]; growth: { src: string; fn: string; points: GrowthPoint[]; shape: GrowthShape }[] };
type M = Mission<State> & { starter?: string; stdin?: string[]; given?: string };

const blank = (): State => ({ runs: [], growth: [] });
const last = (s: State) => s.runs.at(-1);
const cases = (s: State, fn: string, c: { args: unknown[]; want: string }[]) => {
  const r = last(s);
  return !!r && checkCases(r, fn, c).ok;
};
/** A run on input the learner never saw. */
const runWith = (src: string, stdin?: string[]) => { const p = new PyProgram(src, { maxOps: 500_000, stdin }); p.run(); return p; };
/** Every top-level def exists after this, even if a test further down stopped the program. */
const defined = (s: State) => { const r = last(s); return r ? runWith(r.src, r.program.stdin) : null; };
const raisesFrom = (p: PyProgram, fn: string, args: unknown[]) => { const got = p.call(fn, args.map(toPy)); return got.ok ? '' : got.error.type; };

// ---- input-and-errors

// A prompt and whatever's printed next share a line when input comes from a box, as in
// real Python. Asking with no prompt leaves only what the program itself printed, so a
// prompt that mentions 150 can't look like an answer of 150.
const NO_PROMPT = 'read_a_line = input\ndef input(prompt=""):\n    return read_a_line()\n';
/** Did the run end by saying this number? The last line with any digit in it must hold it. */
const saysAge = (src: string, stdin: string[], n: number) => {
  const p = new PyProgram(src, { maxOps: 500_000, stdin, given: NO_PROMPT });
  p.run();
  if (p.status !== 'done') return false;
  // Not only the very end of the output: "You are 41 years old" and a closing "Thanks!"
  // are both fine, and failing them with no reason given told a learner nothing.
  const line = p.stdout.split('\n').filter((l) => /\d/.test(l)).at(-1) ?? '';
  return new RegExp(`(^|[^\\d.-])${n}(?![\\d])`).test(line);
};
// Long enough that a program which gives up after a few tries and makes up an age can't
// reach the end of it. Two lines let `for i in range(3)` plus `return 0` pass every step.
const NONSENSE = Array.from({ length: 200 }, () => 'abc');
const asksAgain = (s: State) => {
  const r = last(s);
  if (!r) return false;
  // Giving up on bad input with a made-up age must not pass: a stream of nonsense
  // has to end with it still asking, which here means running out of input.
  const stuck = runWith(r.src, NONSENSE);
  return saysAge(r.src, ['abc', '', '41'], 41) && saysAge(r.src, ['7'], 7) && stuck.error?.type === 'SandboxLimit';
};
const rejectsImpossible = (s: State) => {
  const r = last(s);
  return !!r && saysAge(r.src, ['-3', '200', '150'], 150) && saysAge(r.src, ['151', '0'], 0) && saysAge(r.src, ['twelve', '-1', '12'], 12);
};

// ---- your-first-tests

// True division, as the learner's own arithmetic would be. Floor division here made
// correct tests such as (10, 25) == 7.5 fail on the "fixed" function, with no way of
// seeing why, since it's hidden.
const PRICE_CORRECT = `def price_after_discount(price, percent):
    return price - price * percent / 100
`;
const PRICE_BUGGY = `def price_after_discount(price, percent):
    return price - percent
`;
export const TICKET_PRICE: UnderTest = {
  name: 'ticket_price',
  params: 'age',
  correct: `def ticket_price(age):
    if age < 5:
        return 0
    if age < 18:
        return 5
    if age < 65:
        return 10
    return 6
`,
  broken: {
    alwaysAdult: 'def ticket_price(age):\n    return 10\n',
    childPaysUnder5: 'def ticket_price(age):\n    if age < 18:\n        return 5\n    if age < 65:\n        return 10\n    return 6\n',
    noSeniorRate: 'def ticket_price(age):\n    if age < 5:\n        return 0\n    if age < 18:\n        return 5\n    return 10\n',
    edgeAt5: 'def ticket_price(age):\n    if age <= 5:\n        return 0\n    if age < 18:\n        return 5\n    if age < 65:\n        return 10\n    return 6\n',
    edgeAt18: 'def ticket_price(age):\n    if age < 5:\n        return 0\n    if age <= 18:\n        return 5\n    if age < 65:\n        return 10\n    return 6\n',
    edgeAt65: 'def ticket_price(age):\n    if age < 5:\n        return 0\n    if age < 18:\n        return 5\n    if age <= 65:\n        return 10\n    return 6\n',
    // The other side of each edge. Tests at exactly 5, 18 and 65 say nothing about 4, 17
    // and 64, so a suite could finish this mission while missing `age < 17`.
    edgeAt4: 'def ticket_price(age):\n    if age < 4:\n        return 0\n    if age < 18:\n        return 5\n    if age < 65:\n        return 10\n    return 6\n',
    edgeAt17: 'def ticket_price(age):\n    if age < 5:\n        return 0\n    if age < 17:\n        return 5\n    if age < 65:\n        return 10\n    return 6\n',
    edgeAt64: 'def ticket_price(age):\n    if age < 5:\n        return 0\n    if age < 18:\n        return 5\n    if age < 64:\n        return 10\n    return 6\n',
    // The right bands at slightly wrong prices. Loose tests such as ticket_price(0) < 5
    // and ticket_price(18) > 5 killed every other mutant and can't see these.
    freeCosts1: 'def ticket_price(age):\n    if age < 5:\n        return 1\n    if age < 18:\n        return 5\n    if age < 65:\n        return 10\n    return 6\n',
    childPays4: 'def ticket_price(age):\n    if age < 5:\n        return 0\n    if age < 18:\n        return 4\n    if age < 65:\n        return 10\n    return 6\n',
    adultPays11: 'def ticket_price(age):\n    if age < 5:\n        return 0\n    if age < 18:\n        return 5\n    if age < 65:\n        return 11\n    return 6\n',
    seniorPays7: 'def ticket_price(age):\n    if age < 5:\n        return 0\n    if age < 18:\n        return 5\n    if age < 65:\n        return 10\n    return 7\n',
  },
};
// Every step asks about the same run, and judging one is fifteen programs. Without this
// a refresh ran the suite seven times over.
let ticketSeen: { src: string; report: ReturnType<typeof judgeSuite> } | null = null;
const ticketReport = (s: State) => {
  const r = last(s);
  if (!r) return null;
  if (ticketSeen?.src !== r.src) ticketSeen = { src: r.src, report: judgeSuite(r.src, TICKET_PRICE) };
  return ticketSeen.report;
};

// ---- whose-code

export const REMOVE_DUPLICATES: UnderTest = {
  name: 'remove_duplicates',
  params: 'items',
  correct: `def remove_duplicates(items):
    """Return the list with duplicates removed, keeping the first of each."""
    seen = []
    for x in items:
        if x not in seen:
            seen.append(x)
    return seen
`,
  broken: {
    plausible: `def remove_duplicates(items):
    """Return the list with duplicates removed, keeping the first of each."""
    for x in items:
        if items.count(x) > 1:
            items.remove(x)
    return items
`,
    changesInput: `def remove_duplicates(items):
    """Return the list with duplicates removed, keeping the first of each."""
    seen = []
    for x in items:
        if x not in seen:
            seen.append(x)
    items[:] = seen
    return items
`,
  },
};
const dupReport = (s: State) => { const r = last(s); return r ? judgeSuite(r.src, REMOVE_DUPLICATES) : null; };
// This sandbox's sets iterate in insertion order, so list(set(items)) would look as
// if it keeps order. Real Python's sets promise no order, and on real Python that
// answer is wrong. Under this stand-in, iterating a set visibly doesn't keep order,
// while using one to remember what's been seen works as it should.
const UNORDERED_SET = `class set:
    def __init__(self, items=[]):
        self.items = []
        for x in items:
            self.add(x)
    def add(self, x):
        if x not in self.items:
            self.items.insert(0, x)
    def __contains__(self, x):
        return x in self.items
    def __iter__(self):
        return iter(self.items)
    def __len__(self):
        return len(self.items)
`;

// ---- real-program

const nestedDict = (o: Record<string, number>) => { const d = new PyDict(); for (const [k, v] of Object.entries(o)) dictSet(d, k, BigInt(v)); return d; };
const asPairs = (v: Val): [string, bigint][] | null => {
  if (!(v instanceof PyDict)) return null;
  return [...v.map.values()].map(([k, x]) => [k as string, x as bigint]);
};

function expenseChecks(s: State): boolean {
  const p = defined(s);
  if (!p || !p.globals.vars.has('parse_expense')) return false;
  const people = ['Ana', 'Ben', 'Cai'];
  const good: [string, string][] = [['Ana 30.00 dinner', "('Ana', 3000)"], ['Ben 12.5 taxi to the airport', "('Ben', 1250)"], ['Cai 7 snacks', "('Cai', 700)"], ['Ana 0.05', "('Ana', 5)"]];
  for (const [line, want] of good) {
    const q = defined(s)!;
    const got = q.call('parse_expense', [line, toPy(people)] as Val[]);
    if (!got.ok || reprOf(got.value) !== want) return false;
  }
  // Each of these must be refused, out loud. An unknown name matters most: quietly
  // accepting "Anna" would invent a fourth traveller who owes nobody and is owed all.
  for (const line of ['Anna 30.00 dinner', 'Ben lots dinner', 'Ben', '', 'Ben 1.234 dinner', 'Ben -5 refund']) {
    const q = defined(s)!;
    const got = q.call('parse_expense', [line, toPy(people)] as Val[]);
    if (got.ok || got.error.type !== 'ValueError') return false;
  }
  return true;
}

function balanceChecks(s: State): boolean {
  const p = defined(s);
  if (!p || !p.globals.vars.has('balances')) return false;
  const trips: { people: string[]; spent: [string, number][] }[] = [
    { people: ['Ana', 'Ben'], spent: [['Ana', 1000]] },
    { people: ['Ana', 'Ben', 'Cai'], spent: [['Ana', 3000], ['Ben', 1500], ['Ana', 1500]] },
    { people: ['Ana', 'Ben', 'Cai'], spent: [['Cai', 100]] }, // does not divide by 3
    { people: ['Dee', 'Eli', 'Fay', 'Gus'], spent: [['Dee', 999], ['Gus', 1]] },
    { people: ['Hal'], spent: [] },
    { people: ['Ana', 'Ben', 'Cai'], spent: [] },
  ];
  for (const t of trips) {
    const q = defined(s)!;
    const got = q.call('balances', [toPy(t.people), new PyList(t.spent.map(([n, c]) => new PyTuple([n, BigInt(c)])))] as Val[]);
    if (!got.ok) return false;
    const pairs = asPairs(got.value);
    if (!pairs || pairs.length !== t.people.length) return false;
    const total = t.spent.reduce((a, [, c]) => a + c, 0);
    let sum = 0n;
    for (const person of t.people) {
      const entry = pairs.find(([k]) => k === person);
      if (!entry || typeof entry[1] !== 'bigint') return false;
      sum += entry[1];
      const paid = t.spent.filter(([n]) => n === person).reduce((a, [, c]) => a + c, 0);
      // Fair to the cent: the leftover cents go to somebody, and each person's share
      // is within one cent of everybody else's.
      const low = Math.floor(total / t.people.length), high = Math.ceil(total / t.people.length);
      const share = paid - Number(entry[1]);
      if (share < low || share > high) return false;
    }
    if (sum !== 0n) return false; // cents neither created nor lost
  }
  return true;
}

/** What's wrong with settle on a trip the learner can't see, in words, or '' if nothing is. */
function settleProblem(s: State): string {
  const p = defined(s);
  if (!p || !p.globals.vars.has('settle')) return 'The lab can\'t find a function called settle.';
  const cases: Record<string, number>[] = [
    { Ana: 1000, Ben: -1000 },
    { Ana: 3000, Ben: -1000, Cai: -2000 },
    { Ana: 500, Ben: 500, Cai: -1000 },
    { Ana: 700, Ben: -300, Cai: -300, Dee: -100 },
    { Ana: 1, Ben: -1, Cai: 0 },
    { Ana: 0, Ben: 0 },
    { Eli: 2500, Fay: 1500, Gus: -3000, Hal: -1000 },
  ];
  for (const bal of cases) {
    const q = defined(s)!;
    const shown = `settle(${reprOf(nestedDict(bal))})`;
    const got = q.call('settle', [nestedDict(bal)]);
    if (!got.ok) return `${shown} raised ${got.error.type}: ${got.error.message}`;
    if (!(got.value instanceof PyList)) return `${shown} returned ${reprOf(got.value)}, and it should return a list`;
    const left = { ...bal };
    // No cap on how many payments. There used to be one, one fewer than the people with
    // a balance, while the lesson promised that any payments reaching 0 count: a correct
    // settle that split each debt in proportion was refused, with no reason given.
    for (const pay of got.value.items) {
      if (!(pay instanceof PyTuple) || pay.items.length !== 3) return `${shown} returned ${reprOf(got.value)}, and each payment should be (payer, payee, cents)`;
      const [from, to, cents] = pay.items;
      if (typeof from !== 'string' || typeof to !== 'string' || typeof cents !== 'bigint' || cents <= 0n) return `${shown} has the payment ${reprOf(pay)}: names, then a positive whole number of cents`;
      if (from === to) return `${shown} has ${from} paying themselves`;
      if (!(from in left) || !(to in left)) return `${shown} has the payment ${reprOf(pay)}, with someone who isn\'t on this trip`;
      left[from] += Number(cents);
      left[to] -= Number(cents);
    }
    const off = Object.entries(left).filter(([, v]) => v !== 0).map(([k, v]) => `${k} ${v}`);
    if (off.length) return `After the payments from ${shown}, these aren\'t at 0: ${off.join(', ')}`;
  }
  return '';
}
const settleChecks = (s: State) => settleProblem(s) === '';

export const TRIP_STDIN = ['Ana, Ben, Cai', 'Ana 90.00 hostel', 'Ben 30.50 train tickets', 'Cai lots of snacks', 'Cai 12.00 snacks', 'done'];

// ---- shapes that recur

/** Ran the function while still broken, printing something the starting program doesn't. */
const HYPOTHESIS_STARTER_OUT = '[1, 3]\n[1, -3, 4]\n';
function triedAGuess(s: State): boolean {
  return s.runs.some((r) => {
    if (r.status !== 'done' || r.stdout === HYPOTHESIS_STARTER_OUT) return false;
    const p = runWith(r.src);
    const got = p.call('without_negatives', [toPy([1, -2, -3, 4])]);
    return got.ok && reprOf(got.value) === '[1, -3, 4]';
  });
}

// Steps 1 and 2 hold before the rule changes and after it, or step 3 would untick them:
// it did, so the mission could never finish, its debrief stayed hidden and its 60 XP
// couldn't be earned. Each amount is judged alone, so a change that reached one copy of
// the rate and missed the other still counts as renamed, and fails at step 3, where the
// lesson wants that failure seen.
const lateFeeShape = (s: State) => {
  const r = last(s);
  if (!r) return false;
  const p = runWith(`${r.src}\nprint(late_fee(due_day=10, returned_day=15), late_fee(due_day=10, returned_day=10), late_fee(due_day=10, returned_day=8), late_fee(due_day=0, returned_day=30), late_fee(due_day=0, returned_day=31))\n`);
  return p.status === 'done' && /(125|150) 0 0 (750|900) (800|950)\s*$/.test(p.stdout);
};
/** Swap days_late for one that always says 1: a late_fee that really uses it now charges one day. */
const lateFeeCallsIt = (s: State) => {
  const r = last(s);
  if (!r) return false;
  const p = runWith(`${r.src}\ndef days_late(due_day, returned_day):\n    return 1\nprint(late_fee(10, 50))\n`);
  return p.status === 'done' && /(^|\n)(25|30)\s*$/.test(p.stdout);
};

// The stand-in set above can't reach {x for x in items}, which this engine builds as its
// own set, in insertion order. Real Python gives [1, 2, 3] for that on [2, 1, 2, 3, 1],
// so it's wrong there and looks right here. Reading the program's parsed form is a
// stop-gap for that one difference, until the engine's sets stop keeping order.
const hasSetComprehension = (src: string) => {
  let found = false;
  const walk = (n: unknown) => {
    if (found || n === null || typeof n !== 'object') return;
    const node = n as { k?: string; kind?: string; items?: { k?: string }[] };
    if (node.k === 'comp' && node.kind === 'set') { found = true; return; }
    // {*items} builds a set too, and just as silently keeps order only in this sandbox.
    if (node.k === 'set' && node.items?.some((i) => i.k === 'star')) { found = true; return; }
    for (const v of Object.values(n)) if (typeof v !== 'bigint') walk(v);
  };
  try { walk(parse(src)); } catch { return false; }
  return found;
};
const WHOSE_FIX_WHY = (s: State) => {
  const r = last(s);
  if (!r) return '';
  if (hasSetComprehension(r.src)) return 'That uses a set to hold the answer. Real Python\'s sets promise no order, so [2, 1, 2, 3, 1] can come out as [1, 2, 3] there. This sandbox\'s sets happen to keep order, which is why it looks right here.';
  return 'The lab tried [1, 2, 1], [3, 3, 3, 3], [], [2, 1, 2, 3, 1] and ["a", "b", "a"], and checked that the list it passed in was left unchanged.';
};

const nested = (n: number): unknown => { let x: unknown = [1]; for (let i = 1; i < n; i++) x = [x]; return x; };

export const PROG_MISSIONS: Record<string, M> = {
  'prog-errors-ask': {
    id: 'prog-errors-ask', title: 'Keep asking until it makes sense', xp: 50, setup: blank,
    stdin: ['forty', '41'],
    starter: `def ask_age():
    text = input("How old are you? ")
    return int(text)

print("You are", ask_age())
`,
    steps: [
      { text: 'Run it. "forty" is what a person might really type, and the program dies', hint: 'Press Run', done: (s) => s.runs.some((r) => r.error?.type === 'ValueError') },
      { text: 'Make ask_age keep asking until it gets a whole number', hint: 'while True: then try: return int(input(...)) and except ValueError: print a message. The loop goes round again by itself.', done: asksAgain, why: (s) => (last(s) ? 'The lab typed abc, then a blank line, then 41, and then 7 on its own: your program\'s last number has to be 41, then 7. Then it typed abc 200 times: your program has to still be asking at the end, not stop or make up an age.' : '') },
      { text: 'Refuse ages that can\'t be right: below 0 or above 150. Ask again for those too', hint: 'Inside the loop, after int(): if 0 <= age <= 150: return age', done: rejectsImpossible, why: (s) => (last(s) ? 'The lab typed -3, 200, 150, and then 151, 0, and then twelve, -1, 12. Your program\'s last number has to be 150, then 0, then 12.' : '') },
    ],
    debrief: 'Bad input from a person is expected, so you catch it, say what was wrong and ask again. If you caught only ValueError, the error int() raises for text it can\'t read, you caught what you planned for. The lab doesn\'t check that: except Exception would have passed here, and the next mission shows what it costs. And notice what never happens: nothing makes up an age. The lab tried it on input of its own, including a long stream of nonsense, and the program just kept asking.',
  },
  'prog-errors-swallow': {
    id: 'prog-errors-swallow', title: 'The error that was never reported', xp: 60, setup: blank,
    starter: `def total_cents(lines):
    # Adds up the amounts, skipping any line that isn't a number.
    total = 0
    for line in lines:
        try:
            total = totl + int(line)
        except Exception:
            pass
    return total

print(total_cents(["250", "oops", "100"]))
`,
    steps: [
      { text: 'Run it. It finishes cleanly, no error at all, and prints 0. The answer should be 350', hint: 'Press Run. Then look at line 6 slowly.', done: (s) => s.runs.some((r) => r.status === 'done' && /^0\s*$/.test(r.stdout)) },
      { text: 'Stop catching everything: catch only the error a bad line really causes', hint: 'int("oops") raises ValueError, so: except ValueError:. Now run it, and read what appears.', done: (s) => { const p = defined(s); return !!p && raisesFrom(p, 'total_cents', [[null]]) !== '' && raisesFrom(defined(s)!, 'total_cents', [[null]]) !== 'Budget'; } },
      { text: 'Now the real bug is on screen. Fix it, so bad lines are skipped and everything else adds up', hint: 'total = total + int(line)', done: (s) => {
        const p = defined(s);
        return cases(s, 'total_cents', [
          { args: [['250', 'oops', '100']], want: '350' }, { args: [[]], want: '0' }, { args: [['x', 'y']], want: '0' }, { args: [['5']], want: '5' }, { args: [[' 7 ', '-3']], want: '4' },
        ]) && !!p && raisesFrom(p, 'total_cents', [[null]]) !== '';
      } },
    ],
    debrief: 'except Exception caught a typo and threw it away, so a program with a broken line looked like a program with no money in it. except ValueError still skips a bad line, on purpose, because that is the one failure you planned for. Everything you didn\'t plan for now stops the program and says where. The lab checked that as well: passing None, a mistake in the calling code rather than bad data, has to stay loud.',
  },

  'prog-debug-traceback': {
    id: 'prog-debug-traceback', title: 'The crash isn\'t where the bug is', xp: 50, setup: blank,
    starter: `def parse_price(line):
    # "tea,2.50" gives the price as a number.
    name, price = line.split(",")
    return price

def total(prices):
    t = 0
    for p in prices:
        t = t + p
    return t

def report(lines):
    prices = []
    for line in lines:
        prices.append(parse_price(line))
    return total(prices)

print(report(["tea,2.50", "cake,4.00"]))
`,
    steps: [
      { text: 'Run it, then read Python\'s report from the bottom up: what went wrong, on which line, called from where?', hint: 'Press Run', done: (s) => s.runs.some((r) => r.error?.type === 'TypeError') },
      { text: 'Fix the cause, not the place it crashed. What does parse_price promise, and what does it really return?', hint: 'One word changes in parse_price: return float(price)', done: (s) => cases(s, 'parse_price', [{ args: ['tea,2.50'], want: '2.5' }, { args: ['x,10'], want: '10.0' }]) && cases(s, 'report', [{ args: [['a,1.5', 'b,2.5', 'c,4.0']], want: '8.0' }, { args: [['a,0.5']], want: '0.5' }, { args: [[]], want: '0' }]) },
    ],
    debrief: 'The crash was in total, on a line that is perfectly correct. The bug was two calls away: parse_price said it returned a number and returned text. Patching total with float(p) would also have made this one print the right thing, while leaving a function that lies to every other caller, which is why the lab called parse_price directly as well. The traceback told you where it hurt. You worked out why.',
  },
  'prog-debug-step': {
    id: 'prog-debug-step', title: 'No error, wrong answer', xp: 60, setup: blank,
    starter: `def longest_run(items):
    # The length of the longest stretch of equal items in a row.
    best = 0
    current = 0
    previous = None
    for x in items:
        if x == previous:
            current += 1
        else:
            if current > best:
                best = current
            current = 1
        previous = x
    return best

print(longest_run(["a", "b", "b", "a"]))
print(longest_run(["a", "a", "b", "b", "b"]))
`,
    steps: [
      { text: 'Run it. The first answer is right. The second should be 3 and it prints 2', hint: 'Press Run', done: (s) => s.runs.some((r) => /^2\s+2\s*$/.test(r.stdout)) },
      { text: 'Press Step and watch best and current on the second list. Say what you expect on each line before you press. Where does your guess first go wrong? Then fix it', hint: 'Watch what happens to current after the last item. Nothing ever compares it with best again.', done: (s) => cases(s, 'longest_run', [
        { args: [['a', 'a', 'b', 'b', 'b']], want: '3' }, { args: [['x']], want: '1' }, { args: [[]], want: '0' }, { args: [[1, 1, 1]], want: '3' }, { args: [[1, 2, 2, 2, 3]], want: '3' }, { args: [[1, 2, 3, 3]], want: '2' }, { args: [[4, 4, 5]], want: '2' },
      ]) },
    ],
    debrief: 'The loop only updates best when a run ends, and the last run is never followed by anything that ends it. So the bug shows only when the longest run comes last, which is why the first test looked fine. That was a hypothesis you could check by pressing Step: "current reaches 3 and is thrown away". The lab then tried lists you never saw, so a fix aimed at the one failing example would not have passed.',
  },
  'prog-debug-hypothesis': {
    id: 'prog-debug-hypothesis', title: 'Test your guess before you touch the code', xp: 60, setup: blank,
    starter: `def without_negatives(items):
    for x in items:
        if x < 0:
            items.remove(x)
    return items

print(without_negatives([1, -2, 3]))
print(without_negatives([1, -2, -3, 4]))
`,
    steps: [
      { text: 'Run it. The first line looks right and the second keeps a -3. Guess why, then write one more print that would prove your guess wrong if it is wrong', hint: 'If removing an item makes the loop skip the next one, then [-1, -2, -3] should leave -2 behind. Predict it, then run it.', done: triedAGuess, why: (s) => (s.runs.length && !triedAGuess(s) ? 'The lab is waiting for a run of the function while it\'s still broken, with something new printed: the unchanged program doesn\'t test anything yet. It can\'t judge your guess, only that you ran a new print before you fixed anything. If you\'ve already changed the function, put it back first.' : '') },
      { text: 'Fix it so that no list can fool it', hint: 'Build a new list and leave the old one alone: keep = [] then keep.append(x) for each x >= 0', done: (s) => cases(s, 'without_negatives', [
        { args: [[1, -2, -3, 4]], want: '[1, 4]' }, { args: [[-1, -2, -3]], want: '[]' }, { args: [[]], want: '[]' }, { args: [[5, 6]], want: '[5, 6]' }, { args: [[-1, 2, -3, -4, 5, -6, -7, -8]], want: '[2, 5]' },
        // Going over the list twice looks like a fix until this many in a row.
        { args: [[-1, -2, -3, -4, -5, -6, -7, -8, -9]], want: '[]' },
        // Each pass over the list removes about half of a run. Four passes used to get
        // through, since the longest run tried was nine, and left -16 behind on -1 to -17.
        // This one takes nine. It's no longer, because a correct but slow fix (a while
        // loop that removes one at a time) has to finish inside the step budget, and at
        // 1,000 it doesn't. So ten passes in a row would still get through: this catches
        // the shortcut as people write it, and it isn't a proof.
        { args: [Array.from({ length: 500 }, (_, i) => -1 - i)], want: '[]' },
      ]) },
    ],
    debrief: 'Removing an item shifts everything after it one place left, while the loop\'s position moves one place right, so the item straight after a removal is never looked at. Your guess made a prediction you could check in one run, and a guess that can be wrong is worth far more than a guess that feels right. Python\'s tutorial warns about changing a collection while looping over it, and suggests looping over a copy or building a new one.',
  },

  'prog-tests-first': {
    id: 'prog-tests-first', title: 'A test that can fail', xp: 50, setup: blank,
    given: PRICE_BUGGY,
    starter: `def test_half_price():
    # Write an assert here. What should 200 at 50 percent off cost?
    pass

test_half_price()
print("all tests passed")
`,
    steps: [
      { text: 'Run it as it is. It says "all tests passed", and it checked nothing', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && /all tests passed/.test(r.stdout)) },
      { text: 'Replace pass with an assert that fails on this function, because the function is wrong', hint: 'assert price_after_discount(200, 50) == 100', done: (s) => {
        const r = last(s);
        // Fails on the bug and passes once the bug is fixed. assert False fails on
        // both, so it never gets past this step.
        return !!r && r.error?.type === 'AssertionError' && judgeSuite(r.src, { name: 'price_after_discount', params: 'price, percent', correct: PRICE_CORRECT, broken: {} }).passesOnCorrect;
      } },
    ],
    debrief: 'Your test fails on this function, and the lab ran it again on a fixed version, where it passes. That difference is what a test is for. The function subtracts 50 where it should subtract 50 percent, and the starting code said "all tests passed" about it, because a test with no check in it can\'t fail.',
  },
  'prog-tests-mutants': {
    id: 'prog-tests-mutants', title: 'Catch the broken versions', xp: 80, setup: blank,
    given: TICKET_PRICE.correct,
    starter: `def test_adult():
    assert ticket_price(30) == 10

test_adult()
print("all tests passed")
`,
    steps: [
      { text: 'Run the starting test. It passes on the correct function', hint: 'Press Run', done: (s) => { const j = ticketReport(s); return !!j && j.passesOnCorrect && j.callsIt; } },
      { text: 'Catch three broken versions: one that always charges 10, one that charges small children, one with no senior price. Your tests must still pass on the correct function', hint: 'Add one assert per price band. For example: assert ticket_price(3) == 0', done: (s) => { const j = ticketReport(s); return !!j && j.passesOnCorrect && j.caught.alwaysAdult && j.caught.childPaysUnder5 && j.caught.noSeniorRate; } },
      { text: 'Catch a version that treats a 5-year-old as under 5', hint: 'Bugs live at the edges. Test exactly 5.', done: (s) => { const j = ticketReport(s); return !!j && j.passesOnCorrect && j.caught.edgeAt5; } },
      { text: 'Catch a version that gets exactly 18 wrong', hint: 'What should an 18-year-old pay? Test it.', done: (s) => { const j = ticketReport(s); return !!j && j.passesOnCorrect && j.caught.edgeAt18; } },
      { text: 'Catch a version that gets exactly 65 wrong', hint: 'What should a 65-year-old pay? Test it.', done: (s) => { const j = ticketReport(s); return !!j && j.passesOnCorrect && j.caught.edgeAt65; } },
      { text: 'An edge has two sides. Catch three versions where a price band stops one year early: at 4, at 17 and at 64', hint: 'What should a 4-year-old, a 17-year-old and a 64-year-old pay?', done: (s) => { const j = ticketReport(s); return !!j && j.passesOnCorrect && j.caught.edgeAt4 && j.caught.edgeAt17 && j.caught.edgeAt64; } },
      { text: 'Catch four versions with the right bands and a slightly wrong price: 1 and not 0, 4 and not 5, 11 and not 10, 7 and not 6', hint: 'Say the exact price with ==. A test that only says < 5 or > 0 can\'t see these.', done: (s) => { const j = ticketReport(s); return !!j && j.passesOnCorrect && j.caught.freeCosts1 && j.caught.childPays4 && j.caught.adultPays11 && j.caught.seniorPays7; } },
    ],
    debrief: 'The lab ran your tests against the real function and thirteen broken ones, called mutants. Some have one tiny change, like a < written as <=, and some are missing a whole rule. A test suite that passes on all of them proves nothing, however green it looks. Yours failed on every mutant and passed on the correct function. Notice how many asserts it took: testing one adult caught only the mutant that overcharges adults. Thirteen is still a sample. A version that\'s wrong only at age 40 would get past these tests, so this is evidence that your tests are strong, not proof that they\'re complete. This is mutation testing at a tiny scale, with the mutants written out in advance. Real tools generate them for you.',
  },

  'prog-readable-refactor': {
    id: 'prog-readable-refactor', title: 'Same behaviour, readable shape', xp: 60, setup: blank,
    starter: `def f(d, r):
    x = r - d
    if x <= 0:
        return 0
    if x > 30:
        return 30 * 25 + (x - 30) * 50
    return x * 25

print(f(10, 15))
print(f(10, 50))
`,
    steps: [
      { text: 'Rename it so a caller can write late_fee(due_day=10, returned_day=15), with the same answers', hint: 'def late_fee(due_day, returned_day): and update the calls at the bottom', done: lateFeeShape },
      { text: 'Pull one idea into its own function: days_late(due_day, returned_day), never below 0. Have late_fee use it', hint: 'return max(0, returned_day - due_day), then late_fee starts with days = days_late(due_day, returned_day)', done: (s) => lateFeeShape(s) && cases(s, 'days_late', [{ args: [10, 15], want: '5' }, { args: [10, 10], want: '0' }, { args: [10, 8], want: '0' }]) && lateFeeCallsIt(s), why: (s) => (lateFeeShape(s) && cases(s, 'days_late', [{ args: [10, 15], want: '5' }, { args: [10, 10], want: '0' }, { args: [10, 8], want: '0' }]) && !lateFeeCallsIt(s) ? 'days_late works, but late_fee isn\'t using it: the lab swapped in a different days_late, and late_fee\'s answer didn\'t change.' : '') },
      { text: 'The rule changes: the first 30 days now cost 30 cents a day, not 25. After that it is still 50. Change it, and don\'t miss a spot', hint: '25 appears twice in the original. Name it once, at the top: FIRST_RATE = 30', done: (s) => cases(s, 'late_fee', [{ args: [10, 15], want: '150' }, { args: [0, 30], want: '900' }, { args: [0, 31], want: '950' }, { args: [0, 40], want: '1400' }, { args: [5, 5], want: '0' }]) },
    ],
    debrief: 'The lab could check your behaviour and your function names. This lab can\'t tell you whether your names are good, which is the honest limit of a checker like this one. A good reader can. The last step is the part that shows the cost. 25 lived in two places, so a change to one idea meant two edits, and missing one wouldn\'t have crashed anything. It would have charged people the wrong amount.',
  },

  'prog-rec-trees': {
    id: 'prog-rec-trees', title: 'Boxes inside boxes', xp: 70, setup: blank,
    starter: `def total(box):
    # A box holds numbers and other boxes, to any depth.
    result = 0
    for item in box:
        if isinstance(item, list):
            result = result + total(box)
        else:
            result = result + item
    return result

print(total([1, 2, 3]))
print(total([1, [2, 3], [[4]]]))
`,
    steps: [
      { text: 'Run it. The flat list works. The nested one never reaches a smaller box, and Python stops it. Read the error report', hint: 'Press Run', done: (s) => s.runs.some((r) => r.error?.type === 'RecursionError') },
      { text: 'Fix the call so each step really is closer to the end', hint: 'total(item), not total(box)', done: (s) => cases(s, 'total', [{ args: [[1, [2, 3], [[4]]]], want: '10' }, { args: [[]], want: '0' }, { args: [[[], [[]]]], want: '0' }, { args: [[[[[[5]]]], 1]], want: '6' }, { args: [nested(50)], want: '1' }]) },
      { text: 'Write depth(box): how many boxes deep it goes. A box with no boxes inside is 1', hint: 'deepest = 0, then for each item that is a list: deepest = max(deepest, depth(item)). Return deepest + 1. The empty box is the base case: its loop never runs.', done: (s) => cases(s, 'depth', [{ args: [[]], want: '1' }, { args: [[1, 2]], want: '1' }, { args: [[[]]], want: '2' }, { args: [[[], []]], want: '2' }, { args: [[1, [2, [3]], [4]]], want: '3' }, { args: [nested(50)], want: '50' }]) },
    ],
    debrief: 'A loop is awkward here, because you don\'t know how many loops to write: the data decides how deep it goes. Recursion fits, since a box inside a box is the same problem, only smaller. Your base case is quiet: an empty box returns without calling anything, because its loop has nothing to do. The bug you fixed is the one that matters: a recursive call has to move towards the end, or it never gets there.',
  },

  'prog-real-trip': {
    id: 'prog-real-trip', title: 'Who owes whom', xp: 120, setup: blank,
    stdin: TRIP_STDIN,
    starter: `# Who owes whom. Friends share costs on a trip: work out who pays whom so
# that everybody ends up even. Amounts are whole cents, because money in
# floats drifts: int(float("19.99") * 100) is 1998, not 1999.

def to_cents(text):
    # "12.50" gives 1250, "12" gives 1200. Anything else raises ValueError.
    parts = text.split(".")
    frac = parts[1] if len(parts) == 2 else ""
    if len(parts) > 2 or not parts[0].isdigit() or len(frac) > 2 or (frac and not frac.isdigit()):
        raise ValueError(f"not an amount: {text}")
    return int(parts[0]) * 100 + int((frac + "00")[:2])

def money(cents):
    return f"{cents // 100}.{cents % 100:02d}"

def parse_expense(line, people):
    # "Ana 30.00 dinner" gives ("Ana", 3000). The words after the amount are
    # optional. Raise ValueError if it can't be read or the name isn't in people.
    raise ValueError("write parse_expense")

def balances(people, expenses):
    # Each person's paid minus their fair share. Everybody's balance added up is 0.
    # If the total doesn't divide evenly, the first few people pay one cent more.
    return {}

def settle(balance):
    # A list of (payer, payee, cents) that brings every balance to 0.
    return []

def test_parse_expense():
    assert parse_expense("Ana 30.00 dinner", ["Ana", "Ben"]) == ("Ana", 3000)
    try:
        parse_expense("Zed 5 lunch", ["Ana", "Ben"])
    except ValueError:
        return
    assert False, "an unknown name must raise ValueError"

def test_balances():
    assert balances(["Ana", "Ben"], [("Ana", 1000)]) == {"Ana": 500, "Ben": -500}
    three = balances(["Ana", "Ben", "Cai"], [("Cai", 100)])
    assert sum(three.values()) == 0, "cents were created or lost"

def test_settle():
    # Any payments will do, so this checks what they add up to, not one exact list.
    left = {"Ana": 500, "Ben": -500}
    for payer, payee, cents in settle({"Ana": 500, "Ben": -500}):
        left[payer] += cents
        left[payee] -= cents
    assert left == {"Ana": 0, "Ben": 0}, "somebody is still owed money"
    assert settle({"Ana": 0, "Ben": 0}) == []

def main():
    people = [p.strip() for p in input("Who is on the trip? ").split(",")]
    print()
    expenses = []
    number = 1
    while True:
        line = input()
        if line == "done":
            break
        number += 1
        try:
            expenses.append(parse_expense(line, people))
        except ValueError as e:
            # Reported, not dropped: the totals below don't include this line.
            print(f"Skipped line {number}: {e}")
    spent = sum([cents for name, cents in expenses])
    print(f"Spent {money(spent)} between {len(people)} people.")
    payments = settle(balances(people, expenses))
    for payer, payee, cents in payments:
        print(f"{payer} pays {payee} {money(cents)}")
    if not payments:
        print("Everybody is even.")

test_parse_expense()
test_balances()
test_settle()
main()
`,
    steps: [
      { text: 'Run it. A test stops the program straight away, and that is the plan: each test says what the next function must do', hint: 'Press Run, then read the error report from the bottom up.', done: (s) => s.runs.some((r) => r.error !== undefined) },
      { text: 'Write parse_expense. The lab tries lines you can\'t see, including an unknown name, a missing amount and a negative one', hint: 'words = line.split(). No words, or fewer than 2: raise ValueError. Name not in people: raise ValueError. Then return (words[0], to_cents(words[1])).', done: expenseChecks },
      { text: 'Write balances. No cent may be created or lost, even when the total doesn\'t divide evenly', hint: 'Add up the total. share = total // len(people), extra = total % len(people). Each person starts at -share, and the first extra people get one cent less. Then add what each person paid.', done: balanceChecks },
      { text: 'Write settle. Any list of payments counts, as long as each is a positive whole number of cents from one person to another, and everyone ends at 0', hint: 'Copy the dict. Repeat: find who is owed most and who owes most. The smaller of the two amounts moves between them. Stop when nobody is owed anything.', done: settleChecks, why: (s) => settleProblem(s) },
      { text: 'Now use it. Change the input box to a real trip of your own, or your flat\'s bills, or last night\'s dinner, and run it', hint: 'First line: the names, with commas. Then one line per payment: Name amount what-for. Last line: done', done: (s) => {
        const r = last(s);
        return !!r && r.status === 'done' && r.program.stdin?.join('\n') !== TRIP_STDIN.join('\n') && /pays|even/.test(r.stdout);
      } },
    ],
    debrief: 'That was a real program: it reads messy input, refuses what it can\'t read and says so, holds its data in a dictionary, does its arithmetic in whole cents, and has tests that would catch a broken change. The lab judged it on behaviour you couldn\'t see, so your code can look nothing like anyone else\'s. Send it to the friend who still owes you money.',
  },

  'prog-whose-catch': {
    id: 'prog-whose-catch', title: 'It looks right. Is it?', xp: 70, setup: blank,
    given: REMOVE_DUPLICATES.broken.plausible,
    starter: `# The one example you've been given works:
assert remove_duplicates([1, 2, 2, 3]) == [1, 2, 3]

# Write an assert that exposes a bug.

print("all tests passed")
`,
    steps: [
      { text: 'Run it. The obvious example passes, and that is usually where people stop', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && /all tests passed/.test(r.stdout)) },
      { text: 'Write an assert that fails on this code and would pass on a correct version. "Keeping the first of each" is a promise: test it', hint: 'Try a list where the duplicates aren\'t next to each other: what should [1, 2, 1] give?', done: (s) => { const j = dupReport(s); return !!j && j.passesOnCorrect && j.callsIt && j.caught.plausible; } },
      { text: 'There\'s a second problem. It changes the list you handed it. Write an assert that catches that too, on a version that gets every answer right', hint: 'a = [1, 1]  then  remove_duplicates(a)  then  assert a == [1, 1]', done: (s) => { const j = dupReport(s); return !!j && j.passesOnCorrect && j.caught.plausible && j.caught.changesInput; } },
    ],
    debrief: 'We wrote this bug on purpose, to read like code you might be handed, with a tidy description and a working example. Like the rest of this site, it was written with AI help, and it isn\'t a captured sample of what any AI tool produces. Plausible isn\'t the same as correct. The test you wrote is what told them apart, and it would have told them apart whoever wrote the code.',
  },
  'prog-whose-fix': {
    id: 'prog-whose-fix', title: 'Now you own it', xp: 40, setup: blank,
    starter: `def remove_duplicates(items):
    """Return the list with duplicates removed, keeping the first of each."""
    for x in items:
        if items.count(x) > 1:
            items.remove(x)
    return items

print(remove_duplicates([1, 2, 1]))
`,
    steps: [
      { text: 'Fix it. Keep the first of each, keep the order, and leave the caller\'s list alone', hint: 'Build a new list: seen = [] and append each x that is not in seen yet.', done: (s) => {
        const r = last(s);
        if (!r || hasSetComprehension(r.src)) return false;
        const p = new PyProgram(`${r.src}\nfor case in [[1, 2, 1], [3, 3, 3, 3], [], [2, 1, 2, 3, 1], ["a", "b", "a"]]:\n    print(remove_duplicates(case))\nkept = [1, 1, 2]\nremove_duplicates(kept)\nprint(kept)\n`, { maxOps: 500_000, given: UNORDERED_SET });
        p.run();
        return p.status === 'done' && /\[1, 2\]\n\[3\]\n\[\]\n\[2, 1, 3\]\n\['a', 'b'\]\n\[1, 1, 2\]\n$/.test(p.stdout);
      }, why: WHOSE_FIX_WHY },
    ],
    debrief: 'The new version uses a second list, so nothing shifts under the loop and the caller\'s list stays as it was. Whether a person, a website or an AI wrote the first draft, this version is the one you would have to answer for. So you read it, you tested it, and now you can explain it.',
  },
};
