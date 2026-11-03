// The storage sandbox against what a real cluster printed. Every pinned string
// below was copied from kubectl 1.37.2 talking to Kubernetes 1.36.1 (kind,
// local-path provisioner), on 2026-11-03, while these lessons were written:
// tiltdev's scratch namespace for the claims and the StatefulSet, the
// throwaway k8s-c cluster for the rest. The command that produced each is named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from '../src/lib/kube-storage/storage.ts';
import { kubectl } from '../src/lib/kube-storage/kubectl.ts';
import { VOLUMES_MISSION, STATEFULSET_MISSION, storageRun, type StorageState } from '../src/lib/kube-storage/missions.ts';
import { INDEXER, SCRATCH, WEB } from '../src/lib/kube-storage/files.ts';
import type { Mission } from '../src/lib/missions.ts';

const text = (out: { text: string }[]) => out.map((l) => l.text).join('\n');
function fresh(files: Record<string, string>) {
  const s = new Storage();
  const f = new Map(Object.entries(files));
  return { s, f, k: (l: string) => text(kubectl(s, f, l)) };
}

/** Run commands the way the widget does: one command, then the checklist re-judged, then time passes. */
function play(m: Mission<StorageState>, script: (string | number)[]) {
  const st = m.setup();
  const judge = () => { let ok = true; return m.steps.map((x) => (ok = ok && x.done(st))); };
  const log: string[] = [];
  for (const cmd of script) {
    if (typeof cmd === 'number') { for (let i = 0; i < cmd; i++) { st.s.step(); judge(); } continue; }
    log.push(`$ ${cmd}`, text(storageRun(st, cmd)));
    judge();
  }
  return { st, done: judge(), log: log.join('\n') };
}

test('kubectl get sc prints kind\'s default class as tiltdev did', () => {
  const { k } = fresh({});
  // kubectl --context kind-tiltdev get sc
  assert.match(k('kubectl get sc'), /^NAME {17}PROVISIONER {13}RECLAIMPOLICY {3}VOLUMEBINDINGMODE {6}ALLOWVOLUMEEXPANSION {3}AGE\nstandard \(default\) {3}rancher\.io\/local-path {3}Delete {10}WaitForFirstConsumer {3}false {18}\S+$/);
});

test('a claim naming a missing class: the real event, the real columns, Pending for ever', () => {
  const { s, k } = fresh({ 'indexer.yaml': INDEXER });
  // kubectl apply -f (two documents)
  assert.equal(k('kubectl apply -f indexer.yaml'), 'persistentvolumeclaim/indexer-data created\npod/indexer created');
  s.step(300);
  const pvc = k('kubectl get pvc');
  assert.match(pvc, /^NAME +STATUS +VOLUME +CAPACITY +ACCESS MODES +STORAGECLASS +VOLUMEATTRIBUTESCLASS +AGE\n/);
  assert.match(pvc, /indexer-data +Pending +hostpath +<unset> +10m/);
  const d = k('kubectl describe pvc indexer-data');
  // kubectl describe pvc wrong-class
  assert.match(d, /Warning +ProvisioningFailed +\S+ \(x\d+ over 10m\) +persistentvolume-controller +storageclass\.storage\.k8s\.io "hostpath" not found/);
  assert.match(d, /^Finalizers: +\[kubernetes\.io\/pvc-protection\]$/m);
  assert.match(d, /^Used By: +indexer$/m);
  // kubectl describe pod indexer
  assert.match(k('kubectl describe pod indexer'), /Warning +FailedScheduling +\S+.* +default-scheduler +0\/1 nodes are available: pod has unbound immediate PersistentVolumeClaims\. not found/);
  assert.equal(s.pods.get('indexer')!.status, 'Pending');
});

test('the decoy: a default-class claim with no pod waits, correctly, with its own reason', () => {
  const { s, k } = fresh({ 'scratch.yaml': SCRATCH });
  k('kubectl apply -f scratch.yaml');
  s.step(5);
  // kubectl describe pvc data (before the pod existed)
  assert.match(k('kubectl describe pvc scratch'), /Normal +WaitForFirstConsumer +.*persistentvolume-controller +waiting for first consumer to be created before binding/);
  assert.match(k('kubectl get pvc'), /scratch +Pending +standard +<unset>/);
});

// The API server's refusal, byte for byte, for a one-access-mode claim on
// hostpath: `kubectl --context kind-tiltdev -n fix-k8s-3 patch pvc wrong-class
// -p '{"spec":{"storageClassName":"standard"}}'` (1.36.1, 2026-11-03).
const IMMUTABLE = (name: string, to: string) => `The PersistentVolumeClaim "${name}" is invalid: spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims\n@@ -10,7 +10,7 @@\n   }\n  },\n  "VolumeName": "",\n- "StorageClassName": "hostpath",\n+ "StorageClassName": ${to},\n  "VolumeMode": "Filesystem",\n  "DataSource": null,\n  "DataSourceRef": null,\n`;

test('changing the class in place is refused with the real message and diff', () => {
  const { k, f } = fresh({ 'indexer.yaml': INDEXER });
  k('kubectl apply -f indexer.yaml');
  assert.equal(k(`kubectl patch pvc indexer-data -p '{"spec":{"storageClassName":"standard"}}'`), IMMUTABLE('indexer-data', '"standard"'));
  // Two access modes move the hunk down a line: seen on tiltdev with [ReadWriteOnce, ReadOnlyMany].
  f.set('two.yaml', 'apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: two-modes\nspec:\n  storageClassName: hostpath\n  accessModes: [ReadWriteOnce, ReadOnlyMany]\n  resources:\n    requests:\n      storage: 2Gi\n');
  k('kubectl apply -f two.yaml');
  assert.match(k(`kubectl patch pvc two-modes -p '{"spec":{"storageClassName":"standard"}}'`), /\n@@ -11,7 \+11,7 @@\n/);
});

// The original failure: delete the storageClassName line and apply over the
// existing claim, and the sandbox said "persistentvolumeclaim/indexer-data
// unchanged" (and "pod/indexer configured"), telling the learner the edit had
// worked. kubectl's three-way merge sends the field's removal, and the API
// refuses it. Real, on tiltdev 1.36.1, `kubectl apply -f` of the same edit
// over an applied claim: the refusal below, after the other objects' lines.
test('apply that drops an applied class is refused, not "unchanged" (the silent success)', () => {
  const { s, f, k } = fresh({ 'indexer.yaml': INDEXER });
  k('kubectl apply -f indexer.yaml');
  f.set('indexer.yaml', INDEXER.replace('  storageClassName: hostpath\n', ''));
  const out = k('kubectl apply -f indexer.yaml');
  assert.doesNotMatch(out, /indexer-data unchanged/);
  assert.equal(out, 'pod/indexer configured\n' + IMMUTABLE('indexer-data', 'null'));
  assert.equal(s.claims.get('indexer-data')!.className, 'hostpath');
  // A class that was defaulted at creation is not in the last apply, so leaving it out is a no-op.
  f.set('d.yaml', 'apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: d\nspec:\n  accessModes: [ReadWriteOnce]\n  resources:\n    requests:\n      storage: 1Gi\n');
  assert.equal(k('kubectl apply -f d.yaml'), 'persistentvolumeclaim/d created');
  assert.equal(k('kubectl apply -f d.yaml'), 'persistentvolumeclaim/d unchanged');
  // Naming the class it already has changes only the last-applied note: real said "configured".
  const named = f.get('d.yaml')!.replace('spec:\n', 'spec:\n  storageClassName: standard\n');
  f.set('d.yaml', named);
  assert.equal(k('kubectl apply -f d.yaml'), 'persistentvolumeclaim/d configured');
  assert.equal(k('kubectl apply -f d.yaml'), 'persistentvolumeclaim/d unchanged');
  // And now that the last apply named it, dropping it again is refused, as it was for real.
  f.set('d.yaml', named.replace('  storageClassName: standard\n', ''));
  assert.match(k('kubectl apply -f d.yaml'), /^The PersistentVolumeClaim "d" is invalid: spec: Forbidden: spec is immutable[^\n]*\n@@ -10,7 \+10,7 @@\n[\s\S]*- "StorageClassName": "standard",\n\+ "StorageClassName": null,\n/);
});

test('unknown and missing fields fail as a real API server fails them', () => {
  const { f, k } = fresh({});
  f.set('typo.yaml', 'apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: typo\nspec:\n  storageClass: standard\n  accessModes: [ReadWriteOnce]\n  resources:\n    requests:\n      storage: 1Gi\n');
  assert.equal(k('kubectl apply -f typo.yaml'), 'Error from server (BadRequest): error when creating "typo.yaml": PersistentVolumeClaim in version "v1" cannot be handled as a PersistentVolumeClaim: strict decoding error: unknown field "spec.storageClass"');
  f.set('nosize.yaml', 'apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: nosize\nspec:\n  accessModes: [ReadWriteOnce]\n');
  assert.equal(k('kubectl apply -f nosize.yaml'), 'The PersistentVolumeClaim "nosize" is invalid: spec.resources[storage]: Required value');
  // A real field the sandbox does not model is refused by name, never ignored.
  f.set('mode.yaml', 'apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: m\nspec:\n  volumeMode: Block\n  accessModes: [ReadWriteOnce]\n  resources:\n    requests:\n      storage: 1Gi\n');
  assert.match(k('kubectl apply -f mode.yaml'), /^sandbox: PersistentVolumeClaim field "spec\.volumeMode" is real Kubernetes, but this sandbox does not model it/);
});

test('fixing the file binds through the provisioner, with the events in the real order', () => {
  const { s, f, k } = fresh({ 'indexer.yaml': INDEXER });
  k('kubectl apply -f indexer.yaml');
  s.step(5);
  // Deleting a claim that only an unscheduled pod names is immediate (no protection).
  assert.equal(k('kubectl delete pvc indexer-data'), 'persistentvolumeclaim "indexer-data" deleted from default namespace');
  s.step();
  f.set('indexer.yaml', INDEXER.replace('  storageClassName: hostpath\n', ''));
  // apply again: the real server said "configured" for the unchanged Pod
  assert.equal(k('kubectl apply -f indexer.yaml'), 'persistentvolumeclaim/indexer-data created\npod/indexer configured');
  s.step(15);
  assert.match(k('kubectl get pvc'), /indexer-data +Bound +pvc-[0-9a-f-]{36} +1Gi +RWO +standard +<unset>/);
  assert.equal(s.pods.get('indexer')!.status, 'Running');
  const reasons = [...k('kubectl describe pvc indexer-data').matchAll(/^ {2}Normal +(\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(reasons, ['WaitForPodScheduled', 'ExternalProvisioning', 'Provisioning', 'ProvisioningSucceeded']);
  assert.match(k('kubectl get pv'), /^NAME +CAPACITY +ACCESS MODES +RECLAIM POLICY +STATUS +CLAIM +STORAGECLASS +VOLUMEATTRIBUTESCLASS +REASON +AGE\npvc-\S+ +1Gi +RWO +Delete +Bound +default\/indexer-data +standard +<unset> +\S+$/);
  // kubectl describe pod indexer: the scheduler's message while the claim was being deleted
  assert.match(k('kubectl describe pod indexer'), /0\/1 nodes are available: persistentvolumeclaim "indexer-data" (not found|is being deleted)\. not found/);
});

test('a claim in use stays Terminating until its pod is gone, then Delete takes the volume', () => {
  const { s, f, k } = fresh({ 'indexer.yaml': INDEXER.replace('hostpath', 'standard') });
  k('kubectl apply -f indexer.yaml');
  s.step(15);
  const out = kubectl(s, f, 'kubectl delete pvc indexer-data');
  assert.equal(out[0].text, 'persistentvolumeclaim "indexer-data" deleted from default namespace');
  assert.equal(out[1].kind, 'dim');
  s.step(3);
  assert.match(k('kubectl get pvc'), /indexer-data +Terminating +pvc-/);
  k('kubectl delete pod indexer');
  s.step(6);
  assert.equal(k('kubectl get pvc'), 'No resources found in default namespace.');
  assert.equal(k('kubectl get pv'), 'No resources found');
});

test('Retain keeps the volume Released, data and all, and a new claim gets a new volume', () => {
  const { s, f, k } = fresh({ 'indexer.yaml': INDEXER.replace('hostpath', 'standard') });
  k('kubectl apply -f indexer.yaml');
  s.step(15);
  k('kubectl exec indexer -- sh -c "echo kept > /data/note.txt"');
  const pv = s.claims.get('indexer-data')!.volume!;
  assert.equal(k(`kubectl patch pv ${pv} -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'`), `persistentvolume/${pv} patched`);
  k('kubectl delete pod indexer');
  k('kubectl delete pvc indexer-data');
  s.step(6);
  assert.match(k('kubectl get pv'), new RegExp(`${pv} +1Gi +RWO +Retain +Released +default/indexer-data`));
  assert.equal(k(`docker exec kind-control-plane cat /var/local-path-provisioner/${pv}_default_indexer-data/note.txt`), 'kept');
  k('kubectl apply -f indexer.yaml');
  s.step(15);
  assert.notEqual(s.claims.get('indexer-data')!.volume, pv);
  void f;
});

test('exec errors match busybox and kubectl', () => {
  const { s, k } = fresh({ 'indexer.yaml': INDEXER.replace('hostpath', 'standard') });
  k('kubectl apply -f indexer.yaml');
  s.step(15);
  // kubectl exec sh -- cat /data/nope.txt
  assert.equal(k('kubectl exec indexer -- cat /data/nope.txt'), "cat: can't open '/data/nope.txt': No such file or directory\ncommand terminated with exit code 1");
  assert.equal(k('kubectl exec nopod -- ls'), 'Error from server (NotFound): pods "nopod" not found');
});

test('StatefulSet: ordered start, the real event wording, and claims that outlive a scale-down', () => {
  const { s, k } = fresh({ 'web.yaml': WEB });
  assert.equal(k('kubectl apply -f web.yaml'), 'service/web created\nstatefulset.apps/web created');
  s.step(3);
  // web-1 must not exist before web-0 is Running and Ready
  assert.ok(s.pods.has('web-0') && !s.pods.has('web-1'));
  s.step(40);
  assert.match(k('kubectl get sts'), /^NAME +READY +AGE\nweb +3\/3 +\S+$/);
  const d = k('kubectl describe sts web');
  // kubectl describe sts slow
  assert.match(d, /SuccessfulCreate +\S+ +statefulset-controller +Create Claim data-web-0 Pod web-0 in StatefulSet web success$/m);
  assert.match(d, /SuccessfulCreate +\S+ +statefulset-controller +Create Pod web-0 in StatefulSet web successful$/m);
  assert.equal(k('kubectl scale sts web --replicas=1'), 'statefulset.apps/web scaled');
  s.step(1);
  // Highest ordinal first: web-2 goes before web-1 is touched.
  assert.equal(s.pods.get('web-2')!.status, 'Terminating');
  assert.equal(s.pods.get('web-1')!.status, 'Running');
  s.step(20);
  assert.equal([...s.pods.keys()].join(), 'web-0');
  assert.equal([...s.claims.keys()].sort().join(), 'data-web-0,data-web-1,data-web-2');
});

test('forced rollback: fixing the template does not free a pod stuck on the bad one', () => {
  const { s, k } = fresh({ 'web.yaml': WEB });
  k('kubectl apply -f web.yaml');
  s.step(40);
  assert.equal(k('kubectl set image sts/web app=panda/web:2.O'), 'statefulset.apps/web image updated');
  s.step(20);
  assert.match(s.pods.get('web-2')!.status, /ErrImagePull|ImagePullBackOff/);
  assert.equal(s.pods.get('web-1')!.image, 'panda/web:1.0');
  k('kubectl set image sts/web app=panda/web:2.0');
  // On 1.36.1 the stuck pod was still on the bad image 2m41s after the revert.
  s.step(90);
  assert.equal(s.pods.get('web-2')!.image, 'panda/web:2.O');
  assert.equal(s.pods.get('web-1')!.image, 'panda/web:1.0');
  assert.equal(k('kubectl delete pod web-2'), 'pod "web-2" deleted from default namespace');
  s.step(40);
  assert.deepEqual([0, 1, 2].map((i) => s.pods.get(`web-${i}`)!.image), ['panda/web:2.0', 'panda/web:2.0', 'panda/web:2.0']);
  assert.equal(k('kubectl rollout status sts/web'), 'partitioned roll out complete: 3 new pods have been updated...');
});

test('whenScaled: Delete removes the claims of scaled-away ordinals', () => {
  const { s, k } = fresh({ 'web.yaml': WEB });
  k('kubectl apply -f web.yaml');
  s.step(40);
  assert.equal(k(`kubectl patch sts web -p '{"spec":{"persistentVolumeClaimRetentionPolicy":{"whenScaled":"Delete"}}}'`), 'statefulset.apps/web patched');
  k('kubectl scale sts web --replicas=1');
  s.step(30);
  assert.equal([...s.claims.keys()].join(), 'data-web-0');
});

test('the sandbox refuses what it does not model, by name', () => {
  const { k } = fresh({});
  assert.match(k('kubectl get pvc | grep Pending'), /^sandbox: "\|" needs a real shell/);
  assert.match(k('kubectl get pvc -w'), /^sandbox: --watch/);
  assert.match(k('kubectl get deploy'), /^sandbox: this storage sandbox does not model deploy/);
  assert.match(k('kubectl get pvc --bogus'), /^error: unknown flag: --bogus/);
  assert.match(k('kubectl get foo'), /^error: the server doesn't have a resource type "foo"/);
  assert.match(k('kubectl edit pvc x'), /^sandbox: kubectl edit/);
});

test('mission: volumes plays start to finish, every step ticked at once', () => {
  const fix = INDEXER.replace('  storageClassName: hostpath\n', '');
  const m = VOLUMES_MISSION;
  const st = m.setup();
  const judge = () => { let ok = true; return m.steps.map((x) => (ok = ok && x.done(st))); };
  for (const c of ['kubectl get pods,pvc', 'kubectl describe pvc indexer-data', 'kubectl get sc', 'kubectl delete pvc indexer-data']) { storageRun(st, c); judge(); }
  // The deleted claim is gone on the next tick. Applying inside the same tick
  // gets the real "currently being deleted" warning and no new claim.
  st.s.step();
  st.files.set('indexer.yaml', fix);
  storageRun(st, 'kubectl apply -f indexer.yaml');
  for (let i = 0; i < 20; i++) { st.s.step(); judge(); }
  storageRun(st, 'kubectl describe pvc scratch'); judge();
  storageRun(st, 'kubectl exec indexer -- sh -c "echo panda-data > /data/note.txt"'); judge();
  const pv = st.s.claims.get('indexer-data')!.volume!;
  for (const c of [`kubectl patch pv ${pv} -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'`, 'kubectl delete pod indexer', 'kubectl delete pvc indexer-data']) { storageRun(st, c); judge(); }
  for (let i = 0; i < 10; i++) { st.s.step(); judge(); }
  assert.deepEqual(judge(), m.steps.map(() => true));
});

test('mission: volumes refuses the shortcuts', () => {
  const m = VOLUMES_MISSION;
  // A StorageClass named hostpath makes the claim bind, and does not pass.
  const st = m.setup();
  st.files.set('alias.yaml', 'apiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: hostpath\nprovisioner: rancher.io/local-path\nvolumeBindingMode: WaitForFirstConsumer\n');
  for (const c of ['kubectl get pvc', 'kubectl describe pvc indexer-data', 'kubectl get sc', 'kubectl apply -f alias.yaml']) storageRun(st, c);
  st.s.step(30);
  assert.equal(st.s.claims.get('indexer-data')!.phase, 'Bound');
  assert.equal(m.steps[3].done(st), false);
  assert.match(m.steps[3].why!(st), /You made a class called hostpath/);
  // Deleting without Retain loses the data, and the step says how to try again.
  const st2 = m.setup();
  st2.files.set('indexer.yaml', INDEXER.replace('hostpath', 'standard'));
  storageRun(st2, 'kubectl delete pvc indexer-data');
  st2.s.step();
  storageRun(st2, 'kubectl apply -f indexer.yaml');
  st2.s.step(20);
  for (const c of ['kubectl exec indexer -- sh -c "echo x > /data/a.txt"', 'kubectl delete pod indexer', 'kubectl delete pvc indexer-data']) storageRun(st2, c);
  st2.s.step(10);
  assert.equal(m.steps[6].done(st2), false);
  assert.match(m.steps[6].why!(st2), /reclaim policy was Delete/);
});

test('mission: statefulsets plays start to finish, and a revert alone does not pass', () => {
  const r = play(STATEFULSET_MISSION, ['kubectl get pods,pvc', 50, 'kubectl exec web-2 -- sh -c "echo written-before-scale-down > /data/note.txt"', 'kubectl scale sts web --replicas=1', 30, 'kubectl get pvc', 'kubectl scale sts web --replicas=3', 40, 'kubectl exec web-2 -- cat /data/note.txt', 'kubectl set image sts/web app=panda/web:2.O', 20, 'kubectl set image sts/web app=panda/web:2.0', 60]);
  assert.match(r.log, /written-before-scale-down/);
  assert.deepEqual(r.done, [true, true, true, true, true, true, false], r.log);
  assert.match(STATEFULSET_MISSION.steps[6].why!(r.st), /still runs the broken image/);
  storageRun(r.st, 'kubectl delete pod web-2');
  for (let i = 0; i < 40; i++) r.st.s.step();
  let ok = true;
  assert.deepEqual(STATEFULSET_MISSION.steps.map((x) => (ok = ok && x.done(r.st))), STATEFULSET_MISSION.steps.map(() => true));
});

test('rollout status says "Waiting for N pods to be ready" while a pod is stuck, as kubectl does', () => {
  const { s, k } = fresh({ 'web.yaml': WEB });
  k('kubectl apply -f web.yaml');
  s.step(40);
  k('kubectl set image sts/web app=panda/web:2.O');
  s.step(20);
  // kubectl 1.37.2 `rollout status sts/web --watch=false` on tiltdev, web-2 in
  // ErrImagePull: readiness is tested before staleness (rollout_status.go).
  // The sandbox used to print "Waiting for partitioned roll out to finish" here.
  assert.equal(kubectl(s, new Map(), 'kubectl rollout status sts/web')[0].text, 'Waiting for 1 pods to be ready...');
});

test('describe in another namespace is NotFound, not default\'s object', () => {
  const { k } = fresh({ 'indexer.yaml': INDEXER });
  k('kubectl apply -f indexer.yaml');
  // kubectl -n kube-system describe pvc rwop, on tiltdev (the claim lived in fix-k8s-3)
  assert.equal(k('kubectl describe pvc indexer-data -n kube-system'), 'Error from server (NotFound): persistentvolumeclaims "indexer-data" not found');
  assert.match(k('kubectl describe pvc indexer-data -n default'), /^Name: +indexer-data$/m);
});

test('real kubectl verbs and flags the sandbox lacks are named as the sandbox\'s limit', () => {
  const { k } = fresh({ 'indexer.yaml': INDEXER });
  assert.match(k('kubectl create -f indexer.yaml'), /^sandbox: kubectl create -f <file> is real/);
  assert.match(k('kubectl delete pvc x -n default'), /^sandbox: -n is a real kubectl flag/);
  assert.match(k('kubectl get pvc --context kind-tiltdev'), /^sandbox: --context is real kubectl/);
  // and a flag kubectl really lacks still gets kubectl's own words
  assert.match(k('kubectl get pvc --bogus'), /^error: unknown flag: --bogus/);
});

test('pod IPs are valid and never shared', () => {
  const { s, k } = fresh({ 'web.yaml': WEB, 'indexer.yaml': INDEXER.replace('hostpath', 'standard') });
  k('kubectl apply -f web.yaml');
  k('kubectl apply -f indexer.yaml');
  s.step(60);
  const ips = [...k('kubectl get pods -o wide').matchAll(/ (10\.244\.0\.(\d+)) /g)];
  assert.equal(ips.length, 4);
  assert.equal(new Set(ips.map((m) => m[1])).size, 4);
  for (const m of ips) assert.ok(+m[2] >= 2 && +m[2] <= 254, m[1]);
});

test('mission: volumes passes a class you made on purpose, and an apply over the claim does not pass', () => {
  const m = VOLUMES_MISSION;
  // Differently-shaped right answer: a Retain class of your own, named in the manifest.
  const st = m.setup();
  st.files.set('keep.yaml', 'apiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: keep\nprovisioner: rancher.io/local-path\nreclaimPolicy: Retain\nvolumeBindingMode: WaitForFirstConsumer\n');
  for (const c of ['kubectl get pods,pvc', 'kubectl describe pvc indexer-data', 'kubectl get sc', 'kubectl apply -f keep.yaml', 'kubectl delete pvc indexer-data']) storageRun(st, c);
  st.s.step();
  st.files.set('indexer.yaml', INDEXER.replace('hostpath', 'keep'));
  storageRun(st, 'kubectl apply -f indexer.yaml');
  st.s.step(20);
  let ok = true;
  assert.deepEqual(m.steps.slice(0, 4).map((x) => (ok = ok && x.done(st))), [true, true, true, true]);
  // Shortcut: edit the file and apply without deleting the claim. Refused, so not passed.
  const st2 = m.setup();
  for (const c of ['kubectl get pods,pvc', 'kubectl describe pvc indexer-data', 'kubectl get sc']) storageRun(st2, c);
  st2.files.set('indexer.yaml', INDEXER.replace('  storageClassName: hostpath\n', ''));
  assert.match(storageRun(st2, 'kubectl apply -f indexer.yaml').map((l) => l.text).join('\n'), /spec is immutable after creation/);
  st2.s.step(20);
  assert.equal(m.steps[3].done(st2), false);
  assert.match(m.steps[3].why!(st2), /Delete the claim first/);
});
