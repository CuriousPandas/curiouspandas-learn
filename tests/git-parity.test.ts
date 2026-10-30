// The playground claims its hashes are real git hashes. This is the proof: the
// same session is replayed through the sandbox and through the git binary, and
// every commit hash, tree listing and conflict file must agree byte for byte.
// If git is not installed the test fails rather than skipping - a parity test
// that quietly skips reads as parity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Repo } from '../src/lib/git/repo.ts';
import { run } from '../src/lib/git/shell.ts';

type Step = { write: [string, string] } | { del: string } | { git: string[] } | { check: string };

class Twin {
  dir = mkdtempSync(join(tmpdir(), 'cp-parity-'));
  t = 1767225600;
  repo = new Repo({ clock: () => ({ time: this.t, tz: '+0000' }), user: { name: 'Curious Panda', email: 'panda@curiouspandas.dev' } });
  env: NodeJS.ProcessEnv;

  constructor() {
    const empty = join(this.dir, '..', `cp-empty-gitconfig-${process.pid}`);
    writeFileSync(empty, '');
    this.env = {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty,
      GIT_AUTHOR_NAME: 'Curious Panda', GIT_AUTHOR_EMAIL: 'panda@curiouspandas.dev',
      GIT_COMMITTER_NAME: 'Curious Panda', GIT_COMMITTER_EMAIL: 'panda@curiouspandas.dev',
    };
    this.real(['init', '-q', '-b', 'main']);
    this.real(['config', 'core.autocrlf', 'false']);
    this.real(['config', 'commit.gpgsign', 'false']);
    run(this.repo, 'git init');
  }

  real(args: string[], allowFail = false): string {
    const date = `${this.t} +0000`;
    try {
      return execFileSync('git', args, { cwd: this.dir, env: { ...this.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: 'utf8' });
    } catch (e) {
      if (allowFail) return String((e as { stdout?: string }).stdout ?? '');
      throw e;
    }
  }

  step(s: Step) {
    if ('write' in s) {
      const [p, c] = s.write;
      mkdirSync(dirname(join(this.dir, p)), { recursive: true });
      writeFileSync(join(this.dir, p), c);
      this.repo.workdir.set(p, c);
    } else if ('del' in s) {
      rmSync(join(this.dir, s.del));
      this.repo.workdir.delete(s.del);
    } else if ('git' in s) {
      this.t += 60;
      const sandbox = run(this.repo, 'git ' + s.git.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' '));
      this.real(s.git, true);
      const errs = sandbox.filter((l) => l.kind === 'err');
      if (s.git[0] !== 'merge') assert.deepEqual(errs, [], `sandbox refused: git ${s.git.join(' ')}`);
    } else this.compare(s.check);
  }

  compare(label: string) {
    const realHead = this.real(['rev-parse', 'HEAD']).trim();
    assert.equal(this.repo.headSha(), realHead, `${label}: HEAD differs`);
    const realTree = this.real(['cat-file', '-p', 'HEAD^{tree}']).trim();
    assert.equal(run(this.repo, `git cat-file -p ${this.repo.commit(realHead).tree}`).map((l) => l.text).join('\n'), realTree, `${label}: tree listing`);
    for (const b of this.real(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads']).trim().split('\n')) {
      const [name, sha] = b.split(' ');
      assert.equal(this.repo.branches.get(name), sha, `${label}: branch ${name}`);
    }
  }

  file(p: string) { return { real: readFileSync(join(this.dir, p), 'utf8'), sandbox: this.repo.workdir.get(p) }; }

  done() { rmSync(this.dir, { recursive: true, force: true }); }
}

test('first commit, nested trees, and the a.txt-beside-a/ sort trap', () => {
  const w = new Twin();
  for (const s of [
    { write: ['hello.txt', 'hello\n'] }, { git: ['add', '.'] }, { git: ['commit', '-m', 'first commit'] }, { check: 'root commit' },
    { write: ['src/app.js', 'console.log("hi")\n'] }, { write: ['a.txt', 'file\n'] }, { write: ['a/b.txt', 'dir\n'] },
    { write: ['docs/guide/intro.md', '# Intro\n'] }, { write: ['empty.txt', ''] },
    { git: ['add', '.'] }, { git: ['commit', '-m', 'nested'] }, { check: 'nested trees' },
    { del: 'a.txt' }, { git: ['add', '.'] }, { git: ['commit', '-m', 'delete a file'] }, { check: 'deletion' },
  ] as Step[]) w.step(s);
  w.done();
});

test('fast-forward, then a clean three-way merge with the default message', () => {
  const w = new Twin();
  for (const s of [
    { write: ['story.txt', 'once\nupon\na\ntime\nthere\nwas\na\npanda\n'] }, { git: ['add', '.'] }, { git: ['commit', '-m', 'start'] },
    { git: ['switch', '-c', 'feature'] }, { write: ['story.txt', 'ONCE\nupon\na\ntime\nthere\nwas\na\npanda\n'] },
    { git: ['commit', '-am', 'shout'] }, { git: ['switch', 'main'] }, { git: ['merge', 'feature'] }, { check: 'fast-forward' },
    { git: ['switch', 'feature'] }, { write: ['story.txt', 'ONCE\nupon\na\ntime\nthere\nwas\na\nred panda\n'] }, { git: ['commit', '-am', 'red'] },
    { git: ['switch', 'main'] }, { write: ['story.txt', 'ONCE\nupon\nthe\ntime\nthere\nwas\na\npanda\n'] }, { git: ['commit', '-am', 'the'] },
    { git: ['merge', '--no-edit', 'feature'] }, { check: 'three-way merge' },
  ] as Step[]) w.step(s);
  assert.equal(w.file('story.txt').sandbox, w.file('story.txt').real);
  w.done();
});

test('a conflict writes the same markers as git, and the resolution commits identically', () => {
  const w = new Twin();
  for (const s of [
    { write: ['menu.txt', 'bamboo\nleaves\nshoots\n'] }, { git: ['add', '.'] }, { git: ['commit', '-m', 'menu'] },
    { git: ['branch', 'snack'] },
    { write: ['menu.txt', 'bamboo\napples\nshoots\n'] }, { git: ['commit', '-am', 'apples'] },
    { git: ['switch', 'snack'] }, { write: ['menu.txt', 'bamboo\npears\nshoots\nhoney\n'] }, { git: ['commit', '-am', 'pears'] },
    { git: ['switch', 'main'] }, { git: ['merge', 'snack'] },
  ] as Step[]) w.step(s);
  const f = w.file('menu.txt');
  assert.equal(f.sandbox, f.real, 'conflict file');
  assert.match(f.real, /<<<<<<< HEAD\napples\n=======\npears\n>>>>>>> snack/);
  for (const s of [
    { write: ['menu.txt', 'bamboo\napples\npears\nshoots\nhoney\n'] }, { git: ['add', 'menu.txt'] },
    { git: ['commit', '-m', 'both fruits'] }, { check: 'resolved merge' },
  ] as Step[]) w.step(s);
  w.done();
});

test('a deleted secret reads back out of history exactly as git prints it', () => {
  // The secrets-in-git lesson rests on this: the sandbox must resolve HEAD~N
  // and ^N the way git does, and `git show <rev>:<path>` must return the bytes
  // git returns, or the lesson would be teaching its own invention.
  const w = new Twin();
  for (const s of [
    { write: ['config.env', 'PORT=8080\n'] }, { write: ['README.md', '# Bamboo shop\n'] },
    { git: ['add', '.'] }, { git: ['commit', '-m', 'start the shop'] },
    { write: ['config.env', 'PORT=8080\nPAYMENT_KEY=panda_live_7Qx2EXAMPLE\n'] }, { git: ['commit', '-am', 'add payment key'] },
    { write: ['config.env', 'PORT=8080\n'] }, { git: ['commit', '-am', 'remove key'] }, { check: 'after the fix' },
  ] as Step[]) w.step(s);
  for (const rev of ['HEAD~1', 'HEAD^', 'HEAD~2', 'HEAD^1', 'HEAD~1^', 'main~1', 'HEAD^0']) {
    assert.equal(w.repo.resolve(rev), w.real(['rev-parse', rev]).trim(), `rev ${rev}`);
  }
  for (const spec of ['HEAD~1:config.env', 'HEAD:config.env', 'HEAD~2:README.md']) {
    const sandbox = run(w.repo, `git show ${spec}`).map((l) => l.text).join('\n');
    assert.equal(sandbox, w.real(['show', spec]).replace(/\n$/, ''), `git show ${spec}`);
  }
  assert.match(run(w.repo, 'git show HEAD~1:config.env').map((l) => l.text).join('\n'), /panda_live_7Qx2EXAMPLE/);
  assert.throws(() => w.repo.resolve('HEAD~5'), /unknown revision/);
  assert.match(run(w.repo, 'git show HEAD~2:missing.txt')[0].text, /does not exist in 'HEAD~2'/);
  w.done();
});

test('hash-object agrees with git for text the learner types', () => {
  const w = new Twin();
  w.step({ write: ['note.txt', 'Curious pandas learn by breaking things.\n'] });
  const real = w.real(['hash-object', 'note.txt']).trim();
  assert.equal(run(w.repo, 'git hash-object note.txt')[0].text, real);
  w.done();
});
