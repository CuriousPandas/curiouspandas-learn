// Missions for the Git track's strategy lessons, in the shape of
// src/lib/missions.ts. They check what the learner's runs produced, and the
// tempting move leaves a step open: a long-lived branch keeps users safe but
// saves every conflict for one big merge; merging daily without a flag shows
// users a half-built feature; rebasing or squashing a branch someone built on
// hands them the mess.

import type { Mission } from '../missions.ts';
import type { Run } from './divergence.ts';
import { type Outcome, hurtSam, releasable } from './history.ts';

export type BranchState = { runs: Run[] };

export const BRANCH_MISSION: Mission<BranchState> = {
  id: 'git-cadence', title: 'Small merges, nothing half-built', xp: 50,
  setup: () => ({ runs: [] }),
  steps: [
    { text: 'Keep the feature on its own branch for the whole two weeks, then merge it', hint: 'Merge: once, after two weeks. Then Run', done: (s) => s.runs.some((r) => r.plan.mergeEvery === 10) },
    { text: 'Find a cadence where no single merge has more than one file to reconcile', hint: 'How often would you have to integrate for the two sides to rarely touch the same file in between?', done: (s) => s.runs.some((r) => r.largest <= 1) },
    { text: 'Do that without users ever reaching the half-built search', hint: 'Merging unfinished code is only safe if it is switched off', done: (s) => s.runs.some((r) => r.largest <= 1 && r.exposedDays.length === 0) },
  ],
  debrief: 'The long-lived branch looked safe and saved every conflict for one merge of eight files, reconciled from memory of two weeks ago. Merging daily kept each merge to at most one file, while both changes were fresh. The flag is what made merging unfinished work safe: the code was in trunk, tested with everyone else\'s, and switched off until it was done.',
};

export type HistoryState = { outcomes: Outcome[] };

export const HISTORY_MISSION: Mission<HistoryState> = {
  id: 'git-integrate', title: 'Tidy history, no casualties', xp: 50,
  setup: () => ({ outcomes: [] }),
  steps: [
    { text: 'Your branch is only on your machine: rebase it onto main for a straight line', hint: 'Scenario: never pushed. Method: rebase', done: (s) => s.outcomes.some((o) => o.scenario === 'solo' && o.method === 'rebase') },
    { text: 'Sam built on your pushed branch. Get it into main without leaving Sam anything to untangle', hint: 'Which method keeps F1 and F2 exactly as Sam has them?', done: (s) => s.outcomes.some((o) => o.scenario === 'shared' && !hurtSam(o)) },
    { text: 'Squash-merge the solo branch so release-please will count it as a new feature', hint: 'Squash makes the pull request title the commit on main', done: (s) => s.outcomes.some((o) => o.scenario === 'solo' && o.method === 'squash' && releasable(o).includes('feat')) },
  ],
  debrief: 'Rewriting history is a private act. On your own branch, rebase and squash give main a clean line and lose nothing. Once someone else has your commits, rebase hands them duplicates and squash leaves them holding commits main never received - a merge commit is the only one of the three that keeps every id they have. And with squash, the pull request title is the commit release-please reads.',
};
