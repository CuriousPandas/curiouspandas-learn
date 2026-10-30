// Three ways to put a new version in front of users, measured by the one number
// users feel: how many of their requests failed. The canary mirrors the Flagger
// analysis in TemplateMechanics/tilt lab 06 - step 25%, max 50%, success floor
// 99%, three failed checks to roll back - so the browser and the real lab tell
// the same story.

export type Strategy = 'rolling' | 'bluegreen' | 'canary';
export type Version = 'good' | 'bad';
export type Status = 'progressing' | 'promoted' | 'rolled-back' | 'switched-back' | 'done';
export type Tick = { t: number; newShare: number; requests: number; failed: number; successRate?: number; note: string };

export const CANARY = { stepWeight: 25, maxWeight: 50, threshold: 3, minSuccess: 99 } as const;
export const REQUESTS_PER_INTERVAL = 400;
// The bad build answers 6% of requests with 500s. Its pods start and pass
// their readiness probe all the same - readiness is not correctness.
export const ERROR_RATE: Record<Version, number> = { good: 0.001, bad: 0.06 };
export const VERSION_LABEL: Record<Version, string> = { good: 'v2 (works)', bad: 'v3 (6% of requests fail)' };

export class Release {
  t = 0;
  newShare = 0;
  failedChecks = 0;
  status: Status = 'progressing';
  ticks: Tick[] = [];
  failedRequests = 0;
  servedByNew = 0;
  manualPromote = false;
  strategy: Strategy;
  version: Version;
  constructor(strategy: Strategy, version: Version) { this.strategy = strategy; this.version = version; }

  get finished() { return this.status !== 'progressing'; }

  private serve(share: number, note: string, successRate?: number) {
    const toNew = Math.round(REQUESTS_PER_INTERVAL * share);
    const failed = Math.round(toNew * ERROR_RATE[this.version]);
    this.failedRequests += failed;
    this.servedByNew += toNew;
    this.ticks.push({ t: this.t, newShare: share, requests: REQUESTS_PER_INTERVAL, failed, successRate, note });
  }

  /** One analysis interval (15s in the lab). */
  step(): Tick | undefined {
    if (this.finished) return;
    this.t++;
    if (this.strategy === 'rolling') {
      // Readiness is all a rolling update waits for, and the bad pods are Ready.
      this.newShare = Math.min(1, this.newShare + 0.25);
      this.serve(this.newShare, this.newShare < 1 ? `${this.newShare * 100}% of pods are the new version - each passed its readiness probe` : 'rollout complete: every pod is the new version');
      if (this.newShare >= 1) this.status = 'done';
    } else if (this.strategy === 'bluegreen') {
      // Green was started and smoke-tested off to the side; now the router flips.
      this.newShare = 1;
      this.serve(1, this.t === 1 ? 'router switched: 100% of traffic to green' : 'green is serving everyone');
      if (this.t >= 4) this.status = 'done';
    } else {
      if (this.newShare === 0) this.newShare = CANARY.stepWeight / 100;
      const toNew = Math.round(REQUESTS_PER_INTERVAL * this.newShare);
      const rate = Math.round(1000 * (1 - Math.round(toNew * ERROR_RATE[this.version]) / Math.max(1, toNew))) / 10;
      if (rate < CANARY.minSuccess) {
        this.failedChecks++;
        this.serve(this.newShare, `success rate ${rate}% < ${CANARY.minSuccess}%: halt advancement, failed checks ${this.failedChecks}/${CANARY.threshold}`, rate);
        if (this.failedChecks >= CANARY.threshold) { this.newShare = 0; this.status = 'rolled-back'; this.ticks[this.ticks.length - 1].note += ' - threshold reached: all traffic back to the primary'; }
      } else {
        this.serve(this.newShare, `success rate ${rate}% >= ${CANARY.minSuccess}%: advance`, rate);
        if (this.newShare * 100 >= CANARY.maxWeight) { this.newShare = 1; this.status = 'promoted'; this.ticks[this.ticks.length - 1].note += ' - max weight reached: promote'; }
        else this.newShare = Math.min(CANARY.maxWeight, this.newShare * 100 + CANARY.stepWeight) / 100;
      }
    }
    return this.ticks[this.ticks.length - 1];
  }

  /** The tempting button: skip the analysis and promote now. */
  promoteNow() {
    if (this.strategy !== 'canary' || this.finished) return;
    this.manualPromote = true;
    this.newShare = 1;
    this.status = 'promoted';
    this.t++;
    this.serve(1, 'promoted by hand before the analysis finished');
  }

  /** Blue-green's undo: flip the router back to blue. Rolling's is a second rollout. */
  rollback() {
    if (this.strategy === 'canary' || this.status === 'rolled-back' || this.status === 'switched-back') return;
    this.t++;
    this.newShare = 0;
    this.status = this.strategy === 'bluegreen' ? 'switched-back' : 'rolled-back';
    this.serve(0, this.strategy === 'bluegreen' ? 'router switched back to blue: instant' : 'rollout undo: old pods come back');
  }

  /** Run to the end with nobody watching - how releases go at 3am. */
  runToEnd(limit = 20) { while (!this.finished && limit-- > 0) this.step(); return this; }
}
