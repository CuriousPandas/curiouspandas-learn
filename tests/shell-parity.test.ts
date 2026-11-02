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
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

// Added for the shell-scripts lesson, which leans on all of these. The status of a
// pipeline with a failing first command is the silent failure it is about.
const SCRIPTS = [
  "printf 'echo one\\necho two\\n' > s; bash s; echo $?",
  "printf '# a comment\\n\\necho hi\\n' > s; bash s",
  "printf '#!/bin/bash\\necho shebang\\n' > s; chmod u+x s; ./s; echo $?",
  "printf 'false\\necho next line still runs\\n' > s; bash s; echo $?",
  "printf 'echo before\\nfalse\\n' > s; bash s; echo $?",
  "printf 'echo a\\nexit 3\\necho b\\n' > s; bash s; echo $?",
  "printf 'false\\nexit\\n' > s; bash s; echo $?",
  "printf 'cat missing || exit 4\\necho never\\n' > s; bash s 2>/dev/null; echo $?",
  "printf 'true || exit 4\\necho reached\\n' > s; bash s; echo $?",
  "printf 'true && exit 5\\necho never\\n' > s; bash s; echo $?",
  "printf 'exit 300\\n' > s; bash s; echo $?",
  "printf 'cd d0 2>/dev/null\\npwd | wc -l\\necho kept going\\n' > s; bash s; echo $?",
  "mkdir -p sub; printf 'cd sub\\npwd | wc -l\\n' > s; bash s; ls | grep -c s; pwd | wc -l",
  "mkdir -p sub2; touch sub2/inner; printf 'cd sub2 && ls\\n' > s; bash s; ls | grep -c inner",
  "printf 'cd nowhere 2>/dev/null && echo moved\\n' > s; bash s; echo $?",
  "printf 'echo $# \"$1\" $2\\n' > s; bash s a b c",
  "printf 'echo $#:$1:\\n' > s; bash s",
  "printf 'grep -c 500 $1\\n' > s; bash s log; bash s f; echo $?",
  "printf 'echo outer $1\\nbash t in\\necho outer $1\\n' > s; printf 'echo inner $1\\n' > t; bash s out",
  "printf 'nosuchcommand 2>/dev/null\\necho after $?\\n' > s; bash s",
  "grep 500 missing 2>/dev/null | wc -l; echo $?",
  "printf 'grep 500 missing 2>/dev/null | wc -l\\n' > s; bash s; echo $?",
  "printf 'grep -c 500 missing 2>/dev/null\\n' > s; bash s; echo $?",
  "grep -c 500 missing 2>/dev/null; echo $?",
  "grep -c zzzz log; echo $?",
  "printf 'cat missing 2>/dev/null > out.txt\\necho exit-was $?\\ncat out.txt | wc -c\\n' > s; bash s",
  "echo 'grep 500 log' > r; echo 'echo done' >> r; cat r; bash r",
  // The exact shapes the lesson and its mission use.
  `printf 'grep 500$ $1 | cut -d " " -f 1 | sort | uniq -c | sort -rn | head -1\\n' > s; bash s log; echo $?`,
  'grep 500 acces.log 2>/dev/null | wc -l; echo $?',
  'grep -c 500 acces.log 2>/dev/null; echo $?',
  'grep -E "50[0-9]$" log',
  "printf 'echo $0\\n' > s; bash s; chmod u+x s; ./s",
  'echo $0 | wc -l',
  'echo "no expansion in single quotes: $HOME" | wc -l',
  "echo 'cd x && rm y' > s; cat s",
  'echo "$?"; false; echo "$?"',
];

test('scripts: order, exit status, exit in a list, $1, and a script\'s cd ending with it match real bash', () => {
  const t = twin();
  try {
    const wrong: string[] = [];
    for (const line of SCRIPTS) {
      const r = t.real(line), o = t.ours(line);
      if (o.out !== r.out) wrong.push(`${line}\nreal: ${JSON.stringify(r.out)}\nours: ${JSON.stringify(o.out)}`);
    }
    assert.equal(wrong.length, 0, wrong.join('\n\n'));
  } finally { t.done(); }
});

// ---- the bad uses: a missing file, a directory, no arguments, a bad flag
//
// `wc -l acces.log` printed nothing, threw a TypeError in the page, and `echo $?` said
// 0, where real wc errors with status 1. So every command is held here to what real
// bash and GNU tools do when used wrongly. Each line runs in a fresh folder, on both
// sides, and status, stdout and the words of the error must all match. "Try --help" and
// usage lines aren't compared, and neither is the note saying what this sandbox knows.
const wordsOf = (err: string) => err.split(/\r?\n/).filter(Boolean)
  .filter((l) => !/^Try '|^Usage:|^\s|^\w+: usage:|^GNU long options:|^Shell options:/.test(l))
  .map((l) => l.replace(/^bash: line \d+: /, 'bash: ').replace(/ \((this sandbox|real ).*\)$/, ''))
  // GNU coreutils and bash word these differently from one version to the next, and
  // Git for Windows' builds differently again. What must match is that it's refused, and
  // which option or file it names. CI's Ubuntu and this repo's Windows both have to pass.
  .map((l) => l.replace(/: invalid option -- '(.)'/, ': bad option $1').replace(/: unknown option -- (\S+)/, ': bad option $1').replace(/: unrecognized option '--(\S+)'/, ': bad option $1')
    .replace(/requires an argument -- '(.)'/, 'requires an argument -- $1')
    .replace(/only one (type of )?list may be specified/, 'only one list')
    .replace(/^cp: target '([^']*)'.*/, 'cp: target $1')
    .replace(/^uniq: error reading '([^']*)'.*/, 'uniq: error reading $1'));

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'cp-shell-'));
  const sh = new Shell();
  sh.fs.put('/dev/null', { type: 'file', device: 'null', mode: 0o666 }, 'root');
  sh.fs.put('/home', { type: 'dir' }, 'root');
  sh.fs.put('/home/panda', { type: 'dir' });
  sh.fs.put('/home/panda/d', { type: 'dir' });
  mkdirSync(join(dir, 'd'));
  for (const [name, text] of Object.entries({ f: 'b\na\nb\n', g: 'x y\n' })) {
    writeFileSync(join(dir, name), text);
    sh.fs.put(`/home/panda/${name}`, { type: 'file', content: text });
  }
  return { dir, sh };
}

function both(line: string) {
  const { dir, sh } = fresh();
  try {
    const r = spawnSync('bash', ['-c', line], { cwd: dir, env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8', input: '' });
    if (r.error) throw r.error;
    const lines = sh.run(line);
    return {
      real: { out: r.stdout.replace(/\r\n/g, '\n'), err: wordsOf(r.stderr), code: r.status },
      ours: { out: sh.rawOut, err: wordsOf(lines.filter((l) => l.kind === 'err').map((l) => l.text).join('\n')), code: sh.status },
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const BAD_USES = [
  // wc, the one that crashed
  'wc -l acces.log', 'wc acces.log', 'wc d', 'wc -l d', 'wc -l f acces.log', 'wc -l acces.log f', 'wc -l f d', 'wc f d', 'wc -l nope1 nope2', 'wc -Q f', 'wc --nope f',
  'wc -l acces.log; echo $?',
  // the other tools that read files
  'cat missing', 'cat d', 'cat f missing', 'cat -Q f', 'cat --nope f',
  'sort missing', 'sort d', 'sort f missing', 'sort -Q f', 'sort --nope f',
  'uniq missing', 'uniq d', 'uniq -Q f', 'uniq f g h',
  'head missing', 'head d', 'head -Q f', 'head -n', 'head -n abc f', 'head -1 f missing', 'head -n 1 f g', 'head -n -1 f', 'head --nope f',
  'tail missing', 'tail d', 'tail -Q f', 'tail -n', 'tail -n abc f', 'tail -n 1 f g', 'tail -n -1 f', 'tail -n +2 f', 'tail --nope f',
  'cut -f1 missing', 'cut -f1 d', 'cut f', 'cut', 'cut -f', 'cut -d', 'cut -f abc f', 'cut -f 0 f', 'cut -c 0 f', 'cut -f1 -c1 f', 'cut -Q f', 'cut --nope f', 'cut -d ab -f1 f',
  'grep', 'grep x missing', 'grep x d', 'grep -Q x f', 'grep --nope x f', 'grep -c b f missing', 'grep "(" f',
  // moving around and looking
  'cd missing', 'cd f', 'cd -Q', 'pwd x | wc -l', 'pwd -Q', 'ls missing', 'ls -9 f', 'ls --nope', 'ls f missing',
  // making and removing
  'mkdir', 'mkdir d', 'mkdir -Q x', 'mkdir -p', 'mkdir a/b', 'touch', 'touch no/x', 'touch -Q x', 'rm', 'rm -f', 'rm missing', 'rm -f missing', 'rm d', 'rm -Q f', 'rm -r .',
  'cp', 'cp f', 'cp missing x', 'cp d x', 'cp f no/x', 'cp f f', 'cp -Q f x', 'cp f g d; ls d | cat', 'cp f g nope', 'mv', 'mv f', 'mv missing x', 'mv f f', 'mv g no/x', 'mv -Q f x', 'mv d e; ls e | cat', 'mv d d',
  'chmod', 'chmod +x', 'chmod +x missing', 'chmod abc f',
  'echo hi | tee no/x', 'echo hi | tee d', 'tee -Q x',
  // bash's own
  'printf', 'printf "%d" abc', 'printf "hi" a', 'printf "%s"', 'printf "%d-" 1 2', 'echo -e "a\\tb"', 'echo -E "a\\tb"', 'echo -ne "a"',
  'sleep', 'sleep abc', 'sleep -Q', 'kill', 'kill 99999', 'kill -s', 'wait abc', 'wait 99999', 'jobs -Q',
  'exit abc', 'exit 1 2', 'whoami x', 'whoami -Q', 'id nosuchuser', 'id -Q', 'history -Q', 'true x', 'false x',
  'bash missing', 'bash d', 'bash -Q', 'nosuch', './missing', './d',
  '> no/x', 'cat < missing', 'echo hi > d',
  // An empty name, which is what "$1" gives a script run with no argument.
  'cat ""', 'grep x ""', 'wc ""', 'wc -l ""', 'head ""', 'tail ""', 'sort ""', 'uniq ""', 'cut -f1 ""', 'ls ""', 'rm ""', 'rm -f ""', 'touch ""', 'mkdir ""', '> ""', 'cat < ""', 'cp "" x', 'cp f ""', 'mv "" x', 'chmod +x ""', 'bash ""', 'echo hi | tee ""',
  `printf 'grep 500 "$1"\\n' > s; bash s; echo $?`,
];

test('bad uses of every command match real bash: status, stdout and the words of the error', () => {
  const wrong: string[] = [];
  for (const line of BAD_USES) {
    const { real, ours } = both(line);
    if (ours.code !== real.code || ours.out !== real.out || JSON.stringify(ours.err) !== JSON.stringify(real.err)) {
      wrong.push(`${line}\nreal: ${real.code} ${JSON.stringify(real.out)} ${JSON.stringify(real.err)}\nours: ${ours.code} ${JSON.stringify(ours.out)} ${JSON.stringify(ours.err)}`);
    }
  }
  assert.equal(wrong.length, 0, `${wrong.length} of ${BAD_USES.length} differ:\n\n${wrong.join('\n\n')}`);
});

// Unquoted $1 used to act as if it were quoted, so the difference the lesson teaches
// couldn't be seen in the lesson's lab. Word splitting and dropped empties are the point.
const WORDS = [
  `touch 'a b'; printf 'grep x $1\\n' > s; bash s 'a b'; echo $?`,
  `touch 'a b'; printf 'grep -c x "$1"\\n' > s; bash s 'a b'; echo $?`,
  `printf 'printf "%%s\\\\n" $1\\n' > s; bash s 'a b'`,
  `printf 'printf "%%s\\\\n" "$1"\\n' > s; bash s 'a b'`,
  `printf 'printf "[%%s]" a $1 b\\n' > s; bash s`,
  `printf 'printf "[%%s]" a "$1" b\\n' > s; bash s`,
  `printf 'echo $1$2\\n' > s; bash s 'a  b' 'c'`,
  `printf 'echo ${1}x\\n' > s; bash s V`,
  `printf 'echo "${1}x"\\n' > s; bash s V`,
  `echo $NOT_SET_ANYWHERE a`,
  `echo "$NOT_SET_ANYWHERE" a`,
  // Each part of a pipe is its own process, so this exit ends that part and not the script.
  `printf 'exit 3 | cat\\necho carried on\\n' > s; bash s; echo $?`,
  `printf 'echo x > $1\\necho after $?\\n' > s; bash s`,
  // A script's errors name the script and the line, and this is what the lesson shows.
  `printf 'echo one\\ncd nowhere\\necho two\\n' > s; bash s`,
  `printf 'nosuchcommand\\n' > s; bash s; echo $?`,
  `printf '#!/bin/bash\\ncd nowhere\\n' > s; chmod u+x s; ./s; echo $?`,
];

test('words: an unquoted $1 splits and an empty one vanishes, and a script names itself in errors', () => {
  const wrong: string[] = [];
  for (const line of WORDS) {
    const { real, ours } = both(line);
    if (ours.code !== real.code || ours.out !== real.out || JSON.stringify(ours.err) !== JSON.stringify(real.err)) {
      wrong.push(`${line}\nreal: ${real.code} ${JSON.stringify(real.out)} ${JSON.stringify(real.err)}\nours: ${ours.code} ${JSON.stringify(ours.out)} ${JSON.stringify(ours.err)}`);
    }
  }
  assert.equal(wrong.length, 0, wrong.join('\n\n'));
});

test('the status that matters in the lesson: grep says 0, 1 or 2 here as in real bash', () => {
  // grep -c counts and exits 1 for "looked, found nothing", and 2 for "couldn't look".
  for (const [line, code] of [['grep -c b f', 0], ['grep -c zebra f', 1], ['grep -c b missing', 2], ['grep -c b d', 2]] as const) {
    const { real, ours } = both(line);
    assert.equal(real.code, code, `real bash changed its mind about: ${line}`);
    assert.equal(ours.code, code, line);
    assert.equal(ours.out, real.out, line);
  }
});

test('where bash versions disagree with each other, the sandbox still refuses out loud', () => {
  // bash 5.2 and 5.3 give different statuses or words for these, so there's no one
  // answer to match. Both refuse, and neither reads as success.
  for (const line of ['cd f g', 'kill abc']) {
    const { real, ours } = both(line);
    assert.notEqual(real.code, 0, line);
    assert.notEqual(ours.code, 0, line);
    assert.equal(ours.out, real.out, line);
    assert.ok(ours.err.length > 0 && real.err.length > 0, line);
  }
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
