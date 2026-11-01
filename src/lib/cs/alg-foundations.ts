// Code lab missions for the first lessons of the Algorithms trail. Same rules as
// src/lib/cs/missions.ts: a step judges behaviour on inputs the learner never saw,
// or how the work grows, never their text.
//
// Imports from missions.ts are types only. That file spreads this one, and a real
// import back would make whichever loads first read the other half-initialised.

import type { CodeMission, CodeState } from './missions.ts';
import { checkCases, classify, measureGrowth, type GrowthShape } from '../py/lab.ts';

const blank = (): CodeState => ({ runs: [], growth: [] });
const lastRun = (s: CodeState) => s.runs.at(-1);
const passes = (s: CodeState, fn: string, cases: { args: unknown[]; want: string }[]) => {
  const r = lastRun(s);
  return !!r && checkCases(r, fn, cases).ok;
};
const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);

/** Where a stopped program stands: the frame it was in when the budget ran out. */
const stuckAt = (s: CodeState) => s.runs.filter((r) => r.status === 'budget').map((r) => {
  // Any frame, not the top one: the budget can run out inside is_leap, whose frame
  // has no `days`, and that would fail the learner on a coin toss.
  const frame = r.program.view().find((f) => f.vars.some((v) => v.name === 'days') && f.vars.some((v) => v.name === 'year'));
  const read = (name: string) => Number(frame?.vars.find((v) => v.name === name)?.value);
  return { days: read('days'), year: read('year') };
});

// Worked out with datetime, counting 1 January 1980 as day 1: tests/alg-foundations
// checks them against real Python. The last days of leap years are what the
// Zune got wrong. 732 catches `while days > 366`, which stops the hang by making
// 1 January wrong in every year after a non-leap year. 366 catches `days >= 366`,
// which stops the hang and calls the last day of 1980 the first of 1981.
export const ZUNE_CASES = [
  { args: [1], want: '1980' }, { args: [365], want: '1980' }, { args: [366], want: '1980' }, { args: [367], want: '1981' },
  { args: [731], want: '1981' }, { args: [732], want: '1982' }, { args: [1827], want: '1984' }, { args: [10592], want: '2008' },
  { args: [10593], want: '2008' }, { args: [10594], want: '2009' },
];

// Worked out with collections.deque, in tests/alg-foundations.
export const PARCEL_CASES = [
  { args: [[]], want: '[]' }, { args: [[7]], want: '[7]' }, { args: [[0, 1]], want: '[1, 0]' }, { args: [[0, 1, 2, 3, 4]], want: '[1, 3, 0, 4, 2]' },
  { args: [[0, 1, 2, 3, 4, 5, 6]], want: '[1, 3, 5, 0, 4, 2, 6]' }, { args: [['a', 'b', 'c', 'd']], want: "['b', 'd', 'c', 'a']" },
];

export const BRACKET_CASES = [
  { args: [''], want: 'True' }, { args: ['()'], want: 'True' }, { args: ['([]{})'], want: 'True' }, { args: ['{[()]}'], want: 'True' }, { args: ['a(b)c'], want: 'True' },
  { args: [')('], want: 'False' }, { args: ['(('], want: 'False' }, { args: ['))'], want: 'False' }, { args: ['([)]'], want: 'False' }, { args: ['(]'], want: 'False' }, { args: ['}'], want: 'False' },
];

export const FIND_CASES = [
  { args: [[], 5], want: '-1' }, { args: [[5], 5], want: '0' }, { args: [[5], 7], want: '-1' }, { args: [[5], 3], want: '-1' }, { args: [[1, 3], 1], want: '0' }, { args: [[1, 3], 3], want: '1' },
  { args: [[1, 3, 5, 7], 1], want: '0' }, { args: [[1, 3, 5, 7], 7], want: '3' }, { args: [[1, 3, 5, 7], 4], want: '-1' }, { args: [[1, 3, 5, 7], 8], want: '-1' }, { args: [[1, 3, 5, 7], 0], want: '-1' },
  { args: [[2, 4, 6, 8, 10, 12, 14, 16, 18], 14], want: '6' },
];

// Measured here rather than through the learner's `worst`, which they could edit.
// Searching for a value that sits near the end, not one smaller than everything,
// so an "is it below the first item?" shortcut in front of a scan cannot look fast.
const findCache = new Map<string, GrowthShape>();
export function findShape(src: string): GrowthShape {
  let shape = findCache.get(src);
  if (!shape) {
    shape = classify(measureGrowth(src, 'find', [1000, 10_000, 100_000], (n) => [Array.from({ length: n }, (_, i) => i), n - 2]));
    findCache.set(src, shape);
  }
  return shape;
}

export const ALG_FOUNDATION_MISSIONS: Record<string, CodeMission> = {
  'alg-what-last-day': {
    id: 'alg-what-last-day', title: 'The day the loop never ended', xp: 50, setup: blank,
    starter: `def is_leap(year):
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)

# days counts from 1 January 1980, which is day 1.
def year_from_days(days):
    year = 1980
    while days > 365:
        if is_leap(year):
            if days > 366:
                days -= 366
                year += 1
        else:
            days -= 365
            year += 1
    return year

print(year_from_days(10000))
`,
    steps: [
      { text: 'Run it. Day 10,000 was in May 2007, and the answer is right', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && /\b2007\b/.test(r.stdout)) },
      { text: 'Now give it 31 December 2008, which is day 10593. Then read the Variables panel: what are days and year stuck at?', hint: 'Change the last line to print(year_from_days(10593))', done: (s) => stuckAt(s).some((f) => f.days === 366 && isLeap(f.year)) },
      { text: 'Fix it so every day gets the right year, including the last day of a leap year', hint: 'With exactly 366 days left in a leap year, you are already on its last day, so the loop should stop. Add an else: break to the inner if', done: (s) => passes(s, 'year_from_days', ZUNE_CASES) },
    ],
    debrief: 'Every step was precise and unambiguous, and a machine followed them exactly. That is what froze the players. Being precise only means the machine cannot misread you. Whether the recipe finishes, and whether it is right, are separate questions, and on 1,460 days out of every 1,461 this one looks fine. Did you try days >= 366 first? It stops the hang and quietly calls 31 December 1980 the first day of 1981.',
  },
  'alg-lists-newest-first': {
    id: 'alg-lists-newest-first', title: 'The cost of the front of the line', xp: 50, setup: blank,
    starter: `def newest_first(events):
    timeline = []
    for e in events:
        timeline.insert(0, e)
    return timeline

print(newest_first([1, 2, 3, 4]))
`,
    steps: [
      { text: 'Run it. The newest event comes first, and the answer is right', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes('[4, 3, 2, 1]')) },
      { text: 'Measure it. Inserting at the front moves everything already there', hint: 'Press Measure growth', done: (s) => s.growth.some((g) => g.shape === 'quadratic') },
      { text: 'Change it so the work grows in step with the input, with the same answers. Measure again to prove it', hint: 'Adding to the end moves nothing. timeline.append(e) in the loop, then timeline.reverse() before returning', done: (s) => {
        const g = s.growth.at(-1);
        return !!g && g.shape === 'linear' && lastRun(s)?.src === g.src && passes(s, 'newest_first', [
          { args: [[]], want: '[]' }, { args: [[7]], want: '[7]' }, { args: [[1, 2, 3]], want: '[3, 2, 1]' }, { args: [['a', 'b']], want: "['b', 'a']" }, { args: [[5, 5, 1]], want: '[1, 5, 5]' },
        ]);
      } },
    ],
    debrief: 'An array keeps its items side by side, so the front is the expensive end: every item has to move to make room. The back costs almost nothing. Same answer, and the shape went from quadratic to linear because you stopped asking the array to do what it is worst at. A linked list would make the front cheap instead, and the next section says what that costs.',
  },
  'alg-stack-brackets': {
    id: 'alg-stack-brackets', title: 'Closing what you opened', xp: 50, setup: blank,
    starter: `def balanced(text):
    depth = 0
    for ch in text:
        if ch in "([{":
            depth += 1
        if ch in ")]}":
            depth -= 1
    return depth == 0

print(balanced("(a[b]c)"))
print(balanced(")("))
print(balanced("([)]"))
`,
    steps: [
      { text: 'Run it. The first answer is right. The other two say True about text that is plainly wrong', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && /True\s+True\s+True/.test(r.stdout)) },
      { text: 'Replace the counter with a stack: push each opener, and on each closer check that it closes the most recent opener', hint: 'stack = [], then stack.append(ch). A closer needs a non-empty stack and stack.pop() to be its partner. Return len(stack) == 0', done: (s) => passes(s, 'balanced', BRACKET_CASES) },
    ],
    debrief: 'A counter knows how many brackets are open. It cannot know which one to close next. A stack can, because the last one opened is the first that must close. That is the same rule your program runs by: the function called last is the one that must finish first.',
  },
  'alg-queue-parcel': {
    id: 'alg-queue-parcel', title: 'A queue that keeps paying', xp: 60, setup: blank,
    starter: `def pass_the_parcel(players):
    queue = []
    for p in players:
        queue.append(p)
    out = []
    while len(queue) > 0:
        # The player at the front passes it on, and goes to the back.
        queue.append(queue.pop(0))
        # The next player is out.
        out.append(queue.pop(0))
    return out

print(pass_the_parcel([0, 1, 2, 3, 4]))
`,
    steps: [
      { text: 'Run it. Players leave in the order 1, 3, 0, 4, 2', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes('[1, 3, 0, 4, 2]')) },
      { text: 'Measure it. Every pop(0) moves the whole line along by one', hint: 'Press Measure growth', done: (s) => s.growth.some((g) => g.shape === 'quadratic') },
      { text: 'Build a queue that does not move anyone, so the work grows in step with the input and the order stays the same. Measure again to prove it', hint: 'Keep head = 0 and read queue[head], then head += 1, in place of queue.pop(0). Loop while head < len(queue). Two lists work too', done: (s) => {
        const g = s.growth.at(-1);
        return !!g && g.shape === 'linear' && lastRun(s)?.src === g.src && passes(s, 'pass_the_parcel', PARCEL_CASES);
      } },
    ],
    debrief: 'Same queue from the outside, different implementation, and the shape changed from quadratic to linear. An index never moves anyone: it only remembers where the front is. The cost is that gone items stay in memory until the list is dropped. Real Python ships this already, in collections.deque, and the sandbox leaves it out because it has no import, so this is the part you would normally not write yourself.',
  },
  'alg-search-halving': {
    id: 'alg-search-halving', title: 'Throw away half', xp: 60, setup: blank,
    starter: `def find(items, target):
    for i in range(len(items)):
        if items[i] == target:
            return i
    return -1

def worst(items):
    return find(items, len(items))

print(find([2, 4, 6, 8], 6))
print(find([2, 4, 6, 8], 5))
`,
    steps: [
      { text: 'Run it. It finds 6 at index 2 and says -1 for 5, which is not there', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && /^2\s+-1\s*$/.test(r.stdout)) },
      { text: 'Measure it, searching for something that is not there. Ten times the items is ten times the work', hint: 'Press Measure growth', done: (s) => s.growth.some((g) => g.shape === 'linear') },
      { text: 'Make it a binary search. The list is sorted, so each look can rule out half of what is left. Measure again to prove it', hint: 'low = 0, high = len(items) - 1. While low <= high: mid = (low + high) // 2. If items[mid] < target, low = mid + 1. If it is greater, high = mid - 1. Otherwise return mid', done: (s) => {
        const r = lastRun(s);
        return !!r && r.status === 'done' && s.growth.at(-1)?.src === r.src && findShape(r.src) === 'logarithmic' && passes(s, 'find', FIND_CASES);
      } },
    ],
    debrief: 'A list ten times longer now costs only a few more looks, because each look throws away half of what is left. You wrote the line Bloch called broken, mid = (low + high) // 2, and it is correct here, because Python integers do not overflow. It also only works because the list is sorted. Nothing checked that, and the lab below shows what happens when it isn\'t.',
  },
};
