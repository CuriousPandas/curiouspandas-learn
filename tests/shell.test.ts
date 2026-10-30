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
