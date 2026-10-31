// Missions for the agile track, in the shape of src/lib/missions.ts. Each checks
// what the board measured over the window, never what the controls say now:
// setting a WIP limit for one day does not count as running with one, and a
// rising velocity does not count as delivering more.

import type { Mission } from '../missions.ts';
import { FlowBoard, WINDOW, SLE, percentile } from './flow.ts';

export type FlowState = { board: FlowBoard };

type Window = { days: FlowBoard['history']; throughput: number; p85: number | null };
/** True if any full window so far met the test. Steps are achievements: once
 * the learner has run a healthy limit, starving the board afterwards must not
 * untick it, or the last two steps could never be done at the same time. */
function everWindow(b: FlowBoard, ok: (w: Window) => boolean): boolean {
  for (let end = WINDOW; end <= b.day; end++) {
    const span: [number, number] = [end - WINDOW, end];
    if (ok({ days: b.history.slice(end - WINDOW, end), throughput: b.throughput(span), p85: percentile(b.cycleTimes(span), SLE.percentile) })) return true;
  }
  return false;
}
// The team finishes about one normal-sized item a day at full capacity, so a
// 20-day window with nobody starved finishes about 20 - between 19 and 25 in
// practice, because item sizes vary. The floor sits under that spread so the
// step does not flicker; a limit of 1 finishes about 11, well under STARVED.
const THROUGHPUT_FLOOR = 17;
const STARVED = 14;

export const FLOW_MISSION: Mission<FlowState> = {
  id: 'flow-wip', title: 'Count the work, then limit it', xp: 60,
  setup: () => ({ board: new FlowBoard() }),
  steps: [
    { text: 'Let work arrive faster than the team can finish, with no WIP limit, for 30 days. Read WIP and the oldest item\'s age', hint: 'Arrivals: more than the team can finish, WIP limit: none, then Run a sprint three times', done: (s) => s.board.history.filter((h) => h.load === 'overload' && h.wipLimit === null).length >= 30 },
    { text: 'Check Little\'s Law over the last 20 days. Does the area under the WIP line equal the time items spent inside the window?', hint: 'Press "Check Little\'s Law" and compare the two totals', done: (s) => s.board.checks.some((c) => !('notMeasured' in c) && c.holds && c.days >= WINDOW) },
    { text: `Keep the overload, set a WIP limit, and get 85th-percentile cycle time within the ${SLE.days}-day service level - without throughput falling`, hint: 'WIP limit: 4, then keep running sprints. The limit only stops new starts: the pile already on the board has to drain first, so watch WIP fall', done: (s) => everWindow(s.board, (w) => w.days.every((h) => h.load === 'overload' && h.wipLimit !== null) && w.throughput >= THROUGHPUT_FLOOR && (w.p85 ?? Infinity) <= SLE.days) },
    { text: 'Starve the board: find a WIP limit so low that throughput falls', hint: 'Four people, at most two on an item. Try a limit of 1 for a full window', done: (s) => everWindow(s.board, (w) => w.days.every((h) => h.wipLimit !== null && !h.sliced) && w.throughput < STARVED) },
  ],
  debrief: 'With no limit, every item that arrived was "started" the same day, and then waited on the board while four people worked on the oldest ones. Cycle time measured that waiting. The limit did not make anyone faster: it kept the queue in the backlog, where it is honest, and throughput stayed where capacity put it. It also could not undo the month before: the items already started had to finish before cycle time came down. Cut the limit too far and people sat idle - a lower WIP is only better while there is still enough work to do. Little\'s Law held on every run, because it is an identity about what you measured, not a promise about what you will get.',
};

export const DOD_MISSION: Mission<FlowState> = {
  id: 'definition-of-done', title: 'Done means done', xp: 60,
  setup: () => { const board = new FlowBoard(); board.wipLimit = 4; board.dod = 'weak'; return { board }; },
  steps: [
    { text: 'Run with the weak Definition of Done for a full 20-day window. Compare "finished" with "stayed done"', hint: 'Run a sprint twice', done: (s) => everWindow(s.board, (w) => w.days.every((h) => h.dod === 'weak')) },
    { text: 'Switch to test-first and run until the whole window uses it', hint: 'Definition of Done: tested and integrated, then Run a sprint twice', done: (s) => everWindow(s.board, (w) => w.days.every((h) => h.dod === 'strong')) },
    { text: 'Which number tells you how much work is really done?', hint: 'One of them counts the same work twice', done: (s) => s.board.answer === 'stayed' && everWindow(s.board, (w) => w.days.every((h) => h.dod === 'strong')) },
  ],
  debrief: 'With the weak Definition of Done the board finished more items - because one in three came back eight days later as new work, and the fix was counted as another finished item. "Finished" counted the same work twice; "stayed done" did not. Testing first cost a quarter more effort per item in this model, and both of those numbers are invented: what is not invented is that a done count which includes undone work cannot tell you how much is done.',
};

export const FORECAST_MISSION: Mission<FlowState> = {
  id: 'velocity-target', title: 'Forecasts, not promises', xp: 60,
  setup: () => { const board = new FlowBoard(); board.wipLimit = 4; return { board }; },
  steps: [
    { text: 'Run three sprints with no velocity target. Note velocity and throughput', hint: 'Run a sprint three times', done: (s) => s.board.sprints.filter((p) => !p.target).length >= 3 },
    { text: 'Switch the velocity target on and run three more sprints', hint: 'Tick "velocity target", then Run a sprint three times', done: (s) => s.board.sprints.filter((p) => p.target).length >= 3 },
    { text: 'Which number tells you whether the team is really delivering more?', hint: 'Points are an estimate the team makes. Which column counts finished items?', done: (s) => s.board.answer === 'throughput' && s.board.sprints.filter((p) => p.target).length >= 3 },
  ],
  debrief: 'Velocity rose because the same work was estimated bigger each sprint - nobody had to lie, the target just pulled every guess upward. The count of finished items did not move, because nothing about the team\'s capacity changed. The Scrum Guide never mentions story points or velocity; the Kanban Guide measures throughput as an exact count. The inflation rate here is invented, because no study has measured one.',
};
