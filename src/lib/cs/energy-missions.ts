// The Joule Lab's mission. It reads what the lab was set to, and a clock the voltage can't
// reach or a missed deadline never counts as a saving. Played in tests/parallel-energy.test.ts.

import type { Mission } from '../missions.ts';
import { EnergyLab, sawBest, sawBrokenSetting, sawSaving, sawSlowClockSameVolts } from './energy.ts';

export type EnergyState = { lab: EnergyLab };

export const ENERGY_MISSION: Mission<EnergyState> = {
  id: 'comp-joule-lab', title: 'Spend fewer joules on the same job', xp: 60, setup: () => ({ lab: new EnergyLab() }),
  steps: [
    { text: 'Keep the voltage at 1.2 V and slow the clock, keeping to the deadline. Did the job cost fewer joules?', hint: 'Set the clock to 2 GHz at 1.2 V', done: (s) => sawSlowClockSameVolts(s.lab) },
    { text: 'Lower the voltage a long way and leave the clock high. What does the chip say?', hint: '0.6 V at 4.5 GHz', done: (s) => sawBrokenSetting(s.lab) },
    { text: 'Lower both, and get the job done by the deadline for at least a third fewer joules than full speed', hint: 'Lower the voltage, then find the fastest clock it allows', done: (s) => sawSaving(s.lab) },
    { text: 'Find the cheapest setting that still makes the deadline', hint: 'Slowest isn\'t cheapest: try each low voltage at the fastest clock it allows', done: (s) => sawBest(s.lab) },
  ],
  debrief: 'Slowing the clock alone didn\'t cut the energy for this job: the same cycles switch the same charge, and the chip leaks for longer. It\'s the voltage that matters, because energy goes with its square, and lower voltage forces a slower clock. That\'s the trade DVFS makes. This chip is invented, so don\'t read its numbers as any real part\'s, but the shape comes from C V² per cycle plus leakage over time.',
};
