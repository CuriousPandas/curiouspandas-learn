// The Network Lab's logic, with no DOM: flooding under RFC 789's LATER rule,
// traversals and shortest paths stepped event by event, and build order with a
// cycle either refused (as Python's graphlib does) or dropped (as GNU make's
// source says it does). tests/network.test.ts holds each of these to real Python.

// ---------- The ARPANET failure (RFC 789) ----------

/**
 * Rosen's definition, with the comparison treating sequence numbers as plain
 * 6-bit numbers. `strict` is his fix: `<` where the original had `<=`.
 * Neither direction is true when n and m are exactly 32 apart under the fix, so
 * this is deliberately not a comparison you could sort with.
 */
export function later(n: number, m: number, strict = false): boolean {
  if (n > m) return strict ? n - m < 32 : n - m <= 32;
  if (n < m) return m - n > 32;
  return false;
}

/** How many of a stream of arrivals one IMP accepts. The report's 30,000 row. */
export function accepted(arrivals: number[], strict = false): number {
  let stored: number | null = null, count = 0;
  for (const u of arrivals) if (stored === null || later(u, stored, strict)) { stored = u; count++; }
  return count;
}

export type Link = readonly [number, number];
// Invented for the lab: six IMPs, and a shape with loops in it. This is not
// ARPANET's map, and a tree here would hide the failure's route back to itself.
export const IMPS = ['A', 'B', 'C', 'D', 'E', 'F'];
export const LINKS: Link[] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [1, 4]];
export const BUFFERS = 8;
// The order Rosen found them queued in. The order matters: in this model the same
// three numbers in any order that isn't the cycle's die out within ten ticks.
export const REAL_SEQS = [8, 40, 44];
export const OTHER_ORDER_SEQS = [44, 40, 8];
// Not from RFC 789: three numbers spaced around the 64, which still form a cycle
// after the fix. They are why Rosen would not promise "no related problems".
export const INVENTED_SEQS = [0, 20, 40];

type Msg = { seq: number };

/**
 * One tick: every IMP handles one queued update (its CPU is the bottleneck, as
 * in the core dumps Rosen describes), and whatever it accepts goes to all its
 * neighbours, including the sender, arriving next tick. A full buffer loses the
 * update. RFC 789 doesn't give buffer counts, so 8 and one-per-tick are the lab's.
 */
export class FloodNet {
  readonly adj: number[][];
  queues: Msg[][];
  stored: (number | null)[];
  strict = false;
  ticks = 0;
  handled = 0; accepted = 0; discarded = 0; dropped = 0;

  readonly size: number;

  constructor(size = IMPS.length, links: Link[] = LINKS) {
    this.size = size;
    this.adj = Array.from({ length: size }, () => []);
    for (const [a, b] of links) { this.adj[a].push(b); this.adj[b].push(a); }
    this.queues = Array.from({ length: size }, () => []);
    this.stored = Array(size).fill(null);
  }

  get inFlight() { return this.queues.reduce((n, q) => n + q.length, 0); }
  get alive() { return this.inFlight > 0; }
  /** IMPs with no free buffer: the state in which, per RFC 789, HELLOs get lost and lines go down. */
  get fullImps() { return this.queues.filter((q) => q.length >= BUFFERS).length; }

  private deliver(to: number, seq: number) {
    if (this.queues[to].length >= BUFFERS) { this.dropped++; return; }
    this.queues[to].push({ seq });
  }

  /** The malfunction: one IMP puts these out, as if retransmitting one update with dropped bits. */
  inject(at: number, seqs: number[]) { for (const seq of seqs) this.deliver(at, seq); }

  tick() {
    const sends: [number, number][] = [];
    for (let i = 0; i < this.size; i++) {
      const m = this.queues[i].shift();
      if (!m) continue;
      this.handled++;
      const cur = this.stored[i];
      if (cur === null || later(m.seq, cur, this.strict)) {
        this.stored[i] = m.seq;
        this.accepted++;
        for (const n of this.adj[i]) sends.push([n, m.seq]);
      } else this.discarded++;
    }
    for (const [to, seq] of sends) this.deliver(to, seq);
    this.ticks++;
  }

  run(n: number) { for (let i = 0; i < n; i++) this.tick(); }

  restart(i: number) { this.queues[i] = []; this.stored[i] = null; }
  restartAll() { for (let i = 0; i < this.size; i++) this.restart(i); }
}

// ---------- Graphs ----------

export type Edge = { from: string; to: string; w: number };
export type Graph = { nodes: string[]; edges: Edge[]; directed: boolean };

export const out = (g: Graph, n: string): Edge[] => {
  const own = g.edges.filter((e) => e.from === n);
  if (g.directed) return own;
  return [...own, ...g.edges.filter((e) => e.to === n).map((e) => ({ from: n, to: e.from, w: e.w }))];
};

/** The same graph in the two standard shapes. The lesson's point is what each costs to hold. */
export function adjacencyList(g: Graph): Record<string, string[]> {
  return Object.fromEntries(g.nodes.map((n) => [n, out(g, n).map((e) => e.to)]));
}
export function adjacencyMatrix(g: Graph): number[][] {
  return g.nodes.map((a) => g.nodes.map((b) => (out(g, a).some((e) => e.to === b) ? 1 : 0)));
}

export type TraversalStep = { visit: string; waiting: string[]; seen: string[]; order: string[] };

/**
 * A queue gives breadth-first and a stack gives depth-first. It really is the one
 * line, so both go through the same loop rather than being two functions that
 * could quietly disagree about how they mark nodes as seen.
 */
export function traverse(g: Graph, start: string, kind: 'bfs' | 'dfs'): TraversalStep[] {
  const steps: TraversalStep[] = [], order: string[] = [];
  const seen = new Set<string>(), waiting = [start];
  while (waiting.length) {
    const visit = kind === 'bfs' ? waiting.shift()! : waiting.pop()!;
    if (seen.has(visit)) continue;
    seen.add(visit);
    order.push(visit);
    for (const e of out(g, visit)) if (!seen.has(e.to)) waiting.push(e.to);
    steps.push({ visit, waiting: [...waiting], seen: [...seen], order: [...order] });
  }
  return steps;
}

export const reachable = (g: Graph, start: string): string[] => traverse(g, start, 'bfs').at(-1)?.order ?? [];

/** Fewest edges from start, which is what breadth-first search gives and depth-first does not. */
export function hops(g: Graph, start: string): Record<string, number> {
  const d: Record<string, number> = { [start]: 0 }, q = [start];
  while (q.length) {
    const u = q.shift()!;
    for (const e of out(g, u)) if (!(e.to in d)) { d[e.to] = d[u] + 1; q.push(e.to); }
  }
  return d;
}

// ---------- Shortest paths ----------

export type Dist = Record<string, number>;
export type PathStep = { settle: string; dist: Dist; note: string };
export type PathRun = { dist: Dist; steps: PathStep[]; relaxations: number; pushes: number; negativeCycle?: boolean };

/**
 * `settled` is the textbook form: once a node is taken it is never looked at
 * again. That line is what makes it wrong on negative edges, with no error.
 * `reinsert` is Erickson's form: any improvement puts the node back. Same code
 * apart from that, so the difference on screen is that one rule.
 * Both take the smallest known distance by scanning, as Dijkstra's paper does.
 */
export function dijkstra(g: Graph, start: string, form: 'settled' | 'reinsert' = 'settled', maxSteps = 200_000): PathRun {
  const dist: Dist = { [start]: 0 }, done = new Set<string>(), open = new Set([start]), steps: PathStep[] = [];
  let relaxations = 0, pushes = 1;
  while (open.size) {
    if (steps.length >= maxSteps) throw new Error(`dijkstra: over ${maxSteps} steps; a negative cycle has no shortest path`);
    let u = '';
    for (const n of open) if (u === '' || dist[n] < dist[u]) u = n;
    open.delete(u);
    done.add(u);
    const changed: string[] = [];
    for (const e of out(g, u)) {
      if (form === 'settled' && done.has(e.to)) continue;
      const nd = dist[u] + e.w;
      if (!(e.to in dist) || nd < dist[e.to]) {
        dist[e.to] = nd;
        relaxations++;
        changed.push(e.to);
        if (!open.has(e.to)) { open.add(e.to); pushes++; }
      }
    }
    steps.push({ settle: u, dist: { ...dist }, note: changed.length ? `improved ${changed.join(', ')}` : 'nothing improved' });
  }
  return { dist, steps, relaxations, pushes };
}

/** Relax every edge, V-1 times. It needs no assumption about signs, so it is the check on the others. */
export function bellmanFord(g: Graph, start: string): PathRun {
  const dist: Dist = { [start]: 0 }, steps: PathStep[] = [];
  const edges = g.nodes.flatMap((n) => out(g, n));
  let relaxations = 0;
  for (let round = 1; round < g.nodes.length; round++) {
    let any = false;
    for (const e of edges) {
      if (!(e.from in dist)) continue;
      const nd = dist[e.from] + e.w;
      if (!(e.to in dist) || nd < dist[e.to]) { dist[e.to] = nd; relaxations++; any = true; }
    }
    steps.push({ settle: `round ${round}`, dist: { ...dist }, note: any ? 'something improved' : 'nothing changed, so stop' });
    if (!any) break;
  }
  const negativeCycle = edges.some((e) => e.from in dist && (!(e.to in dist) || dist[e.from] + e.w < dist[e.to]));
  return { dist, steps, relaxations, pushes: 0, negativeCycle };
}

// With b -> a at -2 this is the counterexample from the sources report, measured
// there against heapq. It starts at +2, so the lesson can show it working first.
export const NEGATIVE: Graph = { directed: true, nodes: ['s', 'a', 'b', 't'], edges: [
  { from: 's', to: 'a', w: 2 }, { from: 's', to: 'b', w: 3 }, { from: 'b', to: 'a', w: 2 }, { from: 'a', to: 't', w: 1 },
] };

export const MAP: Graph = { directed: false, nodes: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], edges: [
  { from: 'A', to: 'B', w: 4 }, { from: 'A', to: 'C', w: 1 }, { from: 'C', to: 'B', w: 2 }, { from: 'B', to: 'D', w: 5 },
  { from: 'C', to: 'E', w: 7 }, { from: 'D', to: 'E', w: 1 }, { from: 'F', to: 'G', w: 3 },
] };

// ---------- Build order ----------

export type Deps = Record<string, string[]>;
export type BuildResult = { order: string[]; cycle?: string[]; dropped: [string, string][]; broken: [string, string][] };

/**
 * `raise` refuses a cycle, as graphlib's CycleError does. `drop` carries on when
 * it meets something already in progress and loses that one dependency, which is
 * what make's src/remake.c says it does ("circular %s <- %s dependency dropped").
 * The drop mode is modelled from that source: make itself was never run here.
 */
export function buildOrder(deps: Deps, mode: 'raise' | 'drop'): BuildResult {
  const state = new Map<string, 'active' | 'done'>(), order: string[] = [], dropped: [string, string][] = [], stack: string[] = [];
  let cycle: string[] | undefined;
  const visit = (n: string) => {
    state.set(n, 'active');
    stack.push(n);
    for (const d of deps[n] ?? []) {
      const s = state.get(d);
      if (s === 'done') continue;
      if (s === 'active') {
        if (mode === 'raise') { cycle ??= [...stack.slice(stack.indexOf(d)), d]; continue; }
        dropped.push([n, d]);
        continue;
      }
      visit(d);
    }
    stack.pop();
    state.set(n, 'done');
    order.push(n);
  };
  for (const n of Object.keys(deps)) if (!state.has(n)) visit(n);
  if (cycle) return { order: [], cycle, dropped: [], broken: [] };
  const at = new Map(order.map((n, i) => [n, i]));
  const broken: [string, string][] = [];
  for (const [n, ds] of Object.entries(deps)) for (const d of ds) if ((at.get(d) ?? -1) > (at.get(n) ?? -1)) broken.push([n, d]);
  return { order, dropped, broken };
}

export const BUILD_DEPS: Deps = { app: ['lib', 'log'], lib: ['core'], log: ['core'], core: [] };
export const CYCLE_EDGE: [string, string] = ['core', 'app'];

// ---------- What the lab's two missions judge ----------

export type RouteRun = { algo: 'bfs' | 'dfs' | 'dijkstra' | 'bellman-ford'; start: string; graph: 'map' | 'negative'; weights: string; hasNegative: boolean; order?: string[]; dist?: Dist };

const sameSeqs = (a: number[] | null, b: number[]) => !!a && a.join() === b.join();

/**
 * Everything the missions look at, kept outside the DOM so tests/network.test.ts
 * can play them, including the shortcuts that must not pass.
 */
export class NetworkLab {
  net = new FloodNet();
  injected: number[] | null = null;
  sinceInject = 0;
  restartedAll = false;
  strictAtInject = false;
  // Sticky: the mission's steps are re-checked on every redraw and shown in order,
  // so an earlier step must stay true once earned.
  sawFloodPersist = false;
  sawReinfection = false;
  sawFixEndIt = false;
  sawFixBroken = false;
  private restarted: number | null = null;
  routes: RouteRun[] = [];
  builds: { cycle: boolean; mode: 'raise' | 'drop'; result: BuildResult }[] = [];
  weights: Record<string, number> = {};

  inject(seqs: number[], at = 0) {
    this.net.inject(at, seqs);
    this.injected = seqs;
    this.sinceInject = 0;
    this.restartedAll = false;
    this.strictAtInject = this.net.strict;
    this.restarted = null;
  }

  /** Runs and only then updates what was seen, so nothing counts until it has actually happened. */
  run(n: number) {
    const before = this.net.alive;
    this.net.run(n);
    if (!this.injected) return;
    if (before) this.sinceInject += n;
    const net = this.net, real = sameSeqs(this.injected, REAL_SEQS), invented = sameSeqs(this.injected, INVENTED_SEQS);
    if (real && !net.strict && net.alive && this.sinceInject >= 100) this.sawFloodPersist = true;
    if (this.restarted !== null && net.alive && net.stored[this.restarted] !== null) { this.sawReinfection = true; this.restarted = null; }
    // Restart-all empties every queue, so an empty network after one says nothing
    // about the fix. RFC 789 says that does clear it, and also doesn't stop a repeat.
    if (real && net.strict && !net.alive && !this.restartedAll && this.sinceInject > 0) this.sawFixEndIt = true;
    if (invented && net.strict && this.strictAtInject && net.alive && this.sinceInject >= 100) this.sawFixBroken = true;
  }

  restart(i: number) {
    this.net.restart(i);
    // Restarting the only IMP holding anything proves nothing about re-infection.
    this.restarted = this.net.alive ? i : null;
  }
  restartAll() { this.net.restartAll(); this.restartedAll = true; this.restarted = null; }
  setStrict(on: boolean) { this.net.strict = on; }
  resetFlood() {
    const strict = this.net.strict;
    this.net = new FloodNet();
    this.net.strict = strict;
    this.injected = null;
    this.sinceInject = 0;
    this.restartedAll = false;
    this.restarted = null;
  }

  negative(): Graph {
    return { ...NEGATIVE, edges: NEGATIVE.edges.map((e) => ({ ...e, w: this.weights[`${e.from}-${e.to}`] ?? e.w })) };
  }
  setWeight(from: string, to: string, w: number) { this.weights[`${from}-${to}`] = w; }

  route(algo: RouteRun['algo'], graphName: 'map' | 'negative', start: string): RouteRun {
    const g = graphName === 'map' ? MAP : this.negative();
    const base = { algo, start, graph: graphName, weights: g.edges.map((e) => e.w).join(), hasNegative: g.edges.some((e) => e.w < 0) };
    const r: RouteRun = algo === 'bfs' || algo === 'dfs'
      ? { ...base, order: traverse(g, start, algo).at(-1)?.order ?? [] }
      : { ...base, dist: (algo === 'dijkstra' ? dijkstra(g, start) : bellmanFord(g, start)).dist };
    this.routes.push(r);
    return r;
  }

  build(withCycle: boolean, mode: 'raise' | 'drop') {
    const deps: Deps = Object.fromEntries(Object.entries(BUILD_DEPS).map(([k, v]) => [k, [...v]]));
    if (withCycle) deps[CYCLE_EDGE[0]].push(CYCLE_EDGE[1]);
    const result = buildOrder(deps, mode);
    this.builds.push({ cycle: withCycle, mode, result });
    return result;
  }
}
