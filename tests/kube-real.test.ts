// Every message the workloads lessons copy from a real cluster, pinned. The
// source for each is the same unless a comment says otherwise: kubectl 1.37.2
// against a kind v1.36.1 cluster (kindest/node:v1.36.1, the image tilt pins),
// run on 2026-11-03 in a throwaway cluster named k8s-a, or read-only on the
// tilt platform's tiltdev cluster. Names (pods, uids, IPs) differ; the shape
// and the words must not. When a later Kubernetes changes a message, this file
// is where the lessons find out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cluster, cronMatches, parseCron, type NodeSpec } from '../src/lib/kube/cluster.ts';
import { kubectl, human, jsonpath, parseSelector, selects } from '../src/lib/kube/kubectl.ts';
import { base64, unbase64, toYaml } from '../src/lib/kube/yaml.ts';

const k = (c: Cluster, cmd: string, files = {}) => kubectl(c, cmd, undefined, files).map((l) => l.text).join('\n');
const kinds = (c: Cluster, cmd: string, files = {}) => kubectl(c, cmd, undefined, files).map((l) => l.kind);
const THREE: NodeSpec[] = [{ name: 'control-plane', cpu: 2000, mem: 4096, controlPlane: true }, { name: 'worker-1', cpu: 2000, mem: 4096 }, { name: 'worker-2', cpu: 2000, mem: 4096 }];
const podOf = (c: Cluster, owner: string) => [...c.pods.values()].find((p) => p.status !== 'Terminating' && (p.owner === owner || p.owner.startsWith(owner + '-')))!;

// ---- namespaces, labels, the object model -------------------------------

test('an empty namespace is "No resources found", on stderr with no error, and names the namespace', () => {
  const c = new Cluster();
  assert.equal(k(c, 'kubectl get pods'), 'No resources found in default namespace.');
  assert.deepEqual(kinds(c, 'kubectl get pods'), ['dim'], 'not an error: exit code 0 on a real cluster');
  assert.equal(k(c, 'kubectl get pods -n nope'), 'No resources found in nope namespace.', 'even for a namespace that does not exist');
  assert.equal(k(c, 'kubectl get pods -A -l app=nobody'), 'No resources found');
});

test('namespaces: create twice, delete a protected one, delete prints the 1.37 shape', () => {
  const c = new Cluster();
  assert.equal(k(c, 'kubectl create namespace shop'), 'namespace/shop created');
  assert.equal(k(c, 'kubectl create namespace shop'), 'Error from server (AlreadyExists): namespaces "shop" already exists');
  assert.equal(k(c, 'kubectl delete ns default'), 'Error from server (Forbidden): namespaces "default" is forbidden: this namespace may not be deleted');
  assert.equal(k(c, 'kubectl delete namespace nope'), 'Error from server (NotFound): namespaces "nope" not found');
  k(c, 'kubectl -n shop create deployment hello --image=panda/hello:1.0 --replicas=2');
  assert.equal(k(c, 'kubectl get deploy hello'), 'Error from server (NotFound): deployments.apps "hello" not found');
  c.step(4);
  assert.match(k(c, 'kubectl get pods -A'), /^NAMESPACE\s+NAME\s+READY\s+STATUS\s+RESTARTS\s+AGE\nshop\s+hello-/);
  assert.match(k(c, 'kubectl -n shop get pods --show-labels'), /LABELS\n.*app=hello,pod-template-hash=/);
  assert.match(k(c, 'kubectl get ns shop --show-labels'), /shop\s+Active\s+\S+\s+kubernetes\.io\/metadata\.name=shop/);
  assert.match(k(c, 'kubectl -n shop get deploy,rs'), /^NAME\s+READY\s+UP-TO-DATE\s+AVAILABLE\s+AGE\ndeployment\.apps\/hello\s+2\/2[\s\S]*\n\nNAME\s+DESIRED\s+CURRENT\s+READY\s+AGE\nreplicaset\.apps\/hello-/);
  assert.equal(k(c, 'kubectl -n shop delete deployment hello'), 'deployment.apps "hello" deleted from shop namespace');
  assert.equal(k(c, 'kubectl delete ns shop'), 'namespace "shop" deleted');
  assert.match(k(c, 'kubectl get ns shop'), /shop\s+Terminating/);
});

test('set-context changes the namespace kubectl uses, and does not check it exists', () => {
  const c = new Cluster();
  assert.equal(k(c, 'kubectl config set-context --current --namespace=shop'), 'Context "kind-sandbox" modified.');
  assert.match(k(c, 'kubectl config get-contexts'), /CURRENT\s+NAME\s+CLUSTER\s+AUTHINFO\s+NAMESPACE\n\*\s+kind-sandbox\s+kind-sandbox\s+kind-sandbox\s+shop/);
  assert.equal(k(c, 'kubectl get pods'), 'No resources found in shop namespace.');
});

test('label: overwrite is refused without --overwrite; selectors match like the real ones', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment hello --image=panda/hello:1.0');
  assert.equal(k(c, 'kubectl label deploy hello tier=web'), 'deployment.apps/hello labeled');
  assert.equal(k(c, 'kubectl label deploy hello tier=api'), "error: 'tier' already has a value (web), and --overwrite is false");
  assert.equal(k(c, 'kubectl label deploy hello tier=api --overwrite'), 'deployment.apps/hello labeled');
  assert.equal(k(c, 'kubectl label deploy hello tier-'), 'deployment.apps/hello unlabeled');
  assert.equal(k(c, 'kubectl label node worker-1 disktype=ssd'), 'node/worker-1 labeled');
  assert.match(k(c, 'kubectl get nodes -l disktype=ssd'), /\nworker-1\s/);
  assert.match(k(c, 'kubectl get nodes -L disktype'), /DISKTYPE[\s\S]*worker-1.*ssd/);
  const l = { app: 'hello', tier: 'web' };
  assert.ok(selects(parseSelector('app in (hello,bye)'), l));
  assert.ok(!selects(parseSelector('app!=hello'), l));
  assert.ok(selects(parseSelector('app'), l) && !selects(parseSelector('!app'), l));
});

test('output formats: an unknown -o lists the real choices; -o name; -o yaml quotes like kubectl', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment hello --image=panda/hello:1.0');
  assert.equal(k(c, 'kubectl get pods -o widee'), 'error: unable to match a printer suitable for the output format "widee", allowed formats are: custom-columns,custom-columns-file,go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,kyaml,name,template,templatefile,wide,yaml');
  assert.equal(k(c, 'kubectl get frobs'), 'error: the server doesn\'t have a resource type "frobs"');
  assert.equal(k(c, 'kubectl get deploy hello -o name'), 'deployment.apps/hello');
  c.step(1);
  const y = k(c, 'kubectl get deploy hello -o yaml');
  for (const line of ['apiVersion: apps/v1', '    deployment.kubernetes.io/revision: "1"', '  progressDeadlineSeconds: 600', '  revisionHistoryLimit: 10', '      maxSurge: 25%', '      - image: panda/hello:1.0', '      dnsPolicy: ClusterFirst', '      terminationGracePeriodSeconds: 30']) {
    assert.ok(y.split('\n').includes(line), `-o yaml has "${line}"`);
  }
  assert.match(y, /^  creationTimestamp: "2026-11-03T06:00:00Z"$/m);
  assert.equal(toYaml({ spec: { schedule: '*/1 * * * *', empty: {}, list: [] } }), "spec:\n  empty: {}\n  list: []\n  schedule: '*/1 * * * *'");
  assert.equal(k(c, 'kubectl get pods -o yaml -l app=nobody'), 'apiVersion: v1\nitems: []\nkind: List\nmetadata:\n  resourceVersion: ""');
});

test('explain carries the real text, and an unknown field is "does not exist"', () => {
  const c = new Cluster();
  assert.match(k(c, 'kubectl explain deployment.spec.replicas'), /FIELD: replicas <integer>\n\n\nDESCRIPTION:\n    Number of desired pods\. This is a pointer to distinguish between explicit\n    zero and not specified\. Defaults to 1\./);
  assert.match(k(c, 'kubectl explain deployment.spec.nonsense'), /error: field "nonsense" does not exist$/);
  assert.match(k(c, 'kubectl explain cronjob.spec.suspend'), /This flag tells the controller to suspend subsequent executions, it does not\n    apply to already started executions\.  Defaults to false\./);
});

test('api-resources rows match the real ones for every kind modelled', () => {
  const c = new Cluster();
  const out = k(c, 'kubectl api-resources');
  for (const row of [/^configmaps\s+cm\s+v1\s+true\s+ConfigMap$/m, /^secrets\s+v1\s+true\s+Secret$/m, /^daemonsets\s+ds\s+apps\/v1\s+true\s+DaemonSet$/m, /^cronjobs\s+cj\s+batch\/v1\s+true\s+CronJob$/m, /^jobs\s+batch\/v1\s+true\s+Job$/m, /^namespaces\s+ns\s+v1\s+false\s+Namespace$/m]) assert.match(out, row);
});

test('kubectl prints ages the way HumanDuration does', () => {
  assert.deepEqual([45, 107, 151, 125, 3840, 11100, 30000, 200000].map(human), ['45s', '107s', '2m31s', '2m5s', '64m', '3h5m', '8h', '2d']);
});

test('global flags work before the verb, and unknown flags are refused by name', () => {
  const c = new Cluster();
  k(c, 'kubectl create ns shop');
  assert.equal(k(c, 'kubectl -n shop create deployment web --image=panda/hello:1.0'), 'deployment.apps/web created');
  assert.ok(c.getDeployment('shop', 'web'));
  assert.equal(k(c, 'kubectl get pods --sort-by=.metadata.name'), "error: unknown flag: --sort-by\nSee 'kubectl get --help' for usage.");
  assert.equal(k(c, 'kubectl get pods -z'), "error: unknown shorthand flag: 'z' in -z\nSee 'kubectl get --help' for usage.");
});

// ---- ConfigMaps and Secrets ---------------------------------------------

test('configmaps and secrets: create, the errors, describe hides values, yaml shows base64', () => {
  const c = new Cluster();
  assert.equal(k(c, 'kubectl create configmap greeting --from-literal=GREETING=v1 --from-literal=COLOUR=green'), 'configmap/greeting created');
  assert.equal(k(c, 'kubectl create configmap greeting --from-literal=GREETING=v1'), 'error: failed to create configmap: configmaps "greeting" already exists');
  assert.equal(k(c, 'kubectl create configmap bad --from-literal=GREETING'), 'error: invalid literal source GREETING, expected key=value');
  assert.match(k(c, 'kubectl get configmap'), /^NAME\s+DATA\s+AGE\ngreeting\s+2\s+\S+\nkube-root-ca\.crt\s+1\s+/);
  assert.match(k(c, 'kubectl describe cm greeting'), /Data\n====\nCOLOUR:\n----\ngreen\n\nGREETING:\n----\nv1\n\n\nBinaryData\n====\n\nEvents:  <none>/);
  assert.equal(k(c, 'kubectl create secret generic db --from-literal=DATABASE_URL=postgres://panda:bamboo@db:5432/shop'), 'secret/db created');
  assert.match(k(c, 'kubectl get secrets'), /^NAME\s+TYPE\s+DATA\s+AGE\ndb\s+Opaque\s+1\s+/);
  assert.match(k(c, 'kubectl get secret db -o yaml'), /^  DATABASE_URL: cG9zdGdyZXM6Ly9wYW5kYTpiYW1ib29AZGI6NTQzMi9zaG9w$/m);
  assert.match(k(c, 'kubectl describe secret db'), /Type:  Opaque\n\nData\n====\nDATABASE_URL:  36 bytes$/);
  assert.equal(k(c, 'echo cG9zdGdyZXM6Ly9wYW5kYTpiYW1ib29AZGI6NTQzMi9zaG9w | base64 -d'), 'postgres://panda:bamboo@db:5432/shop');
  assert.equal(unbase64(base64('héllo')), 'héllo');
  assert.equal(k(c, `kubectl get secret db -o jsonpath='{.data.DATABASE_URL}'`), 'cG9zdGdyZXM6Ly9wYW5kYTpiYW1ib29AZGI6NTQzMi9zaG9w');
});

test('set env --from copies the keys that exist now, and refuses a missing source', () => {
  const c = new Cluster();
  k(c, 'kubectl create configmap greeting --from-literal=GREETING=v1');
  k(c, 'kubectl create deployment web --image=panda/greeter:1.0');
  assert.equal(k(c, 'kubectl set env deploy/web --from=configmap/nothere'), 'Error from server (NotFound): configmaps "nothere" not found');
  assert.equal(k(c, 'kubectl set env deploy/web --from=configmap/greeting'), 'deployment.apps/web env updated');
  assert.deepEqual(c.getDeployment('default', 'web')!.template.envRefs, [{ name: 'GREETING', kind: 'configMap', ref: 'greeting', key: 'GREETING' }]);
  assert.match(k(c, 'kubectl get deploy web -o jsonpath={.spec.template.spec.containers[0].env}'), /"configMapKeyRef":\{"key":"GREETING","name":"greeting"\}/);
  c.step(5);
  assert.match(k(c, `kubectl describe pod ${podOf(c, 'web').name}`), /GREETING:\s+<set to the key 'GREETING' of config map 'greeting'>\s+Optional: false/);
  // A key added later is not in the Deployment, so no restart will bring it in.
  k(c, `kubectl patch configmap greeting -p '{"data":{"NEW":"x"}}'`);
  k(c, 'kubectl rollout restart deployment/web');
  c.step(8);
  assert.equal(podOf(c, 'web').env.NEW, undefined);
});

test('a missing ConfigMap or key is CreateContainerConfigError, with the kubelet\'s words', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment broken --image=panda/hello:1.0');
  k(c, `kubectl patch deploy broken -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","envFrom":[{"configMapRef":{"name":"missing"}}]}]}}}}'`);
  c.step(6);
  assert.match(k(c, 'kubectl get pods'), /broken-\S+\s+0\/1\s+CreateContainerConfigError\s+0/);
  assert.match(k(c, 'kubectl get events'), /Warning\s+Failed\s+pod\/broken-\S+\s+Error: configmap "missing" not found/);
  k(c, 'kubectl create configmap greeting2 --from-literal=A=1');
  k(c, `kubectl patch deploy broken -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","envFrom":null,"env":[{"name":"X","valueFrom":{"configMapKeyRef":{"name":"greeting2","key":"NOPE"}}}]}]}}}}'`);
  c.step(6);
  assert.match(k(c, `kubectl describe pod ${[...c.pods.values()].filter((p) => p.status === 'CreateContainerConfigError').pop()!.name}`), /kubelet\s+spec\.containers\{app\}: Error: couldn't find key NOPE in ConfigMap default\/greeting2/);
  assert.match(k(c, 'kubectl rollout status deploy/broken'), /old replicas are pending termination/, 'the old pod keeps serving');
});

test('a missing ConfigMap volume is FailedMount and ContainerCreating for ever', () => {
  const c = new Cluster();
  const files = { 'p.yaml': { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'mountmissing' }, spec: { containers: [{ name: 'app', image: 'panda/hello:1.0', volumeMounts: [{ name: 'cfg', mountPath: '/etc/cfg' }] }], volumes: [{ name: 'cfg', configMap: { name: 'nothere' } }] } } };
  assert.equal(k(c, 'kubectl apply -f p.yaml', files), 'pod/mountmissing created');
  c.step(10);
  assert.match(k(c, 'kubectl get pod mountmissing'), /mountmissing\s+0\/1\s+ContainerCreating\s+0/);
  assert.match(k(c, 'kubectl describe pod mountmissing'), /Warning\s+FailedMount\s+\S+ \(x\d+ over \S+\)\s+kubelet\s+MountVolume\.SetUp failed for volume "cfg" : configmap "nothere" not found/);
});

test('mounted ConfigMap: the folder updates on the kubelet sync, the subPath file never does', () => {
  const c = new Cluster();
  k(c, 'kubectl create configmap greeting --from-literal=GREETING=v1');
  const files = { 'f.yaml': { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'files' }, spec: { replicas: 1, template: { metadata: { labels: { app: 'files' } }, spec: { containers: [{ name: 'app', image: 'panda/reads-file:1.0', volumeMounts: [{ name: 'g', mountPath: '/etc/greeting' }, { name: 'g', mountPath: '/etc/sub/GREETING', subPath: 'GREETING' }] }], volumes: [{ name: 'g', configMap: { name: 'greeting' } }] } } } } };
  k(c, 'kubectl apply -f f.yaml', files);
  c.step(4);
  const p = podOf(c, 'files');
  assert.equal(k(c, `kubectl exec ${p.name} -- ls /etc/greeting`), 'GREETING');
  k(c, `kubectl patch configmap greeting -p '{"data":{"GREETING":"v2"}}'`);
  assert.equal(k(c, `kubectl exec ${p.name} -- cat /etc/greeting/GREETING`), 'v1', 'not at once');
  c.step(13);
  assert.equal(k(c, `kubectl exec ${p.name} -- cat /etc/greeting/GREETING`), 'v2', 'within one sync period (about a minute)');
  assert.equal(k(c, `kubectl exec ${p.name} -- cat /etc/sub/GREETING`), 'v1', 'subPath: never');
  assert.match(k(c, `kubectl describe pod ${p.name}`), /\/etc\/sub\/GREETING from g \(rw,path="GREETING"\)/);
});

test('rollout restart is an annotation on the template, so it makes new pods', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment web --image=panda/hello:1.0');
  c.step(3);
  const first = podOf(c, 'web').name;
  assert.equal(k(c, 'kubectl rollout restart deploy/nope'), 'Error from server (NotFound): deployments.apps "nope" not found');
  assert.equal(k(c, 'kubectl rollout restart deploy/web'), 'deployment.apps/web restarted');
  assert.ok('kubectl.kubernetes.io/restartedAt' in c.getDeployment('default', 'web')!.template.annotations);
  c.step(8);
  assert.notEqual(podOf(c, 'web').name, first);
});

test('patch: an unknown field is warned about and dropped; a new container needs an image', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment two --image=panda/hello:1.0');
  assert.equal(k(c, `kubectl patch deploy two -p '{"spec":{"template":{"spec":{"frobnicate":true}}}}'`), 'Warning: unknown field "spec.template.spec.frobnicate"\ndeployment.apps/two patched (no change)');
  assert.equal(k(c, `kubectl patch deploy two -p '{"spec":{"template":{"spec":{"containers":[{"name":"sidecar"}]}}}}'`), 'The Deployment "two" is invalid: spec.template.spec.containers[0].image: Required value');
  assert.equal(k(c, `kubectl patch deploy two -p 'not json'`), 'Error from server (BadRequest): json: cannot unmarshal string into Go value of type map[string]interface {}');
  assert.match(k(c, `kubectl patch deploy two -p '{"spec":{"template":{"spec":{"hostPID":true}}}}'`), /does not model spec\.template\.spec\.hostPID/, 'a real field we do not model is refused, not dropped');
});

// ---- init containers and sidecars ---------------------------------------

const jobFiles = {
  'plain.yaml': { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'plain-sidecar' }, spec: { template: { spec: { restartPolicy: 'Never', containers: [{ name: 'report', image: 'panda/report:1.0' }, { name: 'log-shipper', image: 'panda/log-shipper:1.0' }] } } } },
  'native.yaml': { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'native-sidecar' }, spec: { template: { spec: { restartPolicy: 'Never', initContainers: [{ name: 'log-shipper', image: 'panda/log-shipper:1.0', restartPolicy: 'Always' }], containers: [{ name: 'report', image: 'panda/report:1.0' }] } } } },
  'shop.yaml': { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'shop' }, spec: { replicas: 1, template: { metadata: { labels: { app: 'shop' } }, spec: { initContainers: [{ name: 'wait-for-db', image: 'panda/wait-for-db:1.0' }], containers: [{ name: 'app', image: 'panda/hello:1.0' }] } } } },
  'migrate.yaml': { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'migrate' }, spec: { replicas: 1, template: { metadata: { labels: { app: 'migrate' } }, spec: { initContainers: [{ name: 'migrate', image: 'panda/migrate:1.0' }], containers: [{ name: 'app', image: 'panda/hello:1.0' }] } } } },
};

test('a regular sidecar keeps a Job running for ever; a native sidecar lets it complete', () => {
  const c = new Cluster();
  for (const f of ['plain.yaml', 'native.yaml']) k(c, `kubectl apply -f ${f}`, jobFiles);
  c.step(4);
  assert.match(k(c, 'kubectl get pods'), /native-sidecar-\S+\s+[12]\/2\s+Running[\s\S]*plain-sidecar-\S+\s+2\/2\s+Running/);
  c.step(6);
  assert.match(k(c, 'kubectl get pods'), /plain-sidecar-\S+\s+1\/2\s+NotReady\s+0/);
  assert.match(k(c, 'kubectl get pods'), /native-sidecar-\S+\s+1\/2\s+Completed\s+0/, 'Completed while the sidecar is still being stopped, as kind showed');
  c.step(10);
  assert.match(k(c, 'kubectl get jobs'), /^NAME\s+STATUS\s+COMPLETIONS\s+DURATION\s+AGE\nnative-sidecar\s+Complete\s+1\/1\s+\S+\s+\S+\nplain-sidecar\s+Running\s+0\/1/);
  assert.match(k(c, 'kubectl get pods'), /native-sidecar-\S+\s+0\/2\s+Completed/);
  const plain = podOf(c, 'plain-sidecar');
  assert.equal(k(c, `kubectl logs ${plain.name}`), 'Defaulted container "report" out of: report, log-shipper\nwriting nightly report\nreport written to /reports/today.csv');
  assert.match(k(c, 'kubectl describe job native-sidecar'), /Normal\s+SuccessfulCreate\s+\S+\s+job-controller\s+Created pod: native-sidecar-\S+\n\s+Normal\s+Completed\s+\S+\s+job-controller\s+Job completed/);
  assert.match(k(c, `kubectl describe pod ${podOf(c, 'native-sidecar').name}`), /Init Containers:\n  log-shipper:[\s\S]*State:\s+Terminated\n\s+Reason:\s+Error\n\s+Exit Code:\s+137/, 'it ignored SIGTERM and was killed after the grace period, as busybox was on kind');
  assert.match(k(c, 'kubectl describe job plain-sidecar'), /Pods Statuses:\s+1 Active \(0 Ready\) \/ 0 Succeeded \/ 0 Failed/);
});

test('an init container that waits: Init:0/1, no app logs, and the real error for logs', () => {
  const c = new Cluster();
  k(c, 'kubectl apply -f shop.yaml', jobFiles);
  c.step(5);
  const p = podOf(c, 'shop');
  assert.match(k(c, 'kubectl get pods'), /shop-\S+\s+0\/1\s+Init:0\/1\s+0/);
  assert.equal(k(c, `kubectl logs ${p.name}`), `Defaulted container "app" out of: app, wait-for-db (init)\nError from server (BadRequest): container "app" in pod "${p.name}" is waiting to start: PodInitializing`);
  assert.equal(k(c, `kubectl logs ${p.name} -c nope`), `error: container nope is not valid for pod ${p.name} out of: app, wait-for-db (init)`);
  assert.match(k(c, `kubectl logs ${p.name} -c wait-for-db`), /waiting for db/);
  k(c, 'kubectl create deployment db --image=panda/db:1.0');
  c.step(10);
  assert.match(k(c, 'kubectl get pods'), /shop-\S+\s+1\/1\s+Running/);
});

test('a failing init container: Init:Error, then the back-off, counted in RESTARTS', () => {
  const c = new Cluster();
  k(c, 'kubectl apply -f migrate.yaml', jobFiles);
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) { c.step(); seen.add(k(c, 'kubectl get pods').split('\n')[1].split(/\s+/)[2]); }
  assert.ok(seen.has('Init:Error') && seen.has('Init:CrashLoopBackOff'), [...seen].join(' '));
  assert.match(k(c, 'kubectl get pods'), /migrate-\S+\s+0\/1\s+\S+\s+[1-9] \(\S+ ago\)/);
  const p = podOf(c, 'migrate');
  assert.match(k(c, `kubectl describe pod ${p.name}`), new RegExp(`spec\\.initContainers\\{migrate\\}: Back-off restarting failed container migrate in pod ${p.name}_default\\(${p.uid}\\)`));
});

// ---- security context and Pod Security -----------------------------------

test('runAsNonRoot on a root image: CreateContainerConfigError with the kubelet message, and no logs', () => {
  const c = new Cluster();
  k(c, 'kubectl run nginx --image=panda/hello:1.0 --overrides=\'{"spec":{"securityContext":{"runAsNonRoot":true}}}\'');
  k(c, 'kubectl run nginx2 --image=panda/hello:1.0 --overrides=\'{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":0}}}\'');
  k(c, 'kubectl run ok --image=panda/hello:1.0 --overrides=\'{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":1000}}}\'');
  c.step(6);
  const p = c.findPod('default', 'nginx')!, p2 = c.findPod('default', 'nginx2')!;
  assert.match(k(c, 'kubectl get pods'), /nginx\s+0\/1\s+CreateContainerConfigError\s+0/);
  assert.match(k(c, 'kubectl describe pod nginx'), new RegExp(`spec\\.containers\\{nginx\\}: Error: container has runAsNonRoot and image will run as root \\(pod: "nginx_default\\(${p.uid}\\)", container: nginx\\)`));
  assert.match(k(c, 'kubectl describe pod nginx2'), new RegExp(`Error: container's runAsUser breaks non-root policy \\(pod: "nginx2_default\\(${p2.uid}\\)", container: nginx2\\)`));
  assert.equal(k(c, 'kubectl logs nginx'), 'Error from server (BadRequest): container "nginx" in pod "nginx" is waiting to start: CreateContainerConfigError');
  assert.match(k(c, 'kubectl get pods'), /ok\s+1\/1\s+Running/);
  assert.equal(k(c, 'kubectl exec ok -- id'), 'uid=1000 gid=0(root) groups=0(root)');
});

test('Pod Security: the refusal, the warning on create, the warning on label, and an invalid level', () => {
  const c = new Cluster();
  k(c, 'kubectl run early --image=panda/hello:1.0');
  assert.equal(k(c, 'kubectl label ns default pod-security.kubernetes.io/enforce=restricted'),
    'Warning: existing pods in namespace "default" violate the new PodSecurity enforce level "restricted:latest"\nWarning: early: allowPrivilegeEscalation != false, unrestricted capabilities, runAsNonRoot != true, seccompProfile\nnamespace/default labeled');
  const refusal = 'violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false (container "x" must set securityContext.allowPrivilegeEscalation=false), unrestricted capabilities (container "x" must set securityContext.capabilities.drop=["ALL"]), runAsNonRoot != true (pod or container "x" must set securityContext.runAsNonRoot=true), seccompProfile (pod or container "x" must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")';
  assert.equal(k(c, 'kubectl run x --image=panda/hello:1.0'), `Error from server (Forbidden): pods "x" is forbidden: ${refusal}`);
  const dep = k(c, 'kubectl create deployment web --image=panda/hello:1.0');
  assert.equal(dep, `Warning: would violate PodSecurity "restricted:latest": ${refusal.replace('violates PodSecurity "restricted:latest": ', '').replaceAll('"x"', '"app"')}\ndeployment.apps/web created`);
  c.step(4);
  assert.match(k(c, 'kubectl get events'), /FailedCreate\s+replicaset\/web-\S+\s+Error creating: pods "web-\S+" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false/);
  assert.match(k(c, 'kubectl get deploy web'), /web\s+0\/1\s+0\s+0/);
  assert.equal(k(c, 'kubectl label ns default pod-security.kubernetes.io/enforce=bogus --overwrite'), 'The Namespace "default" is invalid: metadata.labels[pod-security.kubernetes.io/enforce]: Invalid value: "bogus": must be one of privileged, baseline, restricted');
  const zero = `kubectl run zero --image=panda/hello:1.0 --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":0,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"zero","image":"panda/hello:1.0","securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}'`;
  assert.equal(k(c, zero), 'Error from server (Forbidden): pods "zero" is forbidden: violates PodSecurity "restricted:latest": runAsUser=0 (pod must not set runAsUser=0)');
  const cap = `kubectl run capadd --image=panda/hello:1.0 --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":1000,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"capadd","image":"panda/hello:1.0","securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"],"add":["NET_ADMIN"]}}}]}}'`;
  assert.equal(k(c, cap), 'Error from server (Forbidden): pods "capadd" is forbidden: violates PodSecurity "restricted:latest": unrestricted capabilities (container "capadd" must not include "NET_ADMIN" in securityContext.capabilities.add)');
  k(c, 'kubectl label ns default pod-security.kubernetes.io/enforce=baseline --overwrite');
  assert.equal(k(c, `kubectl run priv --image=panda/hello:1.0 --overrides='{"spec":{"containers":[{"name":"priv","image":"panda/hello:1.0","securityContext":{"privileged":true}}]}}'`), 'Error from server (Forbidden): pods "priv" is forbidden: violates PodSecurity "baseline:latest": privileged (container "priv" must not set securityContext.privileged=true)');
});

test('a read-only root filesystem breaks an image that writes, until a volume is mounted there', () => {
  const c = new Cluster();
  k(c, `kubectl run ro --image=panda/hello:1.0 --overrides='{"spec":{"containers":[{"name":"ro","image":"panda/hello:1.0","securityContext":{"readOnlyRootFilesystem":true}}]}}'`);
  c.step(8);
  assert.match(k(c, 'kubectl logs ro --previous'), /read-only file system/);
  k(c, `kubectl run ro2 --image=panda/hello:1.0 --overrides='{"spec":{"volumes":[{"name":"tmp","emptyDir":{}}],"containers":[{"name":"ro2","image":"panda/hello:1.0","volumeMounts":[{"name":"tmp","mountPath":"/tmp"}],"securityContext":{"readOnlyRootFilesystem":true}}]}}'`);
  c.step(4);
  assert.match(k(c, 'kubectl get pod ro2'), /ro2\s+1\/1\s+Running/);
});

// ---- Jobs and CronJobs ---------------------------------------------------

test('Jobs: create errors, Completed and Error pods, BackoffLimitExceeded, and an immutable template', () => {
  const c = new Cluster();
  assert.equal(k(c, 'kubectl create job noimage'), 'error: either --image or --from must be specified');
  assert.equal(k(c, 'kubectl create job hello --image=panda/report:1.0'), 'job.batch/hello created');
  const files = { 'flaky.yaml': { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'flaky' }, spec: { backoffLimit: 1, template: { spec: { restartPolicy: 'Never', containers: [{ name: 'flaky', image: 'panda/flaky-report:1.0' }] } } } } };
  k(c, 'kubectl apply -f flaky.yaml', files);
  c.step(20);
  assert.match(k(c, 'kubectl get jobs'), /flaky\s+Failed\s+0\/1[\s\S]*hello\s+Complete\s+1\/1/);
  assert.match(k(c, 'kubectl get pods'), /hello-\S{5}\s+0\/1\s+Completed\s+0/);
  assert.equal((k(c, 'kubectl get pods').match(/flaky-\S{5}\s+0\/1\s+Error\s+0/g) ?? []).length, 2, 'backoffLimit 1: two tries, and both pods kept');
  assert.match(k(c, 'kubectl describe job flaky'), /Warning\s+BackoffLimitExceeded\s+\S+\s+job-controller\s+Job has reached the specified backoff limit/);
  assert.match(k(c, `kubectl patch job hello -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","image":"panda/report:1.0"}]}}}}'`), /^The Job "hello" is invalid: spec\.template: Invalid value: .*: field is immutable$/);
  assert.equal(k(c, 'kubectl delete job hello'), 'job.batch "hello" deleted from default namespace');
});

test('a failed Job pod waits longer before each retry: 10 s, 20 s, 40 s', () => {
  const c = new Cluster();
  k(c, 'kubectl create job flaky --image=panda/flaky-report:1.0');
  const created: number[] = [];
  for (let i = 0; i < 40; i++) { c.step(); for (const p of c.pods.values()) if (!created.includes(p.created)) created.push(p.created); }
  const gaps = created.slice(1).map((t, i) => t - created[i]);
  assert.deepEqual(gaps.slice(0, 3).map((g) => g * 5 > 10 && g * 5 <= 50), [true, true, true]);
  assert.ok(gaps[1] > gaps[0] && gaps[2] > gaps[1], `the gaps grow: ${gaps.join(', ')} ticks`);
});

test('CronJob schedules are validated with the API server\'s messages', () => {
  const c = new Cluster();
  assert.equal(k(c, `kubectl create cronjob tz --image=panda/report:1.0 --schedule='CRON_TZ=UTC */1 * * * *'`), 'error: failed to create cronjob: CronJob.batch "tz" is invalid: spec.schedule: Invalid value: "CRON_TZ=UTC */1 * * * *": cannot use TZ or CRON_TZ in schedule, use timeZone field instead');
  assert.equal(k(c, `kubectl create cronjob bad --image=panda/report:1.0 --schedule='every minute'`), 'error: failed to create cronjob: CronJob.batch "bad" is invalid: spec.schedule: Invalid value: "every minute": expected exactly 5 fields, found 2: [every minute]');
  assert.equal(k(c, `kubectl create cronjob bad2 --image=panda/report:1.0 --schedule='61 * * * *'`), 'error: failed to create cronjob: CronJob.batch "bad2" is invalid: spec.schedule: Invalid value: "61 * * * *": end of range (61) above maximum (59): 61');
  assert.equal(k(c, `kubectl create cronjob tick --image=panda/report:1.0 --schedule='*/1 * * * *'`), 'cronjob.batch/tick created');
  assert.match(k(c, 'kubectl get cronjob'), /^NAME\s+SCHEDULE\s+TIMEZONE\s+SUSPEND\s+ACTIVE\s+LAST SCHEDULE\s+AGE\ntick\s+\*\/1 \* \* \* \*\s+<none>\s+False\s+0\s+<none>\s+/);
  assert.match(k(c, 'kubectl get cronjob tick -o yaml'), /^  schedule: '\*\/1 \* \* \* \*'$/m);
  assert.deepEqual(parseCron('0 2 * * *')[1], [2]);
  // 2026-11-03 02:00 UTC is a Tuesday.
  const m = Date.UTC(2026, 10, 3, 2, 0) / 60000;
  assert.ok(cronMatches('0 2 * * *', m) && !cronMatches('0 2 * * *', m + 1) && cronMatches('0 2 * * 2', m) && !cronMatches('0 2 * * 3', m));
});

test('CronJob runs are named after the scheduled minute; Forbid skips with JobAlreadyActive; history is trimmed', () => {
  const c = new Cluster();
  k(c, `kubectl create cronjob slow --image=panda/slow-report:1.0 --schedule='*/1 * * * *'`);
  k(c, `kubectl patch cronjob slow -p '{"spec":{"concurrencyPolicy":"Forbid"}}'`);
  c.step(26);
  const minute = Date.UTC(2026, 10, 3, 6, 1) / 60000;
  assert.match(k(c, 'kubectl get jobs'), new RegExp(`slow-${minute}\\s+Running`));
  assert.match(k(c, 'kubectl describe cronjob slow'), /Normal\s+JobAlreadyActive\s+\S+\s+cronjob-controller\s+Not starting job because prior execution is running and concurrency policy is Forbid/);
  assert.equal(k(c, 'kubectl create job manual-2 --from=cronjob/nope'), 'Error from server (NotFound): cronjobs.batch "nope" not found');
  assert.equal(k(c, 'kubectl create job manual-1 --from=cronjob/slow'), 'job.batch/manual-1 created');
  c.step(3);
  assert.match(k(c, 'kubectl describe cronjob slow'), /Warning\s+UnexpectedJob\s+\S+.*cronjob-controller\s+Saw a job that the controller did not create or forgot: manual-1/);
  c.step(200);
  const done = [...c.jobs.values()].filter((j) => j.owner === 'slow' && !j.manual && j.condition === 'Complete');
  assert.ok(done.length <= 3, 'successfulJobsHistoryLimit 3');
  assert.match(k(c, 'kubectl describe cronjob slow'), /Saw completed job: slow-\d+, condition: Complete/);
});

test('suspend stops a CronJob with no error, and resuming starts the latest missed run at once', () => {
  const c = new Cluster();
  k(c, `kubectl create cronjob tick --image=panda/report:1.0 --schedule='*/1 * * * *'`);
  assert.equal(k(c, `kubectl patch cronjob tick -p '{"spec":{"suspend":true}}'`), 'cronjob.batch/tick patched');
  c.step(40);
  assert.equal(c.jobs.size, 0);
  assert.equal(c.events.filter((e) => e.type === 'Warning').length, 0, 'nothing anywhere says it is not running');
  assert.match(k(c, 'kubectl get cronjob'), /tick\s+\S+ \S+ \S+ \S+ \S+\s+<none>\s+True\s+0\s+<none>/);
  k(c, `kubectl patch cronjob tick -p '{"spec":{"suspend":false}}'`);
  assert.equal(c.jobs.size, 1, 'the most recent missed run, straight away');
  assert.equal([...c.jobs.keys()][0], `default/tick-${Date.UTC(2026, 10, 3, 6, 3) / 60000}`);
});

// ---- DaemonSets, taints, placement --------------------------------------

const dsFiles = { 'ds.yaml': { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'log-collector' }, spec: { selector: { matchLabels: { app: 'lc' } }, template: { metadata: { labels: { app: 'lc' } }, spec: { containers: [{ name: 'app', image: 'panda/log-shipper:1.0' }] } } } } };

test('a DaemonSet skips the tainted control plane, and DESIRED says so quietly', () => {
  const c = new Cluster({ nodes: THREE });
  assert.match(k(c, 'kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints'), /^NAME\s+TAINTS\ncontrol-plane\s+\[map\[effect:NoSchedule key:node-role\.kubernetes\.io\/control-plane\]\]\nworker-1\s+<none>/);
  assert.match(k(c, 'kubectl describe node control-plane'), /Taints:\s+node-role\.kubernetes\.io\/control-plane:NoSchedule\nUnschedulable:\s+false/);
  k(c, 'kubectl apply -f ds.yaml', dsFiles);
  c.step(4);
  assert.match(k(c, 'kubectl get ds'), /^NAME\s+DESIRED\s+CURRENT\s+READY\s+UP-TO-DATE\s+AVAILABLE\s+NODE SELECTOR\s+AGE\nlog-collector\s+2\s+2\s+2\s+2\s+2\s+<none>\s+/);
  assert.match(k(c, 'kubectl describe ds log-collector'), /Desired Number of Nodes Scheduled: 2\nCurrent Number of Nodes Scheduled: 2/);
  k(c, `kubectl patch ds log-collector -p '{"spec":{"template":{"spec":{"tolerations":[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"}]}}}}'`);
  c.step(12);
  assert.match(k(c, 'kubectl get ds'), /log-collector\s+3\s+3\s+3\s+3\s+3/);
});

test('NoSchedule leaves running pods and DESIRED alone; NoExecute evicts', () => {
  const c = new Cluster({ nodes: THREE });
  k(c, 'kubectl apply -f ds.yaml', dsFiles);
  c.step(4);
  assert.equal(k(c, 'kubectl taint node worker-2 late=1:NoSchedule'), 'node/worker-2 tainted');
  assert.equal(k(c, 'kubectl taint node worker-2 late=1:NoSchedule'), 'error: node worker-2 already has late taint(s) with same effect(s) and --overwrite is false');
  c.step(4);
  assert.match(k(c, 'kubectl get ds'), /log-collector\s+2\s+2\s+2/);
  assert.equal(k(c, 'kubectl taint node worker-1 nope-'), 'error: taint "nope" not found');
  assert.equal(k(c, 'kubectl taint node worker-2 late-'), 'node/worker-2 untainted');
  k(c, 'kubectl taint node worker-2 dedicated=gpu:NoExecute');
  c.step(3);
  assert.ok(![...c.pods.values()].some((p) => p.node === 'worker-2' && p.status !== 'Terminating'), 'evicted');
  assert.match(k(c, 'kubectl get ds'), /log-collector\s+1\s+1\s+1/);
});

test('FailedScheduling, 1.36 wording: taints, selectors, resources, anti-affinity, spread', () => {
  const c = new Cluster({ nodes: THREE });
  k(c, 'kubectl taint node worker-2 dedicated=gpu:NoSchedule');
  k(c, 'kubectl taint node worker-1 dedicated=gpu:NoSchedule');
  k(c, 'kubectl create deployment web --image=panda/hello:1.0');
  c.step(2);
  assert.match(k(c, 'kubectl get events'), /0\/3 nodes are available: 3 node\(s\) had untolerated taint\(s\)\. no new claims to deallocate, preemption: 0\/3 nodes are available: 3 Preemption is not helpful for scheduling\./);
  k(c, 'kubectl taint node worker-1 dedicated-');
  k(c, 'kubectl taint node worker-2 dedicated-');
  k(c, 'kubectl create deployment ssd --image=panda/hello:1.0');
  k(c, `kubectl patch deploy ssd -p '{"spec":{"template":{"spec":{"nodeSelector":{"disktype":"nvme"}}}}}'`);
  c.step(3);
  const ssd = [...c.pods.values()].find((p) => !p.node && p.owner.startsWith('ssd-'))!;
  assert.match(k(c, `kubectl describe pod ${ssd.name}`), /Node-Selectors:\s+disktype=nvme[\s\S]*0\/3 nodes are available: 1 node\(s\) had untolerated taint\(s\), 2 node\(s\) didn't match Pod's node affinity\/selector\. no new claims to deallocate, preemption: 0\/3 nodes are available: 3 Preemption is not helpful for scheduling\./);
  k(c, 'kubectl create deployment big --image=panda/hello:1.0 --replicas=3');
  k(c, 'kubectl set resources deployment big --requests=cpu=1500m');
  c.step(6);
  assert.match(k(c, 'kubectl get events'), /0\/3 nodes are available: 1 node\(s\) had untolerated taint\(s\), 2 Insufficient cpu\. no new claims to deallocate, preemption: 0\/3 nodes are available: 1 Preemption is not helpful for scheduling, 2 No preemption victims found for incoming pod\./);
});

test('required anti-affinity leaves the extra replica Pending; the existing pods\' rule is checked too', () => {
  const c = new Cluster({ nodes: THREE });
  const files = {
    'spread.yaml': { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'spread' }, spec: { replicas: 3, template: { metadata: { labels: { app: 'spread' } }, spec: { affinity: { podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{ labelSelector: { matchLabels: { app: 'spread' } }, topologyKey: 'kubernetes.io/hostname' }] } }, containers: [{ name: 'app', image: 'panda/hello:1.0' }] } } } },
    'guard.yaml': { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'guard', labels: { app: 'guard' } }, spec: { affinity: { podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{ labelSelector: { matchLabels: { app: 'web' } }, topologyKey: 'kubernetes.io/hostname' }] } }, nodeSelector: { 'kubernetes.io/hostname': 'worker-1' }, containers: [{ name: 'app', image: 'panda/hello:1.0' }] } },
    'intruder.yaml': { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'intruder', labels: { app: 'web' } }, spec: { nodeSelector: { 'kubernetes.io/hostname': 'worker-1' }, containers: [{ name: 'app', image: 'panda/hello:1.0' }] } },
  };
  k(c, 'kubectl apply -f spread.yaml', files);
  c.step(4);
  assert.match(k(c, 'kubectl get events'), /0\/3 nodes are available: 1 node\(s\) had untolerated taint\(s\), 2 node\(s\) didn't match pod anti-affinity rules\. no new claims to deallocate, preemption: 0\/3 nodes are available: 1 Preemption is not helpful for scheduling, 2 No preemption victims found for incoming pod\./);
  k(c, 'kubectl delete deployment spread');
  c.step(2);
  k(c, 'kubectl apply -f guard.yaml', files);
  c.step(2);
  k(c, 'kubectl apply -f intruder.yaml', files);
  c.step(2);
  assert.match(k(c, 'kubectl describe pod intruder'), /0\/3 nodes are available: 1 node\(s\) didn't match Pod's node affinity\/selector, 1 node\(s\) didn't satisfy existing pods anti-affinity rules, 1 node\(s\) had untolerated taint\(s\)\. no new claims to deallocate, preemption: 0\/3 nodes are available: 1 No preemption victims found for incoming pod, 2 Preemption is not helpful for scheduling\./);
});

test('topology spread counts a tainted zone as a domain, so it can block pods it cannot use', () => {
  const nodes: NodeSpec[] = [THREE[0], { name: 'worker-1', cpu: 2000, mem: 4096, labels: { 'topology.kubernetes.io/zone': 'zone-a' } }, { name: 'worker-2', cpu: 2000, mem: 4096, labels: { 'topology.kubernetes.io/zone': 'zone-b' } }];
  const c = new Cluster({ nodes });
  const files = { 'zoned.yaml': { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'zoned' }, spec: { replicas: 3, template: { metadata: { labels: { app: 'zoned' } }, spec: { topologySpreadConstraints: [{ maxSkew: 1, topologyKey: 'topology.kubernetes.io/zone', whenUnsatisfiable: 'DoNotSchedule', labelSelector: { matchLabels: { app: 'zoned' } } }], containers: [{ name: 'app', image: 'panda/hello:1.0' }] } } } } };
  k(c, 'kubectl taint node worker-2 maint=true:NoSchedule');
  k(c, 'kubectl apply -f zoned.yaml', files);
  c.step(4);
  assert.equal([...c.pods.values()].filter((p) => p.node).length, 1, 'one in zone-a; zone-b has none, so a second in zone-a would be skew 2');
  const pending = [...c.pods.values()].find((p) => !p.node)!;
  assert.match(k(c, `kubectl describe pod ${pending.name}`), /Topology Spread Constraints:\s+topology\.kubernetes\.io\/zone:DoNotSchedule when max skew 1 is exceeded for selector app=zoned[\s\S]*0\/3 nodes are available: 1 node\(s\) didn't match pod topology spread constraints, 2 node\(s\) had untolerated taint\(s\)\. no new claims to deallocate, preemption: 0\/3 nodes are available: 1 No preemption victims found for incoming pod, 2 Preemption is not helpful for scheduling\./);
  k(c, 'kubectl taint node worker-2 maint-');
  c.step(4);
  assert.equal([...c.pods.values()].filter((p) => p.node).length, 3);
});

test('a node without the topology label is ruled out, and that reason cannot be preempted away', () => {
  const nodes: NodeSpec[] = [THREE[0], { name: 'worker-1', cpu: 2000, mem: 4096, labels: { 'topology.kubernetes.io/zone': 'zone-a' } }, { name: 'worker-2', cpu: 2000, mem: 4096 }];
  const c = new Cluster({ nodes });
  const files = { 'p.yaml': { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'nolabel', labels: { app: 'z' } }, spec: { nodeSelector: { 'kubernetes.io/hostname': 'worker-2' }, topologySpreadConstraints: [{ maxSkew: 1, topologyKey: 'topology.kubernetes.io/zone', whenUnsatisfiable: 'DoNotSchedule', labelSelector: { matchLabels: { app: 'z' } } }], containers: [{ name: 'app', image: 'panda/hello:1.0' }] } } };
  k(c, 'kubectl apply -f p.yaml', files);
  c.step(2);
  assert.match(k(c, 'kubectl describe pod nolabel'), /0\/3 nodes are available: 1 node\(s\) didn't match Pod's node affinity\/selector, 1 node\(s\) didn't match pod topology spread constraints \(missing required label\), 1 node\(s\) had untolerated taint\(s\)\. no new claims to deallocate, preemption: 0\/3 nodes are available: 3 Preemption is not helpful for scheduling\./);
});

test('logs deploy/x picks a pod and says which, like kubectl', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment two --image=panda/hello:1.0 --replicas=2');
  c.step(4);
  assert.match(k(c, 'kubectl logs deploy/two'), /^Found 2 pods, using pod\/two-\S+\nlistening on :8080/);
  assert.equal(k(c, 'kubectl logs solo'), 'error: error from server (NotFound): pods "solo" not found in namespace "default"');
  assert.equal(jsonpath({ a: [{ b: 1 }, { b: 2 }] }, '{.a[*].b}'), '1 2');
});
