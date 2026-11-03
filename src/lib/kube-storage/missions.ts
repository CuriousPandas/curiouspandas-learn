// Missions for the storage sandbox. Like src/lib/missions.ts, they judge the
// state the learner produced, never the words typed. Each step latches once it
// has been true, because later steps change the state earlier ones looked at
// (a rollout makes "all three Ready" false again), and the checklist re-judges
// every step on every tick: an unlatched step there would untick and strand
// the learner with the mission unfinishable.

import type { Mission } from '../missions.ts';
import { Storage } from './storage.ts';
import { kubectl } from './kubectl.ts';
import { INDEXER, SCRATCH, WEB } from './files.ts';

export type StorageState = { s: Storage; files: Map<string, string>; history: string[]; seen: Set<string>; latched: Set<string> };

export function storageSetup(files: Record<string, string>, lines: string[], warm: number): () => StorageState {
  return () => {
    const s = new Storage();
    const st: StorageState = { s, files: new Map(Object.entries(files)), history: [], seen: new Set(), latched: new Set() };
    for (const l of lines) kubectl(s, st.files, l);
    s.step(warm);
    return st;
  };
}

/** A step that stays done once it has been true. */
const latch = (id: string, cond: (s: StorageState) => boolean) => (s: StorageState) => {
  if (s.latched.has(id)) return true;
  if (cond(s)) { s.latched.add(id); return true; }
  return false;
};

const ran = (s: StorageState, re: RegExp) => s.history.some((l) => re.test(l.trim()));
const running = (s: StorageState, pod: string) => { const p = s.s.pods.get(pod); return !!p && p.status === 'Running' && p.ready; };

// ---- volumes: the claim that stayed Pending ----------------------------------

/** A Released volume, kept by Retain, still holding something the learner wrote. */
const keptData = (s: StorageState) => [...s.s.volumes.values()].some((v) => v.status === 'Released' && v.reclaim === 'Retain' && s.s.written.some((w) => w.volume === v.name && v.files.get(w.path) !== undefined));

export const VOLUMES_MISSION: Mission<StorageState> = {
  id: 'storage-pending', title: 'The claim that stayed Pending', xp: 70,
  setup: storageSetup({ 'indexer.yaml': INDEXER, 'scratch.yaml': SCRATCH }, ['kubectl apply -f indexer.yaml', 'kubectl apply -f scratch.yaml'], 12),
  steps: [
    { text: 'The indexer pod is Pending. List the claims: what is it waiting for?', hint: 'kubectl get pods,pvc', done: latch('v1', (s) => s.seen.has('get:pvc')) },
    { text: 'Ask the claim why it is Pending: read its Events', hint: 'kubectl describe pvc indexer-data', done: latch('v2', (s) => s.seen.has('describe:pvc:indexer-data')) },
    { text: 'List the storage classes this cluster really has', hint: 'kubectl get sc', done: latch('v3', (s) => s.seen.has('get:sc')) },
    {
      text: 'Point the claim at a class that exists, and get indexer Running',
      hint: 'Edit indexer.yaml: delete the storageClassName line (or write standard).  then  kubectl delete pvc indexer-data  then  kubectl apply -f indexer.yaml',
      done: latch('v4', (s) => { const c = s.s.claims.get('indexer-data'); const sc = c?.className ? s.s.classes.get(c.className) : undefined; return !!c && c.phase === 'Bound' && !!sc && !sc.byLearner && running(s, 'indexer'); }),
      why: (s) => {
        const c = s.s.claims.get('indexer-data');
        const sc = c?.className ? s.s.classes.get(c.className) : undefined;
        if (sc?.byLearner) return `You made a class called ${sc.name}. The claim binds, but the manifest still names a class that only exists because you invented it here; the next cluster will not have it. Fix the manifest instead: delete the claim and the class, edit indexer.yaml, apply again.`;
        if (ran(s, /patch\s+(pvc|persistentvolumeclaim)/)) return 'A claim\'s storageClassName cannot be changed after it is created (read the error). Delete the claim, fix the file, and apply it again.';
        return '';
      },
    },
    { text: 'scratch is Pending too. Describe it: is that a fault?', hint: 'kubectl describe pvc scratch', done: latch('v5', (s) => s.seen.has('describe:pvc:scratch')) },
    { text: 'Write a file into the indexer\'s volume', hint: 'kubectl exec indexer -- sh -c "echo panda-data > /data/note.txt"', done: latch('v6', (s) => s.s.written.length > 0) },
    {
      text: 'Keep that data: delete the pod and the claim so the volume is Released with your file still on it',
      hint: 'kubectl get pv  then  kubectl patch pv <name> -p \'{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}\'  then  kubectl delete pod indexer  then  kubectl delete pvc indexer-data',
      done: latch('v7', keptData),
      why: (s) => {
        const lost = s.s.written.some((w) => !s.s.volumes.has(w.volume));
        if (lost && !keptData(s)) return 'The volume went with its claim: the reclaim policy was Delete, so the data is gone. Apply indexer.yaml again for a new volume, write a file, and set Retain before you delete.';
        return '';
      },
    },
  ],
  debrief: 'The claim was never broken: it named a class that does not exist here, and Kubernetes waited, exactly as documented, for ever. scratch looked the same in kubectl get pvc and was fine: WaitForFirstConsumer holds a claim until a pod uses it. Describe tells the two apart. And Delete, the reclaim policy a StorageClass gets when none is set, means deleting a claim deletes the data; Retain kept it as a Released volume that nothing will reuse until an administrator decides.',
};

// ---- statefulsets: scaled down, and the disks stayed --------------------------

const setPods = (s: StorageState) => [...s.s.pods.values()].filter((p) => p.owner === 'web');
const allOn = (s: StorageState, image: string) => { const set = s.s.sets.get('web'); return !!set && set.replicas === 3 && [0, 1, 2].every((i) => { const p = s.s.pods.get(`web-${i}`); return !!p && p.image === image && running(s, p.name); }); };

export const STATEFULSET_MISSION: Mission<StorageState> = {
  id: 'storage-sts', title: 'Scaled down, and the disks stayed', xp: 80,
  setup: storageSetup({ 'web.yaml': WEB }, ['kubectl apply -f web.yaml'], 0),
  steps: [
    { text: 'Watch web-0, web-1 and web-2 start, one at a time', hint: 'kubectl get pods,pvc  (run it a few times)', done: latch('s1', (s) => s.seen.has('get:pod') && allOn(s, 'panda/web:1.0')) },
    { text: 'Write a note into web-2\'s volume', hint: 'kubectl exec web-2 -- sh -c "echo written-before-scale-down > /data/note.txt"', done: latch('s2', (s) => s.s.written.some((w) => s.s.volumes.get(w.volume)?.claim === 'data-web-2')) },
    { text: 'Scale the StatefulSet down to 1', hint: 'kubectl scale sts web --replicas=1', done: latch('s3', (s) => s.s.sets.get('web')?.replicas === 1 && setPods(s).length === 1) },
    { text: 'Count the claims now', hint: 'kubectl get pvc', done: latch('s4', (s) => s.seen.has('pvc-outlived-pods')) },
    { text: 'Scale back to 3 and read web-2\'s note', hint: 'kubectl scale sts web --replicas=3  then  kubectl exec web-2 -- cat /data/note.txt', done: latch('s5', (s) => s.seen.has('read-old-note')) },
    { text: 'Roll out version 2.0, with the classic typo: 2.O', hint: 'kubectl set image sts/web app=panda/web:2.O', done: latch('s6', (s) => s.seen.has('sts-stuck')) },
    {
      text: 'Get all three Running on panda/web:2.0',
      hint: 'kubectl set image sts/web app=panda/web:2.0  then  kubectl get pods  then  kubectl delete pod web-2',
      done: latch('s7', (s) => s.seen.has('sts-stuck') && allOn(s, 'panda/web:2.0')),
      why: (s) => {
        const set = s.s.sets.get('web');
        const stuck = setPods(s).find((p) => !p.ready && p.image !== set?.image);
        if (set?.image === 'panda/web:2.0' && stuck) return `The template is fixed, but ${stuck.name} still runs the broken image and the controller is waiting for it to become Ready before it will replace it. It never will. The docs call this out: delete that pod.`;
        return '';
      },
    },
  ],
  debrief: 'Scaling down removed pods from the top ordinal and left every claim, so scaling up gave web-2 its old disk back, note and all: safe by design, and a cost (and a stale-data surprise) if you forget. Then the rollout stopped at web-2 and waited, with web-0 and web-1 still serving 1.0. Fixing the template was not enough, because the controller waits for the broken pod to be Ready before it will touch it. Deleting it let the fixed template through.',
};

/** Observations that come from state rather than one command. Called after every command and tick. */
export function storageWatch(st: StorageState) {
  if ([...st.s.pods.values()].some((p) => p.owner === 'web' && p.image === 'panda/web:2.O' && (p.status === 'ErrImagePull' || p.status === 'ImagePullBackOff'))) st.seen.add('sts-stuck');
}

/** Record what a command looked at, for the "did you look" steps. */
function observe(st: StorageState, what: string) {
  st.seen.add(what);
  if (what === 'get:pvc') {
    const set = st.s.sets.get('web');
    const claims = [...st.s.claims.values()].filter((c) => c.ownerSts === 'web').length;
    if (set && claims > set.replicas) st.seen.add('pvc-outlived-pods');
  }
  // Only a read after the scale-down counts: reading the note before it proves nothing.
  if (/^read:web-2:/.test(what) && st.latched.has('s3')) st.seen.add('read-old-note');
}

/** Run one learner command against the mission's cluster. */
export function storageRun(st: StorageState, line: string) {
  st.history.push(line);
  const result = kubectl(st.s, st.files, line, (w) => observe(st, w));
  storageWatch(st);
  return result;
}

export const STORAGE_MISSIONS: Record<string, Mission<StorageState>> = { [VOLUMES_MISSION.id]: VOLUMES_MISSION, [STATEFULSET_MISSION.id]: STATEFULSET_MISSION };
