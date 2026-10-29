import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha1 } from '../src/lib/git/sha1.ts';

test('sha1 matches node:crypto across the padding boundaries', () => {
  // 55/56/63/64 bytes are where the length field spills into a second block;
  // a padding bug passes every "hello world" test and fails exactly there.
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 4096]) {
    const b = new Uint8Array(randomBytes(n));
    assert.equal(sha1(b), createHash('sha1').update(b).digest('hex'), `length ${n}`);
  }
});

test('the empty blob has the hash every git user eventually meets', () => {
  assert.equal(sha1(new TextEncoder().encode('blob 0\0')), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});
