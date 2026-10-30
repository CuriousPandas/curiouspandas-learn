import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline, type Policy } from '../src/lib/delivery/pipeline.ts';
import { Engine, render } from '../src/lib/delivery/iac.ts';
import { Release, CANARY } from '../src/lib/delivery/release.ts';
import { PIPELINE_MISSION, IAC_MISSION, RELEASE_MISSION } from '../src/lib/delivery/missions.ts';

const P = (p: Partial<Policy> = {}): Policy => ({ cache: false, flaky: 'block', promote: false, ...p });

// ---- pipeline ---------------------------------------------------------------

test('the flaky test fails sometimes with no bug at all - one attempt in three', () => {
  const pipe = new Pipeline();
  const stopped = [1, 2, 3, 4, 5, 6].map(() => pipe.push('code', P()).outcome === 'stopped');
  assert.equal(stopped.filter(Boolean).length, 2, 'two of six clean pushes go red on the flake alone');
});

test('retrying until green ships the race condition, every time', () => {
  for (let warm = 0; warm < 3; warm++) {
    const pipe = new Pipeline();
    for (let i = 0; i < warm; i++) pipe.push('code', P({ flaky: 'retry' }));
    const r = pipe.push('race', P({ flaky: 'retry' }));
    assert.equal(r.outcome, 'shipped', `retry policy, ${warm} earlier pushes`);
    assert.equal(r.shippedRace, true);
  }
});

test('skipping the flaky test ships the race too', () => {
  const r = new Pipeline().push('race', P({ flaky: 'skip' }));
  assert.equal(r.outcome, 'shipped');
  assert.equal(r.shippedRace, true);
});

test('a deterministic test never flakes, and stops the race every time', () => {
  const pipe = new Pipeline();
  for (let i = 0; i < 6; i++) assert.equal(pipe.push('code', P({ flaky: 'deterministic' })).outcome, 'shipped');
  for (let i = 0; i < 3; i++) {
    const r = pipe.push('race', P({ flaky: 'deterministic' }));
    assert.equal(r.stoppedAt, 'test');
    assert.equal(r.shippedRace, false);
  }
});

test('the dependency cache hits on the second push and misses when the lockfile changes', () => {
  const pipe = new Pipeline();
  assert.equal(pipe.push('code', P({ cache: true, flaky: 'deterministic' })).cacheHit, false);
  assert.equal(pipe.push('code', P({ cache: true, flaky: 'deterministic' })).cacheHit, true);
  assert.equal(pipe.push('lockfile', P({ cache: true, flaky: 'deterministic' })).cacheHit, false);
});

test('rebuilding for production ships an artifact staging never ran; promoting ships the same one', () => {
  const pipe = new Pipeline();
  const rebuilt = pipe.push('code', P({ flaky: 'deterministic' }));
  assert.notEqual(rebuilt.prodArtifact, rebuilt.stagingArtifact);
  const promoted = pipe.push('code', P({ flaky: 'deterministic', promote: true }));
  assert.equal(promoted.prodArtifact, promoted.stagingArtifact);
});

test('pipeline mission: played from its hints it completes; the retry fix leaves step 3 open', () => {
  const s = PIPELINE_MISSION.setup();
  const pipe = s.pipe;
  const done = () => PIPELINE_MISSION.steps.map((st) => st.done(s));
  pipe.push('code', P({ flaky: 'deterministic' }));
  pipe.push('code', P({ cache: true, flaky: 'deterministic' }));
  pipe.push('code', P({ cache: true, flaky: 'deterministic' }));
  pipe.push('race', P({ cache: true, flaky: 'retry' }));
  assert.deepEqual(done().slice(0, 3), [true, true, false], 'shipping the race by retrying does not count');
  pipe.push('race', P({ cache: true, flaky: 'deterministic' }));
  pipe.push('code', P({ cache: true, flaky: 'deterministic', promote: true }));
  assert.deepEqual(done(), [true, true, true, true]);
});

// ---- infrastructure as code -------------------------------------------------

test('a first plan creates all three; apply needs a plan, and refuses a stale one', () => {
  const e = new Engine();
  assert.equal(e.apply().ok, false);
  const p = e.plan();
  assert.deepEqual(p.changes.map((c) => c.action), ['create', 'create', 'create']);
  e.edit('server', { size: 'large', image: 'ubuntu-24.04' });
  assert.match(e.apply().message, /Plan again/);
  e.plan();
  assert.equal(e.apply().ok, true);
});

test('a size change is an in-place update; an image change replaces the server and the DNS record follows', () => {
  const e = new Engine();
  e.plan(); e.apply();
  const ipBefore = e.cloud.objects.get('dns')!.attrs.points_to;
  e.edit('server', { size: 'large', image: 'ubuntu-24.04' });
  assert.deepEqual(e.plan().changes.map((c) => `${c.kind}:${c.action}`), ['server:update']);
  e.apply();
  e.edit('server', { size: 'large', image: 'ubuntu-26.04' });
  const p = e.plan();
  assert.deepEqual(p.changes.map((c) => `${c.kind}:${c.action}`), ['server:replace', 'dns:update']);
  assert.ok(p.changes[0].fields.find((f) => f.name === 'image')!.forces);
  assert.match(render(p).map((l) => l.text).join('\n'), /must be replaced[\s\S]*# forces replacement[\s\S]*Plan: 1 to add, 1 to change, 1 to destroy\./);
  e.apply();
  assert.notEqual(e.cloud.objects.get('dns')!.attrs.points_to, ipBefore, 'the record points at the new server');
  assert.equal(e.cloud.objects.get('dns')!.attrs.points_to, e.cloud.ipOf(e.cloud.objects.get('server')!.id));
});

test('a console change is drift: the next plan reports it and puts the configuration back', () => {
  const e = new Engine();
  e.plan(); e.apply();
  e.console('server', 'size', 'xlarge');
  const p = e.plan();
  assert.deepEqual(p.drifted, ['server']);
  const c = p.changes.find((x) => x.kind === 'server')!;
  assert.equal(c.action, 'update');
  assert.deepEqual(c.fields.map((f) => [f.name, f.from, f.to]), [['size', 'xlarge', 'small']]);
});

test('iac mission: completes from its hints; applying the bucket removal leaves the last step open', () => {
  const run = (applyRemoval: boolean) => {
    const s = IAC_MISSION.setup(); const e = s.eng;
    e.plan(); e.apply();
    e.edit('server', { size: 'large', image: 'ubuntu-24.04' }); e.plan(); e.apply();
    e.console('server', 'size', 'xlarge'); e.plan(); e.apply();
    e.edit('server', { size: 'large', image: 'ubuntu-26.04' }); e.plan(); e.apply();
    const bucket = e.desired.bucket!;
    e.edit('bucket', undefined); e.plan();
    if (applyRemoval) e.apply();
    e.edit('bucket', bucket); e.plan();
    return IAC_MISSION.steps.map((st) => st.done(s));
  };
  assert.deepEqual(run(false), [true, true, true, true, true]);
  assert.equal(run(true)[4], false, 'destroying the bucket and recreating it empty does not count');
});

// ---- release strategies -------------------------------------------------------

test('a good canary is promoted at max weight by the analysis', () => {
  const r = new Release('canary', 'good').runToEnd();
  assert.equal(r.status, 'promoted');
  assert.deepEqual(r.ticks.map((t) => t.newShare * 100), [CANARY.stepWeight, CANARY.maxWeight]);
});

test('a bad canary is rolled back after the failed-check threshold, at a quarter of traffic', () => {
  const r = new Release('canary', 'bad').runToEnd();
  assert.equal(r.status, 'rolled-back');
  assert.equal(r.ticks.length, CANARY.threshold);
  assert.ok(r.ticks.every((t) => t.newShare === CANARY.stepWeight / 100), 'never advanced past the first step');
  assert.ok(r.ticks.every((t) => t.successRate! < CANARY.minSuccess));
});

test('the same bad build fails more requests under rolling and blue-green than under a canary', () => {
  const canary = new Release('canary', 'bad').runToEnd().failedRequests;
  const rolling = new Release('rolling', 'bad').runToEnd().failedRequests;
  const blueGreen = new Release('bluegreen', 'bad').runToEnd().failedRequests;
  assert.ok(canary < rolling && rolling < blueGreen, `canary ${canary}, rolling ${rolling}, blue-green ${blueGreen}`);
});

test('release mission: completes from its hints; promoting the bad canary by hand does not count', () => {
  const s = RELEASE_MISSION.setup();
  const go = (r: Release) => { s.releases.push(r); return r; };
  go(new Release('canary', 'good')).runToEnd();
  go(new Release('rolling', 'bad')).runToEnd();
  const bg = go(new Release('bluegreen', 'bad')); bg.step(); bg.rollback();
  const forced = go(new Release('canary', 'bad')); forced.step(); forced.promoteNow();
  assert.deepEqual(RELEASE_MISSION.steps.map((st) => st.done(s)), [true, true, true, false]);
  go(new Release('canary', 'bad')).runToEnd();
  assert.deepEqual(RELEASE_MISSION.steps.map((st) => st.done(s)), [true, true, true, true]);
});
