// Code-lab missions for the sorting, divide-and-conquer, hash-table and heap lessons.
// Same rule as src/lib/cs/missions.ts: a step judges what the program does, by
// calling it on inputs the learner never saw or by measuring how its work grows.
// tests/alg-missions.test.ts plays each one, including the tempting shortcuts.

import type { Mission } from '../missions.ts';
import { checkCases, toPy, type GrowthPoint, type GrowthShape, type RunResult } from '../py/lab.ts';
import { PyProgram } from '../py/vm.ts';
import { PyList } from '../py/values.ts';
import { shuffledInput } from './sorting.ts';

type State = { runs: RunResult[]; growth: { src: string; fn: string; points: GrowthPoint[]; shape: GrowthShape }[] };
type M = Mission<State> & { starter?: string };

const blank = (): State => ({ runs: [], growth: [] });
const last = (s: State) => s.runs.at(-1);
const passes = (s: State, fn: string, cases: { args: unknown[]; want: string }[]) => {
  const r = last(s);
  return !!r && checkCases(r, fn, cases).ok;
};
/** The newest measurement, only if it measured the code that last ran. */
const measured = (s: State) => {
  const g = s.growth.at(-1), r = last(s);
  return g && r && r.src === g.src ? g : undefined;
};

/**
 * Whether fn reached the library sort when called. A mission that asks the learner
 * to write a sort has to know, or `return sorted(left + right)` passes as a merge: it
 * measures n log n and gets every answer right, and a review caught exactly that.
 * Watches what the program does at run time, so a renamed or wrapped call is caught
 * as well, which matching on the text of the program would miss.
 */
export function reachesLibrarySort(src: string, fn: string): boolean {
  const p = new PyProgram(src, { maxOps: 3_000_000 });
  p.run();
  const before = p.sortCalls;
  // Shuffled and as long as the biggest size measured, so a sort kept for big inputs only is found too.
  p.call(fn, [toPy(shuffledInput(1600, 5))]);
  return p.sortCalls > before;
}

const SORT_CASES = [
  { args: [[3, 1, 2]], want: '[1, 2, 3]' },
  { args: [[5, 5, 1, 5, 0, 2]], want: '[0, 1, 2, 5, 5, 5]' },
  { args: [[]], want: '[]' },
  { args: [[7]], want: '[7]' },
  { args: [[9, 8, 7, 6, 5, 4, 3, 2, 1]], want: '[1, 2, 3, 4, 5, 6, 7, 8, 9]' },
  { args: [[2, -1, 2, -1]], want: '[-1, -1, 2, 2]' },
];

const NAN_STARTER = `nan = float("nan")

def clean_sort(numbers):
    return sorted(numbers)

print(clean_sort([3.3, 1.1, 2.2]))
print(clean_sort([3.3, nan, 1.1, 2.2]))
`;

/**
 * Accepts NaNs dropped or moved to either end, since each is a defensible answer
 * and the lesson doesn't own that decision. What it refuses is a list whose real
 * numbers are out of order or missing.
 */
export function cleanSortWorks(src: string): boolean {
  const inputs = [[3.3, NaN, 1.1, 2.2], [NaN, 3.5, 1.5, 2.5], [3.5, 1.5, NaN, 2.5], [5.5, NaN, NaN, 2.5, 1.5, NaN, 0.5], [1.5, 0.5], [NaN], []];
  for (const input of inputs) {
    const p = new PyProgram(src, { maxOps: 2_000_000 });
    p.run();
    if (p.status !== 'done') return false;
    const got = p.call('clean_sort', [toPy(input)]);
    if (!got.ok || !(got.value instanceof PyList)) return false;
    const out = got.value.items;
    if (!out.every((x) => typeof x === 'number' || typeof x === 'bigint')) return false;
    const nums = out.map(Number), real = nums.filter((x) => !Number.isNaN(x));
    const want = input.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    if (real.length !== want.length || real.some((x, i) => x !== want[i])) return false;
    const nans = nums.length - real.length;
    if (nans !== 0 && nans !== input.length - want.length) return false;
    // Every NaN has to sit at one end, or the list still reads as sorted when it isn't.
    const first = nums.findIndex((x) => !Number.isNaN(x)), lastReal = nums.length - 1 - [...nums].reverse().findIndex((x) => !Number.isNaN(x));
    if (real.length && nums.slice(first, lastReal + 1).some(Number.isNaN)) return false;
  }
  return true;
}

const MERGE_STARTER = `def merge(left, right):
    out = []
    while left and right:
        if right[0] < left[0]:
            out.append(right.pop(0))
        else:
            out.append(left.pop(0))
    return out + left + right

def merge_sort(items):
    if len(items) <= 1:
        return items
    mid = len(items) // 2
    return merge(merge_sort(items[:mid]), merge_sort(items[mid:]))

print(merge_sort([5, 2, 9, 1, 5, 6]))
`;

const QUICK_STARTER = `def quick_sort(items):
    if len(items) <= 1:
        return items
    pivot = items[0]
    smaller = [x for x in items if x < pivot]
    same = [x for x in items if x == pivot]
    larger = [x for x in items if x > pivot]
    return quick_sort(smaller) + same + quick_sort(larger)

print(quick_sort([5, 2, 9, 1, 5, 6]))
`;

const TABLE_STARTER = `def h(key):
    return len(key)

def new_table():
    return {"buckets": [[] for _ in range(8)], "count": 0}

def put(table, key, value):
    buckets = table["buckets"]
    bucket = buckets[h(key) % len(buckets)]
    for pair in bucket:
        if pair[0] == key:
            pair[1] = value
            return
    bucket.append([key, value])
    table["count"] += 1

def get(table, key):
    buckets = table["buckets"]
    for pair in buckets[h(key) % len(buckets)]:
        if pair[0] == key:
            return pair[1]
    raise KeyError(key)

def load(n):
    table = new_table()
    for i in range(n):
        put(table, "user" + str(i).zfill(6), i)
    return table

t = load(100)
print(t["count"], get(t, "user000042"))
print("longest bucket:", max([len(b) for b in t["buckets"]]))
`;

/** Runs extra Python after the learner's program and reads what it prints. A program with no working h or put fails here, not silently. */
function probe(src: string, extra: string): string | null {
  const p = new PyProgram(`${src}\n${extra}`, { maxOps: 4_000_000 });
  p.run();
  if (p.status !== 'done') return null;
  return p.stdout.trim().split('\n').at(-1) ?? null;
}

/** h has to spread keys over 64 buckets and answer the same way twice. sum(ord(c)) fails this: its keys only reach a narrow range. */
export function hashSpreads(src: string): boolean {
  const out = probe(src, `__keys = ["user" + str(i).zfill(6) for i in range(2000)]
__counts = [0] * 64
__same = True
for __k in __keys:
    __counts[h(__k) % 64] += 1
    if h(__k) != h(__k):
        __same = False
print(__same, len([c for c in __counts if c > 0]), max(__counts))`);
  if (!out) return false;
  const m = /^True (\d+) (\d+)$/.exec(out);
  return !!m && Number(m[1]) >= 48 && Number(m[2]) <= 200;
}

/** The table has to work and stay short: a Python dict hidden inside put leaves the buckets empty, and fails here. */
export function tableWorks(src: string): boolean {
  const out = probe(src, `__t = new_table()
for __i in range(2000):
    put(__t, "user" + str(__i).zfill(6), __i)
put(__t, "user000007", "again")
__ok = __t["count"] == 2000 and get(__t, "user000007") == "again" and get(__t, "user001999") == 1999
try:
    get(__t, "nobody")
    __ok = False
except KeyError:
    pass
__lens = [len(b) for b in __t["buckets"]]
print(__ok, len(__lens), sum(__lens), max(__lens))`);
  if (!out) return false;
  const m = /^True (\d+) (\d+) (\d+)$/.exec(out);
  return !!m && Number(m[1]) >= 2000 && Number(m[2]) === 2000 && Number(m[3]) <= 16;
}

const HEAP_STARTER = `def push(q, x):
    q.append(x)

def pop_smallest(q):
    best = min(q)
    q.remove(best)
    return best

def drain(items):
    q = []
    for x in items:
        push(q, x)
    out = []
    while q:
        out.append(pop_smallest(q))
    return out

print(drain([5, 1, 4, 2, 3]))
`;

/**
 * Steps for one pop-and-push on a queue of a given size. drain() alone could be
 * faked with sorted(), so this reads the two operations the later lessons rely on.
 */
export function popCost(src: string, size: number): number | null {
  const p = new PyProgram(`${src}
__q = []
for __x in range(${size}):
    push(__q, __x)
def __churn():
    for __i in range(40):
        __v = pop_smallest(__q)
        push(__q, __v + ${size})
`, { maxOps: 8_000_000 });
  p.run();
  if (p.status !== 'done') return null;
  const before = p.ops;
  const r = p.call('__churn', []);
  return r.ok ? (p.ops - before) / 40 : null;
}

/** A heap's cost barely moves when the queue quadruples. A scan's quadruples with it. */
export function queueIsLogarithmic(src: string): boolean {
  const a = popCost(src, 1000), b = popCost(src, 4000);
  return a !== null && b !== null && b / a < 1.6;
}

/** Pops have to come out smallest first, however pushes and pops interleave. */
export function queueOrders(src: string): boolean {
  const out = probe(src, `__q = []
__got = []
for __x in [5, 1, 4]:
    push(__q, __x)
__got.append(pop_smallest(__q))
for __x in [0, 9, 2, 2]:
    push(__q, __x)
while __q:
    __got.append(pop_smallest(__q))
print(__got)`);
  return out === '[1, 0, 2, 2, 4, 5, 9]';
}

export const ALG_CODE_MISSIONS: Record<string, M> = {
  'cs-sort-nan': {
    id: 'cs-sort-nan', title: 'The sort that lied', xp: 40, setup: blank, starter: NAN_STARTER,
    steps: [
      { text: 'Run it, and read the second line closely. No error appears. Is that list sorted?', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes('[3.3, nan, 1.1, 2.2]')) },
      { text: 'Fix clean_sort so the real numbers come out in order wherever the NaN sits', hint: 'A NaN is the only value that is not equal to itself: [x for x in numbers if x == x]. Or keep them at the end with key=lambda x: (x != x, x)', done: (s) => { const r = last(s); return !!r && r.status === 'done' && cleanSortWorks(r.src); } },
    ],
    debrief: 'sorted never checks its answer, and it trusts that < means what it should. Every comparison with NaN is False, so sorted saw a list that already looked in order and left it alone. The same list with the NaN elsewhere comes out differently, which is worse. Real data hides NaN well: one failed parse in a column of a million floats gives you a wrong result and no error.',
  },
  'cs-dc-merge-sort': {
    id: 'cs-dc-merge-sort', title: 'A merge sort that is not n log n', xp: 60, setup: blank, starter: MERGE_STARTER,
    steps: [
      { text: 'Run it. The answer is right', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes('[1, 2, 5, 5, 6, 9]')) },
      { text: 'Measure growth. A merge sort should be close to linear. Is this?', hint: 'Press Measure growth', done: (s) => s.growth.some((g) => g.shape === 'quadratic') },
      { text: 'Find the hidden loop in merge and remove it. Keep the answers right. Calling sorted or .sort inside does not count: a sort is what you are writing', hint: 'left.pop(0) moves every remaining item. Walk with two positions instead: i = j = 0, compare left[i] with right[j], and finish with out + left[i:] + right[j:]', done: (s) => {
        const g = measured(s);
        return !!g && g.fn === 'merge_sort' && g.shape === 'n log n' && passes(s, 'merge_sort', SORT_CASES) && !reachesLibrarySort(g.src, 'merge_sort');
      } },
    ],
    debrief: 'The split was right all along, and so was the recursion. One line in the stitching step scanned the list without looking like it, and that was enough to turn n log n back into quadratic. A divide-and-conquer algorithm costs as much as its combine step lets it, which is what the recurrence T(n) = 2T(n/2) + n is saying.',
  },
  'cs-dc-quicksort': {
    id: 'cs-dc-quicksort', title: 'The kindest input is the cruelest', xp: 60, setup: blank, starter: QUICK_STARTER,
    steps: [
      { text: 'Run it on the small list. It works', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes('[1, 2, 5, 5, 6, 9]')) },
      { text: 'Measure growth. The lab feeds it lists that are already sorted', hint: 'Press Measure growth', done: (s) => s.growth.some((g) => g.shape === 'quadratic') },
      { text: 'Change the pivot so sorted input splits evenly, and keep the answers right', hint: 'pivot = items[len(items) // 2]', done: (s) => {
        const g = measured(s);
        return !!g && g.fn === 'quick_sort' && g.shape === 'n log n' && passes(s, 'quick_sort', SORT_CASES) && !reachesLibrarySort(g.src, 'quick_sort');
      } },
    ],
    debrief: 'Picking the first item as pivot means a sorted list splits into nothing and everything, so each level removes one item and the recursion goes n levels deep. The middle item splits sorted input evenly. That is a fix for this input and no more. Some input is still bad for the middle-item rule, as the sorting lesson\'s adversary shows.',
  },
  'cs-hash-table': {
    id: 'cs-hash-table', title: 'Build a hash table that stays fast', xp: 80, setup: blank, starter: TABLE_STARTER,
    steps: [
      { text: 'Run it. It stores 100 keys and finds one. Now read the last line it prints', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && /100 42\s+longest bucket: 100/.test(r.stdout)) },
      { text: 'Measure growth. Every key here is the same length, so where do they all go?', hint: 'Press Measure growth', done: (s) => s.growth.some((g) => g.fn === 'load' && g.shape === 'quadratic') },
      { text: 'Write a hash that spreads keys out. Adding up the characters will not be enough', hint: 'Mix each character in with a multiply: v = 5381, then for c in key: v = (v * 33 + ord(c)) % 2**32, and return v', done: (s) => { const r = last(s); return !!r && r.status === 'done' && hashSpreads(r.src); } },
      { text: 'Measure again. Eight buckets can only do so much. Grow the table when it fills, so the work stays linear', hint: 'When count passes two thirds of len(buckets), make twice as many buckets and put every pair back through h. Then press Measure growth', done: (s) => {
        const g = measured(s);
        return !!g && g.fn === 'load' && g.shape === 'linear' && tableWorks(g.src);
      } },
    ],
    debrief: 'Two separate things had to be right. A bad hash puts everything in one bucket, and a table of any size is then a list. A good hash with a fixed table is still a list, only eight times shorter, so the work is still quadratic and merely looks better. Growing keeps the average bucket short. Copying everything on each growth sounds expensive, and it is paid for by all the cheap inserts between growths, so the total stays linear.',
  },
  'cs-heap-queue': {
    id: 'cs-heap-queue', title: 'A queue that knows who is next', xp: 80, setup: blank, starter: HEAP_STARTER,
    steps: [
      { text: 'Run it. Everything comes out smallest first', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes('[1, 2, 3, 4, 5]')) },
      { text: 'Measure growth. Each pop scans the whole queue. What does that add up to?', hint: 'Press Measure growth', done: (s) => s.growth.some((g) => g.fn === 'drain' && g.shape === 'quadratic') },
      { text: 'Turn q into a binary heap: push sifts the new item up, and pop moves the last item to the top and sifts it down', hint: 'The parent of position i is (i - 1) // 2. Its children are 2 * i + 1 and 2 * i + 2. Swap with the parent while smaller; on the way down, swap with the smaller child while larger', done: (s) => {
        const g = measured(s);
        return !!g && g.fn === 'drain' && g.shape === 'n log n' && queueOrders(g.src) && queueIsLogarithmic(g.src);
      } },
    ],
    debrief: 'Nothing about the queue is sorted now, and it never needs to be. A heap only keeps one promise: every parent is no larger than its children, so the smallest is always at the top. That is much less than sorted order, and it is exactly what a priority queue needs. Each push and pop walks one path through a tree that stays as short as it can, so each costs about log n. The shortest-paths lesson shows what that is worth: its own code scans, and it counts the comparisons a heap like this one saves.',
  },
};
