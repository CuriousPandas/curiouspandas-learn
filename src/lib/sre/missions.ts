// Missions for the SRE & Observability track, in the shape of src/lib/missions.ts.
// Each checks the state the learner produced, and the tempting answer leaves
// the step open: a threshold alert pages on everything; blaming the service
// with the worst p99 blames the messenger; running peak capacity all day
// drops nothing and costs twice as much.

import type { Mission } from '../missions.ts';
import { type Policy, type RunResult, verdict } from './slo.ts';
import type { Config, SimResult } from './hpa.ts';

// ---- SLOs -------------------------------------------------------------------

export type SloState = { runs: RunResult[] };
const allGood = (s: SloState, p: Policy) => (['blip', 'fast', 'slow'] as const).every((sc) => s.runs.some((r) => r.policy === p && r.scenario === sc && verdict(r).ok));

export const SLO_MISSION: Mission<SloState> = {
  id: 'sre-slo-alert', title: 'Page for the right reasons', xp: 60,
  setup: () => ({ runs: [] }),
  steps: [
    { text: 'Run the blip with the simple "error rate above the SLO" alert. Did it wake someone?', hint: 'Incident: A 10-minute blip; Alert: Error rate above the SLO; Run', done: (s) => s.runs.some((r) => r.scenario === 'blip' && r.policy === 'threshold') },
    { text: 'Run the fast burn with the 3-day average. How long until anyone knows?', hint: 'Incident: A fast burn; Alert: Average over 3 days; Run', done: (s) => s.runs.some((r) => r.scenario === 'fast' && r.policy === 'average') },
    { text: 'Find one alert that pages the fast burn within 15 minutes, stays quiet on the blip, and opens a ticket - not a page - for the slow leak', hint: 'Run all three incidents with the same alert. Only one alert passes all three', done: (s) => (['threshold', 'average', 'burn'] as const).some((p) => allGood(s, p)) },
  ],
  debrief: 'The threshold alert noticed everything, so it noticed the blip too and woke someone for 0.2% of the month. The 3-day average was calm on purpose and so blind to the fast burn. Burn rate asks a different question - how fast is the budget going - and asks it over a long window (is it real?) and a short one (is it still happening?).',
};

// ---- Logs, metrics and traces -----------------------------------------------

export type TraceState = { sawAvg: boolean; sawP99: boolean; openedSlow: string | null; blamed: string | null; logsFor: string | null };

export const TRACE_MISSION: Mission<TraceState> = {
  id: 'sre-find-slow', title: 'Find the slow dependency', xp: 60,
  setup: () => ({ sawAvg: false, sawP99: false, openedSlow: null, blamed: null, logsFor: null }),
  steps: [
    { text: 'Read the dashboard of averages. Is any service over the 300 ms target?', hint: 'The dashboard starts on Average', done: (s) => s.sawAvg },
    { text: 'Switch the dashboard to p99. What does it say now - and does it say who?', hint: 'Press p99', done: (s) => s.sawP99 },
    { text: 'Open the trace of a slow checkout', hint: 'Pick one of the checkouts that took over 2 seconds', done: (s) => s.openedSlow !== null },
    { text: 'Name the one service that made it slow', hint: 'Not the one with the longest bar - the one whose bar is long without children inside it', done: (s) => s.blamed === 'tax' },
    { text: 'Pull the logs for that trace and find out why', hint: 'Logs for this trace', done: (s) => s.logsFor !== null && s.logsFor === s.openedSlow },
  ],
  debrief: 'Every average was under target, because 19 checkouts in 20 were fast. p99 said four services were slow - all of them waiting on the same call. Only the trace showed where the time went, and the log line with the same trace id said why: a 1-second timeout and a retry. Metrics tell you that something is wrong; traces tell you where; logs tell you why.',
};

// ---- Autoscaling --------------------------------------------------------------

export type ScaleState = { runs: { cfg: Config; r: SimResult }[] };

export const SCALE_MISSION: Mission<ScaleState> = {
  id: 'sre-autoscale', title: 'Scale before it hurts', xp: 60,
  setup: () => ({ runs: [] }),
  steps: [
    { text: 'Run the web spike on the starting settings and count the dropped requests', hint: 'Run, unchanged', done: (s) => s.runs.some(({ cfg, r }) => cfg.workload === 'web' && r.droppedPct > 1) },
    { text: 'Get dropped requests under 1% - while averaging no more than 8 pods', hint: 'More pods all day works and costs twice as much. What makes new pods arrive sooner?', done: (s) => s.runs.some(({ cfg, r }) => cfg.workload === 'web' && r.droppedPct < 1 && r.avgPods <= 8) },
    { text: 'Switch to the queue worker, scale it on CPU, and watch the backlog', hint: 'Workload: queue worker; Scale on: CPU', done: (s) => s.runs.some(({ cfg }) => cfg.workload === 'queue' && cfg.metric === 'cpu') },
    { text: 'Make the backlog drain', hint: 'A raised maximum does nothing if the metric never asks for more pods', done: (s) => s.runs.some(({ cfg, r }) => cfg.workload === 'queue' && cfg.metric === 'queue' && r.finalBacklog === 0) },
  ],
  debrief: 'The autoscaler is only as quick as its slowest link: 15 seconds to look, then however long a new pod takes to become Ready - and while it starts, it counts as 0% and holds back the next step. Headroom (a lower target) and fast-starting pods fixed the spike without paying for the peak all day. The queue worker waits on a slow API, so its CPU never rose and the HPA never scaled: scale on what the work actually is.',
};
