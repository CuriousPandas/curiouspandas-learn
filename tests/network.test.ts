// The Network Lab, held to real Python: RFC 789's rule and a re-implementation of
// the flood, graphlib for build order, heapq and Bellman-Ford for shortest paths.
// Fails rather than skips when Python is missing: a parity test that skips quietly
// reads as parity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { MinHeap } from '../src/lib/cs/trees.ts';
import { FloodNet, LINKS, IMPS, BUFFERS, REAL_SEQS, OTHER_ORDER_SEQS, INVENTED_SEQS, MAP, NEGATIVE, BUILD_DEPS, NetworkLab, later, accepted, adjacencyList, adjacencyMatrix, bellmanFord, buildOrder, dijkstra, hops, out, reachable, traverse, type Deps, type Graph } from '../src/lib/cs/network.ts';
import { NETWORK_GRAPHS_MISSION, NETWORK_PATHS_MISSION } from '../src/lib/cs/network-missions.ts';

function findPython(): string {
  for (const c of ['python3', 'python']) {
    const r = spawnSync(c, ['-c', 'import graphlib, heapq; print(1)'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '1') return c;
  }
  throw new Error('No Python 3 with graphlib found; these tests compare against the real thing and cannot pass without it');
}
const PY = findPython();
function py(src: string, input?: unknown): any {
  const r = spawnSync(PY, ['-I', '-X', 'utf8', '-c', src], { encoding: 'utf8', input: JSON.stringify(input ?? null), maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// A small seeded generator, so a failure here can be replayed exactly.
function rng(seed: number) { let s = seed >>> 0; return (n: number) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; }; }

test('LATER follows RFC 789 for all 64 x 64 pairs, both rules, against Python', () => {
  const real: boolean[][][] = py(`
import json
def later(n, m, strict):
    if n > m:
        return n - m < 32 if strict else n - m <= 32
    return n < m and m - n > 32
print(json.dumps([[[later(n, m, s) for m in range(64)] for n in range(64)] for s in (False, True)]))`);
  for (const [i, strict] of [false, true].entries()) for (let n = 0; n < 64; n++) for (let m = 0; m < 64; m++) assert.equal(later(n, m, strict), real[i][n][m], `${n},${m},${strict}`);
});

test('the three numbers form the cycle Rosen describes, and his fix breaks it: the report\'s table', () => {
  assert.ok(later(44, 40) && later(40, 8) && later(8, 44) && !later(8, 40));
  assert.ok(later(44, 40, true) && !later(40, 8, true) && later(8, 44, true) && !later(8, 40, true));
  const arrivals = Array.from({ length: 30000 }, (_, i) => [8, 40, 44][i % 3]);
  assert.equal(accepted(arrivals), 30000);
  assert.equal(accepted(arrivals, true), 1);
});

test('Rosen was right not to promise: the fix ends every dropped-bit chain, and cycles remain', () => {
  // The lesson states these three numbers. Python computes them independently.
  const real: number[] = py(`
import itertools, json
def later(n, m, strict):
    if n > m:
        return n - m < 32 if strict else n - m <= 32
    return n < m and m - n > 32
def cyc(t, strict):
    a, b, c = t
    return (later(b,a,strict) and later(c,b,strict) and later(a,c,strict)) or (later(a,b,strict) and later(b,c,strict) and later(c,a,strict))
def chains(strict):
    found = set()
    for c in range(64):
        for b in range(64):
            if b & c == b and bin(c ^ b).count("1") == 1:
                for a in range(64):
                    if a & b == a and bin(b ^ a).count("1") == 1:
                        t = tuple(sorted((a, b, c)))
                        if cyc(t, strict): found.add(t)
    return len(found)
print(json.dumps([chains(False), chains(True), sum(cyc(t, True) for t in itertools.combinations(range(64), 3))]))`);
  assert.deepEqual(real, [160, 0, 9920]);
  assert.ok(later(20, 0, true) && later(40, 20, true) && later(0, 40, true), '0, 20, 40 still cycles under the fix');
});

const PY_FLOOD = `
import json, sys
spec = json.load(sys.stdin)
out = []
for seqs, strict, at, ticks in spec["runs"]:
    n = 6
    adj = [[] for _ in range(n)]
    for a, b in spec["links"]:
        adj[a].append(b); adj[b].append(a)
    q = [[] for _ in range(n)]
    stored = [None] * n
    handled = acc = disc = drop = 0
    for s in seqs:
        if len(q[at]) >= spec["buffers"]: drop += 1
        else: q[at].append(s)
    def later(a, b):
        if a > b: return a - b < 32 if strict else a - b <= 32
        return a < b and b - a > 32
    for _ in range(ticks):
        sends = []
        for i in range(n):
            if not q[i]: continue
            u = q[i].pop(0)
            handled += 1
            if stored[i] is None or later(u, stored[i]):
                stored[i] = u; acc += 1
                for k in adj[i]: sends.append((k, u))
            else: disc += 1
        for to, u in sends:
            if len(q[to]) >= spec["buffers"]: drop += 1
            else: q[to].append(u)
    out.append([handled, acc, disc, drop, stored, sum(len(x) for x in q)])
print(json.dumps(out))`;

test('the flood matches a separate Python implementation, count for count', () => {
  const runs: [number[], boolean, number, number][] = [];
  for (const seqs of [REAL_SEQS, OTHER_ORDER_SEQS, INVENTED_SEQS]) for (const strict of [false, true]) for (const at of [0, 3]) for (const t of [5, 40, 400]) runs.push([seqs, strict, at, t]);
  const real = py(PY_FLOOD, { runs, links: LINKS, buffers: BUFFERS });
  runs.forEach(([seqs, strict, at, t], i) => {
    const n = new FloodNet();
    n.strict = strict;
    n.inject(at, seqs);
    n.run(t);
    assert.deepEqual([n.handled, n.accepted, n.discarded, n.dropped, n.stored, n.inFlight], real[i], `${seqs} strict=${strict} at=${at} t=${t}`);
  });
});

test('flood behaviour the lesson states: never dies under <=, dies under <, order matters, 0-20-40 survives the fix', () => {
  const run = (seqs: number[], strict: boolean, at = 0) => { const n = new FloodNet(); n.strict = strict; n.inject(at, seqs); let t = 0; while (n.alive && t < 20000) { n.tick(); t++; } return { n, t }; };
  for (const at of IMPS.keys()) {
    const live = run(REAL_SEQS, false, at);
    assert.ok(live.n.alive, `IMP ${at}: should still be alive at 20,000 ticks`);
    const fixed = run(REAL_SEQS, true, at);
    assert.ok(!fixed.n.alive && fixed.t <= 10, `IMP ${at}: fix should end it in ten ticks, took ${fixed.t}`);
    const other = run(OTHER_ORDER_SEQS, false, at);
    assert.ok(!other.n.alive && other.t <= 10, `IMP ${at}: other order should die out, took ${other.t}`);
    assert.ok(run(INVENTED_SEQS, true, at).n.alive, `IMP ${at}: 0, 20, 40 should survive the fix`);
  }
  // Every buffer full: the state in which Rosen says HELLOs can't get a buffer.
  const n = new FloodNet();
  n.inject(0, REAL_SEQS);
  n.run(1000);
  assert.equal(n.fullImps, IMPS.length);
  assert.ok(n.dropped > 0);
});

test('restarting one IMP doesn\'t help and restarting all does, as RFC 789 says', () => {
  const n = new FloodNet();
  n.inject(0, REAL_SEQS);
  n.run(300);
  n.restart(2);
  assert.equal(n.stored[2], null);
  n.run(20);
  assert.notEqual(n.stored[2], null, 'its neighbours re-infect it');
  assert.ok(n.alive);
  n.restartAll();
  assert.ok(!n.alive);
  n.run(20);
  assert.ok(!n.alive, 'nothing regenerates it');
});

const randomGraph = (seed: number, neg: boolean): Graph => {
  const r = rng(seed), size = 4 + r(5), nodes = Array.from({ length: size }, (_, i) => `n${i}`), edges: Graph['edges'] = [];
  // Edges only run forward when negatives are allowed: no cycle can then be
  // negative, which is the only case where a shortest path is even defined.
  for (let a = 0; a < size; a++) for (let b = 0; b < size; b++) {
    if (a === b || (neg && b < a) || r(100) > 35) continue;
    edges.push({ from: nodes[a], to: nodes[b], w: neg ? r(15) - 6 : 1 + r(12) });
  }
  return { nodes, edges, directed: true };
};

const PY_PATHS = `
import heapq, json, sys
out = []
for g in json.load(sys.stdin):
    adj = {n: [] for n in g["nodes"]}
    for e in g["edges"]:
        adj[e["from"]].append((e["to"], e["w"]))
    s = g["nodes"][0]
    # The heapq form, settled set included.
    dist, done, heap = {s: 0}, set(), [(0, s)]
    while heap:
        d, u = heapq.heappop(heap)
        if u in done: continue
        done.add(u)
        for v, w in adj[u]:
            if v not in done and (v not in dist or d + w < dist[v]):
                dist[v] = d + w
                heapq.heappush(heap, (dist[v], v))
    bf = {s: 0}
    for _ in range(len(g["nodes"]) - 1):
        for e in g["edges"]:
            if e["from"] in bf and (e["to"] not in bf or bf[e["from"]] + e["w"] < bf[e["to"]]):
                bf[e["to"]] = bf[e["from"]] + e["w"]
    out.append([dist, bf])
print(json.dumps(out))`;

const sorted = (d: Record<string, number>) => Object.fromEntries(Object.entries(d).sort());

test('on 200 random non-negative graphs, every form agrees with heapq and Bellman-Ford', () => {
  const gs = Array.from({ length: 200 }, (_, i) => randomGraph(i + 1, false));
  const real = py(PY_PATHS, gs);
  gs.forEach((g, i) => {
    const s = g.nodes[0];
    assert.deepEqual(sorted(dijkstra(g, s).dist), sorted(real[i][0]));
    assert.deepEqual(sorted(dijkstra(g, s, 'reinsert').dist), sorted(real[i][0]));
    assert.deepEqual(sorted(bellmanFord(g, s).dist), sorted(real[i][1]));
    assert.deepEqual(real[i][0], real[i][0]);
  });
});

test('on 200 random graphs with negative edges, re-inserting stays right and the settled form goes wrong silently', () => {
  const gs = Array.from({ length: 200 }, (_, i) => randomGraph(i + 1000, true));
  const real = py(PY_PATHS, gs);
  let wrong = 0;
  gs.forEach((g, i) => {
    const s = g.nodes[0];
    assert.deepEqual(sorted(dijkstra(g, s, 'reinsert').dist), sorted(real[i][1]), 're-insert vs Python Bellman-Ford');
    assert.deepEqual(sorted(bellmanFord(g, s).dist), sorted(real[i][1]));
    assert.deepEqual(sorted(dijkstra(g, s).dist), sorted(real[i][0]), 'settled form matches heapq, wrong answers included');
    if (JSON.stringify(sorted(real[i][0])) !== JSON.stringify(sorted(real[i][1]))) wrong++;
  });
  // A check that passes because no graph ever exposed the bug would be worthless.
  assert.ok(wrong > 10, `only ${wrong} of 200 graphs exposed the bug`);
});

test('the report\'s counterexample, exactly', () => {
  const g: Graph = { ...NEGATIVE, edges: NEGATIVE.edges.map((e) => (e.from === 'b' ? { ...e, w: -2 } : e)) };
  const d = dijkstra(g, 's').dist;
  assert.deepEqual([d.a, d.t], [2, 3]);
  const r = dijkstra(g, 's', 'reinsert').dist;
  assert.deepEqual([r.a, r.t], [1, 2]);
  const b = bellmanFord(g, 's').dist;
  assert.deepEqual([b.a, b.t], [1, 2]);
  // With +2 it is an ordinary graph and everything agrees.
  assert.deepEqual(sorted(dijkstra(NEGATIVE, 's').dist), sorted(bellmanFord(NEGATIVE, 's').dist));
});

test('re-inserting can take exponentially many relaxations, as Erickson warns', () => {
  // Read from his figure (Shier and Witzgall's family): stages with a direct edge
  // and a two-edge way round, biggest stage first. Each later stage gets re-done
  // whenever an earlier one improves. The lesson states the k=14 count, for 29 nodes.
  const build = (k: number): Graph => {
    const nodes: string[] = ['v0'], edges: Graph['edges'] = [];
    for (let i = 0; i < k; i++) {
      const j = k - i, a = `v${i}`, m = `m${i}`, b = `v${i + 1}`;
      nodes.push(m, b);
      edges.push({ from: a, to: m, w: 0 }, { from: m, to: b, w: -(2 ** j) }, { from: a, to: b, w: -(2 ** (j - 1)) });
    }
    return { nodes, edges, directed: true };
  };
  assert.deepEqual([4, 6, 8, 10, 12, 14].map((k) => dijkstra(build(k), 'v0', 'reinsert').relaxations), [45, 189, 765, 3069, 12285, 49149]);
  // Still right, and the settled form on the same graph is quickly wrong.
  const g = build(8);
  assert.equal(g.nodes.length, 17);
  assert.deepEqual(sorted(dijkstra(g, 'v0', 'reinsert').dist), sorted(bellmanFord(g, 'v0').dist));
  assert.equal(dijkstra(g, 'v0', 'reinsert').dist.v8, -510);
  assert.equal(dijkstra(g, 'v0').dist.v8, -255);
  assert.ok(bellmanFord(build(14), 'v0').relaxations < 100, 'the lesson says under 100 at 14 stages');
});

test('the trees lesson promised shortest paths ran on its priority queue, and it scans: the promise is gone, and the saving is counted', () => {
  const read = (p: string) => readFileSync(p, 'utf8');
  // The lesson, its debrief and the code comment all said so. Nothing in that lesson's lab uses a heap.
  assert.doesNotMatch(read('src/lib/cs/network.ts'), /MinHeap|PriorityQueue/);
  assert.doesNotMatch(read('src/lib/cs/alg-strategies.ts'), /MinHeap|PriorityQueue/);
  assert.doesNotMatch(read('src/lib/cs/alg-missions.ts'), /shortest-paths lesson runs on/);
  assert.doesNotMatch(read('src/lib/cs/trees.ts'), /uses this as its priority queue/);
  assert.match(read('src/content/lessons/algorithms/trees-and-heaps.mdx'), /Its own code uses Dijkstra's plain scan/);
  // The numbers the shortest-paths lesson gives, on its grid, with every road the same length.
  const grid = (N: number) => {
    const key = (x: number, y: number) => `${x},${y}`, start = key((N - 1) / 2, (N - 1) / 2);
    const near = (k: string) => {
      const [x, y] = k.split(',').map(Number);
      return ([[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as [number, number][]).filter(([a, b]) => a >= 0 && a < N && b >= 0 && b < N).map(([a, b]) => key(a, b));
    };
    // The scan. `reads` is what the lesson's code does, going over every node in dist, and it's
    // added up rather than looped, since that loop is 800 million steps. `tidy` really does loop.
    const dist = new Map([[start, 0]]), open = new Set([start]), scanned = new Map<string, number>();
    let reads = 0, tidy = 0;
    while (open.size) {
      reads += dist.size;
      let u = '';
      for (const n of open) { tidy++; if (u === '' || dist.get(n)! < dist.get(u)!) u = n; }
      open.delete(u);
      scanned.set(u, dist.get(u)!);
      for (const v of near(u)) if (!dist.has(v)) { dist.set(v, dist.get(u)! + 1); open.add(v); }
    }
    // The heap, with an entry count and stale copies skipped, as the lesson describes. Its
    // comparison count is held to real heapq in tests/trees.test.ts.
    const h = new MinHeap<[number, number, string]>((a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]));
    const best = new Map([[start, 0]]), done = new Map<string, number>();
    let count = 0;
    h.push([0, count++, start]);
    while (h.size) {
      const [d, , u] = h.pop();
      if (done.has(u)) continue;
      done.set(u, d);
      for (const v of near(u)) if (!done.has(v) && (!best.has(v) || d + 1 < best.get(v)!)) { best.set(v, d + 1); h.push([d + 1, count++, v]); }
    }
    assert.deepEqual([...done.entries()].sort(), [...scanned.entries()].sort(), 'both find the same distances, or the comparison means nothing');
    return { nodes: done.size, reads, tidy, heap: h.comparisons };
  };
  const big = grid(201);
  assert.deepEqual(big, { nodes: 40401, reads: 826966801, tidy: 10866601, heap: 363749 });
  assert.ok(big.tidy / big.heap > 29 && big.tidy / big.heap < 31, 'about 30 times');
  assert.ok(big.reads / big.heap > 2000);
  const small = grid(51);
  assert.ok(small.reads / small.heap < big.reads / big.heap && small.tidy / small.heap < big.tidy / big.heap, 'the gap grows with the map');
  const lesson = read('src/content/lessons/algorithms/shortest-paths.mdx');
  for (const n of ['40,401', '826,966,801', '10,866,601', '363,749']) assert.ok(lesson.includes(n), n);
});

test('the lesson\'s grid: Dijkstra settles about 5,000 nodes for a route of 50 steps, because it spreads every way', () => {
  const r = py(`
import heapq, json
s, goal = (100, 100), (150, 100)
dist, done, heap, settled = {s: 0}, set(), [(0, s)], 0
while heap:
    d, u = heapq.heappop(heap)
    if u in done: continue
    done.add(u); settled += 1
    if u == goal: break
    x, y = u
    for v in ((x+1, y), (x-1, y), (x, y+1), (x, y-1)):
        if 0 <= v[0] <= 200 and 0 <= v[1] <= 200 and v not in done and (v not in dist or d + 1 < dist[v]):
            dist[v] = d + 1; heapq.heappush(heap, (d + 1, v))
print(json.dumps([settled, d]))`);
  assert.equal(r[1], 50, 'a route of 50 edges has 51 nodes');
  // Everything nearer than 50 steps has to be settled first: 2·49·50 + 1 = 4,901.
  // How many at exactly 50 go first depends on ties, up to all 5,101.
  assert.ok(r[0] > 4901 && r[0] <= 5101, `settled ${r[0]}`);
});

test('breadth-first gives fewest hops and depth-first does not; both reach the same set, and the island stays out', () => {
  const b = traverse(MAP, 'A', 'bfs').at(-1)!.order, d = traverse(MAP, 'A', 'dfs').at(-1)!.order;
  assert.notDeepEqual(b, d);
  assert.deepEqual([...b].sort(), [...d].sort());
  assert.deepEqual(reachable(MAP, 'A').sort(), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(reachable(MAP, 'F').sort(), ['F', 'G']);
  assert.equal(hops(MAP, 'A').B, 1);
  assert.equal(dijkstra(MAP, 'A').dist.B, 3, 'the one-hop route to B is longer than the two-hop one: fewest hops is not shortest');
});

test('traversals match Python\'s collections.deque and a list used as a stack', () => {
  const gs = Array.from({ length: 50 }, (_, i) => randomGraph(i + 500, false));
  const real = py(`
import json, sys
from collections import deque
out = []
for g in json.load(sys.stdin):
    adj = {n: [] for n in g["nodes"]}
    for e in g["edges"]:
        adj[e["from"]].append(e["to"])
    res = []
    for kind in ("bfs", "dfs"):
        seen, order, w = set(), [], deque([g["nodes"][0]])
        while w:
            n = w.popleft() if kind == "bfs" else w.pop()
            if n in seen: continue
            seen.add(n); order.append(n)
            for v in adj[n]:
                if v not in seen: w.append(v)
        res.append(order)
    out.append(res)
print(json.dumps(out))`, gs);
  gs.forEach((g, i) => {
    assert.deepEqual(traverse(g, g.nodes[0], 'bfs').at(-1)!.order, real[i][0]);
    assert.deepEqual(traverse(g, g.nodes[0], 'dfs').at(-1)!.order, real[i][1]);
  });
});

test('the two representations describe the same graph, and the matrix is the bigger one here', () => {
  const list = adjacencyList(MAP), matrix = adjacencyMatrix(MAP);
  MAP.nodes.forEach((a, i) => MAP.nodes.forEach((b, j) => assert.equal(matrix[i][j] === 1, list[a].includes(b), `${a}-${b}`)));
  const entries = MAP.nodes.reduce((c, n) => c + out(MAP, n).length, 0);
  assert.equal(entries, MAP.edges.length * 2, 'an undirected edge is listed from both ends');
  assert.ok(entries < MAP.nodes.length ** 2);
});

const PY_GRAPHLIB = `
import graphlib, json, sys
out = []
for deps in json.load(sys.stdin):
    try:
        out.append({"order": list(graphlib.TopologicalSorter(deps).static_order())})
    except graphlib.CycleError as e:
        out.append({"cycle": e.args[1]})
print(json.dumps(out))`;

test('build order against graphlib on 300 random graphs: same verdict, every edge respected, real cycles', () => {
  const cases: Deps[] = [BUILD_DEPS, { app: ['lib'], lib: ['core'], core: ['app'] }];
  for (let s = 1; s <= 300; s++) {
    const r = rng(s * 7), size = 3 + r(6), names = Array.from({ length: size }, (_, i) => `t${i}`), d: Deps = {};
    for (const n of names) d[n] = names.filter((m) => m !== n && r(100) < 18);
    cases.push(d);
  }
  const real = py(PY_GRAPHLIB, cases);
  let cycles = 0, clean = 0;
  cases.forEach((d, i) => {
    const mine = buildOrder(d, 'raise');
    assert.equal(!!mine.cycle, !!real[i].cycle, `verdict differs on ${JSON.stringify(d)}`);
    if (mine.cycle) {
      cycles++;
      // A valid cycle may be reported from a different starting node than Python's,
      // so what's checked is that it really is one.
      assert.equal(mine.cycle[0], mine.cycle.at(-1));
      for (let k = 0; k + 1 < mine.cycle.length; k++) assert.ok(d[mine.cycle[k]].includes(mine.cycle[k + 1]), `${mine.cycle} is not a cycle in ${JSON.stringify(d)}`);
    } else {
      clean++;
      const at = new Map(mine.order.map((n, k) => [n, k]));
      for (const [n, ds] of Object.entries(d)) for (const m of ds) assert.ok(at.get(m)! < at.get(n)!, `${n} built before ${m}`);
      assert.equal(mine.order.length, Object.keys(d).length);
      assert.equal(mine.broken.length, 0);
      // Python's order is valid too, and needn't be the same list. Test the property.
      const pa = new Map<string, number>(real[i].order.map((n: string, k: number) => [n, k]));
      for (const [n, ds] of Object.entries(d)) for (const m of ds) assert.ok(pa.get(m)! < pa.get(n)!);
    }
  });
  assert.ok(cycles > 30 && clean > 30, `need both kinds: ${cycles} cycles, ${clean} clean`);
});

test('drop mode carries on, builds everything, and leaves an edge visibly broken', () => {
  const r = buildOrder({ app: ['lib'], lib: ['core'], core: ['app'] }, 'drop');
  assert.equal(r.cycle, undefined);
  assert.deepEqual(r.dropped, [['core', 'app']]);
  assert.equal(r.order.length, 3);
  assert.deepEqual(r.broken, [['core', 'app']]);
  assert.deepEqual(r.order, ['core', 'lib', 'app']);
  assert.ok(buildOrder({ app: ['lib'], lib: ['core'], core: ['app'] }, 'raise').cycle);
});

// ---------- The missions, played ----------

const playGraphs = () => {
  const s = NETWORK_GRAPHS_MISSION.setup(), l = s.lab;
  const steps = NETWORK_GRAPHS_MISSION.steps;
  assert.ok(!steps.some((st) => st.done(s)), 'no step is born done');
  l.inject(REAL_SEQS); l.run(100);
  assert.ok(steps[0].done(s));
  l.restart(2); l.run(10);
  assert.ok(steps[1].done(s));
  l.resetFlood(); l.setStrict(true); l.inject(REAL_SEQS); l.run(100);
  assert.ok(steps[2].done(s));
  l.resetFlood(); l.inject(INVENTED_SEQS); l.run(100);
  assert.ok(steps[3].done(s));
  l.route('bfs', 'map', 'A'); l.route('dfs', 'map', 'A');
  assert.ok(steps[4].done(s));
  l.build(true, 'raise'); l.build(true, 'drop');
  assert.ok(steps[5].done(s));
  assert.ok(steps.every((st) => st.done(s)), 'earlier steps stay done');
};
test('the graphs mission can be finished from its hints, and its steps stay done', playGraphs);

test('shortcuts don\'t pass the graphs mission', () => {
  const m = NETWORK_GRAPHS_MISSION.steps;
  // Running with nothing injected is a quiet network, not a tested one.
  let s = NETWORK_GRAPHS_MISSION.setup();
  s.lab.run(500);
  assert.ok(!m[0].done(s));
  // The other order dies out: not the failure.
  s = NETWORK_GRAPHS_MISSION.setup();
  s.lab.inject(OTHER_ORDER_SEQS); s.lab.run(100);
  assert.ok(!m[0].done(s));
  // Too short a run.
  s = NETWORK_GRAPHS_MISSION.setup();
  s.lab.inject(REAL_SEQS); s.lab.run(50);
  assert.ok(!m[0].done(s));
  // Restart-all empties the network without the fix, and with it, and proves nothing.
  s = NETWORK_GRAPHS_MISSION.setup();
  s.lab.inject(REAL_SEQS); s.lab.run(100); s.lab.restartAll(); s.lab.run(10);
  assert.ok(!m[2].done(s), 'restart-all with no fix');
  s = NETWORK_GRAPHS_MISSION.setup();
  s.lab.setStrict(true); s.lab.inject(REAL_SEQS); s.lab.restartAll(); s.lab.run(10);
  assert.ok(!m[2].done(s), 'restart-all with the fix on');
  // Restarting the only busy IMP before anything spread isn't re-infection.
  s = NETWORK_GRAPHS_MISSION.setup();
  s.lab.inject(REAL_SEQS); s.lab.restart(0); s.lab.run(10);
  assert.ok(!m[1].done(s));
  // The invented numbers without the fix on show nothing about the fix.
  s = NETWORK_GRAPHS_MISSION.setup();
  s.lab.inject(INVENTED_SEQS); s.lab.run(100);
  assert.ok(!m[3].done(s));
  // BFS and DFS from different starts reach different sets; it doesn't count.
  s = NETWORK_GRAPHS_MISSION.setup();
  s.lab.route('bfs', 'map', 'A'); s.lab.route('dfs', 'map', 'F');
  assert.ok(!m[4].done(s));
  // Only one build mode, or a graph with no cycle.
  s = NETWORK_GRAPHS_MISSION.setup();
  s.lab.build(true, 'raise'); s.lab.build(false, 'drop');
  assert.ok(!m[5].done(s));
});

test('the paths mission plays through, and doesn\'t pass on a positive graph or on one algorithm', () => {
  const m = NETWORK_PATHS_MISSION.steps;
  const s = NETWORK_PATHS_MISSION.setup(), l = s.lab;
  assert.ok(!m.some((st) => st.done(s)));
  l.route('dijkstra', 'negative', 's');
  assert.ok(!m[0].done(s), 'one algorithm is not a comparison');
  l.route('bellman-ford', 'negative', 's');
  assert.ok(m[0].done(s));
  assert.ok(!m[1].done(s) && !m[2].done(s), 'positive runs say nothing about negative edges');
  l.setWeight('b', 'a', -2);
  l.route('dijkstra', 'negative', 's');
  assert.ok(m[1].done(s) && !m[2].done(s));
  l.route('bellman-ford', 'negative', 's');
  assert.ok(m.every((st) => st.done(s)));
  // Comparing runs at two different lengths isn't a disagreement about one graph.
  const t = NETWORK_PATHS_MISSION.setup();
  t.lab.setWeight('b', 'a', -2); t.lab.route('dijkstra', 'negative', 's');
  t.lab.setWeight('b', 'a', -1); t.lab.route('bellman-ford', 'negative', 's');
  assert.ok(!m[2].done(t));
});

test('the lab records one route run as a fact about the lengths used', () => {
  const l = new NetworkLab();
  assert.equal(l.route('dijkstra', 'negative', 's').hasNegative, false);
  l.setWeight('b', 'a', -2);
  const r = l.route('dijkstra', 'negative', 's');
  assert.equal(r.hasNegative, true);
  assert.equal(r.dist!.t, 3);
});
