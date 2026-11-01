// The Tree Shaper's logic: one stream of keys through a plain binary search tree,
// a red-black tree, a B-tree and a binary heap, with every comparison counted.
// tests/trees.test.ts holds them to exact formulas and to real Python's heapq.
//
// Everything here walks with loops, not recursion, because a degenerate tree is
// the point: a recursive walk would overflow on the very shape being shown.

import type { Mission } from '../missions.ts';
import { Lcg } from './sorting.ts';

export type Order = 'sorted' | 'shuffled' | 'nearly';

export function keyStream(n: number, order: Order, seed = 1): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  const r = new Lcg(seed);
  if (order === 'shuffled') for (let i = n - 1; i > 0; i--) { const j = r.next(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  // About one neighbouring pair in twenty is swapped: the way a feed that is
  // "basically in order" really looks. It behaves almost as badly as sorted.
  if (order === 'nearly') for (let i = 0; i + 1 < n; i += 2) if (r.next(20) === 0) [a[i], a[i + 1]] = [a[i + 1], a[i]];
  return a;
}

/** Where each node sits, for drawing: x is its rank in key order, y is its depth. */
export type Shape = { edges: [number, number, number, number][]; height: number; nodes: number };

type BNode = { key: number; left: BNode | null; right: BNode | null };

export class BST {
  root: BNode | null = null;
  comparisons = 0;
  size = 0;

  insert(key: number) {
    const fresh: BNode = { key, left: null, right: null };
    this.size++;
    if (!this.root) { this.root = fresh; return; }
    for (let at = this.root; ;) {
      this.comparisons++;
      if (key < at.key) { if (!at.left) { at.left = fresh; return; } at = at.left; }
      else { if (!at.right) { at.right = fresh; return; } at = at.right; }
    }
  }

  get height() { return heightOf(this.root); }
  shape(): Shape { return shapeOf(this.root, this.size); }
}

/** Edges of a tree, the longest root-to-leaf path counted in edges, as Sen & Tarjan count it (an empty tree is -1). */
function heightOf(root: { left: any; right: any } | null): number {
  if (!root) return -1;
  let h = -1;
  const stack: [any, number][] = [[root, 0]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (d > h) h = d;
    if (x.left) stack.push([x.left, d + 1]);
    if (x.right) stack.push([x.right, d + 1]);
  }
  return h;
}

function shapeOf(root: { key: number; left: any; right: any } | null, nodes: number): Shape {
  const edges: Shape['edges'] = [];
  if (!root) return { edges, height: -1, nodes: 0 };
  // In-order walk gives each node's x; a stack keeps it safe on a 4,000-long chain.
  const pos = new Map<any, [number, number]>();
  const stack: [any, number][] = [];
  let x = 0, cur: any = root, d = 0, height = 0;
  while (cur || stack.length) {
    while (cur) { stack.push([cur, d]); cur = cur.left; d++; }
    const [n, depth] = stack.pop()!;
    pos.set(n, [x++, depth]);
    if (depth > height) height = depth;
    cur = n.right; d = depth + 1;
  }
  for (const [n, [nx, ny]] of pos) {
    for (const c of [n.left, n.right]) if (c) { const [cx, cy] = pos.get(c)!; edges.push([nx, ny, cx, cy]); }
  }
  return { edges, height, nodes };
}

// ---- red-black tree -----------------------------------------------------------

const RED = 0, BLACK = 1;
type RB = { key: number; color: number; left: RB | null; right: RB | null; parent: RB | null };

/**
 * Standard bottom-up red-black insertion. Deletion is the textbook's when rebalance
 * is on, and with it off is a plain binary-search-tree delete that leaves the
 * colours as they were: Sen & Tarjan's vendor, as they tell it.
 */
export class RedBlack {
  root: RB | null = null;
  comparisons = 0;
  size = 0;
  rebalanceDeletes: boolean;

  constructor(rebalanceDeletes = true) { this.rebalanceDeletes = rebalanceDeletes; }

  get height() { return heightOf(this.root); }
  shape(): Shape { return shapeOf(this.root, this.size); }

  private rotateLeft(x: RB) {
    const y = x.right!;
    x.right = y.left;
    if (y.left) y.left.parent = x;
    y.parent = x.parent;
    if (!x.parent) this.root = y; else if (x === x.parent.left) x.parent.left = y; else x.parent.right = y;
    y.left = x; x.parent = y;
  }

  private rotateRight(x: RB) {
    const y = x.left!;
    x.left = y.right;
    if (y.right) y.right.parent = x;
    y.parent = x.parent;
    if (!x.parent) this.root = y; else if (x === x.parent.right) x.parent.right = y; else x.parent.left = y;
    y.right = x; x.parent = y;
  }

  insert(key: number) {
    const z: RB = { key, color: RED, left: null, right: null, parent: null };
    let y: RB | null = null, x = this.root;
    while (x) {
      y = x;
      this.comparisons++;
      x = key < x.key ? x.left : x.right;
    }
    z.parent = y;
    if (!y) this.root = z; else if (key < y.key) y.left = z; else y.right = z;
    this.size++;
    this.fixInsert(z);
  }

  private fixInsert(start: RB) {
    let z = start;
    while (z.parent && z.parent.color === RED) {
      const p = z.parent, g = p.parent!;
      if (p === g.left) {
        const u = g.right;
        if (u && u.color === RED) { p.color = BLACK; u.color = BLACK; g.color = RED; z = g; continue; }
        if (z === p.right) { z = p; this.rotateLeft(z); }
        z.parent!.color = BLACK; g.color = RED; this.rotateRight(g);
      } else {
        const u = g.left;
        if (u && u.color === RED) { p.color = BLACK; u.color = BLACK; g.color = RED; z = g; continue; }
        if (z === p.left) { z = p; this.rotateRight(z); }
        z.parent!.color = BLACK; g.color = RED; this.rotateLeft(g);
      }
    }
    this.root!.color = BLACK;
  }

  private find(key: number): RB | null {
    let x = this.root;
    while (x && x.key !== key) { this.comparisons++; x = key < x.key ? x.left : x.right; }
    return x;
  }

  private transplant(u: RB, v: RB | null) {
    if (!u.parent) this.root = v; else if (u === u.parent.left) u.parent.left = v; else u.parent.right = v;
    if (v) v.parent = u.parent;
  }

  delete(key: number): boolean {
    const z = this.find(key);
    if (!z) return false;
    this.size--;
    let y = z, removed = y.color, x: RB | null, xParent: RB | null;
    if (!z.left) { x = z.right; xParent = z.parent; this.transplant(z, z.right); }
    else if (!z.right) { x = z.left; xParent = z.parent; this.transplant(z, z.left); }
    else {
      y = z.right;
      while (y.left) y = y.left;
      removed = y.color;
      x = y.right;
      if (y.parent === z) xParent = y;
      else {
        xParent = y.parent;
        this.transplant(y, y.right);
        y.right = z.right; y.right!.parent = y;
      }
      this.transplant(z, y);
      y.left = z.left; y.left!.parent = y;
      y.color = z.color;
    }
    if (this.rebalanceDeletes && removed === BLACK) this.fixDelete(x, xParent);
    // Even a tree skipping repairs keeps a black root: insertion's repair assumes
    // one, and without this the skipped repair would crash, not quietly degrade.
    if (this.root) this.root.color = BLACK;
    return true;
  }

  private fixDelete(start: RB | null, startParent: RB | null) {
    let x = start, p = startParent;
    const black = (n: RB | null) => !n || n.color === BLACK;
    while (x !== this.root && black(x)) {
      if (x === p!.left) {
        let w = p!.right!;
        if (w.color === RED) { w.color = BLACK; p!.color = RED; this.rotateLeft(p!); w = p!.right!; }
        if (black(w.left) && black(w.right)) { w.color = RED; x = p; p = x!.parent; }
        else {
          if (black(w.right)) { w.left!.color = BLACK; w.color = RED; this.rotateRight(w); w = p!.right!; }
          w.color = p!.color; p!.color = BLACK; w.right!.color = BLACK; this.rotateLeft(p!); x = this.root;
        }
      } else {
        let w = p!.left!;
        if (w.color === RED) { w.color = BLACK; p!.color = RED; this.rotateRight(p!); w = p!.left!; }
        if (black(w.right) && black(w.left)) { w.color = RED; x = p; p = x!.parent; }
        else {
          if (black(w.left)) { w.right!.color = BLACK; w.color = RED; this.rotateLeft(w); w = p!.left!; }
          w.color = p!.color; p!.color = BLACK; w.left!.color = BLACK; this.rotateRight(p!); x = this.root;
        }
      }
    }
    if (x) x.color = BLACK;
  }

  /** Throws unless every red-black rule holds. Only true while deletes rebalance, which is what the tests pin. */
  validate() {
    if (this.root && this.root.color !== BLACK) throw new Error('root is red');
    const stack: [RB, number][] = this.root ? [[this.root, 0]] : [];
    let blackHeight = -1, last: number | null = null;
    for (const k of liveKeys(this.root)) {
      if (last !== null && k < last) throw new Error('keys out of order');
      last = k;
    }
    while (stack.length) {
      const [n, b] = stack.pop()!;
      if (n.color === RED && ((n.left && n.left.color === RED) || (n.right && n.right.color === RED))) throw new Error('red node with red child');
      const nb = b + (n.color === BLACK ? 1 : 0);
      if (!n.left || !n.right) {
        if (blackHeight === -1) blackHeight = nb;
        else if (blackHeight !== nb) throw new Error(`black heights differ: ${blackHeight} and ${nb}`);
      }
      if (n.left) stack.push([n.left, nb]);
      if (n.right) stack.push([n.right, nb]);
    }
  }
}

// ---- B-tree ---------------------------------------------------------------------

type BTNode = { keys: number[]; kids: BTNode[] };

/** A B-tree where a node holds up to fanout-1 keys and has up to fanout children. */
export class BTree {
  root: BTNode = { keys: [], kids: [] };
  fanout: number;
  comparisons = 0;
  size = 0;
  height = 0;

  constructor(fanout: number) {
    if (fanout < 3) throw new Error('a B-tree needs a fanout of at least 3');
    this.fanout = fanout;
  }

  /** Binary search inside a node. The comparisons count, but the node read is what costs on disk. */
  private slot(node: BTNode, key: number): number {
    let lo = 0, hi = node.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      this.comparisons++;
      if (key < node.keys[mid]) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  insert(key: number) {
    const path: { node: BTNode; at: number }[] = [];
    let node = this.root;
    while (node.kids.length) {
      const at = this.slot(node, key);
      path.push({ node, at });
      node = node.kids[at];
    }
    node.keys.splice(this.slot(node, key), 0, key);
    this.size++;
    // Split upward while a node is over-full. The tree only ever grows at the
    // root, and that is why every leaf stays at the same depth whatever the order.
    while (node.keys.length >= this.fanout) {
      const mid = node.keys.length >> 1, up = node.keys[mid];
      const right: BTNode = { keys: node.keys.slice(mid + 1), kids: node.kids.slice(mid + 1) };
      node.keys = node.keys.slice(0, mid);
      node.kids = node.kids.slice(0, mid + 1);
      const parent = path.pop();
      if (!parent) { this.root = { keys: [up], kids: [node, right] }; this.height++; return; }
      parent.node.keys.splice(parent.at, 0, up);
      parent.node.kids.splice(parent.at + 1, 0, right);
      node = parent.node;
    }
  }

  /** Nodes a lookup reads, which is what a disk or a page cache charges for. */
  nodeReads(): number { return this.height + 1; }

  depths(): Set<number> {
    const seen = new Set<number>(), stack: [BTNode, number][] = [[this.root, 0]];
    while (stack.length) {
      const [n, d] = stack.pop()!;
      if (!n.kids.length) seen.add(d);
      for (const k of n.kids) stack.push([k, d + 1]);
    }
    return seen;
  }

  shape(): { levels: number[]; height: number } {
    const levels: number[] = [];
    let row: BTNode[] = [this.root];
    while (row.length) { levels.push(row.length); row = row.flatMap((n) => n.kids); }
    return { levels, height: this.height };
  }
}

/** ⌈log_f n⌉ by integer multiplication, so 1000 in base 10 is exactly 3. */
export function logCeil(n: number, f: number): number {
  let h = 0, reach = 1;
  while (reach < n) { reach *= f; h++; }
  return h;
}

// ---- binary heap and priority queue ----------------------------------------------

/**
 * A port of Python's heapq, including its trick in heappop: it walks the hole all
 * the way down first, then sifts the moved item back up, which the textbook doesn't
 * do. So the list after each operation, and the number of comparisons, match real
 * heapq exactly, and a test holds it to that.
 *
 * The Tree Shaper's heap panel runs on this. The shortest-paths lab doesn't: it scans, as
 * Dijkstra's paper did, and tests/network.test.ts uses this only to count what a heap
 * would save on that lesson's grid. `lt` must only use <.
 */
export class MinHeap<T> {
  items: T[] = [];
  comparisons = 0;
  private lt: (a: T, b: T) => boolean;

  constructor(lt: (a: T, b: T) => boolean) { this.lt = lt; }

  get size() { return this.items.length; }
  peek(): T | undefined { return this.items[0]; }

  private less(a: T, b: T) { this.comparisons++; return this.lt(a, b); }

  private siftDown(start: number, from: number) {
    const a = this.items, item = a[from];
    let pos = from;
    while (pos > start) {
      const parent = (pos - 1) >> 1;
      if (this.less(item, a[parent])) { a[pos] = a[parent]; pos = parent; } else break;
    }
    a[pos] = item;
  }

  private siftUp(from: number) {
    const a = this.items, end = a.length, item = a[from];
    let pos = from, child = 2 * pos + 1;
    while (child < end) {
      const right = child + 1;
      if (right < end && !this.less(a[child], a[right])) child = right;
      a[pos] = a[child];
      pos = child;
      child = 2 * pos + 1;
    }
    a[pos] = item;
    this.siftDown(from, pos);
  }

  push(item: T) {
    this.items.push(item);
    this.siftDown(0, this.items.length - 1);
  }

  pop(): T {
    const a = this.items;
    if (!a.length) throw new Error('pop from an empty heap');
    const last = a.pop()!;
    if (!a.length) return last;
    const top = a[0];
    a[0] = last;
    this.siftUp(0);
    return top;
  }
}

/** A priority queue with the entry count heapq's docs recommend: ties come out in the order they went in, and items are never compared. */
export class PriorityQueue<T> {
  private heap = new MinHeap<{ p: number; n: number; item: T }>((a, b) => a.p < b.p || (a.p === b.p && a.n < b.n));
  private count = 0;
  get size() { return this.heap.size; }
  get comparisons() { return this.heap.comparisons; }
  push(item: T, priority: number) { this.heap.push({ p: priority, n: this.count++, item }); }
  pop(): { item: T; priority: number } { const e = this.heap.pop(); return { item: e.item, priority: e.p }; }
}

// ---- the Tree Shaper ---------------------------------------------------------------

export type ShaperRun = {
  n: number; order: Order; fanout: number; seed: number;
  bst: { comparisons: number; height: number; shape: Shape };
  rb: { comparisons: number; height: number; shape: Shape };
  bt: { comparisons: number; height: number; reads: number; levels: number[] };
  heap: { comparisons: number; height: number };
};

/** Above this, drawing every edge says nothing the height doesn't and costs a slow frame. */
const DRAW_LIMIT = 4000;

export function shapeRun(n: number, order: Order, fanout: number, seed = 1): ShaperRun {
  if (n > DRAW_LIMIT) throw new Error(`the shaper draws at most ${DRAW_LIMIT} keys`);
  const keys = keyStream(n, order, seed);
  const bst = new BST(), rb = new RedBlack(), bt = new BTree(fanout), heap = new MinHeap<number>((a, b) => a < b);
  for (const k of keys) { bst.insert(k); rb.insert(k); bt.insert(k); heap.push(k); }
  return {
    n, order, fanout, seed,
    bst: { comparisons: bst.comparisons, height: bst.height, shape: bst.shape() },
    rb: { comparisons: rb.comparisons, height: rb.height, shape: rb.shape() },
    bt: { comparisons: bt.comparisons, height: bt.height, reads: bt.nodeReads(), levels: bt.shape().levels },
    heap: { comparisons: heap.comparisons, height: Math.floor(Math.log2(n)) },
  };
}

// ---- the outage replay ---------------------------------------------------------

export const HEIGHT_LIMIT = 80;

export type Update = { op: 'ins' | 'del'; key: number };
export type ReplayEvent = { kind: 'trip' | 'recover' | 'clean'; ops: number; height: number; live: number };
export type ReplayRun = { rebalance: boolean; rebuildFromLive: boolean; events: ReplayEvent[]; ops: number; finalHeight: number; maxHeight: number; live: number; trips: number; outage: boolean };

/**
 * An update log. Keys arrive in order and every second one is deleted soon after,
 * like short-lived records in an append-mostly table. This is ours: the paper
 * doesn't give the vendor's workload. It needed no cleverness to find. Without
 * delete repairs, this log makes the tree nearly a straight line, with height n-2
 * for n live keys (tests/trees.test.ts pins it), because each delete quietly takes
 * away the black nodes that insertion's repair counts on.
 */
export function updateLog(updates: number): Update[] {
  const log: Update[] = [];
  for (let i = 0; i < updates; i++) {
    log.push({ op: 'ins', key: i });
    if (i % 2 === 1) log.push({ op: 'del', key: i - 1 });
  }
  return log;
}

/** Applies the log, stopping when the safety check fires. */
function applyLog(log: Update[], rebalance: boolean): { tree: RedBlack; tripped: number; maxHeight: number } {
  const t = new RedBlack(rebalance);
  let maxHeight = 0;
  for (let i = 0; i < log.length; i++) {
    if (log[i].op === 'ins') t.insert(log[i].key); else t.delete(log[i].key);
    const h = t.height;
    if (h > maxHeight) maxHeight = h;
    if (h > HEIGHT_LIMIT) return { tree: t, tripped: i + 1, maxHeight };
  }
  return { tree: t, tripped: -1, maxHeight };
}

function liveKeys(root: RedBlack['root']): number[] {
  const out: number[] = [], st: NonNullable<RedBlack['root']>[] = [];
  let c = root;
  while (c || st.length) {
    while (c) { st.push(c); c = c.left; }
    const n = st.pop()!;
    out.push(n.key);
    c = n.right;
  }
  return out;
}

/**
 * Sen & Tarjan say the recovery process "too" exceeded the bound, not what it did.
 * Here, as an illustration, it replays the same update log into an empty tree. So
 * with the same rules it trips at the same point every time. Capped, because a
 * real one goes round until someone steps in.
 */
export function replayOutage(rebalance: boolean, rebuildFromLive = false, updates = 2000, maxTrips = 3): ReplayRun {
  const log = updateLog(updates);
  const events: ReplayEvent[] = [];
  let ops = 0, maxHeight = 0, trips = 0, tree: RedBlack;
  for (;;) {
    const r = applyLog(log, rebalance);
    tree = r.tree;
    if (r.maxHeight > maxHeight) maxHeight = r.maxHeight;
    if (r.tripped < 0) { ops += log.length; break; }
    ops += r.tripped;
    trips++;
    events.push({ kind: 'trip', ops: r.tripped, height: tree.height, live: tree.size });
    if (rebuildFromLive) {
      // Reinserting only what's live builds a tree with no history in it, which
      // is the idea behind the paper's periodic rebuilding.
      const fresh = new RedBlack(rebalance);
      for (const k of liveKeys(tree.root)) fresh.insert(k);
      tree = fresh;
      events.push({ kind: 'clean', ops: tree.size, height: tree.height, live: tree.size });
      break;
    }
    if (trips >= maxTrips) break;
    events.push({ kind: 'recover', ops: 0, height: tree.height, live: tree.size });
  }
  return { rebalance, rebuildFromLive, events, ops, finalHeight: tree.height, maxHeight, live: tree.size, trips, outage: trips > 1 && !rebuildFromLive };
}

export type ShaperState = { runs: ShaperRun[]; replays: ReplayRun[] };

export const SHAPER_MISSION: Mission<ShaperState> = {
  id: 'cs-tree-shaper', title: 'Keep the tree short', xp: 80,
  setup: () => ({ runs: [], replays: [] }),
  steps: [
    { text: 'Feed 1,000 keys in sorted order. What shape does the plain tree take?', hint: 'Keys: 1,000, order: sorted, then Grow', done: (s) => s.runs.some((r) => r.n >= 1000 && r.order === 'sorted' && r.bst.comparisons === r.n * (r.n - 1) / 2) },
    { text: 'Same keys, shuffled. Nothing about the tree changed, only the order of arrival', hint: 'Order: shuffled, then Grow', done: (s) => s.runs.some((r) => r.n >= 1000 && r.order === 'shuffled' && r.bst.height < 4 * Math.log2(r.n)) },
    { text: 'Try keys that are nearly in order. A feed that is "basically sorted" is still dangerous to a plain tree', hint: 'Order: nearly sorted, then Grow', done: (s) => s.runs.some((r) => r.n >= 1000 && r.order === 'nearly' && r.bst.height > r.n / 4) },
    { text: 'Give the B-tree a wider node on the sorted feed, and watch its height fall', hint: 'Order: sorted, B-tree fanout: 100, then Grow', done: (s) => s.runs.some((r) => r.n >= 1000 && r.order === 'sorted' && r.fanout >= 100 && r.bt.height <= 2) },
    { text: 'Replay the outage: a red-black tree that rebalances after inserts but not deletes, with a height limit of 80', hint: 'Untick "rebalance after deletes", then Replay the updates', done: (s) => s.replays.some((r) => !r.rebalance && r.trips >= 2 && r.outage) },
    { text: 'Replay the same updates with deletes rebalancing', hint: 'Tick "rebalance after deletes", then Replay the updates', done: (s) => s.replays.some((r) => r.rebalance && r.trips === 0 && r.finalHeight <= HEIGHT_LIMIT) },
  ],
  debrief: 'The plain tree has no opinion about its shape, so the order of arrival decides it, and sorted is the worst order there is. A red-black tree refuses to get tall by rotating as it goes. A B-tree refuses by growing only at the root, so every leaf stays at one depth, and a wide node makes it very short. Then the outage: the height check was sound, and it fired correctly, every time. It could only say "too tall". The tree got tall because a repair was skipped on the delete path, and replaying the same log rebuilt the same tall tree. Sen and Tarjan call their story fictionalized, and they do not give the workload: this replay is our own illustration of it.',
};
