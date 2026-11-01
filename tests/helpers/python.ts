// The real interpreter, for tests that hold a model to it. Throws when Python is
// missing: a ground-truth test that quietly skips reads as a pass.

import { spawnSync } from 'node:child_process';

let found: string | undefined;

export function python(): string {
  if (found) return found;
  // On Windows `python3` can be the Store stub, which exits non-zero with no
  // version, so each candidate has to prove it runs.
  for (const c of ['python3', 'python']) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], { encoding: 'utf8' });
    if (r.status === 0 && /^3 \d+/.test(r.stdout)) { found = c; return c; }
  }
  throw new Error('No Python 3 found; these tests compare against the real interpreter and cannot pass without it');
}

export function pythonVersion(): [number, number] {
  const r = spawnSync(python(), ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], { encoding: 'utf8' });
  const [a, b] = r.stdout.trim().split(/\s+/).map(Number);
  return [a, b];
}

/** Runs a program with no site or environment influence. `env` is for PYTHONHASHSEED, which -I would ignore, so it drops -I. */
export function runPython(src: string, env?: Record<string, string>) {
  // On stdin, not -c: a long program passed as an argument hits Windows' command
  // line limit, and spawnSync reports that only as a null status.
  const args = env ? ['-X', 'utf8', '-'] : ['-I', '-X', 'utf8', '-'];
  const r = spawnSync(python(), args, { encoding: 'utf8', input: src, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env });
  return { status: r.status, stdout: (r.stdout ?? '').replace(/\r\n/g, '\n'), stderr: r.stderr ?? '' };
}
