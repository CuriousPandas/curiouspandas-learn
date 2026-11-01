// "Every code sample must run." This reads the eight lesson files themselves, so a
// sample edited in a lesson can't drift from what was tested. Each Python block and
// each lab's starting code runs in the sandbox and in real Python, and must match.
// A block marked "# real machine" uses what the sandbox lacks, so it runs in real
// Python or real bash only, and if the lesson shows output right after it, that output
// must be what really appears, errors included. Fails rather than skips when the tool is
// missing. A script's marker sits under its #! line, which has to be the very first line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PyProgram } from '../src/lib/py/vm.ts';
import { formatTraceback } from '../src/lib/py/lab.ts';
import { PROG_MISSIONS } from '../src/lib/cs/prog-missions.ts';
import { LINUX_MISSIONS, world } from '../src/lib/shell/missions.ts';
import { CLEANUP_SCRIPT } from '../src/lib/shell/script-missions.ts';

const LESSONS = ['input-and-errors', 'debugging', 'your-first-tests', 'readable-code', 'recursion', 'real-program', 'shell-scripts', 'whose-code'];
const read = (slug: string) => readFileSync(join(import.meta.dirname, '..', 'src', 'content', 'lessons', 'programming', `${slug}.mdx`), 'utf8').replace(/\r\n/g, '\n');
const found: string | undefined = ['python3', 'python'].find((c) => /^3 \d+/.test(spawnSync(c, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], { encoding: 'utf8' }).stdout ?? ''));
if (!found) throw new Error('No Python 3 found; these tests compare against the real interpreter and cannot pass without it');
const PY: string = found;
const minor = Number(spawnSync(PY, ['-c', 'import sys; print(sys.version_info[1])'], { encoding: 'utf8' }).stdout);

const lastErr = (stderr: string) => (stderr.trim().split(/\r?\n/).at(-1) ?? '').replace(/\. Did you mean: .*\?$/, '');
function compare(src: string, stdin?: string[]) {
  const r = spawnSync(PY!, ['-I', '-X', 'utf8', '-c', src], { encoding: 'utf8', input: stdin ? stdin.map((l) => `${l}\n`).join('') : '' });
  const p = new PyProgram(src, { stdin });
  p.run();
  const ours = p.error ? (p.error.message ? `${p.error.type}: ${p.error.message}` : p.error.type) : '';
  assert.equal(p.stdout, r.stdout.replace(/\r\n/g, '\n'), `stdout differs for:\n${src}`);
  assert.equal(ours.split(':')[0], lastErr(r.stderr).split(':')[0], `error type differs for:\n${src}\nreal: ${r.stderr}\nours: ${ours}`);
}

const fences = (body: string, lang: string) => [...body.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```(\\s*```text\\n([\\s\\S]*?)```)?', 'g'))].map((m) => ({ code: m[1], shown: m[3] }));
const labs = (body: string) => [...body.matchAll(/<CodeLab(?: stdin="([^"]*)")? code=\{`([\s\S]*?)`\}/g)].map((m) => ({ stdin: m[1]?.split('\n'), code: m[2] }));

test('every lesson has both kinds of check to run: this test is not passing because it found nothing', () => {
  let py = 0, lab = 0;
  for (const slug of LESSONS) { py += fences(read(slug), 'python').length; lab += labs(read(slug)).length; }
  assert.ok(py >= 10, `only ${py} python blocks found`);
  assert.ok(lab >= 7, `only ${lab} labs found`);
});

for (const slug of LESSONS) {
  test(`${slug}: every Python block and lab matches real Python`, () => {
    const body = read(slug);
    for (const { code } of fences(body, 'python')) {
      if (!code.startsWith('# real machine')) compare(code);
    }
    for (const { code, stdin } of labs(body)) compare(code, stdin);
  });
}

test('every mission\'s starting code matches real Python too', () => {
  for (const [id, m] of Object.entries(PROG_MISSIONS)) {
    if (!m.starter) continue;
    // A mission's given code runs first in the sandbox, so it goes first in real Python.
    const whole = (m.given ?? '') + m.starter;
    const r = spawnSync(PY!, ['-I', '-X', 'utf8', '-c', whole], { encoding: 'utf8', input: (m.stdin ?? []).map((l) => `${l}\n`).join('') });
    const p = new PyProgram(m.starter, { stdin: m.stdin, given: m.given });
    p.run();
    assert.equal(p.stdout, r.stdout.replace(/\r\n/g, '\n'), id);
    assert.equal(p.error?.type ?? '', lastErr(r.stderr).split(':')[0], id);
  }
});

const REPORT_LOG = (fails: number) => `${Array.from({ length: fails }, (_, i) => `10.0.0.${i} - - "GET / HTTP/1.1" 500`).join('\n')}\n10.0.0.9 - - "GET / HTTP/1.1" 200\n`;
const inTemp = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-prog-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

const realScripts = () => fences(read('shell-scripts'), 'bash').filter((b) => /^(#!\/bin\/bash\n)?# real machine/.test(b.code));

test('shell-scripts: every real-machine script gives the output the lesson shows', () => {
  const blocks = realScripts();
  assert.ok(blocks.length >= 4, `only ${blocks.length} real-machine scripts found`);
  for (const b of blocks) {
    inTemp((dir) => {
      writeFileSync(join(dir, 'busy.log'), REPORT_LOG(3));
      writeFileSync(join(dir, 'calm.log'), REPORT_LOG(0));
      writeFileSync(join(dir, 'a.sh'), b.code);
      // Errors merged in: the first block's whole point is the error it prints, and
      // comparing stdout alone let the lesson show `starting` with the error left out.
      const r = spawnSync('bash', ['-c', 'bash a.sh 2>&1'], { cwd: dir, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
      if (r.error) throw r.error;
      if (b.shown !== undefined) assert.equal(r.stdout.replace(/\r\n/g, '\n'), b.shown, `output differs for:\n${b.code}`);
    });
  }
});

test('shell-scripts: scripts that need bash say so on their first line', () => {
  for (const b of realScripts()) if (/set -[a-z]*o|local |\(\w|\[@\]/.test(b.code)) assert.ok(b.code.startsWith('#!/bin/bash\n'), b.code);
});

test('shell-scripts: the log script stops when it could not look, where `|| true` said "fine"', () => {
  const script = realScripts().find((b) => b.code.includes('count_failures'))!.code;
  assert.doesNotMatch(script, /\|\| true/);
  const run = (code: string, setup: (dir: string) => void) => inTemp((dir) => {
    setup(dir);
    writeFileSync(join(dir, 'a.sh'), code);
    const r = spawnSync('bash', ['a.sh'], { cwd: dir, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    return { out: r.stdout.replace(/\r\n/g, '\n'), err: r.stderr, code: r.status };
  });
  const noLogs = (_: string) => {};
  const broken = (dir: string) => mkdirSync(join(dir, 'broken.log'));
  // The original failures, named: no logs at all, and a log grep can't read.
  const none = run(script, noLogs);
  assert.equal(none.out, '', 'no .log files must not print "*.log: fine"');
  assert.notEqual(none.code, 0);
  assert.match(none.err, /\*\.log/);
  const unread = run(script, broken);
  assert.equal(unread.out, '', 'an unreadable log must not print "broken.log: fine"');
  assert.notEqual(unread.code, 0);
  assert.match(unread.err, /broken\.log/);
  // What the prose says the tempting version does. If this stops being true, so does the lesson.
  const tempting = script.replace("    local status=0\n", '').replace('|| status=$?', '|| true').replace(/ {4}# 1 means.*\n {4}\[ "\$status" -le 1 \]\n/, '');
  assert.match(tempting, /\|\| true\n\}/);
  const a = run(tempting, noLogs);
  assert.equal(a.out, '*.log: fine\n');
  assert.equal(a.code, 0);
  const b = run(tempting, broken);
  assert.equal(b.out, 'broken.log: fine\n');
  assert.equal(b.code, 0);
  for (const phrase of ['*.log: fine', 'broken.log: fine']) assert.ok(read('shell-scripts').includes(phrase), phrase);
});

test('shell-scripts: the pieces of that script the shell lab has behave the same, and the rest is refused by name', () => {
  const sh = world();
  sh.fs.put('/home/panda/busy.log', { type: 'file', content: REPORT_LOG(3) });
  sh.fs.put('/home/panda/calm.log', { type: 'file', content: REPORT_LOG(0) });
  sh.fs.put('/home/panda/broken.log', { type: 'dir' });
  const said = (line: string) => { const lines = sh.run(line); return { text: lines.map((l) => l.text).join('\n'), code: sh.status }; };
  assert.deepEqual(said("grep -c ' 500$' busy.log"), { text: '3', code: 0 });
  assert.deepEqual(said("grep -c ' 500$' calm.log"), { text: '0', code: 1 });
  assert.equal(said("grep -c ' 500$' broken.log").code, 2);
  assert.equal(said("grep -c ' 500$' nothing.log").code, 2);
  // The lab can't run the script itself: functions, for and if are real-machine material.
  for (const line of ['count_failures() {', 'for log in *.log; do', 'if [ 1 -le 1 ]; then', 'local status=0', 'status=$?']) {
    const r = said(line);
    assert.notEqual(r.code, 0, line);
    assert.doesNotMatch(r.text, /command not found/, line);
  }
});

test('shell-scripts: the lesson\'s "try both" works in the terminal it sits above', () => {
  const sh = world();
  sh.run('grep -c 500 acces.log');
  assert.equal(sh.status, 2);
  assert.equal(sh.run('grep -c zebra notes.txt')[0].text, '0');
  assert.equal(sh.status, 1);
});

test('shell-scripts: it names what it needs, with links that exist, and no longer says the reader knows it', () => {
  const body = read('shell-scripts');
  assert.doesNotMatch(body, /You already know the commands/);
  assert.doesNotMatch(body, /ones you've used/);
  for (const slug of ['pipes', 'permissions', 'processes-and-signals']) {
    assert.ok(body.includes(`(/learn/linux/${slug}/)`), slug);
    assert.ok(existsSync(join(import.meta.dirname, '..', 'src', 'content', 'lessons', 'linux', `${slug}.mdx`)), slug);
  }
});

const body = (slug: string) => read(slug);

test('whose-code: each study is reported with its limits, and neither of METR\'s 2026 groups is left out', () => {
  const b = body('whose-code');
  // Peng: the interval and the sample, next to the headline.
  assert.match(b, /55\.8% faster"\. The 95% confidence interval is 21% to 89%/);
  assert.match(b, /95 freelancers/);
  // METR 2026: the smaller, larger result alone made it look more certain than it is.
  assert.match(b, /10 developers returning[^|]*18% speedup, from 38% faster to 9% slower/);
  assert.match(b, /47 newly recruited developers: an estimated 4% speedup, from 15% faster to 9% slower/);
  assert.match(b, /from 2% to 39% longer/);
  assert.match(b, /\$150 to \$50/);
  assert.match(b, /four of the five tasks/);
});

test('whose-code: nothing from OpenAI\'s page is quoted, because it couldn\'t be read', () => {
  const b = body('whose-code');
  for (const q of ['We hereby assign', 'output may not be unique', 'You must evaluate Output']) assert.ok(!b.includes(q), q);
  assert.match(b, /refused our automated check with a 403 error/);
  assert.doesNotMatch(b.split('---')[1], /openai\.com/, 'a page nobody could read isn\'t a source');
  // Every company's terms come with a date, and the section says the ground moves.
  assert.match(b, /effective 8 October 2025/);
  assert.match(b, /moves quickly/);
});

test('whose-code: the claim about how it was made matches the site\'s own account', () => {
  const b = body('whose-code');
  assert.match(b, /was written with heavy use of AI/);
  assert.doesNotMatch(b, /every claim here links/);
  const built = readFileSync(join(import.meta.dirname, '..', 'src', 'pages', 'built', 'index.astro'), 'utf8');
  assert.match(built, /Most of the code and lesson text on this site was written by the AI/);
});

// This was a conditional that passed either way, so when the engine gained
// KeyboardInterrupt the callout saying it didn't have one stayed, and nothing failed.
test('input-and-errors: KeyboardInterrupt behaves as the callout says, and the callout no longer denies it', () => {
  const run = (src: string) => { const p = new PyProgram(src); p.run(); return p; };
  const past = run('try:\n    raise KeyboardInterrupt\nexcept Exception:\n    print("caught")\n');
  assert.equal(past.stdout, '');
  assert.equal(past.error?.type, 'KeyboardInterrupt');
  assert.equal(run('try:\n    raise KeyboardInterrupt\nexcept:\n    print("caught")\n').stdout, 'caught\n');
  assert.doesNotMatch(body('input-and-errors'), /no `KeyboardInterrupt`/);
});

test('input-and-errors: finally is not promised on a way out that skips it', () => {
  const r = spawnSync(PY!, ['-I', '-c', 'import os\ntry:\n    os._exit(0)\nfinally:\n    print("ran")'], { encoding: 'utf8' });
  assert.equal(r.stdout, '');
  assert.doesNotMatch(body('input-and-errors'), /however you leave/);
});

test('debugging: the differences the callout lists from real tracebacks are real', () => {
  // From a file: python -c has no source lines to show, so it prints no markers either.
  const real = (src: string) => inTemp((dir) => {
    writeFileSync(join(dir, 'a.py'), src);
    return spawnSync(PY!, ['-I', '-X', 'utf8', 'a.py'], { cwd: dir, encoding: 'utf8' }).stderr.replace(/\r\n/g, '\n');
  });
  const lab = (src: string) => { const p = new PyProgram(src); p.run(); return formatTraceback(p.error!, src); };
  const typo = 'total = 1\nprint(totl)\n';
  assert.match(real(typo), /Did you mean: 'total'\?/);
  assert.doesNotMatch(lab(typo), /Did you mean/);
  const multi = 'print(\n    1 / 0\n)\n';
  assert.match(real(multi), /line 2, in <module>/);
  assert.match(lab(multi), /line 1, in <module>/);
  assert.match(real('1 / 0\n'), /~~\^~~|\^\^\^/);
  if (minor === 11) assert.match(real('x = [1 / 0 for i in [1]]\n'), /<listcomp>/);
  if (minor >= 12) assert.doesNotMatch(real('x = [1 / 0 for i in [1]]\n'), /<listcomp>/);
  assert.doesNotMatch(lab('x = [1 / 0 for i in [1]]\n'), /<listcomp>/);
});

test('debugging: q in pdb does end in the traceback the lesson warns about', () => {
  const r = spawnSync(PY!, ['-X', 'utf8', '-c', 'def f():\n    breakpoint()\n    return 1\nprint(f())\n'], { encoding: 'utf8', input: 'q\n', env: { ...process.env, PYTHONBREAKPOINT: 'pdb.set_trace' } });
  assert.match(r.stderr, /bdb\.BdbQuit/);
  assert.match(body('debugging'), /bdb\.BdbQuit/);
});

test('readable-code: names are judged by a reader, and this is said of the lab, not of machines for ever', () => {
  assert.doesNotMatch(body('readable-code'), /A machine can't yet/);
  assert.doesNotMatch(PROG_MISSIONS['prog-readable-refactor'].debrief, /only a person/);
});

test('recursion: isinstance is explained where it first appears, and the loop claim isn\'t absolute', () => {
  const b = body('recursion');
  assert.ok(b.indexOf('`isinstance(item, list)` asks') < b.indexOf('isinstance(item, list):'));
  assert.doesNotMatch(b, /with plain loops/);
});

test('real-program: forms the worked version uses are explained, and it copies as earlier lessons do', () => {
  const b = body('real-program');
  assert.match(b, /`lambda p: left\[p\]` is a small function with no name/);
  assert.match(b, /`except ValueError as e` catches/);
  assert.doesNotMatch(b, /dict\(balance\)/);
  assert.match(b, /Get-Content mytrip\.txt \| python trip\.py/);
});

test('shell-scripts: the claims about real bash in the text', () => {
  const run = (script: string) => inTemp((dir) => spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8' }));
  // set -e really stops, and with a non-zero status.
  const stops = run('set -e\ncd /no/such/folder\necho never');
  assert.notEqual(stops.status, 0);
  assert.equal(stops.stdout, '');
  // Its documented gap: a failure on the left of && doesn't stop it.
  assert.equal(run('set -e\nfalse && echo a\necho still-here').stdout, 'still-here\n');
  // set -u: an unset variable is an error, and an empty one is not.
  assert.notEqual(run('set -u\necho "$NEVER_SET"').status, 0);
  assert.equal(run('set -u\nEMPTY=""\necho "[$EMPTY]"').stdout, '[]\n');
  // ${var:?} refuses both, before the command runs.
  const guarded = run('EMPTY=""\necho "${EMPTY:?}/x"\necho never');
  assert.notEqual(guarded.status, 0);
  assert.equal(guarded.stdout, '');
  // The Steam line with an empty variable means /*. echo in place of rm: nothing is deleted.
  assert.match(run('STEAMROOT=""\necho rm -rf "$STEAMROOT/"* | cut -d " " -f 1-3').stdout, /^rm -rf \//);
  // Spaces around = aren't an assignment.
  assert.notEqual(run('limit = 2').status, 0);
  // bash -c's own exit: the pipeline status claim, in the mission's own wording.
  assert.equal(run('grep 500 acces.log 2>/dev/null | wc -l; echo $?').stdout.replace(/\s+/g, ' ').trim(), '0 0');
});

test('shell-scripts: the mission\'s script really does what the lesson says, on real bash', () => {
  inTemp((dir) => {
    // Real rm -r * in a real temp folder, one level down, so the worst it can do is here.
    const home = join(dir, 'home');
    mkdirSync(join(home, 'cache'), { recursive: true });
    writeFileSync(join(home, 'notes.txt'), 'x');
    writeFileSync(join(home, 'cache', 'a.tmp'), 'x');
    writeFileSync(join(home, 'cleanup.sh'), CLEANUP_SCRIPT);
    const bad = spawnSync('bash', ['cleanup.sh'], { cwd: home, encoding: 'utf8' });
    assert.equal(bad.status, 0, 'it exits 0');
    assert.equal(bad.stdout, 'cache cleaned\n');
    assert.match(bad.stderr, /cashe/);
    assert.equal(spawnSync('bash', ['-c', 'ls -A | wc -l'], { cwd: home, encoding: 'utf8' }).stdout.trim(), '0', 'and everything in the folder is gone');
  });
});

test('shell mission hints work when typed exactly as shown', () => {
  const m = LINUX_MISSIONS['prog-shell-report'];
  const s = m.setup();
  for (const st of m.steps) for (const cmd of (st.hint ?? '').split(/\s+then\s+/)) s.sh.run(cmd.trim());
  assert.ok(m.steps.every((st) => st.done(s)), 'following every hint must finish the mission');
  const q = LINUX_MISSIONS['prog-shell-silent'];
  const t = q.setup();
  for (const st of q.steps) for (const cmd of (st.hint ?? '').split(/\s+then\s+/)) t.sh.run(cmd.trim());
  assert.ok(q.steps.every((st) => st.done(t)), 'following every hint must finish the mission');
});

test('input-and-errors: the table of exceptions and the real-machine file programs', () => {
  for (const [src, type] of [['int("forty")', 'ValueError'], ['"a" + 1', 'TypeError'], ['1 / 0', 'ZeroDivisionError'], ['{}["x"]', 'KeyError'], ['[][5]', 'IndexError'], ['totl + 1', 'NameError']]) {
    const body = read('input-and-errors');
    assert.ok(body.includes(`| \`${src}\` | \`${type}\` |`), `the table must list ${src}`);
    const r = spawnSync(PY!, ['-I', '-c', src], { encoding: 'utf8' });
    assert.equal(lastErr(r.stderr).split(':')[0], type, src);
    compare(src);
  }
  const blocks = fences(read('input-and-errors'), 'python').filter((b) => b.code.startsWith('# real machine'));
  assert.equal(blocks.length, 2);
  inTemp((dir) => {
    const run = (code: string) => { writeFileSync(join(dir, 'p.py'), code); return spawnSync(PY!, ['-I', 'p.py'], { cwd: dir, encoding: 'utf8' }); };
    assert.equal(run(blocks[0].code).stdout.replace(/\r\n/g, '\n'), 'No notes.txt here yet.\n');
    assert.equal(run(blocks[1].code).status, 0);
    assert.equal(run(blocks[0].code).stdout.replace(/\r\n/g, '\n'), 'first note\n');
    // Catching everything makes opening a folder report that the file doesn't exist.
    const wide = blocks[0].code.replace('open("notes.txt")', 'open(".")').replace('except FileNotFoundError', 'except Exception');
    assert.equal(run(wide).stdout.replace(/\r\n/g, '\n'), 'No notes.txt here yet.\n');
    // That wasn't what went wrong: without the wide except the error is another one.
    assert.doesNotMatch(lastErr(run(blocks[0].code.replace('open("notes.txt")', 'open(".")')).stderr), /FileNotFoundError/);
  });
});

test('debugging: the traceback printed in the lesson is the one the lab really gives, and pdb sample works', () => {
  const start = PROG_MISSIONS['prog-debug-traceback'].starter!;
  const p = new PyProgram(start);
  p.run();
  const shown = fences(read('debugging'), 'text').map((b) => b.code).find((c) => c.startsWith('Traceback'))!;
  assert.equal(`${formatTraceback(p.error!, start)}\n`, shown);
  const sample = fences(read('debugging'), 'python').find((b) => b.code.startsWith('# real machine'))!;
  // Without -I: PYTHONBREAKPOINT has to be read, so breakpoint() does nothing here.
  const r = spawnSync(PY!, ['-X', 'utf8', '-c', sample.code], { encoding: 'utf8', env: { ...process.env, PYTHONBREAKPOINT: '0' } });
  assert.equal(r.stdout.trim(), '2');
});

test('readable-code: the two versions really agree on every input', () => {
  const [terse, clear] = fences(read('readable-code'), 'python');
  const strip = (c: string) => c.split('\n').filter((l) => !l.startsWith('print')).join('\n');
  const src = `${strip(terse.code)}\n${strip(clear.code)}\nfor due in range(0, 50, 7):\n    for back in range(0, 120):\n        assert f(due, back) == late_fee(due, back), (due, back)\nprint("same")\n`;
  compare(src);
  const p = new PyProgram(src);
  p.run();
  assert.equal(p.stdout, 'same\n');
  assert.match(terse.code, /f\(10, 15\)/);
  const q = new PyProgram(terse.code);
  q.run();
  assert.equal(q.stdout, '125\n');
});

test('recursion: the depths the lesson states, in the sandbox and in real Python', () => {
  const body = read('recursion');
  const [probe] = labs(body).filter((l) => l.code.includes('go_deeper'));
  const r = spawnSync(PY!, ['-I', '-c', probe.code], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'stopped after 999 calls');
  const p = new PyProgram(probe.code);
  p.run();
  assert.equal(p.stdout.trim(), 'stopped after 999 calls');
  const [howMany] = labs(body).filter((l) => l.code.includes('how_many'));
  const q = new PyProgram(howMany.code);
  q.run();
  assert.equal(q.stdout, '998\n');
  assert.equal(q.error?.type, 'RecursionError');
  assert.match(formatTraceback(q.error!, howMany.code), /\[Previous line repeated 996 more times\]/);
  // Only the principle is pinned for json: the exact depth changed between 3.11 and 3.12.
  const json = spawnSync(PY!, ['-I', '-c', 'import json\nn = 100000\ntry:\n    json.loads("[" * n + "]" * n)\n    print("parsed")\nexcept RecursionError:\n    print("RecursionError")'], { encoding: 'utf8' });
  assert.equal(json.stdout.trim(), 'RecursionError');
  if (minor === 12) {
    const at = (n: number) => spawnSync(PY!, ['-I', '-c', `import json\ntry:\n    json.loads("[" * ${n} + "]" * ${n})\n    print("ok")\nexcept RecursionError:\n    print("no")`], { encoding: 'utf8' }).stdout.trim();
    assert.equal(at(5000), 'ok');
    assert.equal(at(20000), 'no');
  }
  // The keep-your-own-stack version works where the recursive one stops.
  const iterative = labs(body).find((l) => l.code.includes('still_to_open'))!;
  const s = new PyProgram(iterative.code);
  s.run();
  assert.equal(s.stdout, '10\n5000\n');
});

test('real-program: the worked version in the lesson finishes the mission', () => {
  const solution = fences(read('real-program'), 'python').find((b) => b.code.includes('def settle'))!.code;
  const starter = PROG_MISSIONS['prog-real-trip'].starter!;
  const src = starter.replace('def test_parse_expense():', `${solution}\ndef test_parse_expense():`);
  const stdin = PROG_MISSIONS['prog-real-trip'].stdin!;
  const p = new PyProgram(src, { stdin });
  p.run();
  assert.equal(p.status, 'done', p.error?.message);
  assert.equal(p.error, undefined);
  // The same program on real Python, on the same lines, with the same result.
  const r = spawnSync(PY!, ['-I', '-X', 'utf8', '-c', src], { encoding: 'utf8', input: stdin.map((l) => `${l}\n`).join('') });
  assert.equal(r.stdout.replace(/\r\n/g, '\n'), p.stdout);
  // The example the lesson prints, without the unreadable line.
  const clean = new PyProgram(src, { stdin: ['Ana, Ben, Cai', 'Ana 90.00 hostel', 'Ben 30.50 train tickets', 'Cai 12.00 snacks', 'done'] });
  clean.run();
  const shown = fences(read('real-program'), 'text').flatMap((b) => [b.code, b.shown ?? '']).find((c) => c.startsWith('Spent'))!;
  assert.ok(clean.stdout.endsWith(shown), `lesson shows:\n${shown}\nprogram prints:\n${clean.stdout}`);
});

test('real-program: the fewest-payments example in the GoDeeper is true', () => {
  const solution = fences(read('real-program'), 'python').find((b) => b.code.includes('def settle'))!.code;
  const settle = solution.slice(solution.indexOf('def settle'));
  const p = new PyProgram(`${settle}\nprint(settle({"Ana": 4, "Ben": 3, "Cai": 2, "Dee": -4, "Eli": -5}))\n`);
  p.run();
  assert.equal(p.stdout, "[('Eli', 'Ana', 4), ('Dee', 'Ben', 3), ('Dee', 'Cai', 1), ('Eli', 'Cai', 1)]\n");
  // Three do, and they bring everyone to 0.
  const left: Record<string, number> = { Ana: 4, Ben: 3, Cai: 2, Dee: -4, Eli: -5 };
  for (const [from, to, n] of [['Dee', 'Ana', 4], ['Eli', 'Ben', 3], ['Eli', 'Cai', 2]] as const) { left[from] += n; left[to] -= n; }
  assert.ok(Object.values(left).every((v) => v === 0));
});
