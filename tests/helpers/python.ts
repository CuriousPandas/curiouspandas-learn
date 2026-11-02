// The real interpreter, for tests that hold a model to it. Throws when Python is
// missing: a ground-truth test that quietly skips reads as a pass.
//
// TEST_PYTHON picks another interpreter for runPython, as a command line, e.g.
//   TEST_PYTHON="wsl -d Ubuntu-24.04 --exec python3"
// CI runs 3.12, and a Windows machine may only have 3.11 locally: without this, a
// version difference showed up only after a push, as one did in tinycomp's fuzz.

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

/** The interpreter runPython uses: TEST_PYTHON when set, else python(). */
function command(): [string, string[]] {
  const override = process.env.TEST_PYTHON?.trim();
  if (!override) return [python(), []];
  const [cmd, ...pre] = override.split(/\s+/);
  return [cmd, pre];
}

export function pythonVersion(): [number, number] {
  const [cmd, pre] = command();
  const r = spawnSync(cmd, [...pre, '-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], { encoding: 'utf8' });
  const [a, b] = r.stdout.trim().split(/\s+/).map(Number);
  return [a, b];
}

/** Runs a program with no site or environment influence. `env` is for PYTHONHASHSEED, which -I would ignore, so it drops -I. */
export function runPython(src: string, env?: Record<string, string>) {
  // On stdin, not -c: a long program passed as an argument hits Windows' command
  // line limit, and spawnSync reports that only as a null status.
  const [cmd, pre] = command();
  const args = [...pre, ...(env ? ['-X', 'utf8', '-'] : ['-I', '-X', 'utf8', '-'])];
  // wsl.exe passes only the variables WSLENV names, so without this PYTHONHASHSEED
  // would silently not reach a WSL interpreter, and a seeded test would fail for that.
  const forward = env && process.env.TEST_PYTHON ? { WSLENV: [process.env.WSLENV, ...Object.keys(env)].filter(Boolean).join(':') } : {};
  const r = spawnSync(cmd, args, { encoding: 'utf8', input: src, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env, ...forward } : process.env });
  return { status: r.status, stdout: (r.stdout ?? '').replace(/\r\n/g, '\n'), stderr: r.stderr ?? '' };
}
