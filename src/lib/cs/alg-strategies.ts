// Code-lab missions for the second half of the Algorithms trail: shortest paths,
// greedy, dynamic programming, growth classes and the Robodebt averaging lab.
// Every step judges behaviour on inputs the learner never saw, and each mission's
// tempting shortcuts are played and refused in tests/alg-strategies.test.ts.
//
// Imports from missions.ts are types only: missions.ts spreads this file into
// CODE_MISSIONS, so a value import here would be a cycle.

import type { CodeMission, CodeState } from './missions.ts';
import { checkCases, classify, measureGrowth, toPy, type GrowthPoint, type RunResult } from '../py/lab.ts';
import { PyProgram } from '../py/vm.ts';
import { repr } from '../py/values.ts';

const blank = (): CodeState => ({ runs: [], growth: [] });
type Case = { args: unknown[]; want: string };

// Steps are re-judged on every redraw and shown only in order, so an earlier step
// has to stay true after the program has moved on. Judging every run that ever
// happened would re-run each one on each redraw, hence the cache.
const verdicts = new WeakMap<RunResult, Map<string, boolean>>();
function everPassed(s: CodeState, fn: string, cases: Case[], key: string): boolean {
  return s.runs.some((r) => {
    if (r.status !== 'done') return false;
    let m = verdicts.get(r);
    if (!m) verdicts.set(r, m = new Map());
    if (!m.has(key)) m.set(key, checkCases(r, fn, cases).ok);
    return m.get(key)!;
  });
}

const edges = (...e: [string, string, number][]) => e;

// ---------- Shortest paths ----------

const COUNTEREXAMPLE = edges(['s', 'a', 2], ['s', 'b', 3], ['b', 'a', -2], ['a', 't', 1]);
const PATH_CASES: Case[] = [
  { args: [COUNTEREXAMPLE, 's', 't'], want: '2' },
  { args: [COUNTEREXAMPLE, 's', 'a'], want: '1' },
  { args: [edges(['p', 'q', 4], ['p', 'r', 1], ['r', 'q', 2], ['q', 'z', 5], ['r', 'z', 9]), 'p', 'z'], want: '8' },
  { args: [edges(['p', 'q', 5], ['p', 'r', 6], ['r', 'q', -4], ['q', 'z', 1], ['r', 'z', 4]), 'p', 'z'], want: '3' },
  { args: [edges(['p', 'q', 1]), 'q', 'p'], want: 'None' },
  { args: [edges(['p', 'q', 1]), 'p', 'p'], want: '0' },
];

// ---------- Greedy ----------

const LIE_CASES: Case[] = [
  { args: [[1, 3, 4]], want: '6' },
  { args: [[1, 7, 10]], want: '14' },
  { args: [[1, 12, 19]], want: '24' },
  { args: [[1, 5, 18, 25]], want: '28' },
  { args: [[1, 5, 10, 25]], want: 'None' },
  { args: [[1, 2, 5, 10]], want: 'None' },
  { args: [[1, 4, 5]], want: '8' },
];

// Each answer is held to a brute-force search through real Python in the tests.
export const CLASS_CASES: Case[] = [
  { args: [[[9, 17], [9, 10], [10, 11], [11, 12]]], want: '3' },
  { args: [[[1, 4], [3, 6], [5, 9]]], want: '2' },
  { args: [[[0, 6], [1, 4], [3, 5], [3, 8], [4, 7], [5, 9], [6, 10], [8, 11]]], want: '3' },
  { args: [[[1, 2], [3, 4], [5, 6]]], want: '3' },
  { args: [[[1, 10], [2, 3], [4, 5], [6, 7], [8, 9]]], want: '4' },
  { args: [[]], want: '0' },
  { args: [[[5, 6], [1, 2], [3, 4], [2, 3]]], want: '4' },
];

// ---------- Dynamic programming ----------

function fibExact(n: number): string {
  let a = 0n, b = 1n;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a.toString();
}
const FIB_CASES: Case[] = [{ args: [0], want: '0' }, { args: [1], want: '1' }, { args: [10], want: '55' }, { args: [30], want: '832040' }, { args: [90], want: fibExact(90) }];
const FIB_DEEP: Case[] = [...FIB_CASES, { args: [5000], want: fibExact(5000) }];

// Judges fib itself, on fresh programs so one call's memo can't help the next. Any
// RecursionError used to pass this step, including one from another function or from
// a fib with no memo, which is not the lesson's point that the memo fails too. The
// naive fib fails here on fib(30) and fib(90): they run out of budget.
function fastButTooDeep(r: RunResult): boolean {
  const call = (n: number) => { const p = new PyProgram(r.src, { maxOps: 2_000_000 }); p.run(); return p.call('fib', [toPy(n)]); };
  if (!FIB_CASES.every((c) => { const got = call(c.args[0] as number); return got.ok && repr(got.value) === c.want; })) return false;
  const deep = call(5000);
  return !deep.ok && deep.error.type === 'RecursionError';
}
function memoHitTheStack(s: CodeState): boolean {
  return s.runs.some((r) => {
    if (r.error?.type !== 'RecursionError') return false;
    let m = verdicts.get(r);
    if (!m) verdicts.set(r, m = new Map());
    if (!m.has('deep-memo')) m.set('deep-memo', fastButTooDeep(r));
    return m.get('deep-memo')!;
  });
}

// ---------- Growth classes ----------

const SORT_CASES: Case[] = [
  { args: [[3, 1, 2]], want: '[1, 2, 3]' },
  { args: [[]], want: '[]' },
  { args: [[5, 5, 1, 5, 2]], want: '[1, 2, 5, 5, 5]' },
  { args: [[9, 8, 7, 6, 5, 4, 3, 2, 1]], want: '[1, 2, 3, 4, 5, 6, 7, 8, 9]' },
];
const shapeOn = (src: string, input: (n: number) => number[]) => classify(measureGrowth(src, 'quicksort', [100, 200, 400, 800], (n) => [input(n)]));
const descending = (n: number) => Array.from({ length: n }, (_, i) => n - i);
// A real pivot sort splits the list at every level, so even on sorted input it makes
// about n lg n comparisons. sorted() spots the sorted run and makes n - 1, which is why
// "return sorted(items)" used to pass this step without touching a pivot, and why a
// shape alone can't refuse it. Measured at n = 800 in the sandbox: 1,602 steps for
// sorted(), 2,404 with a reversed check too, and 51,678 to 97,098 for six real sorts
// written by hand, against a floor of 3,858.
const didItsOwnSplitting = (points: GrowthPoint[]) => {
  const last = points.at(-1);
  return !!last && last.ops !== null && last.ops >= (last.n * Math.log2(last.n)) / 2;
};

// ---------- Robodebt ----------

const DEBT_CASES: Case[] = [
  // Worked a block of fortnights off benefit, then was on benefit with no income: owes nothing.
  { args: [[2000, 2000, 2000, 0, 0, 0], [false, false, false, true, true, true]], want: '0.0' },
  // Steady income, on benefit throughout: 100 over the free amount each fortnight, half of it owed.
  { args: [[400, 400, 400, 400], [true, true, true, true]], want: '200.0' },
  // A real overpayment: one fortnight's pay while on benefit that averaging would hide.
  { args: [[1300, 0, 0, 0], [true, true, true, true]], want: '500.0' },
  { args: [[100, 200, 300], [true, true, true]], want: '0.0' },
  { args: [[], []], want: '0.0' },
];

export const ALG_STRATEGY_MISSIONS: Record<string, CodeMission> = {
  'alg-paths-dijkstra': {
    id: 'alg-paths-dijkstra', title: 'Make it stop lying', xp: 60, setup: blank,
    starter: `# (from, to, length). s to b to a to t adds up to 2.
EDGES = [("s", "a", 2), ("s", "b", 3), ("b", "a", -2), ("a", "t", 1)]

def shortest(edges, start, goal):
    dist = {start: 0}
    settled = set()
    while True:
        # Dijkstra's own step, a plain scan: no priority queue in 1959.
        best = None
        for node in dist:
            if node not in settled and (best is None or dist[node] < dist[best]):
                best = node
        if best is None:
            return None
        if best == goal:
            return dist[best]
        settled.add(best)
        for a, b, length in edges:
            if a == best and b not in settled:
                if b not in dist or dist[a] + length < dist[b]:
                    dist[b] = dist[a] + length

print(shortest(EDGES, "s", "t"))
`,
    steps: [
      { text: 'Run it. It finishes with no error. What did it print, and what does adding up s, b, a, t give?', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && /^3\s*$/.test(r.stdout)) },
      { text: 'Make shortest give the right length on negative edges too, without breaking ordinary graphs. It is judged on graphs you can\'t see', hint: 'Three changes. Stop returning early: run until nothing is left, then return dist.get(goal). Remove "and b not in settled". When an edge improves b, put b back with settled.discard(b).', done: (s) => everPassed(s, 'shortest', PATH_CASES, 'paths') },
    ],
    debrief: 'One rule was the whole bug: "a settled node is never looked at again". Take it away and the answer is right as long as there is no negative cycle. Erickson calls this form the more deserving of Dijkstra\'s name, and warns the price: on some graphs with negative edges it does exponentially many relaxations. So "Dijkstra fails on negative edges" is true of the version you started with and false of the one you ended with.',
  },

  'alg-greedy-coins': {
    id: 'alg-greedy-coins', title: 'Catch it lying', xp: 50, setup: blank,
    starter: `def greedy(amount, coins):
    # Biggest coin that fits, again and again. What a cashier does.
    count = 0
    for coin in sorted(coins, reverse=True):
        while amount >= coin:
            amount -= coin
            count += 1
    return count

def fewest(amount, coins):
    # The true answer, from a table. The next lesson is about why a table works.
    best = [0] * (amount + 1)
    for a in range(1, amount + 1):
        best[a] = min([best[a - c] + 1 for c in coins if c <= a])
    return best[amount]

def first_lie(coins):
    # The smallest amount up to 100 where greedy needs more coins, or None.
    return None

print(greedy(30, [1, 5, 10, 25]), fewest(30, [1, 5, 10, 25]))
print(greedy(6, [1, 3, 4]), fewest(6, [1, 3, 4]))
print(first_lie([1, 3, 4]))
`,
    steps: [
      { text: 'Run it. On American coins the two agree on 30. On coins of 1, 3 and 4, look at 6', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && /^2 2\s+3 2\b/.test(r.stdout)) },
      { text: 'Write first_lie: try each amount from 1 to 100 and return the first one where greedy and fewest differ. If none does, return None', hint: 'for amount in range(1, 101):  then  if greedy(amount, coins) != fewest(amount, coins):  then  return amount', done: (s) => everPassed(s, 'first_lie', LIE_CASES, 'lie') },
    ],
    debrief: 'Greedy was right on every American amount and wrong on 6 with coins of 1, 3 and 4. Nothing in the code differs between those: the coins decide whether the method is correct. So a greedy algorithm needs either a proof or a check like yours, and a passing example is neither. Yours only looks up to 100, which is a test of that range, not a proof for every amount.',
  },

  'alg-greedy-classes': {
    id: 'alg-greedy-classes', title: 'Which greedy rule?', xp: 50, setup: blank,
    starter: `def most_classes(classes):
    # Take them in some order, keeping each one that doesn't clash with the last.
    # This rule is "earliest start". Is that the right thing to be greedy about?
    chosen = 0
    free_from = 0
    for start, finish in sorted(classes, key=lambda c: c[0]):
        if start >= free_from:
            chosen += 1
            free_from = finish
    return chosen

print(most_classes([(9, 17), (9, 10), (10, 11), (11, 12)]))
`,
    steps: [
      { text: 'Run it on four classes. Three of them fit in a morning. How many did it choose?', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && /^1\s*$/.test(r.stdout)) },
      { text: 'Change only the sort rule until it is right on inputs you can\'t see. Try shortest class first as well: it looks good and it also fails', hint: 'Shortest first is key=lambda c: c[1] - c[0]. The right one sorts by when a class ends.', done: (s) => everPassed(s, 'most_classes', CLASS_CASES, 'classes') },
    ],
    debrief: 'Three plausible greedy rules, one loop, and only "ends earliest" is right. It is right for a reason you can state: whatever the best timetable starts with, swapping that class for the one that ends first can\'t cause a clash, because nothing else in the timetable could have started before it ended. Repeat the swap and the best timetable becomes yours. That argument is the difference between this rule and the two that merely look sensible.',
  },

  'alg-dp-fib': {
    id: 'alg-dp-fib', title: 'Fast is not the same as safe', xp: 70, setup: blank,
    starter: `def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

print(fib(0), fib(1), fib(2))
`,
    steps: [
      { text: 'Measure its growth. Each row adds only 4 to n. What happens to the work?', hint: 'Press Measure growth', done: (s) => s.growth.some((g) => g.shape === 'exponential or worse') },
      // n log n counts as well: the lab runs the whole program before it measures,
      // so a memo already partly filled by a print at the bottom bends the first sizes.
      { text: 'Remember answers in a dict, so nothing is worked out twice. Measure again: the work should grow in step with n', hint: 'memo = {} at the top. In fib: if n in memo: return memo[n]. Store the result in memo[n] before returning it. Measuring runs your whole program first, so keep the print at the bottom small.', done: (s) => s.growth.some((g) => (g.shape === 'linear' || g.shape === 'n log n') && s.runs.some((r) => r.src === g.src && r.status === 'done' && checkCases(r, 'fib', FIB_CASES).ok)) },
      { text: 'Keep the memo and add print(fib(5000)) at the bottom, then Run. It starts from an empty memo. What happens?', hint: 'print(fib(5000))', done: memoHitTheStack },
      { text: 'Rewrite fib with no recursion: build up from fib(0) in a loop. fib(5000) has to work, from cold', hint: 'a, b = 0, 1  then  for _ in range(n):  then  a, b = b, a + b  then  return a', done: (s) => everPassed(s, 'fib', FIB_DEEP, 'deep') },
    ],
    debrief: 'Memoising fixed the time and did nothing for the depth. Every memoised call still waits for the one below it, so fib(5000) from cold needs 5,000 calls stacked up at once, and the limit is 1,000. Real Python raises the same error on functools.cache, which this sandbox doesn\'t have. Building from the bottom needs no stack at all, and it only ever remembers two numbers: the same trick, with the memory taken away too.',
  },

  'alg-growth-quicksort': {
    id: 'alg-growth-quicksort', title: 'The input that was already sorted', xp: 60, setup: blank,
    starter: `def quicksort(items):
    if len(items) < 2:
        return items
    pivot = items[0]
    rest = items[1:]
    smaller = [x for x in rest if x < pivot]
    larger = [x for x in rest if x >= pivot]
    return quicksort(smaller) + [pivot] + quicksort(larger)

print(quicksort([3, 1, 4, 1, 5, 9, 2, 6]))
`,
    steps: [
      { text: 'Run it. It sorts. Now measure growth: the lab feeds it lists that are already in order', hint: 'Press Run, then Measure growth', done: (s) => s.growth.some((g) => g.shape === 'quadratic') },
      { text: 'Choose the pivot from the middle of the list instead, keep it sorting correctly, and measure again', hint: 'mid = len(items) // 2  then  pivot = items[mid]  then  rest = items[:mid] + items[mid + 1:]', done: (s) => s.growth.some((g) => (g.shape === 'n log n' || g.shape === 'linear') && didItsOwnSplitting(g.points) && s.runs.some((r) => r.src === g.src && r.status === 'done' && checkCases(r, 'quicksort', SORT_CASES).ok) && shapeOn(g.src, descending) !== 'quadratic' && shapeOn(g.src, descending) !== 'cubic or worse') },
    ],
    debrief: 'The same code went from quadratic to n log n because of which input it was given and which element it picked, and neither version changed its average case much. You also moved the worst case rather than removing it: a list that rises and then falls still goes quadratic on the middle pivot. That is what a worst case means: there is an input for it, and someone or something may supply it.',
  },

  'alg-people-averaging': {
    id: 'alg-people-averaging', title: 'A debt nobody owed', xp: 60, setup: blank,
    starter: `# Invented numbers. The real scheme's rates and rules were more complicated.
FREE = 300     # income allowed each fortnight before the benefit is reduced
TAPER = 0.5    # how much of each dollar over that must be paid back

def debt(income, on_benefit):
    # What the scheme did: take the total, spread it evenly over every fortnight.
    average = sum(income) / len(income)
    owed = 0.0
    for fortnight in range(len(income)):
        if on_benefit[fortnight] and average > FREE:
            owed += (average - FREE) * TAPER
    return owed

# Six fortnights of well-paid work with no benefit, then twenty with no work at all.
income = [2000] * 6 + [0] * 20
on_benefit = [False] * 6 + [True] * 20
print(debt(income, on_benefit))
`,
    steps: [
      { text: 'Run it. In every fortnight this person was paid the benefit, they earned nothing. What does it say they owe?', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && /^1615\.3/.test(r.stdout)) },
      { text: 'Fix debt so it uses what was actually earned in each fortnight. It must still catch a real overpayment, and an empty record owes nothing', hint: 'Remove the average. Loop over the fortnights and use income[fortnight] where average was.', done: (s) => everPassed(s, 'debt', DEBT_CASES, 'debt') },
    ],
    debrief: 'The fix took one line, and it is not the whole story. Your version needs the fortnight-by-fortnight figures, and the scheme held only the totals employers reported to the tax office. Getting real figures meant asking employers or the person, which is what the old manual process did. Averaging saved that work, and a Federal Court declaration later said averaged figures could not satisfy a decision-maker that a debt existed. The cheap version of the data produced a confident number, and the burden of disproving it landed on the person.',
  },
};
