// Layout for <Diagram>: boxes on a small grid, arrows between them, and steps
// that reveal them in order. Pure functions, so the geometry is unit-tested and
// the build fails on a broken diagram instead of shipping a picture with an
// arrow into nothing.

export type Kind = 'plain' | 'ok' | 'warn' | 'bad' | 'info';
export type DNode = { id: string; label: string; sub?: string; x: number; y: number; kind?: Kind };
export type DEdge = { from: string; to: string; label?: string; dashed?: boolean };
export type DStep = { caption: string; show?: string[]; focus?: string[] };
export type Diagram = { id: string; title: string; desc: string; nodes: DNode[]; edges: DEdge[]; steps?: DStep[] };

export const BOX = { w: 168, h: 58, gapX: 100, gapY: 52, pad: 14 };
// The phone layout's columns sit closer: at 76 the two-across picture drew
// labels at 11.2px on a 375px screen; at 56 they clear 12px. An arrow label
// across that gap can overlap the boxes' borders, so labels draw on top.
export const NARROW_GAP_X = 56;
// Past these a label overflows its box. Measured against the widest glyphs at
// the sizes Diagram.astro draws; a longer label belongs in the caption.
// 18 was too generous: "ns1.bamboo.example" (18) in bold 16px overflowed its
// box on desktop and was clipped on phones (writer N). 16 clears it.
export const MAX_LABEL = 16;
export const MAX_SUB = 22;
// An arrow label has to fit the gap between two columns (100 units). At about
// 7 units a character, 13-14 character labels ("closes the gap") still ran into
// the boxes either side; 12 clears them.
export const MAX_EDGE_LABEL = 12;
// Phones get the layout turned so the short side runs across. Two boxes across
// keeps a label near 13px on a 375px screen; three shrinks it to about 8px.
// The long side is capped so the desktop picture still fits a lesson column:
// five across drew labels near 10px.
export const MAX_SHORT = 2;
export const MAX_LONG = 4;

export const edgeId = (e: DEdge) => `${e.from}->${e.to}`;

export function validate(d: Diagram): void {
  const where = `Diagram ${d.id}`;
  const ids = new Set<string>();
  for (const n of d.nodes) {
    if (ids.has(n.id)) throw new Error(`${where}: two boxes are called "${n.id}"`);
    ids.add(n.id);
    if (n.label.length > MAX_LABEL) throw new Error(`${where}: label "${n.label}" is longer than ${MAX_LABEL} characters and will overflow its box`);
    if (n.sub && n.sub.length > MAX_SUB) throw new Error(`${where}: sub-label "${n.sub}" is longer than ${MAX_SUB} characters`);
    if (!Number.isInteger(n.x) || !Number.isInteger(n.y) || n.x < 0 || n.y < 0) throw new Error(`${where}: box "${n.id}" needs whole-number x and y from 0`);
  }
  const cells = new Set(d.nodes.map((n) => `${n.x},${n.y}`));
  if (cells.size !== d.nodes.length) throw new Error(`${where}: two boxes share a grid cell`);
  const cols = Math.max(...d.nodes.map((n) => n.x)) + 1, rows = Math.max(...d.nodes.map((n) => n.y)) + 1;
  if (Math.min(cols, rows) > MAX_SHORT) throw new Error(`${where}: ${cols}x${rows} grid - one side must be at most ${MAX_SHORT} boxes so a phone can show it readably`);
  if (Math.max(cols, rows) > MAX_LONG) throw new Error(`${where}: ${cols}x${rows} grid - at most ${MAX_LONG} boxes along the long side; split it into two diagrams`);
  const known = new Set(ids);
  for (const e of d.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`${where}: arrow ${edgeId(e)} points at a box that does not exist`);
    if (e.label && e.label.length > MAX_EDGE_LABEL) throw new Error(`${where}: arrow label "${e.label}" is longer than ${MAX_EDGE_LABEL} characters and will run into the boxes`);
    known.add(edgeId(e));
  }
  for (const [i, s] of (d.steps ?? []).entries()) {
    for (const ref of [...(s.show ?? []), ...(s.focus ?? [])])
      if (!known.has(ref)) throw new Error(`${where}: step ${i + 1} names "${ref}", which is no box or arrow (arrows are "from->to")`);
  }
  if (!d.title.trim() || !d.desc.trim()) throw new Error(`${where}: title and desc are required - they are what a screen reader gets instead of the picture`);
}

// Swap axes so a wide flow becomes a tall one. The picture keeps every box and
// arrow; only the reading direction turns from left-right to top-bottom.
export const transpose = (nodes: DNode[]): DNode[] => nodes.map((n) => ({ ...n, x: n.y, y: n.x }));

export const grid = (nodes: DNode[]) => ({ cols: Math.max(...nodes.map((n) => n.x)) + 1, rows: Math.max(...nodes.map((n) => n.y)) + 1 });

export const size = (nodes: DNode[], gx = BOX.gapX) => {
  const { cols, rows } = grid(nodes);
  return { w: BOX.pad * 2 + cols * BOX.w + (cols - 1) * gx, h: BOX.pad * 2 + rows * BOX.h + (rows - 1) * BOX.gapY };
};

export const origin = (n: DNode, gx = BOX.gapX) => ({ x: BOX.pad + n.x * (BOX.w + gx), y: BOX.pad + n.y * (BOX.h + BOX.gapY) });

// Where the line from a box's centre towards (tx, ty) leaves the box, so arrows
// start and end on edges rather than under the labels.
export function exit(n: DNode, tx: number, ty: number, inset = 0, gx = BOX.gapX) {
  const o = origin(n, gx);
  const cx = o.x + BOX.w / 2, cy = o.y + BOX.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = BOX.w / 2 + inset, hh = BOX.h / 2 + inset;
  const t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return { x: cx + dx * t, y: cy + dy * t };
}

export function line(from: DNode, to: DNode, gx = BOX.gapX) {
  const a = origin(from, gx), b = origin(to, gx);
  const ac = { x: a.x + BOX.w / 2, y: a.y + BOX.h / 2 }, bc = { x: b.x + BOX.w / 2, y: b.y + BOX.h / 2 };
  // A small gap at the head end leaves room for the arrowhead.
  const p = exit(from, bc.x, bc.y, 2, gx), q = exit(to, ac.x, ac.y, 6, gx);
  return { x1: p.x, y1: p.y, x2: q.x, y2: q.y, mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2 };
}

// Steps reveal cumulatively: step n shows everything named in steps 1..n. A
// diagram with no steps is shown whole. Returns, per element, the first step
// that shows it (0 = shown from the start).
export function firstShown(d: Diagram): Map<string, number> {
  const all = [...d.nodes.map((n) => n.id), ...d.edges.map(edgeId)];
  const steps = d.steps ?? [];
  const named = new Set(steps.flatMap((s) => s.show ?? []));
  const at = new Map<string, number>();
  // Anything no step mentions is context, shown from the start.
  for (const id of all) if (!named.has(id)) at.set(id, 0);
  steps.forEach((s, i) => { for (const id of s.show ?? []) if (!at.has(id)) at.set(id, i); });
  return at;
}
