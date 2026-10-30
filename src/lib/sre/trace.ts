// A checkout service and its dependencies, as metrics, traces and logs would
// each describe it. One dependency (the tax service) is slow for 1 request in
// 20. Its average stays respectable, so a dashboard of averages points at
// nobody; the trace of a slow request points straight at it, and the trace id
// in the logs says why. (SRE book, ch. 4: "A simple average can obscure these
// tail latencies".)

export type Span = { id: string; parent: string | null; service: string; name: string; start: number; ms: number };
export type Trace = { traceId: string; spans: Span[]; total: number; slow: boolean };
export type LogLine = { ts: number; level: 'info' | 'warn' | 'error'; service: string; traceId: string; msg: string };

export const SERVICES = ['gateway', 'checkout', 'cart', 'pricing', 'tax', 'payments'] as const;
export type Service = (typeof SERVICES)[number];

// Deterministic, so the lesson, the tests and every learner see the same day.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const hex = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');

export function generate(count = 400, seed = 7): { traces: Trace[]; logs: LogLine[] } {
  const r = rng(seed);
  const traces: Trace[] = [], logs: LogLine[] = [];
  for (let i = 0; i < count; i++) {
    const traceId = hex(r, 32);
    const ts = i * 150;
    // The slow path: the tax service times out once and retries, for 1 in 20.
    const slow = i % 20 === 7;
    const jitter = () => Math.round(r() * 8);
    const cart = 22 + jitter();
    const taxMs = slow ? 2000 + Math.round(r() * 300) : 14 + jitter();
    const pricing = 9 + taxMs + jitter();
    const pay = 45 + jitter();
    const spans: Span[] = [];
    const add = (id: string, parent: string | null, service: Service, name: string, start: number, ms: number) => { spans.push({ id, parent, service, name, start, ms }); return start + ms; };
    // Checkout calls cart, then pricing (which calls tax), then payments, in order.
    let t = 4;
    t = add('s3', 's2', 'cart', 'GET /cart', t, cart) + 2;
    const pStart = t;
    add('s5', 's4', 'tax', 'GET /rate', pStart + 4, taxMs);
    t = add('s4', 's2', 'pricing', 'POST /quote', pStart, pricing) + 2;
    t = add('s6', 's2', 'payments', 'POST /charge', t, pay);
    const checkout = t + 3;
    add('s2', 's1', 'checkout', 'POST /checkout', 2, checkout - 2);
    const total = checkout + 2;
    add('s1', null, 'gateway', 'POST /api/checkout', 0, total);
    spans.sort((a, b) => a.start - b.start);
    traces.push({ traceId, spans, total, slow });

    logs.push({ ts, level: 'info', service: 'checkout', traceId, msg: 'checkout started' });
    if (slow) {
      logs.push({ ts: ts + 1004, level: 'warn', service: 'tax', traceId, msg: 'upstream rates-provider timed out after 1000ms, retrying (1/2)' });
      logs.push({ ts: ts + 2010, level: 'info', service: 'tax', traceId, msg: 'rates-provider answered on retry' });
    }
    logs.push({ ts: ts + total, level: 'info', service: 'checkout', traceId, msg: `checkout complete in ${total}ms` });
  }
  return { traces, logs };
}

/** Per-service latency the way a dashboard aggregates it. */
export function serviceStats(traces: Trace[]) {
  const by = new Map<string, number[]>();
  for (const t of traces) for (const s of t.spans) (by.get(s.service) ?? by.set(s.service, []).get(s.service)!).push(s.ms);
  const pct = (xs: number[], p: number) => { const v = [...xs].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]; };
  return SERVICES.map((service) => {
    const xs = by.get(service) ?? [];
    return { service, avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), p50: pct(xs, 50), p99: pct(xs, 99) };
  });
}

/** The span that spent the most time on its own, not waiting for children:
 *  a parent is slow whenever any child is, so the culprit is the deepest one. */
export function selfTime(trace: Trace): { service: string; ms: number }[] {
  return trace.spans.map((s) => {
    const kids = trace.spans.filter((c) => c.parent === s.id).reduce((a, c) => a + c.ms, 0);
    return { service: s.service, ms: s.ms - kids };
  }).sort((a, b) => b.ms - a.ms);
}

/** Time series cost of a metric: one series per combination of label values
 *  (Prometheus docs: "every unique combination of key-value label pairs
 *  represents a new time series"). */
export function seriesCount(labelValues: number[]): number {
  return labelValues.reduce((a, b) => a * b, 1);
}
