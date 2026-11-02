// The Amdahl Lab's mission. It reads what the lab was set to, so any route that really reaches
// the target counts, and more cores alone can't. Played in tests/parallel-energy.test.ts.

import type { Mission } from '../missions.ts';
import { AmdahlLab, ranSchedule, sawManyCoresAtNinety, sawTwentyTimes } from './parallel.ts';

export type AmdahlState = { lab: AmdahlLab };

export const AMDAHL_MISSION: Mission<AmdahlState> = {
  id: 'comp-amdahl-lab', title: 'Buy cores or shrink the wait', xp: 60, setup: () => ({ lab: new AmdahlLab() }),
  steps: [
    { text: 'A job that is 90% parallel, on 8 cores. Read the speedup: it isn\'t 8', hint: 'Set parallel to 90% and cores to 8', done: (s) => s.lab.seen.some((e) => e.p === 0.9 && e.cores === 8) },
    { text: 'Run it tick by tick, with no formula, and compare the two numbers', hint: 'Press Run tick by tick', done: (s) => ranSchedule(s.lab) },
    { text: 'Still at 90%, give it at least 512 cores. How close to 10 times does it get?', hint: 'Move cores up, and watch the limit', done: (s) => sawManyCoresAtNinety(s.lab) },
    { text: 'You need 20 times, and your budget is 64 cores. Find what has to change', hint: 'Cores won\'t do it. Raise the parallel share until the speedup passes 20', done: (s) => sawTwentyTimes(s.lab) },
  ],
  debrief: 'At 90% parallel, nothing buys you more than 10 times, because the serial 10% still takes as long as it ever did. Going from 8 cores to 1,024 multiplied the hardware 128 times and the speedup about 2.1 times. Moving the serial share from 10% to about 3.5% was what reached 20 on 64 cores, and that\'s a change to the program. Remember this is a law about a fixed job with a fixed split, and real programs also pay to coordinate. Gustafson\'s objection is the other half of the picture: people often use more cores to run a bigger job instead.',
};
