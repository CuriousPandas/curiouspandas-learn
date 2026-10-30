// The Git strategy lessons' two simulators, and the ground truth behind them.
// The divergence model's numbers are the ones the lesson quotes. The history
// model's two warnings - rebasing a branch someone built on leaves them
// duplicate commits, and squashing it leaves them commits main never received -
// are replayed through the real git binary below. If git is missing these fail
// rather than skip: a check that quietly skips reads as a pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulate } from '../src/lib/gitflow/divergence.ts';
import { integrate, hurtSam, releasable, layout, SQUASH_TITLES } from '../src/lib/gitflow/history.ts';
import { BRANCH_MISSION, HISTORY_MISSION } from '../src/lib/gitflow/missions.ts';

const done = <S>(m: { steps: { done: (s: S) => boolean }[] }, s: S) => m.steps.map((st) => st.done(s));

test('a two-week branch saves eight files for one merge; daily merges never see more than one', () => {
  const long = simulate({ mergeEvery: 10, flag: false });
  assert.equal(long.merges.length, 1);
  assert.equal(long.largest, 8);
  const three = simulate({ mergeEvery: 3, flag: false });
  assert.equal(three.largest, 2);
  const daily = simulate({ mergeEvery: 1, flag: false });
  assert.equal(daily.largest, 1);
  assert.equal(daily.total, 1);
});

test('merging unfinished work without a flag exposes it; with a flag nothing is exposed', () => {
  assert.deepEqual(simulate({ mergeEvery: 1, flag: false }).exposedDays, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(simulate({ mergeEvery: 1, flag: true }).exposedDays, []);
  assert.deepEqual(simulate({ mergeEvery: 10, flag: false }).exposedDays, [], 'the long branch is safe for users - that is what makes it tempting');
});

test('branch mission: the long branch and the flagless daily merge both leave a step open', () => {
  const runs = [simulate({ mergeEvery: 10, flag: true }), simulate({ mergeEvery: 1, flag: false }), simulate({ mergeEvery: 3, flag: true })];
  assert.deepEqual(done(BRANCH_MISSION, { runs }), [true, true, false]);
  runs.push(simulate({ mergeEvery: 1, flag: true }));
  assert.deepEqual(done(BRANCH_MISSION, { runs }), [true, true, true]);
});

test('merge keeps the feature commits; rebase replaces them; squash collapses them', () => {
  const m = integrate('solo', 'merge');
  assert.deepEqual(m.main, ['M', 'C', 'B', 'A']);
  assert.deepEqual(m.commits.find((c) => c.id === 'M')!.parents, ['C', 'F2']);
  const r = integrate('solo', 'rebase');
  assert.deepEqual(r.main, ["F2'", "F1'", 'C', 'B', 'A'], 'a straight line, with new commits');
  const s = integrate('solo', 'squash');
  assert.deepEqual(s.main, ['S', 'C', 'B', 'A']);
  assert.ok(!layout(s).nodes.find((n) => n.id === 'F1')!.onMain);
});

test('on a shared branch only a merge leaves Sam nothing to untangle', () => {
  assert.equal(hurtSam(integrate('shared', 'merge')), false);
  const r = integrate('shared', 'rebase');
  assert.equal(r.samDuplicates.length, 2);
  const s = integrate('shared', 'squash');
  assert.equal(s.samRelists.length, 2);
  for (const o of [integrate('solo', 'rebase'), integrate('solo', 'squash')]) assert.equal(hurtSam(o), false, 'rewriting a private branch hurts nobody');
});

test('with a squash merge, release-please reads only the title', () => {
  assert.deepEqual(releasable(integrate('solo', 'squash', SQUASH_TITLES[0])), ['feat']);
  assert.deepEqual(releasable(integrate('solo', 'squash', 'Update search')), []);
  assert.deepEqual(releasable(integrate('solo', 'merge')), ['feat', 'fix'], 'a merge keeps each conventional commit');
});

test('history mission: rebasing or squashing the shared branch, or a vague title, leaves a step open', () => {
  const outcomes = [integrate('solo', 'rebase'), integrate('shared', 'rebase'), integrate('shared', 'squash'), integrate('solo', 'squash', 'WIP')];
  assert.deepEqual(done(HISTORY_MISSION, { outcomes }), [true, false, false]);
  outcomes.push(integrate('shared', 'merge'), integrate('solo', 'squash', SQUASH_TITLES[0]));
  assert.deepEqual(done(HISTORY_MISSION, { outcomes }), [true, true, true]);
});

// ---- ground truth: the same stories with the real git binary ---------------

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cp-strategy-'));
  const cfg = join(dir, 'gitconfig');
  writeFileSync(cfg, '');
  const env = {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: cfg,
    GIT_AUTHOR_NAME: 'Curious Panda', GIT_AUTHOR_EMAIL: 'panda@curiouspandas.dev',
    GIT_COMMITTER_NAME: 'Curious Panda', GIT_COMMITTER_EMAIL: 'panda@curiouspandas.dev',
  };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd: join(dir, cwd), env, encoding: 'utf8' }).trim();
  const commit = (cwd: string, file: string, msg: string) => { writeFileSync(join(dir, cwd, file), `${msg}\n`); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', msg); };
  // origin with A, B on main; you branch F1, F2 and push; Sam builds G on F2;
  // a teammate lands C on main.
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')], { env });
  execFileSync('git', ['clone', '-q', join(dir, 'origin.git'), join(dir, 'you')], { env });
  git('you', 'switch', '-q', '-c', 'main');
  commit('you', 'a.txt', 'chore: start the shop');
  commit('you', 'b.txt', 'feat: list products');
  git('you', 'push', '-q', 'origin', 'main');
  git('you', 'switch', '-q', '-c', 'feature');
  commit('you', 'f1.txt', 'feat(search): filter results by price');
  commit('you', 'f2.txt', 'fix(search): keep filters on page reload');
  git('you', 'push', '-q', 'origin', 'feature');
  execFileSync('git', ['clone', '-q', '-b', 'feature', join(dir, 'origin.git'), join(dir, 'sam')], { env });
  commit('sam', 'g.txt', 'feat(search): save a filter');
  git('you', 'switch', '-q', 'main');
  commit('you', 'c.txt', 'fix(cart): round totals');
  git('you', 'push', '-q', 'origin', 'main');
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('real git: rebasing the pushed branch leaves Sam each feature commit twice', () => {
  const s = sandbox();
  try {
    s.git('you', 'switch', '-q', 'feature');
    s.git('you', 'rebase', '-q', 'main');
    s.git('you', 'push', '-q', '--force', 'origin', 'feature');
    s.git('sam', 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'feature');
    const msgs = s.git('sam', 'log', '--format=%s').split('\n');
    const twice = [...new Set(msgs.filter((m, i) => msgs.indexOf(m) !== i))].sort();
    const model = [...integrate('shared', 'rebase').samDuplicates].sort();
    assert.deepEqual(twice, model);
  } finally { s.done(); }
});

test('real git: after a squash merge, Sam\'s branch still offers your commits to main', () => {
  const s = sandbox();
  try {
    s.git('you', 'merge', '-q', '--squash', 'feature');
    s.git('you', 'commit', '-q', '-m', SQUASH_TITLES[0]);
    s.git('you', 'push', '-q', 'origin', 'main');
    s.git('sam', 'fetch', '-q', 'origin');
    const relisted = s.git('sam', 'log', '--format=%s', 'origin/main..HEAD').split('\n').filter((m) => m !== 'feat(search): save a filter').sort();
    assert.deepEqual(relisted, [...integrate('shared', 'squash').samRelists].sort());
    assert.equal(s.git('you', 'log', '-1', '--format=%s', 'main'), SQUASH_TITLES[0], 'the squash commit carries the title');
  } finally { s.done(); }
});

test('real git: a merge commit keeps the ids Sam has, so his pull is a plain step', () => {
  const s = sandbox();
  try {
    const f2 = s.git('you', 'rev-parse', 'feature');
    s.git('you', 'merge', '-q', '--no-ff', '--no-edit', 'feature');
    s.git('you', 'push', '-q', 'origin', 'main');
    s.git('sam', 'fetch', '-q', 'origin');
    assert.equal(s.git('sam', 'merge-base', '--is-ancestor', f2, 'origin/main') === '', true);
    assert.equal(s.git('sam', 'log', '--format=%s', 'origin/main..HEAD'), 'feat(search): save a filter', 'Sam has only his own commit left to offer');
  } finally { s.done(); }
});
