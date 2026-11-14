// The browser check is split across CI jobs (scripts/lib/shard.mjs). The split
// is only safe if every page and every scenario lands in exactly one part: one
// that lands in none is never checked again and nothing says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShard } from '../scripts/lib/shard.mjs';

test('shard: with no SHARD, everything runs', () => {
  for (const spec of [undefined, '']) {
    const s = parseShard(spec);
    assert.equal(s.total, 1);
    assert.ok([0, 1, 2, 500].every((i) => s.mine(i)));
  }
});

test('shard: every item is in exactly one part, for any number of parts', () => {
  for (let total = 1; total <= 7; total++) {
    const parts = Array.from({ length: total }, (_, k) => parseShard(`${k + 1}/${total}`));
    for (let i = 0; i < 400; i++) {
      assert.equal(parts.filter((p) => p.mine(i)).length, 1, `item ${i} with ${total} parts`);
    }
    // And the parts are the same size to within one item.
    const sizes = parts.map((p) => Array.from({ length: 400 }, (_, i) => i).filter(p.mine).length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${total} parts: ${sizes}`);
  }
});

test('shard: a value that cannot mean a part is an error, never "run nothing"', () => {
  for (const bad of ['3', '0/3', '4/3', '1/0', '2-3', 'a/b', ' 1/3', '1/3 ']) {
    assert.throws(() => parseShard(bad), /SHARD/, JSON.stringify(bad));
  }
});
