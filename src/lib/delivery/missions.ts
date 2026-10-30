// Missions for the Delivery track, in the shape of src/lib/missions.ts. They
// check the state the learner produced, and the tempting fix leaves the step
// open: retrying a flaky test until it goes green ships the race; promoting a
// failing canary by hand gets it to production, which is the opposite of the goal.

import type { Mission } from '../missions.ts';
import { Pipeline } from './pipeline.ts';
import { Engine } from './iac.ts';
import type { Release } from './release.ts';

// ---- pipelines --------------------------------------------------------------

export type PipelineState = { pipe: Pipeline };

export const PIPELINE_MISSION: Mission<PipelineState> = {
  id: 'pipe-ship', title: 'Green that means something', xp: 60,
  setup: () => ({ pipe: new Pipeline() }),
  steps: [
    { text: 'Push a small code change and follow it all the way to production', hint: 'Pick "A small code change", then Push', done: (s) => s.pipe.runs.some((r) => r.outcome === 'shipped') },
    { text: 'Turn the dependency cache on and get an install that takes seconds, not minutes', hint: 'Tick the cache, then push the same kind of change twice', done: (s) => s.pipe.runs.some((r) => r.cacheHit) },
    { text: 'Push the race condition - and make sure it is stopped every time, not just sometimes', hint: 'Retrying or skipping "cart total" lets it through. What would make the test fail every time the race is there?', done: (s) => s.pipe.runs.some((r) => r.change === 'race' && r.stoppedAt === 'test' && r.policy.flaky === 'deterministic') },
    { text: 'Get a fixed build to production that is byte-for-byte what staging ran', hint: 'Push a code change (it fixes the race) with "promote the staged artifact" ticked', done: (s) => s.pipe.runs.some((r) => r.outcome === 'shipped' && !r.shippedRace && r.policy.promote && r.prodArtifact === r.stagingArtifact) },
  ],
  debrief: 'A flaky test trains everyone to ignore red, and a retry loop turns "fails sometimes" into green - which is exactly how a race condition looks. Making the test deterministic gave it back its meaning. Promoting the staged artifact meant production ran the bytes you tested; rebuilding re-resolved a floating dependency and shipped something nobody had.',
};

// ---- infrastructure as code -------------------------------------------------

export type IacState = { eng: Engine };

const plans = (s: IacState) => s.eng.history.filter((h) => h.event === 'plan').map((h) => h.plan!);
const applies = (s: IacState) => s.eng.history.filter((h) => h.event === 'apply').map((h) => h.plan!);

export const IAC_MISSION: Mission<IacState> = {
  id: 'iac-plan', title: 'Read the plan', xp: 60,
  setup: () => ({ eng: new Engine() }),
  steps: [
    { text: 'Plan, then apply, the starting configuration', hint: 'Plan, read it, then Apply', done: (s) => applies(s).some((p) => p.changes.filter((c) => c.action === 'create').length === 3) },
    { text: 'Change the server size in the code: plan an in-place update and apply it', hint: 'Size: large, then Plan and Apply', done: (s) => applies(s).some((p) => p.changes.some((c) => c.kind === 'server' && c.action === 'update')) },
    { text: 'Someone resizes the server in the console. Find out with a plan', hint: 'Console: "resize the server by hand", then Plan', done: (s) => plans(s).some((p) => p.drifted.includes('server')) },
    { text: 'Change the server image. Before applying, find what else the plan touches - then apply it', hint: 'A new image cannot be changed on a live server: it is replaced, gets a new IP, and the DNS record has to follow', done: (s) => applies(s).some((p) => p.changes.some((c) => c.kind === 'server' && c.action === 'replace') && p.changes.some((c) => c.kind === 'dns' && c.action === 'update')) },
    { text: 'Remove the bucket from the code and plan it. Read what would be destroyed, then put the bucket back without applying the removal', hint: 'Untick the bucket, Plan, read the "-" lines, tick it again, Plan', done: (s) => { const ps = plans(s); const i = ps.findIndex((p) => p.changes.some((c) => c.kind === 'bucket' && c.action === 'destroy')); return i >= 0 && ps.slice(i + 1).some((p) => !p.changes.some((c) => c.action === 'destroy')) && s.eng.cloud.objects.has('bucket') && !applies(s).some((p) => p.changes.some((c) => c.kind === 'bucket' && c.action === 'destroy')); } },
  ],
  debrief: 'The plan is the review. An in-place update, a hand change undone, a replacement that quietly moved an IP and dragged a DNS record along, and a deletion that would have taken your data with it - all of it was on screen before anything happened. Apply is the easy part; reading the plan is the job.',
};

// ---- release strategies -----------------------------------------------------

export type ReleaseState = { releases: Release[] };

export const RELEASE_MISSION: Mission<ReleaseState> = {
  id: 'canary-guard', title: 'Stop it at a quarter', xp: 60,
  setup: () => ({ releases: [] }),
  steps: [
    { text: 'Ship the working v2 with a canary and watch it promote itself', hint: 'Version: v2, strategy: canary, then Release', done: (s) => s.releases.some((r) => r.strategy === 'canary' && r.version === 'good' && r.status === 'promoted' && !r.manualPromote) },
    { text: 'Ship the broken v3 with a plain rolling update. Count the failed requests', hint: 'Version: v3, strategy: rolling update, then Release', done: (s) => s.releases.some((r) => r.strategy === 'rolling' && r.version === 'bad' && r.finished) },
    { text: 'Ship v3 with blue-green and switch back as soon as you see the errors', hint: 'Blue-green, Release, then "Switch back to blue"', done: (s) => s.releases.some((r) => r.strategy === 'bluegreen' && r.version === 'bad' && r.status === 'switched-back') },
    { text: 'Ship v3 with a canary. It must end rolled back - not promoted', hint: 'Let the analysis run. "Promote now" is the button that makes this go wrong', done: (s) => s.releases.some((r) => r.strategy === 'canary' && r.version === 'bad' && r.status === 'rolled-back') },
  ],
  debrief: 'Every strategy got v3 in front of users - the difference was how many. The rolling update waited only for readiness, and the bad pods were Ready. Blue-green was all or nothing, saved only by a fast hand on the switch. The canary showed it to a quarter of traffic, measured, and backed out on its own - no person awake required.',
};
