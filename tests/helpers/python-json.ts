// A reference written in real Python, fed its jobs as JSON on stdin. runPython() in python.ts
// sends the program itself on stdin, so it can't also carry the jobs. Fails rather than skips.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { python as interpreter } from './python.ts';

export function python(src: string, input = ''): string {
  const r = spawnSync(interpreter(), ['-I', '-X', 'utf8', '-c', src], { encoding: 'utf8', input, maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
