// Missions for the code lab, in the shape of src/lib/missions.ts. A step judges
// the program's behaviour, by calling the learner's function on inputs they never
// saw or by measuring how its work grows, never by matching their text. So any
// correct route counts, and a program that prints the right answer for the one
// visible case does not pass.

import type { Mission } from '../missions.ts';
import { checkCases, type GrowthPoint, type GrowthShape, type RunResult } from '../py/lab.ts';

export type CodeState = { runs: RunResult[]; growth: { src: string; fn: string; points: GrowthPoint[]; shape: GrowthShape }[] };
export type CodeMission = Mission<CodeState> & { starter?: string };

const blank = (): CodeState => ({ runs: [], growth: [] });
export const lastRun = (s: CodeState) => s.runs.at(-1);
export const passes = (s: CodeState, fn: string, cases: { args: unknown[]; want: string }[]) => {
  const r = lastRun(s);
  return !!r && checkCases(r, fn, cases).ok;
};

export const CODE_MISSIONS: Record<string, CodeMission> = {
  'cs-growth-duplicates': {
    id: 'cs-growth-duplicates', title: 'Same answer, different bill', xp: 60, setup: blank,
    starter: `def has_duplicate(items):
    seen = []
    for x in items:
        if x in seen:
            return True
        seen.append(x)
    return False

print(has_duplicate([3, 1, 4, 1, 5]))
print(has_duplicate([2, 7, 1, 8]))
`,
    steps: [
      { text: 'Run it. Both answers are right, so nothing looks wrong yet.', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && /True\s+False/.test(r.stdout)) },
      { text: 'Measure how its work grows on lists with no duplicates. What happens each time the input doubles?', hint: 'Press Measure growth', done: (s) => s.growth.some((g) => g.shape === 'quadratic') },
      { text: 'Change one thing so the work grows in step with the input, and keep the answers right', hint: 'Which built-in type can answer "have I seen this?" without scanning? seen = set(), then seen.add(x)', done: (s) => {
        const g = s.growth.at(-1);
        return !!g && g.shape === 'linear' && passes(s, 'has_duplicate', [
          { args: [[1, 2, 3]], want: 'False' }, { args: [[1, 2, 1]], want: 'True' }, { args: [[]], want: 'False' }, { args: [[5, 5]], want: 'True' },
        ]) && lastRun(s)!.src === g.src;
      } },
    ],
    debrief: 'One line hid the whole bill. Asking whether x is in a list reads the list, so the loop does a scan per item, and doubling the input quadruples the work. Your tests passed the whole time, because a small input never shows this. A set answers the same question without scanning. That is what big-O is for: it describes how the work grows, not how long it took today.',
  },
};
