// GitOps as a loop you can watch: what is in git, what is live, and which
// reconciler (if any) closes the gap. The three modes are the three situations
// a learner actually meets:
//
//  - manual:    someone ran kubectl apply once. Nothing watches.
//  - helm:      a Flux HelmRelease with no drift detection. Flux compares the
//               release spec with the Helm release it installed - not with the
//               live objects - so a kubectl edit survives until git changes.
//               Drift detection is an opt-in field (.spec.driftDetection); the
//               tilt platform's 35 HelmReleases do not set it.
//  - kustomize: a Flux Kustomization. Every interval it re-applies and
//               corrects drift; with prune on it also deletes what git dropped.
//
// Sources: fluxcd.io/flux/components/kustomize/kustomizations and
// fluxcd.io/flux/components/helm/helmreleases. tests/platform.test.ts pins each.

export type Mode = 'manual' | 'helm' | 'kustomize';
export type State = { replicas: number; image: string; banner: boolean };
export type LogLine = { tick: number; text: string; kind: 'info' | 'fix' | 'warn' };

export class GitOps {
  tick = 0;
  mode: Mode;
  interval: number;
  prune: boolean;
  git: State;
  live: State;
  revision = 1;
  applied = 1;
  log: LogLine[] = [];
  corrected = 0;
  pruned = 0;
  private next: number;

  constructor(opts: { mode?: Mode; interval?: number; prune?: boolean } = {}) {
    this.mode = opts.mode ?? 'kustomize';
    this.interval = opts.interval ?? 6;
    this.prune = opts.prune ?? true;
    this.git = { replicas: 2, image: 'panda/hello:1.0', banner: true };
    this.live = { ...this.git };
    this.next = this.interval;
  }

  private say(text: string, kind: LogLine['kind'] = 'info') {
    this.log.push({ tick: this.tick, text, kind });
    if (this.log.length > 60) this.log.shift();
  }

  setMode(mode: Mode) { this.mode = mode; this.next = this.tick + this.interval; this.say(`Reconciler is now: ${mode}`); }

  commit(change: Partial<State>, message: string) {
    this.git = { ...this.git, ...change };
    this.revision++;
    this.say(`git commit r${this.revision}: ${message}`);
  }

  kubectlEdit(change: Partial<State>) {
    if (change.banner === true && !this.live.banner) this.say('kubectl created configmap/banner by hand');
    this.live = { ...this.live, ...change };
    const parts = Object.entries(change).map(([k, v]) => `${k}=${v}`).join(', ');
    this.say(`kubectl edit (live only, git unchanged): ${parts}`, 'warn');
  }

  /** Same as running `kubectl apply -f` on what is in git right now. */
  applyByHand() {
    this.converge(false);
    this.applied = this.revision;
    this.say(`kubectl apply by hand: live now matches r${this.revision}`);
  }

  get drifted() { return this.live.replicas !== this.git.replicas || this.live.image !== this.git.image || this.live.banner !== this.git.banner; }

  private converge(prune: boolean) {
    const fixes: string[] = [];
    if (this.live.replicas !== this.git.replicas) fixes.push(`replicas ${this.live.replicas} -> ${this.git.replicas}`);
    if (this.live.image !== this.git.image) fixes.push(`image ${this.live.image} -> ${this.git.image}`);
    if (this.git.banner && !this.live.banner) fixes.push('configmap/banner recreated');
    const removeBanner = !this.git.banner && this.live.banner && prune;
    this.live = { replicas: this.git.replicas, image: this.git.image, banner: this.git.banner || (this.live.banner && !prune) };
    if (removeBanner) { fixes.push('configmap/banner pruned (gone from git)'); this.pruned++; }
    return fixes;
  }

  step(n = 1) {
    for (let i = 0; i < n; i++) {
      this.tick++;
      if (this.mode === 'manual' || this.tick < this.next) continue;
      this.next = this.tick + this.interval;
      if (this.mode === 'helm') {
        if (this.revision === this.applied) continue;
        // A new revision triggers an upgrade, which renders the chart again -
        // so a hand edit is overwritten now, as a side effect, not before.
        const fixes = this.converge(true);
        this.applied = this.revision;
        this.say(`HelmRelease upgraded to r${this.revision}${fixes.length ? `: ${fixes.join('; ')}` : ''}`);
        continue;
      }
      const wasDrifted = this.drifted;
      const newRev = this.revision !== this.applied;
      const fixes = this.converge(this.prune);
      this.applied = this.revision;
      if (wasDrifted && !newRev && fixes.length) { this.corrected++; this.say(`Kustomization corrected drift: ${fixes.join('; ')}`, 'fix'); }
      else if (newRev) this.say(`Kustomization applied r${this.revision}${fixes.length ? `: ${fixes.join('; ')}` : ''}`);
      else if (!this.git.banner && this.live.banner) this.say('configmap/banner is no longer in git, but prune is off - it stays, owned by nobody', 'warn');
      else this.say('Kustomization: no drift');
    }
  }

  untilNext() { return this.mode === 'manual' ? null : Math.max(0, this.next - this.tick); }
}
