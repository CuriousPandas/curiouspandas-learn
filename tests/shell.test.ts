// The Linux track's sandbox shell and missions. Each mission is played from its
// own hints and must finish; each tempting wrong fix (chmod 777, kill -9 first,
// counting every request) must leave the mission unfinished.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINUX_MISSIONS, world, NOISY } from '../src/lib/shell/missions.ts';
import { Shell, applyMode, tokenize, parse } from '../src/lib/shell/shell.ts';
import { modeString, canAccess, USERS, R } from '../src/lib/shell/fs.ts';

const commands = (hint: string) => hint.split(/\s{2}(?:then|or)\s{2}/).map((c) => c.trim());
const out = (sh: Shell, line: string) => sh.run(line).map((l) => l.text).join('\n');

for (const m of Object.values(LINUX_MISSIONS)) {
  test(`linux mission "${m.id}" is completable from its hints`, () => {
    const s = m.setup();
    assert.ok(!m.steps.every((st) => st.done(s)), 'not complete before starting');
    assert.ok(!m.steps[0].done(s), 'the first step is not born done');
    for (const step of m.steps) {
      for (const cmd of commands(step.hint ?? '')) s.sh.run(cmd);
      assert.ok(step.done(s), `step "${step.text}" not done after its hint`);
    }
    assert.ok(m.steps.every((st) => st.done(s)), 'every step still done at the end');
  });
}

const play = (id: string, lines: string[]) => {
  const m = LINUX_MISSIONS[id];
  const s = m.setup();
  for (const l of lines) s.sh.run(l);
  return { s, done: m.steps.map((st) => st.done(s)) };
};

test('chmod 777 makes deploy.sh run but does not pass: anyone could rewrite it', () => {
  const { s, done } = play('linux-perms', ['./deploy.sh', 'ls -l deploy.sh', 'chmod 777 deploy.sh', './deploy.sh']);
  assert.equal(s.sh.scriptRuns.at(-1)?.code, 0, 'it does run');
  assert.equal(done[2], false);
  assert.equal(done[3], false);
});

test('chmod 775 (group-writable) does not pass either; 744 and 755 do', () => {
  assert.equal(play('linux-perms', ['chmod 775 deploy.sh']).done[2], false);
  for (const m of ['744', '755', 'u+x', '700']) assert.equal(play('linux-perms', ['./deploy.sh', 'ls -l', `chmod ${m} deploy.sh`]).done[2], true, m);
});

test('kill -9 on orders loses its work and the graceful step never passes', () => {
  const { s, done } = play('linux-signals', ['ps -e', 'kill -9 311']);
  assert.equal(done[1], false);
  assert.ok(s.sh.signals.some((g) => g.pid === 311 && g.sig === 'KILL'));
});

test('forcing stuck before asking politely does not pass: there was nothing to learn from', () => {
  const { done } = play('linux-signals', ['ps -e', 'kill 311', 'kill -9 312', 'ps -e']);
  assert.equal(done[2], false);
  assert.equal(done[3], false);
});

test('counting every request names the wrong client', () => {
  const { done, s } = play('linux-pipes', ['wc -l access.log', "grep ' 500$' access.log", "cut -d ' ' -f 1 access.log | sort | uniq -c | sort -rn"]);
  assert.equal(done[2], false);
  assert.match(s.sh.outputs.at(-1)!.split('\n')[0], /^\s+12 10\.0\.0\.8$/, 'the busiest client overall is a different one');
  assert.equal(NOISY.ip, '10.0.4.17');
});

test('owner, group and other are checked in order: the first class that matches decides', () => {
  // path_resolution(7): an owner with no read bit is refused even though
  // "other" may read. The class is chosen first; its bits are then final.
  const sh = world();
  sh.fs.put('/home/panda/odd.txt', { type: 'file', content: 'x', mode: 0o044 });
  assert.equal(canAccess(sh.fs.lookup('/home/panda/odd.txt', USERS.panda)!, USERS.panda, R), false);
  assert.match(out(sh, 'cat odd.txt'), /cat: odd\.txt: Permission denied/);
  assert.equal(canAccess(sh.fs.lookup('/home/panda/odd.txt', USERS.web)!, USERS.web, R), true);
});

test('deleting a file needs write on its folder, not on the file', () => {
  const sh = world();
  sh.fs.put('/home/panda/locked.txt', { type: 'file', content: 'x', mode: 0o444 });
  assert.equal(out(sh, 'echo y > locked.txt'), 'bash: locked.txt: Permission denied');
  assert.equal(out(sh, 'rm locked.txt; ls locked.txt'), "ls: cannot access 'locked.txt': No such file or directory");
});

test('only the owner may chmod; a file you do not own stays out of reach', () => {
  const sh = world();
  assert.match(out(sh, 'chmod 644 /etc/shadow'), /Operation not permitted/);
  assert.match(out(sh, 'cat /etc/shadow'), /Permission denied/);
});

test('./script needs the execute bit, bash script only read; 126 and 127 mean different things', () => {
  const sh = world();
  sh.fs.put('/home/panda/s.sh', { type: 'file', content: 'echo ran\n' });
  assert.match(out(sh, './s.sh; echo $?'), /Permission denied\n126$/);
  assert.equal(out(sh, 'bash s.sh'), 'ran');
  assert.match(out(sh, 'nosuchthing; echo $?'), /command not found\n127$/);
});

test('modes: octal and symbolic agree with chmod(1), including +w honouring the umask', () => {
  const f = (mode: number) => modeString({ type: 'file', content: '', mode, owner: 'p', group: 'p', mtime: 0 });
  assert.equal(f(applyMode(0o644, '754', false)), '-rwxr-xr--');
  assert.equal(f(applyMode(0o644, 'u+x', false)), '-rwxr--r--');
  assert.equal(f(applyMode(0o644, '+x', false)), '-rwxr-xr-x');
  // No "who": the umask (022) masks the result, so +w only reaches the owner.
  assert.equal(f(applyMode(0o444, '+w', false)), '-rw-r--r--');
  assert.equal(f(applyMode(0o777, 'go-w', false)), '-rwxr-xr-x');
  assert.equal(f(applyMode(0o640, 'o=r,g+w', false)), '-rw-rw-r--');
  assert.throws(() => applyMode(0o644, 'z+q', false), /invalid mode/);
});

test('> truncates before the command runs, so cat f > f empties f', () => {
  const sh = world();
  out(sh, 'echo keep > f');
  out(sh, 'cat f > f');
  assert.equal(out(sh, 'cat f'), '');
});

test('&& and || follow exit statuses', () => {
  const sh = world();
  assert.equal(out(sh, 'false && echo no || echo yes'), 'yes');
  assert.equal(out(sh, 'true && echo yes || echo no'), 'yes');
});

test('quotes: single quotes keep $ literal, double quotes expand it', () => {
  const sh = world();
  assert.equal(out(sh, `echo '$HOME' "$HOME"`), '$HOME /home/panda');
});

test('unsupported commands are refused by name, never silently ignored', () => {
  const sh = world();
  assert.match(out(sh, 'sudo chmod 777 /etc/shadow'), /^sudo: /);
  assert.match(out(sh, 'vim notes.txt'), /no editor/);
  assert.equal(sh.status, 127);
});

test('syntax errors are reported, not half-run', () => {
  for (const l of ['ls |', 'true &&', "echo 'open"]) assert.throws(() => parse(tokenize(l)), /syntax|EOF/, l);
});

test('a job killed by a signal reports 128 + signal through wait', () => {
  const sh = world();
  for (const [sig, code] of [['TERM', 143], ['KILL', 137], ['INT', 130]] as const) {
    assert.equal(out(sh, `sleep 300 & kill -${sig} $!; wait $!; echo $?`).split('\n').pop(), String(code), sig);
  }
});

// ---- failure must never read as success

test('wc -l acces.log: the crash the shell-scripts lesson hit. It errors with status 1, and $? says so', () => {
  const sh = world();
  const lines = sh.run('wc -l acces.log');
  assert.deepEqual(lines.map((l) => [l.kind, l.text]), [['err', 'wc: acces.log: No such file or directory']]);
  assert.equal(sh.status, 1);
  assert.equal(out(sh, 'wc -l acces.log; echo $?'), 'wc: acces.log: No such file or directory\n1');
});

test('an unexpected JS exception says it is the sandbox\'s bug, and never reads as status 0', () => {
  const sh = world();
  const real = sh.fs.lookup.bind(sh.fs);
  const quiet = console.error;
  console.error = () => {};
  try {
    sh.fs.lookup = () => { throw new TypeError('planted'); };
    for (const line of ['ls', 'echo before; ls', 'cat notes.txt | wc -l']) {
      sh.status = 0;
      const lines = sh.run(line);
      assert.match(lines.at(-1)!.text, /bug in the sandbox, not your command.*planted/, line);
      assert.equal(lines.at(-1)!.kind, 'err', line);
      assert.notEqual(sh.status, 0, line);
    }
    // Output from before the failure isn't lost with it.
    assert.equal(sh.run('echo before; ls')[0].text, 'before');
    sh.fs.lookup = real;
    sh.run(`echo 'cat nope' > s.sh`);
    sh.fs.lookup = (abs, user) => { if (abs.endsWith('/nope')) throw new TypeError('planted in a script'); return real(abs, user); };
    const inScript = sh.run('bash s.sh');
    assert.match(inScript.at(-1)!.text, /bug in the sandbox, not your command/);
    assert.notEqual(sh.status, 0);
    // The script's own state didn't stay stuck: the prompt is the prompt again.
    sh.fs.lookup = real;
    assert.equal(out(sh, 'exit'), 'exit: this terminal stays open. In a script, exit ends the script');
  } finally { console.error = quiet; }
});

test('no command, however badly used, reaches the sandbox-bug message', () => {
  const commands = ['help', 'pwd', 'true', 'false', 'exit', 'whoami', 'hostname', 'id', 'history', 'cd', 'ls', 'cat', 'echo', 'printf', 'mkdir', 'touch', 'rm', 'cp', 'mv', 'tee', 'chmod', 'ps', 'kill', 'sleep', 'jobs', 'wait', 'grep', 'wc', 'sort', 'uniq', 'head', 'tail', 'cut', 'bash', 'sh'];
  const shapes = ['', 'missing', 'd', 'f', 'f/under', 'd/under', '/', '.', '..', '-Q', '--nope', '-', '--', '-n', '-n abc', '-f', '-d', '-s', '-r /', '-rf /', '-r .', '-r ..', 'f f', 'f d', 'd f', 'd d', 'f missing', 'missing f', 'missing missing2', 'f g h', '/etc/shadow', '/dev/null', '""', "''", '$1', '"$1"', '~', '*', '%', '%1', '0', '99999', 'abc', '+x', '777', '/etc/shadow f'];
  const quiet = console.error;
  const seen: string[] = [];
  console.error = (...a: unknown[]) => { seen.push(a.join(' ')); };
  let ran = 0;
  try {
    for (const c of commands) for (const shape of shapes) {
      const line = `${c} ${shape}`.trim();
      for (const whole of [line, `echo x | ${line}`, `${line} | cat`, `${line} > out.txt`]) {
        // A fresh machine each time: rm -r * here would hide the rest of the table.
        const sh = world();
        sh.fs.put('/home/panda/f', { type: 'file', content: 'b\na\n' });
        sh.fs.put('/home/panda/g', { type: 'file', content: 'x\n' });
        sh.fs.put('/home/panda/d', { type: 'dir' });
        const lines = sh.run(whole);
        const bug = lines.find((l) => /bug in the sandbox/.test(l.text));
        assert.equal(bug, undefined, `${whole} -> ${bug?.text}`);
        ran++;
      }
    }
  } finally { console.error = quiet; }
  assert.deepEqual(seen, []);
  assert.equal(ran, commands.length * shapes.length * 4, 'the table ran in full');
});

test('rm -r / is refused, as real rm refuses it: the lesson opens on that very command', () => {
  // Never run on a real machine by this test, for reasons that need no comment. The
  // wording is GNU rm's. It used to throw out of parentOf: no output, status 0.
  for (const line of ['rm -r /', 'rm -rf /', 'rm -rf "/"']) {
    const sh = world();
    const lines = sh.run(line);
    assert.match(lines[0].text, /it is dangerous to operate recursively on '\/'/, line);
    assert.equal(sh.status, 1, line);
    assert.ok(sh.fs.lookup('/home/panda/notes.txt', sh.user), `${line} deleted something`);
  }
  const sh = world();
  sh.run('cd projects');
  assert.match(out(sh, 'rm -r ..'), /refusing to remove '\.' or '\.\.' directory/);
  assert.ok(sh.fs.lookup('/home/panda/notes.txt', sh.user));
});

test('a printf whose format uses no values finishes: it used to hang the page', () => {
  const sh = world();
  assert.equal(out(sh, 'printf hi a b'), 'hi');
  assert.equal(sh.status, 0);
});

test('a script that runs itself stops with a message instead of overflowing the JS stack', () => {
  const sh = world();
  sh.run(`echo 'bash s.sh' > s.sh`);
  const lines = sh.run('bash s.sh');
  assert.ok(lines.some((l) => /this sandbox stops at 50 scripts/.test(l.text)), JSON.stringify(lines.slice(-1)));
  assert.equal(out(sh, 'pwd'), '/home/panda');
});

test('what real bash has and this sandbox lacks is refused by name, not "command not found"', () => {
  for (const line of ['! false', 'bash -c "echo hi"', '[[ 1 == 1 ]]', 'case x in', 'local a=1', '(echo hi)', 'echo hi 2>&1', 'echo `pwd`', 'awk 1 f']) {
    const sh = world();
    const lines = sh.run(line);
    assert.ok(lines.some((l) => l.kind === 'err'), `${line}: ${JSON.stringify(lines)}`);
    assert.ok(!lines.some((l) => /command not found|syntax error/.test(l.text)), `${line}: ${JSON.stringify(lines)}`);
    assert.notEqual(sh.status, 0, line);
  }
  // Refused, not mistaken for a file with a dash in its name.
  const sh = world();
  sh.run('touch -Q');
  assert.equal(sh.fs.lookup('/home/panda/-Q', sh.user), undefined, 'touch -Q made a file called -Q');
});

test('a #! line naming something that isn\'t there fails when the file is run directly, and only then', () => {
  const sh = world();
  sh.run(`echo '#!/no/such/thing' > s`);
  sh.run(`echo 'echo ran' >> s`);
  sh.run('chmod u+x s');
  const direct = sh.run('./s');
  assert.match(direct[0].text, /required file not found/);
  assert.equal(sh.status, 127);
  assert.equal(out(sh, 'bash s'), 'ran');
  assert.equal(sh.status, 0);
});
