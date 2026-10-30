// Missions check the *state* the learner produced, never the exact words they
// typed, so any correct route counts. Where a step is about looking (reading
// events, describing a pod), the check is on what they looked at, because
// "I fixed it without finding out why" is the habit these labs exist to break.
// Fix-shape checks copy the tilt graders: raising memory on the probe-killed
// pod would eventually go green too, for the wrong reason, so it does not pass.

import { Repo } from './git/repo.ts';
import { run } from './git/shell.ts';
import { Cluster } from './kube/cluster.ts';
import { kubectl } from './kube/kubectl.ts';

export type Step<S> = { text: string; hint?: string; done: (s: S) => boolean };
export type Mission<S> = { id: string; title: string; xp: number; setup: () => S; steps: Step<S>[]; debrief: string };

export type GitState = { repo: Repo; history: string[] };
export type KubeState = { cluster: Cluster; history: string[]; seen: Set<string>; deleted: Set<string> };

const ran = (h: string[], re: RegExp) => h.some((l) => re.test(l.trim()));

function gitSetup(lines: string[] = []): () => GitState {
  return () => {
    let t = 1767225600;
    const repo = new Repo({ clock: () => ({ time: (t += 60), tz: '+0000' }) });
    for (const l of lines) run(repo, l);
    // Fresh missions use the learner's real clock from here on.
    if (lines.length) { const base = t; const start = Date.now(); repo.clock = () => ({ time: base + Math.floor((Date.now() - start) / 1000) + 60, tz: '+0000' }); }
    return { repo, history: [] };
  };
}

const onMain = (r: Repo) => r.head.kind === 'branch' && r.head.name === 'main';

export const GIT_MISSIONS: Record<string, Mission<GitState>> = {
  'git-first-commit': {
    id: 'git-first-commit', title: 'Your first commit', xp: 40, setup: gitSetup(),
    steps: [
      { text: 'Turn this folder into a repository', hint: 'git init', done: (s) => s.repo.initialized },
      { text: 'Create a file with something in it', hint: 'echo "hello, panda" > hello.txt', done: (s) => [...s.repo.workdir.values()].some((v) => v.length > 0) },
      { text: 'Ask git what it sees - your file is untracked', hint: 'git status', done: (s) => ran(s.history, /^git status/) && s.repo.workdir.size > 0 },
      { text: 'Stage it', hint: 'git add hello.txt', done: (s) => s.repo.index.size > 0 || !!s.repo.headSha() },
      { text: 'Commit it with a message', hint: 'git commit -m "my first commit"', done: (s) => !!s.repo.headSha() },
      { text: 'Read the history', hint: 'git log', done: (s) => !!s.repo.headSha() && ran(s.history, /^git log/) },
    ],
    debrief: 'That 40-character name in git log is a SHA-1 of the commit\'s exact bytes. Change one letter anywhere and the name changes completely.',
  },
  'git-branch-merge': {
    id: 'git-branch-merge', title: 'Branch, change, merge', xp: 50,
    setup: gitSetup(['git init', 'echo "# Bamboo notes" > notes.md', 'git add .', 'git commit -m "start notes"']),
    steps: [
      { text: 'Make a branch called idea and switch to it', hint: 'git switch -c idea', done: (s) => s.repo.branches.has('idea') },
      { text: 'Commit a change on idea', hint: 'echo "bamboo can grow 90cm in a day" >> notes.md  then  git commit -am "add a fact"', done: (s) => { const i = s.repo.branches.get('idea'); return !!i && s.repo.ancestors(i).size > 1; } },
      { text: 'Switch back to main - notice your change is gone from notes.md', hint: 'git switch main  then  cat notes.md', done: (s) => onMain(s.repo) && ran(s.history, /^git (switch|checkout) main/) },
      { text: 'Merge idea into main', hint: 'git merge idea', done: (s) => { const i = s.repo.branches.get('idea'), m = s.repo.branches.get('main'); return !!i && !!m && s.repo.isAncestor(i, m) && s.repo.ancestors(i).size > 1; } },
    ],
    debrief: 'main had not moved since you branched, so git just slid the main label forward: a fast-forward. No merge commit was needed. Diverge both branches first and you get a real three-way merge.',
  },
  'git-conflict': {
    id: 'git-conflict', title: 'Resolve a real conflict', xp: 60,
    setup: gitSetup([
      'git init', 'echo "bamboo" > menu.txt', 'echo "leaves" >> menu.txt', 'echo "shoots" >> menu.txt', 'git add .', 'git commit -m "menu"',
      'git branch snack', 'echo "bamboo" > menu.txt', 'echo "apples" >> menu.txt', 'echo "shoots" >> menu.txt', 'git commit -am "apples instead of leaves"',
      'git switch snack', 'echo "bamboo" > menu.txt', 'echo "pears" >> menu.txt', 'echo "shoots" >> menu.txt', 'git commit -am "pears instead of leaves"', 'git switch main',
    ]),
    steps: [
      { text: 'Merge snack into main', hint: 'git merge snack', done: (s) => !!s.repo.merging || mergedSnack(s.repo) },
      { text: 'Look at the file git left you', hint: 'cat menu.txt', done: (s) => ran(s.history, /^cat menu\.txt/) },
      { text: 'Rewrite menu.txt with no conflict markers - keep whichever lines you like', hint: 'echo "bamboo" > menu.txt  then  echo "apples" >> menu.txt  then  echo "pears" >> menu.txt  then  echo "shoots" >> menu.txt', done: (s) => mergedSnack(s.repo) || (!!s.repo.merging && !(s.repo.workdir.get('menu.txt') ?? '<<<').includes('<<<<<<<') && !(s.repo.workdir.get('menu.txt') ?? '').includes('>>>>>>>')) },
      { text: 'Mark it resolved and finish the merge', hint: 'git add menu.txt  then  git commit -m "both fruits"', done: (s) => mergedSnack(s.repo) },
    ],
    debrief: 'The merge commit you just made has two parents. That is all a merge is: a commit that remembers both histories. Git refused to guess, because both sides changed the same line.',
  },
  'git-objects': {
    id: 'git-objects', title: 'Look inside .git', xp: 50,
    setup: gitSetup(['git init', 'echo "same words" > a.txt', 'echo "same words" > b.txt', 'echo "different" > c.txt', 'git add .', 'git commit -m "three files"']),
    steps: [
      { text: 'Hash a file without committing it', hint: 'git hash-object a.txt', done: (s) => ran(s.history, /^git hash-object/) },
      { text: 'Ask what kind of object HEAD is', hint: 'git cat-file -t HEAD', done: (s) => ran(s.history, /^git cat-file -t/) },
      { text: 'Print the commit itself', hint: 'git cat-file -p HEAD', done: (s) => ran(s.history, /^git cat-file -p (HEAD|[0-9a-f]{4,})/) },
      { text: 'Print its tree - find which two files share one blob', hint: 'copy the tree hash from the commit, then git cat-file -p <tree>', done: (s) => s.history.some((l) => { const m = /^git cat-file -p ([0-9a-f]{4,40})/.exec(l.trim()); if (!m) return false; try { return s.repo.get(s.repo.resolve(m[1])).type === 'tree'; } catch { return false; } }) },
    ],
    debrief: 'a.txt and b.txt point at the same blob. Git stores content once, named by its hash, no matter how many paths hold it. That is content addressing, and it is why git can tell what changed without comparing every byte.',
  },
  'git-secret-history': {
    id: 'git-secret-history', title: 'Deleted is not gone', xp: 60,
    setup: gitSetup(['git init', 'echo "PORT=8080" > config.env', 'echo "# Bamboo shop" > README.md', 'git add .', 'git commit -m "start the shop"']),
    steps: [
      { text: 'Paste the payment key into config.env (it is fake - a real one looks just as harmless)', hint: 'echo "PAYMENT_KEY=panda_live_7Qx2EXAMPLE" >> config.env', done: (s) => hasKey(s.repo.workdir.get('config.env')) || keyCommitted(s.repo) },
      { text: 'Commit it. This is the mistake', hint: 'git commit -am "add payment key"', done: (s) => keyCommitted(s.repo) },
      { text: 'Notice, delete the key from the file, and commit the fix', hint: 'echo "PORT=8080" > config.env  then  git commit -am "remove key"', done: (s) => keyCommitted(s.repo) && !treeHasKey(s.repo, s.repo.headSha()) },
      // Any route that puts the key back on screen counts: reading the old file,
      // or showing the commit that added or removed it.
      { text: 'Prove it is still there: read config.env as it was one commit ago', hint: 'git show HEAD~1:config.env', done: (s) => !treeHasKey(s.repo, s.repo.headSha()) && s.history.some((l) => showsKey(s.repo, l.trim())) },
    ],
    debrief: 'Deleting the line made a new snapshot. The old one is still in history, and in every clone, fork and CI cache that fetched it. Rewriting history cannot reach those copies, so the real fix is outside git: revoke the key and issue a new one. Then the leaked copy is worthless wherever it is.',
  },
};

// The fake key. Shaped to be unmistakably fake and to match no real scanner
// rule, so pushing this repo cannot trip secret scanning on a real provider.
const KEY = /panda_live_\w+/;
const hasKey = (t: string | undefined) => !!t && KEY.test(t);
const treeHasKey = (r: Repo, sha: string | undefined) => !!sha && [...r.treeOfCommit(sha).values()].some((b) => hasKey((r.get(b) as { data: string }).data));
const keyCommitted = (r: Repo) => r.allCommits().some((c) => treeHasKey(r, c));
function showsKey(r: Repo, line: string): boolean {
  const m = /^git show(?:\s+(\S+))?$/.exec(line);
  if (!m) return false;
  try {
    const spec = m[1] ?? 'HEAD';
    const colon = spec.indexOf(':');
    if (colon > 0) {
      const blob = r.treeOfCommit(r.resolve(spec.slice(0, colon))).get(spec.slice(colon + 1));
      return !!blob && hasKey((r.get(blob) as { data: string }).data);
    }
    // A whole commit shows its diff: the key appears if it is on either side.
    const c = r.resolve(spec);
    return treeHasKey(r, c) || treeHasKey(r, r.commit(c).parents[0]);
  } catch {
    return false;
  }
}

function mergedSnack(r: Repo) {
  const m = r.branches.get('main'), sn = r.branches.get('snack');
  return !!m && !!sn && !r.merging && r.commit(m).parents.length === 2 && r.isAncestor(sn, m);
}

function kubeSetup(lines: string[], warm = 0, nodes?: ConstructorParameters<typeof Cluster>[0]): () => KubeState {
  return () => {
    const cluster = new Cluster(nodes);
    for (const l of lines) kubectl(cluster, l);
    cluster.step(warm);
    return { cluster, history: [], seen: new Set(), deleted: new Set() };
  };
}

const readyOf = (c: Cluster, d: string) => { try { return c.deploymentStatus(d); } catch { return null; } };

export const KUBE_MISSIONS: Record<string, Mission<KubeState>> = {
  'kube-self-heal': {
    id: 'kube-self-heal', title: 'Make a promise, then break it', xp: 50, setup: kubeSetup([]),
    steps: [
      { text: 'Create a deployment called hello with 3 replicas of panda/hello:1.0', hint: 'kubectl create deployment hello --image=panda/hello:1.0 --replicas=3', done: (s) => s.cluster.deployments.get('hello')?.replicas === 3 || s.deleted.size > 0 },
      { text: 'Wait until all three pods are Running and Ready', hint: 'kubectl get pods', done: (s) => (readyOf(s.cluster, 'hello')?.ready ?? 0) >= 3 || s.deleted.size > 0 },
      { text: 'Delete one of the pods', hint: 'kubectl delete pod <copy a name from get pods>', done: (s) => s.deleted.size > 0 },
      { text: 'Watch Kubernetes put it back - with a new name', hint: 'kubectl get pods', done: (s) => s.deleted.size > 0 && (readyOf(s.cluster, 'hello')?.ready ?? 0) >= 3 && [...s.deleted].every((n) => !s.cluster.pods.has(n)) },
    ],
    debrief: 'Nobody told Kubernetes to replace the pod. The ReplicaSet controller kept comparing "want 3" with "have 2" and fixed the difference. That loop, not any single command, is Kubernetes.',
  },
  'kube-pending': {
    id: 'kube-pending', title: 'Why won\'t it schedule?', xp: 60,
    setup: kubeSetup(['kubectl create deployment big --image=panda/hello:1.0 --replicas=3', 'kubectl set resources deployment big --requests=cpu=1500m'], 6),
    steps: [
      { text: 'Find the pod that is stuck', hint: 'kubectl get pods -o wide', done: (s) => ran(s.history, /get (po|pods?)\b/) },
      { text: 'Ask it why - describe the Pending pod and read its Events', hint: 'kubectl describe pod <the Pending one>', done: (s) => s.seen.has('describe:pending') },
      { text: 'See how full the nodes are', hint: 'kubectl get nodes', done: (s) => ran(s.history, /get (no|nodes?)\b/) },
      { text: 'Fix it so all 3 replicas run (do not scale down)', hint: 'kubectl set resources deployment big --requests=cpu=500m', done: (s) => { const st = readyOf(s.cluster, 'big'); return !!st && st.desired >= 3 && st.ready >= 3 && st.current === st.desired; } },
    ],
    debrief: 'The scheduler places pods by what they *request*, not what they use. Three pods asking for 1.5 CPUs each cannot fit on two 2-CPU nodes, however idle those CPUs are. And if your fix still did not fit beside the old pods, you saw the rollout wait: new pods need room before old ones may leave.',
  },
  'kube-two-crashes': {
    id: 'kube-two-crashes', title: 'Two crashes, one exit code', xp: 80,
    setup: kubeSetup(['kubectl create deployment starved --image=panda/greedy:1.0', 'kubectl set resources deployment starved --limits=memory=64Mi', 'kubectl create deployment impatient --image=panda/slowpoke:1.0'], 10),
    steps: [
      { text: 'Both pods restart forever. Look at both of them', hint: 'kubectl get pods', done: (s) => ran(s.history, /get (po|pods?)\b/) },
      { text: 'Describe the starved pod: find its exit code and reason', hint: 'kubectl describe pod <starved-...>', done: (s) => s.seen.has('describe:starved') },
      { text: 'Describe the impatient pod: same exit code - what do its Events say?', hint: 'kubectl describe pod <impatient-...>', done: (s) => s.seen.has('describe:impatient') },
      { text: 'Fix starved the way its reason asks', hint: 'kubectl set resources deployment starved --limits=memory=256Mi', done: (s) => { const d = s.cluster.deployments.get('starved'); return !!d && d.template.limits.mem >= 200 && (readyOf(s.cluster, 'starved')?.ready ?? 0) >= 1; } },
      { text: 'Fix impatient the way its events ask - a startup probe, not more memory', hint: `kubectl patch deployment impatient -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","startupProbe":{"httpGet":{"path":"/","port":8080},"periodSeconds":5,"failureThreshold":24}}]}}}}'`, done: (s) => { const d = s.cluster.deployments.get('impatient'); return !!d && d.template.startupProbe && (readyOf(s.cluster, 'impatient')?.ready ?? 0) >= 1; } },
    ],
    debrief: '137 is 128 + 9: SIGKILL. It says something killed the process, never what. OOMKilled means the kernel did it for memory; a Liveness event means the kubelet did it because a probe gave up. Same number, opposite fixes - and the wrong fix (more memory for impatient) never helps. The startup probe needs a budget, too: 5 s x 24 gives it two minutes, where the defaults (10 s x 3) would have killed it at 30.',
  },
  'kube-quota': {
    id: 'kube-quota', title: 'The pods that were never born', xp: 70,
    setup: kubeSetup(['kubectl create quota pandas --hard=pods=3', 'kubectl create deployment quota-demo --image=panda/hello:1.0 --replicas=6'], 8),
    steps: [
      { text: 'The deployment wants 6. Count what exists', hint: 'kubectl get deploy  then  kubectl get pods', done: (s) => ran(s.history, /get (deploy|deployments?)\b/) },
      { text: 'Find where the refusal is written down', hint: 'kubectl get events  or  kubectl describe deploy quota-demo', done: (s) => ran(s.history, /get (ev|events?)\b/) || s.seen.has('describe:deploy:quota-demo') },
      { text: 'Raise the quota to 6 - do not delete it', hint: `kubectl patch quota/pandas -p '{"spec":{"hard":{"pods":"6"}}}'`, done: (s) => !!s.cluster.quota && s.cluster.quota.pods >= 6 },
      { text: 'Wait for the ReplicaSet to retry - it backs off, so this takes a moment', hint: 'kubectl get pods', done: (s) => !!s.cluster.quota && (readyOf(s.cluster, 'quota-demo')?.ready ?? 0) >= 6 },
    ],
    debrief: 'There was no failing pod to debug because the missing pods were never created - the API server refused them at admission. Deleting the quota would also have "worked", and would have removed the guardrail. That is why this mission only passes with the quota still there.',
  },
  'kube-rollout': {
    id: 'kube-rollout', title: 'A typo is not an outage', xp: 60,
    setup: kubeSetup(['kubectl create deployment hello --image=panda/hello:1.0 --replicas=3'], 4),
    steps: [
      { text: 'Roll out version 2.0 - but make the classic typo: a capital O instead of zero', hint: 'kubectl set image deployment/hello app=panda/hello:2.O', done: (s) => s.cluster.deployments.get('hello')?.template.image === 'panda/hello:2.O' || s.seen.has('typo') },
      { text: 'Watch: the new pod cannot pull its image. Are the old ones still serving?', hint: 'kubectl get pods', done: (s) => s.seen.has('typo') },
      { text: 'Ask the rollout how it is going', hint: 'kubectl rollout status deployment/hello', done: (s) => s.seen.has('typo') && ran(s.history, /rollout status/) },
      { text: 'Fix the tag and finish the rollout', hint: 'kubectl set image deployment/hello app=panda/hello:2.0', done: (s) => { const st = readyOf(s.cluster, 'hello'); return s.seen.has('typo') && !!st && st.ready === 3 && st.current === 3 && [...s.cluster.pods.values()].every((p) => p.template.image === 'panda/hello:2.0'); } },
    ],
    debrief: 'Beyond the maxUnavailable allowance (25% rounded down: zero at 3 replicas), a rolling update removes an old pod only once a new one is Ready. A new pod that never becomes Ready stalls the rollout - with the old version still answering. That is the whole reason the strategy exists.',
  },
};

/** Record what a kubectl command looked at, for the "did you find out why" steps. */
export function kubeObserve(s: KubeState, line: string) {
  s.history.push(line);
  const c = s.cluster;
  const m = /describe\s+(?:po|pods?)(?:\s+|\/)(\S+)/.exec(line);
  if (m) {
    const p = c.pods.get(m[1]);
    if (p && !p.node) s.seen.add('describe:pending');
    if (p?.owner.startsWith('starved-')) s.seen.add('describe:starved');
    if (p?.owner.startsWith('impatient-')) s.seen.add('describe:impatient');
  }
  const d = /describe\s+(?:deploy|deployments?)(?:\s+|\/)(\S+)/.exec(line);
  if (d) s.seen.add(`describe:deploy:${d[1]}`);
  const del = /delete\s+(?:po|pods?)(?:\s+|\/)(\S+)/.exec(line);
  if (del && c.pods.has(del[1])) s.deleted.add(del[1]);
}

/** Called every tick so state-only observations (a typo'd rollout happened) are not missed. */
export function kubeWatch(s: KubeState) {
  if ([...s.cluster.pods.values()].some((p) => p.template.image === 'panda/hello:2.O' && (p.status === 'ErrImagePull' || p.status === 'ImagePullBackOff'))) s.seen.add('typo');
}
