// The video list (src/data/videos.ts) feeds two places: <Watch> inside a
// lesson and the /videos/ page. The build already refuses a <Watch> with no
// entry. Nothing in the build refuses the reverse: an entry whose lesson never
// embeds it shows on /videos/ with "From the lesson ..." and the lesson says
// nothing about a video. These pin that direction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { VIDEOS, videoFor } from '../src/data/videos.ts';

const dir = 'src/content/lessons';
const tags = new Map<string, string[]>();
for (const t of readdirSync(dir)) for (const f of readdirSync(join(dir, t))) {
  const found = [...readFileSync(join(dir, t, f), 'utf8').matchAll(/<Watch\b[^>]*>/g)].map((m) => m[0]);
  if (found.length) tags.set(`${t}/${f.replace(/\.mdx$/, '')}`, found);
}

test('videos: every listed video is embedded in the lesson it names, once', () => {
  for (const v of VIDEOS) {
    assert.deepEqual(tags.get(v.lesson), [`<Watch lesson="${v.lesson}" />`], `${v.lesson} must contain exactly <Watch lesson="${v.lesson}" />`);
  }
});

test('videos: every <Watch> in a lesson names that lesson and has an entry', () => {
  for (const [lesson, found] of tags) {
    for (const tag of found) assert.equal(tag, `<Watch lesson="${lesson}" />`, `in ${lesson}`);
    assert.doesNotThrow(() => videoFor(lesson));
  }
  assert.throws(() => videoFor('platform/no-such-lesson'), /no video for lesson "platform\/no-such-lesson"/);
});

test('videos: one video per lesson, a real YouTube id and a poster that exists', () => {
  assert.equal(new Set(VIDEOS.map((v) => v.lesson)).size, VIDEOS.length, 'two videos for one lesson: videoFor would only ever return the first');
  assert.equal(new Set(VIDEOS.map((v) => v.youtube)).size, VIDEOS.length, 'the same YouTube id listed twice');
  for (const v of VIDEOS) {
    assert.match(v.youtube, /^[\w-]{11}$/);
    assert.ok(existsSync(join('public', v.poster)), `${v.poster} is not under public/`);
    assert.ok(v.minutes > 0 && v.about.length > 40, `${v.lesson} needs minutes and a description`);
  }
});
