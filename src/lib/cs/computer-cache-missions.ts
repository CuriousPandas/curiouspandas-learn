// Code-lab missions for How a Machine Computes. The learner writes a real cache simulator in
// Python, judged on address lists they never see. The wrong answers these must reject: counting
// distinct lines (ignores eviction), counting every read, and treating LRU as direct-mapped.
// Each `want` here is produced by a separate reference in real Python in tests/cache.test.ts.

import type { Mission } from '../missions.ts';
import { checkCases, type GrowthPoint, type GrowthShape, type RunResult } from '../py/lab.ts';

type State = { runs: RunResult[]; growth: { src: string; fn: string; points: GrowthPoint[]; shape: GrowthShape }[] };
type M = Mission<State> & { starter?: string; stdin?: string[]; given?: string };

const blank = (): State => ({ runs: [], growth: [] });
const last = (s: State) => s.runs.at(-1);
const pass = (s: State, fn: string, c: { args: unknown[]; want: string }[]) => { const r = last(s); return !!r && checkCases(r, fn, c).ok; };
const why = (s: State, fn: string, c: { args: unknown[]; want: string }[]) => { const r = last(s); if (!r) return ''; const v = checkCases(r, fn, c); return v.ok ? '' : v.why; };

export const DIRECT_CASES: { args: unknown[]; want: string }[] = [
  { args: [[], 4, 64], want: '0' },
  { args: [[0, 4, 8, 60], 4, 64], want: '1' },
  { args: [[0, 64, 128, 192, 0, 64, 128, 192], 4, 64], want: '4' },
  { args: [[0, 256, 0, 256, 0, 256], 4, 64], want: '6' },
  { args: [[0, 256, 64, 320, 0, 256], 4, 64], want: '6' },
  { args: [[1000, 1004, 1064, 1000, 5000, 1000, 5000], 8, 32], want: '3' },
  { args: [[0, 1, 2, 3, 16, 17, 32, 0], 2, 16], want: '4' },
  { args: [[0, 128, 0, 128], 2, 64], want: '4' },
];
export const LRU_CASES: { args: unknown[]; want: string }[] = [
  { args: [[], 4, 64], want: '0' },
  { args: [[0, 256, 0, 256, 0, 256], 4, 64], want: '2' },
  { args: [[0, 64, 128, 192, 256, 0], 4, 64], want: '6' },
  { args: [[0, 64, 128, 192, 0, 256, 64], 4, 64], want: '6' },
  { args: [[0, 64, 0, 128, 0, 192, 0, 256, 0], 4, 64], want: '5' },
  { args: [[1000, 1004, 1064, 1000, 5000, 1000, 5000], 8, 32], want: '3' },
];

export const COMPUTER_MISSIONS: Record<string, M> = {
  'computer-cache-sim': {
    id: 'computer-cache-sim', title: 'Build the cache', xp: 70, setup: blank,
    starter: `# A direct-mapped cache: each line of memory has exactly one slot it can go in.
def count_misses(addresses, lines, line_size):
    cache = [None] * lines
    misses = 0
    for address in addresses:
        line = address // line_size
        slot = line % lines
        # Your code goes here. Is this line already in its slot?
        # If not, that's a miss, and it goes in, replacing what was there.
    return misses

print(count_misses([0, 4, 8, 64, 0], 4, 64))
`,
    steps: [
      { text: 'Finish count_misses. Reads in the same line after the first are hits, and two lines that want one slot keep throwing each other out', hint: 'if cache[slot] != line: misses += 1 and cache[slot] = line', done: (s) => pass(s, 'count_misses', DIRECT_CASES), why: (s) => why(s, 'count_misses', DIRECT_CASES) },
      { text: 'Add count_misses_lru, with the same arguments. Now any line can go in any slot, and the one left out when it fills up is the one used longest ago. Keep count_misses too', hint: 'A list works, oldest first. On a hit, remove the line and append it. On a miss, if the list is full, pop(0), then append it', done: (s) => pass(s, 'count_misses', DIRECT_CASES) && pass(s, 'count_misses_lru', LRU_CASES), why: (s) => (pass(s, 'count_misses', DIRECT_CASES) ? why(s, 'count_misses_lru', LRU_CASES) : '') },
    ],
    debrief: 'Those few lines are a cache simulator, and the lab above is a bigger version of the same idea. On reads of 0 and 256 in turn, the two cost 6 misses against 2: same cache size, and a different rule about where a line may go. Those extra 4 are conflict misses: they come only from where a line may go. It doesn\'t always go that way. Try [0, 64, 128, 192, 256] three times over with 4 lines: LRU misses all 15 reads, and direct-mapped misses 9, because a loop just bigger than the cache keeps throwing out the very line it needs next. Real caches sit between your two functions, because checking every slot at once costs hardware and checking one costs misses. That\'s what "ways" trade off.',
  },
};
