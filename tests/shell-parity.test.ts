// The Linux track's terminal claims its text tools print what the real ones
// print. This replays the same command lines through the sandbox and through
// real bash with GNU coreutils, in a temp directory holding the same files, and
// compares the output byte for byte. If bash is missing the test fails rather
// than skipping - a parity test that quietly skips reads as parity.
//
// LC_ALL=C on the real side: sort and ls follow the locale, and the sandbox
// orders by bytes, as the C locale does (the pipes lesson says so).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Shell } from '../src/lib/shell/shell.ts';

const FILES: Record<string, string> = {
  f: 'b\na\nb\nc b\n',
  nums: '10 a\n9 b\n10 0\n-3 z\n',
  log: '10.0.0.1 GET / 200\n10.0.0.2 GET /x 500\n10.0.0.1 GET /y 500\n10.0.0.3 get /z 404\n',
  sorted: 'a\na\nb\nc\nc\nc\n',
};

function twin() {
  const dir = mkdtempSync(join(tmpdir(), 'cp-shell-'));
  const sh = new Shell();
  sh.fs.put('/dev/null', { type: 'file', device: 'null', mode: 0o666 }, 'root');
  sh.fs.put('/home', { type: 'dir' }, 'root');
  sh.fs.put('/home/panda', { type: 'dir' });
  for (const [name, text] of Object.entries(FILES)) {
    writeFileSync(join(dir, name), text);
    sh.fs.put(`/home/panda/${name}`, { type: 'file', content: text });
  }
  const real = (line: string) => {
    const r = spawnSync('bash', ['-c', line], { cwd: dir, env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8' });
    if (r.error) throw r.error;
    return { out: r.stdout, err: r.stderr, code: r.status };
  };
  const ours = (line: string) => {
    const lines = sh.run(line);
    // stdout is compared raw (echo -n has no newline). Job announcements are
    // not part of it: the sandbox behaves like an interactive shell, which
    // prints "[1] 4250" and "[1]+ Terminated"; bash -c does not.
    const err = lines.filter((l) => l.kind === 'err').map((l) => l.text + '\n').join('');
    return { out: sh.rawOut, err, code: sh.status };
  };
  return { real, ours, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const SAME_STDOUT = [
  'sort f', 'sort -r f', 'sort -u f', 'sort f | uniq -c', 'sort f | uniq -c | sort -rn', 'sort -n nums', 'sort -rn nums',
  'uniq sorted', 'uniq -c sorted', 'uniq -d sorted',
  'wc f', 'wc -l f', 'wc -w f', 'wc -c f', 'cat f | wc', 'cat f | wc -l', 'wc -l f log', 'wc f log',
  'head -n 2 f', 'head -2 f', 'tail -1 f', 'tail -n +2 f', 'tail -n 2 log',
  "cut -d ' ' -f 1 log", "cut -d ' ' -f 1,4 log", "cut -d ' ' -f 2- log", 'cut -c 1-3 log',
  'grep -c 500 log', 'grep -n 500 log', 'grep -v 200 log', 'grep 500 log f', 'grep -i get log', "grep ' 500$' log", 'grep -E "50+" log',
  "cut -d ' ' -f 1 log | sort | uniq -c | sort -rn | head -1",
  'echo hi > g; echo there >> g; cat g', 'cat f > f2; cat f2 > f2; cat f2', 'cat f | tee t > /dev/null; cat t',
  `echo 'a  b' "c   d" e`, 'echo -n no-newline', 'printf "%s-%d\\n" a 3 b 4',
  'false && echo no || echo yes', 'true || echo a && echo b', 'nosuch 2>/dev/null; echo $?', 'grep zzz log; echo $?', 'grep x missing 2>/dev/null; echo $?',
  'sleep 30 & kill -TERM $!; wait $!; echo $?', 'sleep 30 & kill -KILL $!; wait $!; echo $?', 'sleep 30 & kill -INT $!; wait $!; echo $?',
  'ls | cat', 'mkdir -p d/e; ls d', 'touch new; ls | grep new',
];

test('text tools, redirection and exit codes match real bash and coreutils', () => {
  const t = twin();
  try {
    for (const line of SAME_STDOUT) {
      const r = t.real(line), o = t.ours(line);
      assert.equal(o.out, r.out, `stdout differs for: ${line}`);
    }
  } finally { t.done(); }
});

test('the reference tools are GNU coreutils', () => {
  // Parity is defined against GNU coreutils. Ubuntu 26.04 ships uutils instead,
  // whose messages differ; comparing against it failed CI with a confusing
  // word-by-word diff. Say what is wrong instead.
  const v = spawnSync('bash', ['-c', 'mkdir --version'], { encoding: 'utf8' }).stdout ?? '';
  assert.match(v, /GNU coreutils/, `parity needs GNU coreutils as the reference; this machine's mkdir reports: ${v.split(/\n/)[0] || '(nothing)'}`);
});

test('error messages from the file tools match coreutils word for word', () => {
  const t = twin();
  try {
    for (const line of ['cat missing', 'grep x missing', 'rm d', 'mkdir d', 'mkdir d', 'cat d', 'mkdir a/b']) {
      if (line === 'rm d' || line === 'cat d') { t.real('mkdir -p d'); t.ours('mkdir -p d'); }
      const r = t.real(line), o = t.ours(line);
      assert.equal(o.err, r.err, `stderr differs for: ${line}`);
      assert.equal(o.code, r.code, `exit status differs for: ${line}`);
    }
  } finally { t.done(); }
});
