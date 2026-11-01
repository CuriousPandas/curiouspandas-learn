// Fairness Lab's mission. The steps read what the lab saw, never text, and flagging
// everyone or nobody doesn't count as making the error rates equal. Played, with
// those shortcuts, in tests/fairness.test.ts.

import type { Mission } from '../missions.ts';
import { FairnessLab } from './fairness.ts';

export type FairState = { lab: FairnessLab };

export const FAIRNESS_MISSION: Mission<FairState> = {
  id: 'alg-people-fairness', title: 'Pick your fairness', xp: 60, setup: () => ({ lab: new FairnessLab() }),
  steps: [
    { text: 'Same threshold for both groups. A score means the same chance in either group. Now read the two false-positive rates', hint: 'Set both thresholds to the same value, somewhere in the middle', done: (s) => s.lab.sawSameScoreGap },
    { text: 'Set different thresholds until the false-positive rates match to within 2 points. What happened to the other two rows?', hint: 'Try a higher threshold for Group B than for Group A', done: (s) => s.lab.sawFprEqualised },
    { text: 'Ask the lab to try every pair of thresholds for all three measures at once', hint: 'Press Try every pair', done: (s) => s.lab.searched.includes('different') },
    { text: 'Switch to the same-base-rate data and find thresholds where all three match', hint: 'Choose Same base rates, then set both thresholds to the same value', done: (s) => s.lab.sawAllEqual },
  ],
  debrief: 'A score that means the same thing in both groups still flagged a larger share of the innocent people in the group with the higher base rate, and evening that out made a flag mean something different in each group. That isn\'t a bug in these invented numbers. Chouldechova\'s equation ties the four together, so when base rates differ you can\'t have all of them, short of a flag that is never wrong about anyone it flags. Equal base rates only make it possible, and that data was easy because its two groups are identical: groups with equal base rates and different spreads of scores can still come apart. Which measure to hold equal is not a question arithmetic can answer: it depends on who pays for which kind of mistake.',
};
