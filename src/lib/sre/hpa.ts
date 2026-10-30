// A Horizontal Pod Autoscaler, close enough to the real controller to fail
// the same ways. From the Kubernetes docs:
//   desiredReplicas = ceil(currentReplicas x currentMetricValue / desiredMetricValue)
// evaluated every 15 s; no action within a 0.1 tolerance; a not-yet-ready pod
// counts as 0% when scaling up (so a slow start delays the next scale-up too);
// and scale-down takes the highest recommendation from the last 300 s.

export const TICK_S = 15;
export const TOLERANCE = 0.1;
export const DOWN_WINDOW_S = 300;

export type Workload = 'web' | 'queue';
export type Metric = 'cpu' | 'queue';
export type Config = {
  workload: Workload;
  metric: Metric;
  target: number;       // CPU utilization % of request, or messages per pod
  minReplicas: number;
  maxReplicas: number;
  startupS: number;     // from pod created to Ready
};

export const DEFAULTS: Config = { workload: 'web', metric: 'cpu', target: 90, minReplicas: 2, maxReplicas: 12, startupS: 60 };

// A web pod at 100% of its CPU request serves 50 requests a second. A queue
// worker spends its time waiting on a slow API: each pod finishes 5 messages a
// second whatever happens, at about 20% CPU, busy or not.
const WEB_RPS_PER_POD = 50;
const WORKER_RATE = 5;
const WORKER_CPU = 20;

export type Tick = { t: number; demand: number; ready: number; starting: number; desired: number; metric: number; served: number; dropped: number; backlog: number };

/** Traffic over 40 minutes: steady, a spike that ramps up over 2 minutes from
 *  minute 10, back to normal at minute 18. The quiet half is what makes
 *  "just run enough pods for the peak all day" visibly expensive. */
export const SPIKE = { from: 600, ramp: 120, to: 1080 };
export const DURATION_S = 40 * 60;
export function demandAt(w: Workload, t: number): number {
  const [low, high] = w === 'web' ? [120, 480] : [8, 40]; // requests or messages per second
  if (t < SPIKE.from || t >= SPIKE.to) return low;
  return low + (high - low) * Math.min(1, (t - SPIKE.from) / SPIKE.ramp);
}

export const TARGETS: Record<Metric, number[]> = { cpu: [90, 70, 50], queue: [100, 50, 20] };

export function simulate(cfg: Config, durationS = DURATION_S) {
  // Pods are ready-at times; the deployment starts warm at minReplicas.
  let pods: number[] = Array(cfg.minReplicas).fill(-Infinity);
  const recs: { t: number; n: number }[] = [];
  const ticks: Tick[] = [];
  let backlog = 0, served = 0, dropped = 0, podSeconds = 0;

  for (let t = 0; t < durationS; t += TICK_S) {
    const ready = pods.filter((r) => r <= t).length;
    const starting = pods.length - ready;
    const demand = demandAt(cfg.workload, t);

    // Serve this tick.
    let metric: number, tickServed: number, tickDropped = 0;
    if (cfg.workload === 'web') {
      const capacity = ready * WEB_RPS_PER_POD;
      tickServed = Math.min(demand, capacity);
      tickDropped = demand - tickServed;
      // Utilization against the request, capped at 100%: a saturated pod
      // cannot report more than all of its CPU.
      metric = ready ? Math.min(100, (demand / capacity) * 100) : 0;
    } else {
      backlog += demand * TICK_S;
      tickServed = Math.min(backlog, ready * WORKER_RATE * TICK_S) / TICK_S;
      backlog -= tickServed * TICK_S;
      metric = cfg.metric === 'cpu' ? (ready ? WORKER_CPU : 0) : ready ? backlog / ready : backlog;
    }
    served += tickServed * TICK_S; dropped += tickDropped * TICK_S;
    podSeconds += pods.length * TICK_S;

    // The controller. Not-ready pods are set aside and count as 0% when the
    // result would be a scale-up - the docs' "conservative" assumption.
    const current = pods.length;
    const value = cfg.metric === 'cpu' && cfg.workload === 'web'
      ? (ready ? Math.min(100, (demand / (ready * WEB_RPS_PER_POD)) * 100) * ready / current : 0)
      : metric;
    const ratio = value / cfg.target;
    let desired = current;
    if (Math.abs(ratio - 1) > TOLERANCE) desired = Math.ceil(current * ratio);
    desired = Math.max(cfg.minReplicas, Math.min(cfg.maxReplicas, desired));
    recs.push({ t, n: desired });
    if (desired > current) {
      pods = pods.concat(Array(desired - current).fill(t + cfg.startupS));
    } else if (desired < current) {
      // Scale down only to the highest recommendation in the window.
      const windowMax = Math.max(...recs.filter((r) => r.t > t - DOWN_WINDOW_S).map((r) => r.n));
      const target = Math.max(desired, Math.min(current, windowMax));
      if (target < current) pods = pods.slice(0, target);
    }
    ticks.push({ t, demand, ready, starting, desired, metric: Math.round(metric * 10) / 10, served: tickServed, dropped: tickDropped, backlog: Math.round(backlog) });
  }
  const total = served + dropped;
  return {
    ticks,
    droppedPct: total ? (dropped / total) * 100 : 0,
    peakBacklog: Math.max(...ticks.map((k) => k.backlog)),
    finalBacklog: ticks[ticks.length - 1].backlog,
    avgPods: podSeconds / durationS,
    peakPods: Math.max(...ticks.map((k) => k.ready + k.starting)),
  };
}

export type SimResult = ReturnType<typeof simulate>;

/** The formula on its own, for the lesson and the tests. */
export function desiredReplicas(current: number, currentValue: number, targetValue: number): number {
  const ratio = currentValue / targetValue;
  return Math.abs(ratio - 1) <= TOLERANCE ? current : Math.ceil(current * ratio);
}
