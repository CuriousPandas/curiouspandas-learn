import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlowBoard, percentile, WINDOW, SPRINT, SLE } from '../src/lib/agile/flow.ts';
import { FLOW_MISSION, FORECAST_MISSION } from '../src/lib/agile/missions.ts';

const measured = (b: FlowBoard) => {
  const c = b.little();
  assert.ok(!('notMeasured' in c), 'window should be measured');
  return c as Exclude<ReturnType<FlowBoard['little']>, { notMeasured: true }>;
};

test("Little's LL.2 holds exactly on every board shape: stable, overloaded, limited, sliced, never empty", () => {
  const shapes: ((b: FlowBoard) => void)[] = [
    () => {},
    (b) => { b.load = 'overload'; },
    (b) => { b.load = 'overload'; b.wipLimit = 4; },
    (b) => { b.load = 'overload'; b.wipLimit = 1; },
    (b) => { b.load = 'overload'; b.sliced = true; },
  ];
  for (const shape of shapes) {
    const b = new FlowBoard(); shape(b); b.run(57);
    const c = measured(b);
    assert.equal(c.area, c.residence, 'area under WIP must equal summed residence, as integers');
    assert.ok(Math.abs(c.L - c.lambda * c.W) < 1e-9);
  }
  const busy = new FlowBoard(); busy.load = 'overload'; busy.run(40);
  assert.ok(busy.wipByDay.slice(-WINDOW).every((w) => w > 0), 'the overloaded board is never empty in the window');
  assert.ok(measured(busy).holds, "Little's corollary: it holds even when the system is never empty");
});

test('a bookkeeper that loses items fails the check - so the check is not algebra that always passes', () => {
  const b = new FlowBoard(); b.load = 'overload'; b.run(40);
  const lossy = b.items.filter((i) => i.finish === undefined || i.finish % 7 !== 0);
  assert.ok(lossy.length < b.items.length);
  const c = b.little(lossy);
  assert.ok(!('notMeasured' in c) && !c.holds, 'dropping finished items must break area = residence');
});

test('an empty window reports "not measured", never "holds"', () => {
  const c = new FlowBoard().little();
  assert.ok('notMeasured' in c);
});

test('the everyday estimate drifts under overload and agrees when the board is stable', () => {
  const over = new FlowBoard(); over.load = 'overload'; over.run(60);
  assert.ok(measured(over).practitioner.gap > 0.15, 'arrivals outpacing finishes open a gap');
  const calm = new FlowBoard(); calm.load = 'overload'; calm.wipLimit = 4; calm.run(60);
  assert.ok(measured(calm).practitioner.gap < 0.1);
});

test('a WIP limit cuts cycle time without cutting throughput; too low a limit starves the team', () => {
  const run = (limit: number | null) => { const b = new FlowBoard(); b.load = 'overload'; b.wipLimit = limit; b.run(60); return b; };
  const open = run(null), four = run(4), one = run(1);
  assert.equal(four.throughput(), open.throughput(), 'same people, same capacity, same finishes');
  assert.ok(percentile(four.cycleTimes(), 85)! * 3 < percentile(open.cycleTimes(), 85)!);
  assert.ok(open.inProgress.length > 5 * four.inProgress.length, 'with no limit the queue sits on the board as "started" work');
  assert.ok(four.backlog.length > 0, 'with a limit it waits, honestly, in the backlog');
  assert.ok(one.throughput() < four.throughput() * 0.75, 'a limit of 1 leaves half the team idle');
});

test('cycle time comes out of capacity: nothing in the engine computes it from the law', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/lib/agile/flow.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /cycle\w*\s*=\s*[^;\n]*\/\s*(lambda|throughput)/i);
});

test('under a velocity target the points per finished item inflate while the count of finished items does not', () => {
  const b = new FlowBoard(); b.wipLimit = 4; b.run(SPRINT * 4); b.velocityTarget = true; b.run(SPRINT * 4);
  const before = b.sprints.filter((s) => !s.target), after = b.sprints.filter((s) => s.target);
  const ppi = (ss: typeof before) => ss.reduce((s, x) => s + x.velocity, 0) / ss.reduce((s, x) => s + x.throughput, 0);
  const tp = (ss: typeof before) => ss.reduce((s, x) => s + x.throughput, 0) / ss.length;
  assert.ok(ppi(after) > ppi(before) * 1.3, 'velocity rises because estimates grow');
  assert.ok(Math.abs(tp(after) - tp(before)) / tp(before) < 0.25, 'throughput stays where capacity puts it');
});

test('flow mission: completes from its hints; one day of a WIP limit does not count', () => {
  const s = FLOW_MISSION.setup();
  assert.ok(!FLOW_MISSION.steps.some((st) => st.done(s)));
  const b = s.board;
  b.load = 'overload'; b.run(SPRINT * 3);
  assert.ok(FLOW_MISSION.steps[0].done(s));
  b.checkLittle();
  assert.ok(FLOW_MISSION.steps[1].done(s));
  b.wipLimit = 4; b.run(1);
  assert.ok(!FLOW_MISSION.steps[2].done(s), 'a limit set for one day has not been run with');
  b.run(SPRINT * 2);
  assert.ok(!FLOW_MISSION.steps[2].done(s), 'the 30 items started before the limit still have to drain');
  b.run(SPRINT * 2);
  assert.ok(FLOW_MISSION.steps[2].done(s), `p85 ${percentile(b.cycleTimes(), 85)} vs SLE ${SLE.days}, throughput ${b.throughput()}`);
  b.wipLimit = 1; b.run(SPRINT * 2);
  assert.ok(FLOW_MISSION.steps[3].done(s));
  // Steps 3 and 4 need opposite windows. Both must stay done together, or
  // the mission can never complete: it once checked only the current window.
  assert.ok(FLOW_MISSION.steps.every((st) => st.done(s)), 'all four steps done at once');
});

test('forecast mission: completes from its hints; picking velocity does not pass', () => {
  const s = FORECAST_MISSION.setup();
  assert.ok(!FORECAST_MISSION.steps.some((st) => st.done(s)));
  s.board.run(SPRINT * 3);
  assert.ok(FORECAST_MISSION.steps[0].done(s));
  s.board.velocityTarget = true; s.board.run(SPRINT * 3);
  assert.ok(FORECAST_MISSION.steps[1].done(s));
  s.board.answer = 'velocity';
  assert.ok(!FORECAST_MISSION.steps[2].done(s));
  s.board.answer = 'throughput';
  assert.ok(FORECAST_MISSION.steps[2].done(s));
});
