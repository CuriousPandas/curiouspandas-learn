// A toy CI/CD pipeline: lint, install, test, build, publish, then staging and
// production. Small on purpose - each knob exists to show one real failure:
//
// - The dependency cache is keyed on the lockfile, so a lockfile change misses.
// - The "cart total" test is flaky, and a race condition in the code makes it
//   fail more often without failing every time. Retrying until green, or
//   skipping the test, lets that race reach production. Making the test
//   deterministic is what restores its signal.
// - Rebuilding for production re-resolves a floating dependency, so production
//   can run an artifact nobody tested. Promoting the staged artifact cannot.
//
// The flake is a fixed pattern, not random: every learner sees the same thing,
// and the tests below can pin it.

import { sha1 } from '../git/sha1.ts';

export type Change = 'code' | 'lockfile' | 'race';
export type FlakyPolicy = 'block' | 'retry' | 'skip' | 'deterministic';
export type Policy = { cache: boolean; flaky: FlakyPolicy; promote: boolean };
export type StageId = 'lint' | 'install' | 'test' | 'build' | 'publish' | 'staging' | 'prod';
export type Stage = { id: StageId; status: 'pass' | 'fail' | 'skipped'; seconds: number; note: string };
export type Run = {
  n: number; change: Change; policy: Policy; stages: Stage[];
  outcome: 'shipped' | 'stopped'; stoppedAt?: StageId;
  cacheHit: boolean; attempts: number;
  stagingArtifact?: string; prodArtifact?: string;
  shippedRace: boolean;
};

export const STAGES: { id: StageId; label: string }[] = [
  { id: 'lint', label: 'lint' }, { id: 'install', label: 'install deps' }, { id: 'test', label: 'test' },
  { id: 'build', label: 'build' }, { id: 'publish', label: 'publish' }, { id: 'staging', label: 'staging' }, { id: 'prod', label: 'production' },
];

export const CHANGES: Record<Change, { label: string; detail: string }> = {
  code: { label: 'A small code change', detail: 'Edits one function. Dependencies untouched.' },
  lockfile: { label: 'Bump a dependency', detail: 'Changes package-lock.json, so the cache key changes too.' },
  race: { label: 'A change with a race condition', detail: 'Two requests can update the cart at once. The "cart total" test catches it - when it runs reliably.' },
};

// sha1 takes bytes. Handed a string it still returned 40 hex characters - a
// hash of garbage that compared consistently, so only the type checker saw it.
const short = (s: string) => sha1(new TextEncoder().encode(s)).slice(0, 12);

export class Pipeline {
  runs: Run[] = [];
  /** Every test attempt ever made: the flaky pattern keys off this. */
  attemptCounter = 0;
  /** The race stays in the code until a later push replaces it with a fix. */
  raceInCode = false;
  /** Bumped by the lockfile change; the cache key is the lockfile's hash. */
  lockfileVersion = 1;
  /** Cache keys that have been saved so far. */
  cache = new Set<string>();
  /** A floating dependency (^1.4) - upstream publishes a new release now and then. */
  upstreamMinor = 4;
  codeVersion = 0;

  /**
   * One attempt of the "cart total" test. Flaky: fails one attempt in three.
   * With the race in the code it fails two in three - more often, never always.
   * Made deterministic (a fake clock, requests serialised by the test), it
   * passes every time without the race and fails every time with it.
   */
  private cartTotalPasses(policy: FlakyPolicy): boolean {
    const k = this.attemptCounter++;
    if (policy === 'deterministic') return !this.raceInCode;
    return this.raceInCode ? k % 3 === 1 : k % 3 !== 2;
  }

  push(change: Change, policy: Policy): Run {
    this.codeVersion++;
    if (change === 'race') this.raceInCode = true;
    else if (change === 'code') this.raceInCode = false; // the next code change fixes it
    if (change === 'lockfile') this.lockfileVersion++;
    // Upstream keeps releasing whether or not you push.
    if (this.runs.length % 2 === 1) this.upstreamMinor++;

    const stages: Stage[] = [];
    const run: Run = { n: this.runs.length + 1, change, policy: { ...policy }, stages, outcome: 'shipped', cacheHit: false, attempts: 0, shippedRace: false };
    const stop = (id: StageId, seconds: number, note: string) => {
      stages.push({ id, status: 'fail', seconds, note });
      run.outcome = 'stopped'; run.stoppedAt = id;
      for (const s of STAGES.slice(STAGES.findIndex((x) => x.id === id) + 1)) stages.push({ id: s.id, status: 'skipped', seconds: 0, note: 'not reached' });
      this.runs.push(run);
      return run;
    };

    stages.push({ id: 'lint', status: 'pass', seconds: 12, note: 'style and types' });

    const key = `deps-${short(`lockfile-v${this.lockfileVersion}`).slice(0, 8)}`;
    run.cacheHit = policy.cache && this.cache.has(key);
    if (policy.cache) this.cache.add(key);
    stages.push({ id: 'install', status: 'pass', seconds: run.cacheHit ? 6 : 95, note: !policy.cache ? 'no cache: downloads everything' : run.cacheHit ? `cache hit: ${key}` : `cache miss: ${key} (saved for next time)` });

    if (policy.flaky === 'skip') {
      stages.push({ id: 'test', status: 'pass', seconds: 40, note: '"cart total" skipped - the rest passed' });
    } else {
      const tries = policy.flaky === 'retry' ? 3 : 1;
      let passed = false;
      for (let i = 0; i < tries && !passed; i++) { run.attempts++; passed = this.cartTotalPasses(policy.flaky); }
      if (!passed) return stop('test', 48 * run.attempts, run.attempts > 1 ? `"cart total" failed all ${run.attempts} attempts` : '"cart total" failed');
      stages.push({ id: 'test', status: 'pass', seconds: 48 * run.attempts, note: run.attempts > 1 ? `"cart total" passed on attempt ${run.attempts} of 3` : 'all tests passed' });
    }

    const artifact = (minor: number) => short(`app-${this.codeVersion}-lib-1.${minor}`);
    run.stagingArtifact = artifact(this.upstreamMinor);
    stages.push({ id: 'build', status: 'pass', seconds: 40, note: `resolved lib ^1.4 -> 1.${this.upstreamMinor}` });
    stages.push({ id: 'publish', status: 'pass', seconds: 8, note: `artifact ${run.stagingArtifact}` });
    stages.push({ id: 'staging', status: 'pass', seconds: 30, note: `running ${run.stagingArtifact}` });

    if (policy.promote) {
      run.prodArtifact = run.stagingArtifact;
      stages.push({ id: 'prod', status: 'pass', seconds: 30, note: `promoted ${run.prodArtifact} - the artifact staging ran` });
    } else {
      // A rebuild resolves the floating dependency again - and upstream
      // released in between.
      this.upstreamMinor++;
      run.prodArtifact = artifact(this.upstreamMinor);
      stages.push({ id: 'prod', status: 'pass', seconds: 78, note: `rebuilt: lib -> 1.${this.upstreamMinor}, artifact ${run.prodArtifact} - never ran in staging` });
    }
    run.shippedRace = this.raceInCode;
    this.runs.push(run);
    return run;
  }
}

export const totalSeconds = (r: Run) => r.stages.reduce((n, s) => n + s.seconds, 0);
