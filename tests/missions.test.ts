// A mission whose last step can never turn green is the worst bug this site can
// have: it looks like the learner's fault. Each mission is played here using
// only its own hints, and every step must end up done. A second pass checks the
// steps are not born done - a check that is already true teaches nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIT_MISSIONS, KUBE_MISSIONS, kubeObserve, kubeWatch, type KubeState } from '../src/lib/missions.ts';
import { run } from '../src/lib/git/shell.ts';
import { kubectl } from '../src/lib/kube/kubectl.ts';

const commands = (hint: string) => hint.split(/\s{2}(?:then|or)\s{2}/).map((c) => c.trim());

for (const m of Object.values(GIT_MISSIONS)) {
  test(`git mission "${m.id}" is completable from its hints`, () => {
    const s = m.setup();
    assert.ok(!m.steps.every((st) => st.done(s)), 'not complete before starting');
    for (const step of m.steps) {
      for (let cmd of commands(step.hint ?? '')) {
        if (cmd.includes('<tree>')) {
          const tree = s.repo.commit(s.repo.headSha()!).tree;
          cmd = `git cat-file -p ${tree.slice(0, 7)}`;
        }
        if (cmd.startsWith('copy the tree')) cmd = `git cat-file -p ${s.repo.commit(s.repo.headSha()!).tree.slice(0, 7)}`;
        s.history.push(cmd);
        const out = run(s.repo, cmd);
        const errs = out.filter((l) => l.kind === 'err' && !/CONFLICT|Automatic merge failed/.test(l.text));
        assert.deepEqual(errs, [], `"${cmd}" errored`);
      }
      assert.ok(step.done(s), `step "${step.text}" not done after its hint`);
    }
    assert.ok(m.steps.every((st) => st.done(s)), 'every step still done at the end');
  });
}

test('reading the cleaned file does not count as finding the leaked key', () => {
  // The lesson is that the key survives in history. Looking at HEAD, where it
  // is gone, proves the opposite, so it must not tick the last step.
  const m = GIT_MISSIONS['git-secret-history'];
  const s = m.setup();
  for (const cmd of ['echo "PAYMENT_KEY=panda_live_7Qx2EXAMPLE" >> config.env', 'git commit -am "add payment key"']) { s.history.push(cmd); run(s.repo, cmd); }
  assert.equal(m.steps[2].done(s), false, 'committing the key is not the fix');
  for (const cmd of ['echo "PORT=8080" > config.env', 'git commit -am "remove key"', 'git show HEAD:config.env', 'cat config.env']) { s.history.push(cmd); run(s.repo, cmd); }
  assert.equal(m.steps[2].done(s), true);
  assert.equal(m.steps[3].done(s), false, 'HEAD and the working file no longer hold the key');
  s.history.push('git show HEAD~1'); run(s.repo, 'git show HEAD~1');
  assert.equal(m.steps[3].done(s), true, 'the commit that added the key shows it in its diff');
});

function playKube(s: KubeState, cmd: string) {
  const pods = [...s.cluster.pods.values()].filter((p) => p.status !== 'Terminating');
  cmd = cmd
    .replace('<the Pending one>', pods.find((p) => !p.node)?.name ?? 'none')
    .replace('<starved-...>', pods.find((p) => p.owner.startsWith('starved-'))?.name ?? 'none')
    .replace('<impatient-...>', pods.find((p) => p.owner.startsWith('impatient-'))?.name ?? 'none')
    .replace('<copy a name from get pods>', pods[0]?.name ?? 'none');
  kubeObserve(s, cmd);
  const out = kubectl(s.cluster, cmd);
  assert.deepEqual(out.filter((l) => l.kind === 'err'), [], `"${cmd}" errored`);
}

for (const m of Object.values(KUBE_MISSIONS)) {
  test(`kube mission "${m.id}" is completable from its hints`, () => {
    const s = m.setup();
    assert.ok(!m.steps.every((st) => st.done(s)), 'not complete before starting');
    for (const step of m.steps) {
      for (const cmd of commands(step.hint ?? '')) playKube(s, cmd);
      for (let i = 0; i < 60 && !step.done(s); i++) { s.cluster.step(); kubeWatch(s); }
      assert.ok(step.done(s), `step "${step.text}" not done within 60 ticks of its hint`);
    }
  });
}

test('the wrong fix for the probe-killed pod does not pass the mission', () => {
  const m = KUBE_MISSIONS['kube-two-crashes'];
  const s = m.setup();
  playKube(s, 'kubectl set resources deployment impatient --limits=memory=1Gi');
  for (let i = 0; i < 80; i++) s.cluster.step();
  assert.equal(m.steps[4].done(s), false);
});

test('deleting the quota instead of raising it does not pass the mission', () => {
  const m = KUBE_MISSIONS['kube-quota'];
  const s = m.setup();
  playKube(s, 'kubectl delete quota pandas');
  for (let i = 0; i < 80; i++) s.cluster.step();
  assert.equal(m.steps[3].done(s), false, 'six healthy pods, guardrail gone: not a pass');
});
