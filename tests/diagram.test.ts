import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, transpose, grid, line, origin, firstShown, BOX, type Diagram } from '../src/lib/diagram.ts';

const base = (): Diagram => ({
  id: 't', title: 'A commit', desc: 'A commit points at a tree, which points at blobs.',
  nodes: [
    { id: 'commit', label: 'commit', x: 0, y: 0 },
    { id: 'tree', label: 'tree', x: 1, y: 0 },
    { id: 'blob', label: 'blob', x: 2, y: 0 },
  ],
  edges: [{ from: 'commit', to: 'tree' }, { from: 'tree', to: 'blob' }],
});

test('a well-formed diagram passes', () => validate(base()));

test('an arrow to a missing box fails the build instead of drawing into nothing', () => {
  const d = base(); d.edges.push({ from: 'tree', to: 'ghost' });
  assert.throws(() => validate(d), /does not exist/);
});

test('a step naming something that is not there fails, including a mistyped arrow', () => {
  const d = base(); d.steps = [{ caption: 'x', show: ['commit->blob'] }];
  assert.throws(() => validate(d), /no box or arrow/);
});

test('labels that would overflow their box fail', () => {
  const d = base(); d.nodes[0].label = 'a label far too long for a box';
  assert.throws(() => validate(d), /overflow/);
});

test('a grid no phone can show readably fails, a wide-but-short one passes', () => {
  const d = base();
  d.nodes = [0, 1, 2].flatMap((x) => [0, 1, 2].map((y) => ({ id: `n${x}${y}`, label: 'n', x, y })));
  d.edges = [];
  assert.throws(() => validate(d), /at most 2 boxes/);
  const wide = base(); wide.nodes.push({ id: 'four', label: 'four', x: 3, y: 1 });
  validate(wide);
  wide.nodes.push({ id: 'five', label: 'five', x: 4, y: 0 });
  assert.throws(() => validate(wide), /at most 4 boxes/);
});

test('a screen reader always gets a title and description', () => {
  const d = base(); d.desc = ' ';
  assert.throws(() => validate(d), /screen reader/);
});

test('turning a wide flow tall swaps axes and keeps every box', () => {
  const t = transpose(base().nodes);
  assert.deepEqual(grid(t), { cols: 1, rows: 3 });
  assert.deepEqual(t.map((n) => n.id), ['commit', 'tree', 'blob']);
});

test('arrows start and end on box edges, not under the labels', () => {
  const [a, b] = base().nodes;
  const l = line(a, b);
  const ao = origin(a), bo = origin(b);
  assert.ok(l.x1 >= ao.x + BOX.w, 'starts at or past the right edge of the source');
  assert.ok(l.x2 <= bo.x, 'ends at or before the left edge of the target');
  assert.equal(l.y1, ao.y + BOX.h / 2);
});

test('steps reveal cumulatively; anything no step names is context shown from the start', () => {
  const d = base();
  d.steps = [{ caption: 'first', show: ['commit'] }, { caption: 'then', show: ['tree', 'commit->tree'] }];
  const at = firstShown(d);
  assert.equal(at.get('commit'), 0);
  assert.equal(at.get('tree'), 1);
  assert.equal(at.get('commit->tree'), 1);
  assert.equal(at.get('blob'), 0);
});
