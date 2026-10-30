import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetMinutes, run, verdict, type Policy, type Scenario } from '../src/lib/sre/slo.ts';
import { generate, serviceStats, selfTime, seriesCount } from '../src/lib/sre/trace.ts';
import { simulate, desiredReplicas, DEFAULTS, type Config } from '../src/lib/sre/hpa.ts';
import { SLO_MISSION, TRACE_MISSION, SCALE_MISSION } from '../src/lib/sre/missions.ts';

// ---- SLOs -------------------------------------------------------------------

test('99.9% over 30 days is 43.2 minutes of budget (43,200 minutes x 0.001)', () => {
  assert.equal(Math.round(budgetMinutes(0.999) * 10) / 10, 43.2);
  assert.equal(Math.round(budgetMinutes(0.9999) * 100) / 100, 4.32);
});

const all = (p: Policy) => (['blip', 'fast', 'slow'] as Scenario[]).map((s) => verdict(run(s, p)));

test('the simple threshold alert pages on the blip: good recall, poor precision (SRE Workbook)', () => {
  const blip = run('blip', 'threshold');
  assert.ok(blip.pages.length > 0, 'it should page on the blip');
  assert.ok(blip.budgetSpent < 0.01, `the blip spends under 1% of the budget, spent ${blip.budgetSpent}`);
  assert.equal(all('threshold').every((v) => v.ok), false);
});

test('the 3-day average never pages the fast burn', () => {
  const fast = run('fast', 'average');
  assert.equal(fast.firstPageAfter, null);
  assert.ok(fast.budgetSpent > 0.05, 'the fast burn really is expensive');
});

test('multiwindow burn rate: pages the fast burn quickly, ignores the blip, tickets the slow leak', () => {
  const [blip, fast, slow] = (['blip', 'fast', 'slow'] as Scenario[]).map((s) => run(s, 'burn'));
  assert.equal(blip.pages.length, 0);
  assert.ok(fast.firstPageAfter !== null && fast.firstPageAfter <= 15, `paged after ${fast.firstPageAfter}`);
  assert.equal(slow.pages.length, 0);
  assert.ok(slow.tickets.length > 0);
  assert.ok(all('burn').every((v) => v.ok));
});

test('SLO mission: only an alert that passes all three incidents ticks the last step', () => {
  const s = SLO_MISSION.setup();
  for (const p of ['threshold', 'average'] as Policy[]) for (const sc of ['blip', 'fast', 'slow'] as Scenario[]) s.runs.push(run(sc, p));
  assert.equal(SLO_MISSION.steps[2].done(s), false, 'the wrong alerts must not pass');
  for (const sc of ['blip', 'fast', 'slow'] as Scenario[]) s.runs.push(run(sc, 'burn'));
  assert.ok(SLO_MISSION.steps.every((st) => st.done(s)));
});

// ---- Logs, metrics and traces -----------------------------------------------

const { traces, logs } = generate();
const stats = serviceStats(traces);

test('every average is under the 300 ms target - the dashboard looks healthy', () => {
  for (const s of stats) assert.ok(s.avg < 300, `${s.service} avg ${s.avg}`);
});

test('p99 says something is slow but not who: four services over 300 ms at once', () => {
  const slow = stats.filter((s) => s.p99 > 300).map((s) => s.service).sort();
  assert.deepEqual(slow, ['checkout', 'gateway', 'pricing', 'tax']);
});

test('a slow trace\'s own-time points at tax alone; its logs share the trace id and say why', () => {
  const t = traces.find((x) => x.slow)!;
  assert.equal(selfTime(t)[0].service, 'tax');
  const lines = logs.filter((l) => l.traceId === t.traceId);
  assert.ok(lines.some((l) => l.level === 'warn' && /timed out/.test(l.msg)));
  const fast = traces.find((x) => !x.slow)!;
  assert.equal(logs.filter((l) => l.traceId === fast.traceId).some((l) => /timed out/.test(l.msg)), false);
});

test('trace mission: blaming the service with the worst p99 does not pass', () => {
  const s = TRACE_MISSION.setup();
  s.blamed = 'checkout';
  assert.equal(TRACE_MISSION.steps[3].done(s), false);
  s.blamed = 'tax';
  assert.ok(TRACE_MISSION.steps[3].done(s));
});

test('label cardinality multiplies: adding a user id label turns 600 series into 30 million', () => {
  assert.equal(seriesCount([5, 6, 20]), 600);
  assert.equal(seriesCount([5, 6, 20, 50_000]), 30_000_000);
});

// ---- Autoscaling --------------------------------------------------------------

test('HPA formula, from the Kubernetes docs: 200m against 100m doubles, 50m halves, inside 10% does nothing', () => {
  assert.equal(desiredReplicas(3, 200, 100), 6);
  assert.equal(desiredReplicas(4, 50, 100), 2);
  assert.equal(desiredReplicas(4, 108, 100), 4);
  assert.equal(desiredReplicas(4, 115, 100), 5);
});

const sim = (c: Partial<Config>) => simulate({ ...DEFAULTS, ...c });

test('starting settings drop requests in the spike, and a higher maximum does not help', () => {
  assert.ok(sim({}).droppedPct > 5);
  assert.equal(sim({ maxReplicas: 24 }).droppedPct, sim({}).droppedPct);
});

test('peak capacity all day drops nothing but costs about twice the pods', () => {
  const over = sim({ minReplicas: 10 });
  assert.equal(over.droppedPct, 0);
  assert.ok(over.avgPods >= 10);
  const fast = sim({ startupS: 15 });
  assert.ok(fast.droppedPct < 1 && fast.avgPods <= 8, `fast start: ${fast.droppedPct}% at ${fast.avgPods} pods`);
});

test('a queue worker scaled on CPU never scales; scaled on queue depth, the backlog drains', () => {
  const cpu = sim({ workload: 'queue', metric: 'cpu', target: 50 });
  assert.equal(cpu.peakPods, DEFAULTS.minReplicas);
  assert.ok(cpu.finalBacklog > 1000);
  assert.ok(sim({ workload: 'queue', metric: 'cpu', target: 50, maxReplicas: 24 }).finalBacklog > 1000, 'a bigger max cannot help');
  assert.equal(sim({ workload: 'queue', metric: 'queue', target: 50 }).finalBacklog, 0);
});

test('scale mission: overprovisioning does not pass, a fast start does', () => {
  const s = SCALE_MISSION.setup();
  const add = (c: Partial<Config>) => { const cfg = { ...DEFAULTS, ...c }; s.runs.push({ cfg, r: simulate(cfg) }); };
  add({}); add({ minReplicas: 10 });
  assert.equal(SCALE_MISSION.steps[1].done(s), false);
  add({ startupS: 15 });
  assert.ok(SCALE_MISSION.steps[1].done(s));
  add({ workload: 'queue', metric: 'cpu', target: 50, maxReplicas: 24 });
  assert.equal(SCALE_MISSION.steps[3].done(s), false);
  add({ workload: 'queue', metric: 'queue', target: 50 });
  assert.ok(SCALE_MISSION.steps.every((st) => st.done(s)));
});
