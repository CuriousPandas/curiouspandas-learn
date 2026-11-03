// Missions for the workloads lessons: namespaces, config, init containers and
// sidecars, security contexts, Jobs and CronJobs, DaemonSets and placement.
// They judge the state the learner produced and what the sandbox actually
// showed them (state.saw), never the words typed, so any correct route
// counts. Each tempting shortcut that would also turn the cluster green is
// named in tests/kube-missions.test.ts and must not pass.

import { Cluster, key, type NodeSpec, type Pod } from './cluster.ts';
import { kubectl, type Files, type Seen, type Out } from './kubectl.ts';
import type { KubeState, Mission } from '../missions.ts';
import { kubeObserve, kubeWatch } from '../missions.ts';

/** Run one line the way the widget does: record it, run it, and remember what it showed. */
export function kubeRun(s: KubeState, line: string): Out[] {
  kubeObserve(s, line);
  const saw = (s.saw ??= []);
  // Snapshot what the pod looked like at that moment: the Pod object itself
  // keeps changing, and judging an old look by today's state un-ticked steps.
  const out = kubectl(s.cluster, line, (x) => saw.push({ ...x, tick: s.cluster.tick, seq: saw.length, podStatus: x.pod?.status, podNode: x.pod?.node, files: x.pod ? { ...x.pod.files } : undefined }), s.files ?? {});
  kubeWatch(s);
  return out;
}

function setup(lines: string[], warm = 0, opts: { nodes?: NodeSpec[]; files?: Files; after?: (c: Cluster) => void } = {}): () => KubeState {
  return () => {
    const cluster = new Cluster({ nodes: opts.nodes });
    const files = opts.files ?? {};
    for (const l of lines) {
      const out = kubectl(cluster, l, undefined, files);
      // A setup line that fails would leave the mission quietly broken.
      const err = out.find((o) => o.kind === 'err');
      if (err) throw new Error(`mission setup failed on "${l}": ${err.text}`);
    }
    opts.after?.(cluster);
    cluster.step(warm);
    return { cluster, history: [], seen: new Set(), deleted: new Set(), files, saw: [] };
  };
}

const saw = (s: KubeState, f: (x: Seen) => boolean) => (s.saw ?? []).some(f);
const kinds = (x: Seen) => (x.kind ?? '').split(',');
const ownedBy = (c: Cluster, p: Pod, deploy: string) => p.ownerKind === 'ReplicaSet' && c.replicasets.get(key(p.ns, p.owner))?.owner === deploy;
const podsOfDeploy = (c: Cluster, ns: string, d: string) => c.podsIn(ns).filter((p) => p.status !== 'Terminating' && ownedBy(c, p, d));
const ready = (c: Cluster, ns: string, d: string) => { try { return c.deploymentStatus(d, ns); } catch { return null; } };
const settled = (c: Cluster, ns: string, d: string, n?: number) => {
  const st = ready(c, ns, d);
  return !!st && st.ready >= (n ?? st.desired) && st.current === st.desired && st.upToDate === st.desired && st.desired >= (n ?? 1);
};

const THREE_NODES: NodeSpec[] = [
  { name: 'control-plane', cpu: 2000, mem: 4096, controlPlane: true },
  { name: 'worker-1', cpu: 2000, mem: 4096 },
  { name: 'worker-2', cpu: 2000, mem: 4096 },
];

// ---- manifests a mission hands the learner --------------------------------

const reportJob = (native: boolean) => ({
  apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'nightly-report' },
  spec: {
    template: {
      spec: {
        restartPolicy: 'Never',
        ...(native ? { initContainers: [{ name: 'log-shipper', image: 'panda/log-shipper:1.0', restartPolicy: 'Always' }] } : {}),
        containers: [{ name: 'report', image: 'panda/report:1.0' }, ...(native ? [] : [{ name: 'log-shipper', image: 'panda/log-shipper:1.0' }])],
      },
    },
  },
});

const shopWithInit = {
  apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'shop', labels: { app: 'shop' } },
  spec: {
    replicas: 1, selector: { matchLabels: { app: 'shop' } },
    template: { metadata: { labels: { app: 'shop' } }, spec: { initContainers: [{ name: 'wait-for-db', image: 'panda/wait-for-db:1.0' }], containers: [{ name: 'app', image: 'panda/hello:1.0' }] } },
  },
};

const webAnti = (preferred: boolean) => ({
  apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', labels: { app: 'web' } },
  spec: {
    replicas: preferred ? 4 : 3, selector: { matchLabels: { app: 'web' } },
    template: {
      metadata: { labels: { app: 'web' } },
      spec: {
        affinity: {
          podAntiAffinity: preferred
            ? { preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 100, podAffinityTerm: { labelSelector: { matchLabels: { app: 'web' } }, topologyKey: 'kubernetes.io/hostname' } }] }
            : { requiredDuringSchedulingIgnoredDuringExecution: [{ labelSelector: { matchLabels: { app: 'web' } }, topologyKey: 'kubernetes.io/hostname' }] },
        },
        containers: [{ name: 'app', image: 'panda/hello:1.0' }],
      },
    },
  },
});

const filesMount = {
  apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'files', labels: { app: 'files' } },
  spec: {
    replicas: 1, selector: { matchLabels: { app: 'files' } },
    template: {
      metadata: { labels: { app: 'files' } },
      spec: {
        containers: [{ name: 'app', image: 'panda/reads-file:1.0', volumeMounts: [{ name: 'greeting', mountPath: '/etc/greeting' }, { name: 'greeting', mountPath: '/etc/sub/GREETING', subPath: 'GREETING' }] }],
        volumes: [{ name: 'greeting', configMap: { name: 'greeting' } }],
      },
    },
  },
};

const collector = {
  apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'log-collector', labels: { app: 'log-collector' } },
  spec: { selector: { matchLabels: { app: 'log-collector' } }, template: { metadata: { labels: { app: 'log-collector' } }, spec: { containers: [{ name: 'app', image: 'panda/log-shipper:1.0' }] } } },
};

const nightlyCron = {
  apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name: 'nightly' },
  spec: { schedule: '*/1 * * * *', suspend: true, jobTemplate: { spec: { template: { spec: { restartPolicy: 'Never', containers: [{ name: 'report', image: 'panda/report:1.0' }] } } } } },
};

const backfill = {
  apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'backfill' },
  spec: { backoffLimit: 2, template: { spec: { restartPolicy: 'Never', containers: [{ name: 'report', image: 'panda/flaky-report:1.0' }] } } },
};

// ---- the missions --------------------------------------------------------

const cmGreeting = (c: Cluster, name: string) => c.configmaps.get(key('default', name))?.data.GREETING;
const changedAt = (s: KubeState, cm: string, was: string) => cmGreeting(s.cluster, cm) !== undefined && cmGreeting(s.cluster, cm) !== was;
/** The tick of the first patch/apply that changed this ConfigMap's value, so a later look can be judged "after". */
function firstChange(s: KubeState) {
  return (s.saw ?? []).find((x) => (x.verb === 'patch' || x.verb === 'apply') && x.kind === 'configmaps' && x.name === 'greeting')?.seq ?? Infinity;
}

const nativeSidecar = (c: Cluster) => {
  const j = c.jobs.get(key('default', 'nightly-report'));
  return !!j && j.template.initContainers.some((x) => x.name === 'log-shipper' && x.restartPolicy === 'Always') && !j.template.sidecars.length;
};

const tolerationIsNarrow = (c: Cluster) => {
  const ds = c.daemonsets.get(key('default', 'log-collector'));
  return !!ds && ds.template.tolerations.some((t) => t.key === 'node-role.kubernetes.io/control-plane') && !ds.template.tolerations.some((t) => !t.key);
};

export const KUBE_A_MISSIONS: Record<string, Mission<KubeState>> = {
  'kube-namespaces': {
    id: 'kube-namespaces', title: 'No resources found, and the app is running', xp: 60,
    setup: setup(['kubectl create namespace shop', 'kubectl -n shop create deployment hello --image=panda/hello:1.0 --replicas=2'], 6),
    steps: [
      { text: 'The shop app is up. Ask for its pods the way most people do', hint: 'kubectl get pods', done: (s) => saw(s, (x) => x.verb === 'get' && kinds(x).includes('pods') && x.ns === 'default' && !x.allNs && x.text === '') },
      { text: 'Find which namespace the pods are really in', hint: 'kubectl get pods -A', done: (s) => saw(s, (x) => x.verb === 'get' && kinds(x).some((k) => k === 'pods' || k === 'deployments') && /\bshop\//.test(x.text ?? '')) },
      { text: 'Read the hello Deployment as the API server stores it. Find its uid, its status, and defaults nobody typed', hint: 'kubectl -n shop get deployment hello -o yaml', done: (s) => saw(s, (x) => x.verb === 'get' && kinds(x).includes('deployments') && (x.output === 'yaml' || x.output === 'json') && /shop\/hello/.test(x.text ?? '')) },
      { text: 'Make shop the namespace your context uses, so you can stop typing -n', hint: 'kubectl config set-context --current --namespace=shop', done: (s) => s.cluster.context.namespace === 'shop' },
      { text: 'Now pick out the hello pods by their label', hint: 'kubectl get pods -l app=hello', done: (s) => s.cluster.context.namespace === 'shop' && saw(s, (x) => x.verb === 'get' && kinds(x).includes('pods') && x.ns === 'shop' && !!x.selector && /shop\/hello-/.test(x.text ?? '')) },
    ],
    debrief: 'Nothing was broken: kubectl asked the default namespace, and the pods live in shop. "No resources found" means "none here", never "none anywhere". A namespace is a scope for names, not a wall: the same cluster, nodes and network sit under all of them. And set-context does not check the namespace exists, so a typo there makes every later command look at an empty room without an error.',
  },
  'kube-config': {
    id: 'kube-config', title: 'You changed the ConfigMap and nothing changed', xp: 80,
    setup: setup([
      'kubectl create configmap greeting --from-literal=GREETING="hello from v1"',
      'kubectl create deployment web --image=panda/greeter:1.0',
      'kubectl set env deployment/web --from=configmap/greeting',
      'kubectl create deployment api --image=panda/needs-config:1.0',
    ], 10),
    steps: [
      { text: 'Read what web prints', hint: 'kubectl logs deployment/web', done: (s) => saw(s, (x) => x.verb === 'logs' && !!x.pod && ownedBy(s.cluster, x.pod, 'web')) },
      { text: 'Change the greeting in the ConfigMap', hint: `kubectl patch configmap greeting -p '{"data":{"GREETING":"hello from v2"}}'`, done: (s) => changedAt(s, 'greeting', 'hello from v1') },
      { text: 'Look at web again. Did it notice?', hint: 'kubectl logs deployment/web', done: (s) => changedAt(s, 'greeting', 'hello from v1') && saw(s, (x) => x.verb === 'logs' && !!x.pod && ownedBy(s.cluster, x.pod, 'web') && (x.seq ?? 0) > firstChange(s)) },
      {
        text: 'Make web read the new value', hint: 'kubectl rollout restart deployment/web',
        done: (s) => { const v = cmGreeting(s.cluster, 'greeting'); const ps = podsOfDeploy(s.cluster, 'default', 'web'); return v !== 'hello from v1' && settled(s.cluster, 'default', 'web') && ps.length > 0 && ps.every((p) => p.ready && p.env.GREETING === v); },
        why: (s) => podsOfDeploy(s.cluster, 'default', 'web').some((p) => p.env.GREETING === 'hello from v1') ? 'web\'s pods still hold the value they read when they started.' : '',
      },
      {
        text: 'api crashes for want of DATABASE_URL. Put it in a Secret and give api the Secret', hint: 'kubectl create secret generic db --from-literal=DATABASE_URL=postgres://db:5432/shop  then  kubectl set env deployment/api --from=secret/db',
        done: (s) => { const d = s.cluster.getDeployment('default', 'api'); return !!d && d.template.envRefs.some((r) => r.kind === 'secret' && r.key === 'DATABASE_URL') && !('DATABASE_URL' in d.template.env) && settled(s.cluster, 'default', 'api'); },
        why: (s) => 'DATABASE_URL' in (s.cluster.getDeployment('default', 'api')?.template.env ?? {}) ? 'That put the password in the Deployment itself, in plain text. Use --from=secret/<name>.' : '',
      },
      { text: 'Read the Secret back as YAML. Is the value hidden?', hint: 'kubectl get secret db -o yaml', done: (s) => saw(s, (x) => x.verb === 'get' && kinds(x).includes('secrets') && (x.output === 'yaml' || x.output === 'json' || !!x.output?.startsWith('jsonpath')) && /default\/db\b/.test(x.text ?? '')) },
    ],
    debrief: 'Environment variables are copied into a container once, when it starts, so web kept saying v1 until new pods replaced the old ones. The Secret worked the same way, and its YAML showed the value base64-encoded: try echo <that text> | base64 -d. Encoding is not encryption. Anyone who can read the Secret can read the password, which is why who may get secrets matters more than the Secret itself.',
  },
  'kube-config-volume': {
    id: 'kube-config-volume', title: 'The file that changed by itself, and the one that never did', xp: 60,
    setup: setup(['kubectl create configmap greeting --from-literal=GREETING=v1', 'kubectl apply -f files.yaml'], 6, { files: { 'files.yaml': filesMount } }),
    steps: [
      { text: 'files mounts the greeting ConfigMap twice: as a folder, and as one file with subPath. Read what it sees', hint: 'kubectl logs deployment/files', done: (s) => saw(s, (x) => x.verb === 'logs' && !!x.pod && ownedBy(s.cluster, x.pod, 'files')) },
      { text: 'Change the greeting to v2', hint: `kubectl patch configmap greeting -p '{"data":{"GREETING":"v2"}}'`, done: (s) => changedAt(s, 'greeting', 'v1') },
      {
        text: 'Keep looking. The folder copy changes within about a minute, with no restart. What about the subPath copy?', hint: 'kubectl exec deployment/files -- cat /etc/greeting/GREETING /etc/sub/GREETING',
        done: (s) => {
          const v = cmGreeting(s.cluster, 'greeting');
          return changedAt(s, 'greeting', 'v1') && saw(s, (x) => (x.verb === 'logs' || x.verb === 'exec') && !!x.pod && ownedBy(s.cluster, x.pod, 'files') && (x.seq ?? 0) > firstChange(s)) && podsOfDeploy(s.cluster, 'default', 'files').some((p) => p.files['/etc/greeting/GREETING'] === v);
        },
        why: (s) => podsOfDeploy(s.cluster, 'default', 'files').some((p) => p.files['/etc/greeting/GREETING'] === cmGreeting(s.cluster, 'greeting')) ? 'It has synced. Look at the pod once more.' : 'The kubelet has not synced the folder yet. Time runs on its own: wait and look again.',
      },
      {
        text: 'Get the subPath file updated too', hint: 'kubectl rollout restart deployment/files',
        done: (s) => { const v = cmGreeting(s.cluster, 'greeting'); const ps = podsOfDeploy(s.cluster, 'default', 'files'); return v !== 'v1' && settled(s.cluster, 'default', 'files') && ps.length > 0 && ps.every((p) => p.files['/etc/sub/GREETING'] === v); },
      },
    ],
    debrief: 'A ConfigMap mounted as a folder is refreshed by the kubelet on its next sync, which took about a minute on a real kind cluster. A subPath mount is a copy of one file made when the container started, and the docs say it "will not receive ConfigMap updates". Neither change is announced: the app has to re-read the file, and you have to know which kind of mount you have.',
  },
  'kube-sidecars': {
    id: 'kube-sidecars', title: 'The Job that never finished', xp: 80,
    setup: setup(['kubectl apply -f report-plain.yaml', 'kubectl apply -f shop.yaml'], 8, { files: { 'report-plain.yaml': reportJob(false), 'report-native.yaml': reportJob(true), 'shop.yaml': shopWithInit } }),
    steps: [
      { text: 'nightly-report should take seconds. Look at the Job and its pod', hint: 'kubectl get jobs  then  kubectl get pods', done: (s) => saw(s, (x) => x.verb === 'get' && kinds(x).includes('jobs')) && saw(s, (x) => x.verb === 'get' && kinds(x).includes('pods')) },
      { text: 'Read the report container\'s own logs. Did it do its work?', hint: 'kubectl logs job/nightly-report -c report', done: (s) => saw(s, (x) => x.verb === 'logs' && x.container === 'report' && x.pod?.ownerKind === 'Job') },
      {
        text: 'Compare report-plain.yaml with report-native.yaml, then replace the Job with the native-sidecar version', hint: 'cat report-native.yaml  then  kubectl delete job nightly-report  then  kubectl apply -f report-native.yaml',
        done: (s) => nativeSidecar(s.cluster) && s.cluster.jobs.get(key('default', 'nightly-report'))?.condition === 'Complete',
        why: (s) => nativeSidecar(s.cluster) ? 'Wait for it: the log shipper gets 30 seconds to stop.' : '',
      },
      { text: 'shop sits at Init:0/1. Ask the init container what it is waiting for', hint: 'kubectl logs deployment/shop -c wait-for-db', done: (s) => saw(s, (x) => x.verb === 'logs' && x.container === 'wait-for-db') },
      { text: 'Give it what it waits for', hint: 'kubectl create deployment db --image=panda/db:1.0', done: (s) => settled(s.cluster, 'default', 'shop') && s.cluster.getDeployment('default', 'shop')!.template.initContainers.length > 0 },
    ],
    debrief: 'A Job is complete when its pod finishes, and a pod finishes when every regular container has stopped. The log shipper never stops, so the report was written and the Job waited for ever. Declared as an init container with restartPolicy: Always, the same container becomes a native sidecar: it starts first and is stopped once the main container exits. A plain init container is the opposite: it must finish before anything else starts, and while it waits the app has no logs at all.',
  },
  'kube-nonroot': {
    id: 'kube-nonroot', title: 'Run as non-root, refuse to start', xp: 80,
    setup: setup([
      'kubectl create deployment web --image=panda/hello:1.0',
      `kubectl patch deployment web -p '{"spec":{"template":{"spec":{"securityContext":{"runAsNonRoot":true}}}}}'`,
    ], 6),
    steps: [
      { text: 'web never starts, and has no logs. Find out why', hint: 'kubectl describe pod -l app=web', done: (s) => saw(s, (x) => x.verb === 'describe' && !!x.pod && ownedBy(s.cluster, x.pod, 'web') && x.podStatus === 'CreateContainerConfigError') },
      {
        text: 'Keep runAsNonRoot, and tell the pod which non-root user to run as', hint: `kubectl patch deployment web -p '{"spec":{"template":{"spec":{"securityContext":{"runAsUser":1000}}}}}'`,
        done: (s) => { const d = s.cluster.getDeployment('default', 'web'); return !!d && (d.template.sc.runAsNonRoot ?? d.template.podSc.runAsNonRoot) === true && settled(s.cluster, 'default', 'web'); },
        why: (s) => { const d = s.cluster.getDeployment('default', 'web'); return d && (d.template.sc.runAsNonRoot ?? d.template.podSc.runAsNonRoot) !== true ? 'That turned the check off instead of passing it.' : ''; },
      },
      { text: 'Switch on the restricted Pod Security level for this namespace. Read what it says about web', hint: 'kubectl label namespace default pod-security.kubernetes.io/enforce=restricted', done: (s) => s.cluster.psaLevel('default', 'enforce') === 'restricted' },
      {
        text: 'Deploy api, then find where its refusal is written down', hint: 'kubectl create deployment api --image=panda/hello-nonroot:1.0  then  kubectl get events',
        done: (s) => !!s.cluster.getDeployment('default', 'api') && s.cluster.events.some((e) => e.reason === 'FailedCreate' && e.message.includes('violates PodSecurity')) && saw(s, (x) => (x.verb === 'get' && kinds(x).includes('events')) || (x.verb === 'describe' && (x.kind === 'deployments' || x.kind === 'replicasets'))),
      },
      {
        text: 'Give api the settings restricted asks for, and keep the namespace restricted', hint: `kubectl patch deployment api -p '{"spec":{"template":{"spec":{"securityContext":{"runAsNonRoot":true,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"app","securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}}}'`,
        done: (s) => s.cluster.psaLevel('default', 'enforce') === 'restricted' && settled(s.cluster, 'default', 'api'),
        why: (s) => s.cluster.psaLevel('default', 'enforce') !== 'restricted' ? 'Removing the label lets api in by removing the rule.' : '',
      },
    ],
    debrief: 'Two different gates. runAsNonRoot is checked by the kubelet when the container starts, against the user the image declares, so the pod existed and sat in CreateContainerConfigError with no logs. Pod Security is checked by the API server when a pod is created, so api\'s pods were never made and the refusal is an event on its ReplicaSet. And web is still running only because nothing has restarted it: the next pod web makes will be refused too.',
  },
  'kube-cron': {
    id: 'kube-cron', title: 'The nightly job that stopped running', xp: 80,
    setup: setup(['kubectl apply -f nightly.yaml', 'kubectl apply -f backfill.yaml'], 14, { files: { 'nightly.yaml': nightlyCron, 'backfill.yaml': backfill } }),
    steps: [
      { text: 'The nightly report has not run. Look at the CronJob and its Jobs', hint: 'kubectl get cronjobs,jobs', done: (s) => saw(s, (x) => x.verb === 'get' && kinds(x).includes('cronjobs')) },
      { text: 'Find what stopped it. No event, no error: read its settings', hint: 'kubectl describe cronjob nightly', done: (s) => saw(s, (x) => (x.verb === 'describe' && x.kind === 'cronjobs') || (x.verb === 'get' && kinds(x).includes('cronjobs') && !!x.output && x.output !== 'wide')) },
      {
        text: 'Resume it, and watch a scheduled run complete', hint: `kubectl patch cronjob nightly -p '{"spec":{"suspend":false}}'`,
        done: (s) => { const cj = s.cluster.cronjobs.get(key('default', 'nightly')); return !!cj && !cj.suspend && [...s.cluster.jobs.values()].some((j) => j.owner === 'nightly' && !j.manual && j.condition === 'Complete'); },
      },
      { text: 'Run it once more, now, without waiting for the schedule', hint: 'kubectl create job nightly-now --from=cronjob/nightly', done: (s) => [...s.cluster.jobs.values()].some((j) => j.owner === 'nightly' && j.manual && j.condition === 'Complete') },
      { text: 'backfill has given up. Find how many tries it got, and what each one said', hint: 'kubectl describe job backfill  then  kubectl logs job/backfill', done: (s) => saw(s, (x) => x.verb === 'describe' && x.kind === 'jobs' && x.name === 'backfill') && saw(s, (x) => x.verb === 'logs' && x.pod?.owner === 'backfill') },
    ],
    debrief: 'suspend: true is a valid setting, so nothing reports it as a problem: the CronJob simply makes no Jobs. When it was resumed, the most recent missed run started at once and the older ones were not made up. backfill failed three times, once more than its backoffLimit of 2 allows, each try waiting longer than the last, and then the Job was marked Failed for good. Its pods stay behind so you can read why.',
  },
  'kube-daemonset': {
    id: 'kube-daemonset', title: 'The log collector that skipped a node', xp: 70,
    setup: setup(['kubectl apply -f log-collector.yaml', 'kubectl create deployment web --image=panda/hello:1.0 --replicas=2'], 6, { nodes: THREE_NODES, files: { 'log-collector.yaml': collector } }),
    steps: [
      { text: 'The collector should run on every node. Compare its DESIRED with the number of nodes', hint: 'kubectl get daemonsets  then  kubectl get nodes', done: (s) => saw(s, (x) => x.verb === 'get' && kinds(x).includes('daemonsets')) && saw(s, (x) => x.verb === 'get' && kinds(x).includes('nodes')) },
      { text: 'Find what keeps it off the missing node', hint: 'kubectl describe node control-plane', done: (s) => saw(s, (x) => (x.verb === 'describe' && x.kind === 'nodes' && (x.name === 'control-plane' || !x.name)) || (x.verb === 'get' && kinds(x).includes('nodes') && !!x.output && x.output !== 'wide')) },
      {
        text: 'Tolerate that taint, and only that one', hint: `kubectl patch daemonset log-collector -p '{"spec":{"template":{"spec":{"tolerations":[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"}]}}}}'`,
        // Judged on the control-plane node only: a taint added to a worker in
        // the next step can legitimately lower DESIRED again.
        done: (s) => tolerationIsNarrow(s.cluster) && s.cluster.podsOf('default', 'log-collector', 'DaemonSet').some((p) => p.node === 'control-plane' && p.ready && p.status !== 'Terminating'),
        why: (s) => s.cluster.daemonsets.get(key('default', 'log-collector'))?.template.tolerations.some((t) => !t.key) ? 'A toleration with no key tolerates every taint, including ones added later for good reasons.' : '',
      },
      {
        text: 'Reserve worker-2 for a GPU team with a taint, then scale web to 4. Where do the new pods go, and does the collector leave?', hint: 'kubectl taint node worker-2 dedicated=gpu:NoSchedule  then  kubectl scale deployment web --replicas=4',
        done: (s) => {
          const c = s.cluster;
          const w2 = c.nodes.find((n) => n.name === 'worker-2')!;
          const ds = c.daemonsets.get(key('default', 'log-collector'));
          const tainted = w2.taints.find((t) => t.key === 'dedicated' && t.effect === 'NoSchedule');
          // Judge the new web pods, not the collector: whether the collector
          // stays depends on timing (a rollout that replaces it after the
          // taint cannot put it back), and a step that hangs on timing can
          // strand someone who did everything right.
          const at = Math.min(...(s.saw ?? []).filter((x) => x.verb === 'taint' && x.name === 'worker-2').map((x) => x.tick ?? Infinity));
          const fresh = podsOfDeploy(c, 'default', 'web').filter((p) => p.created >= at);
          return !!tainted && !!ds && settled(c, 'default', 'web', 4) && fresh.length > 0 && fresh.every((p) => p.node !== 'worker-2') && tolerationIsNarrow(c);
        },
      },
    ],
    debrief: 'kind taints its control-plane node NoSchedule, and a DaemonSet obeys taints like any other pod, so DESIRED quietly counted two nodes, not three. Nothing reported an error; on the tilt platform that once meant the API server\'s logs were simply missing from Loki. NoSchedule only stops new pods: the new web pods were kept off worker-2, while the collector already running there stayed, unless its own rollout replaced it after the taint, in which case the replacement was kept off too. NoExecute is the effect that evicts running pods.',
  },
  'kube-placement': {
    id: 'kube-placement', title: 'Pending: didn\'t match Pod\'s node affinity', xp: 80,
    setup: setup([
      'kubectl create deployment fast --image=panda/hello:1.0',
      `kubectl patch deployment fast -p '{"spec":{"template":{"spec":{"nodeSelector":{"disktype":"ssd"}}}}}'`,
      'kubectl apply -f web.yaml',
    ], 8, { nodes: [{ name: 'worker-1', cpu: 2000, mem: 4096 }, { name: 'worker-2', cpu: 2000, mem: 4096 }, { name: 'worker-3', cpu: 2000, mem: 4096 }], files: { 'web.yaml': webAnti(false), 'web-preferred.yaml': webAnti(true) } }),
    steps: [
      { text: 'fast is Pending. Read the scheduler\'s reason', hint: 'kubectl describe pod -l app=fast', done: (s) => saw(s, (x) => x.verb === 'describe' && !!x.pod && ownedBy(s.cluster, x.pod, 'fast') && !x.podNode) },
      {
        text: 'worker-3 is the node with the SSD. Label it so fast can land there, without touching fast', hint: 'kubectl label node worker-3 disktype=ssd',
        done: (s) => { const d = s.cluster.getDeployment('default', 'fast'); return !!d && d.template.nodeSelector.disktype === 'ssd' && settled(s.cluster, 'default', 'fast') && podsOfDeploy(s.cluster, 'default', 'fast').every((p) => p.node === 'worker-3'); },
        why: (s) => { const d = s.cluster.getDeployment('default', 'fast'); return d && d.template.nodeSelector.disktype !== 'ssd' ? 'Removing the selector lets fast run anywhere, including on disks it was written to avoid.' : ''; },
      },
      {
        text: 'web wants one pod per node, required. Scale it to 4 on these 3 nodes and read why the fourth waits', hint: 'kubectl scale deployment web --replicas=4  then  kubectl get events',
        done: (s) => (s.cluster.getDeployment('default', 'web')?.replicas ?? 0) >= 4 && s.cluster.events.some((e) => e.reason === 'FailedScheduling' && e.message.includes('anti-affinity')) && saw(s, (x) => (x.verb === 'get' && kinds(x).includes('events')) || (x.verb === 'describe' && !!x.pod && ownedBy(s.cluster, x.pod, 'web') && !x.podNode)),
      },
      {
        text: 'Replace web with the preferred version in web-preferred.yaml and count where its 4 pods land', hint: 'kubectl delete deployment web  then  kubectl apply -f web-preferred.yaml  then  kubectl get pods -o wide',
        done: (s) => {
          const d = s.cluster.getDeployment('default', 'web');
          const applied = (s.saw ?? []).filter((x) => x.verb === 'apply' && x.kind === 'deployments' && x.name === 'web').map((x) => x.seq ?? 0);
          const since = applied.length ? Math.max(...applied) : Infinity;
          return !!d && d.template.affinity.antiPreferred.length > 0 && !d.template.affinity.antiRequired.length && settled(s.cluster, 'default', 'web', 4)
            && saw(s, (x) => x.verb === 'get' && kinds(x).includes('pods') && x.output === 'wide' && (x.seq ?? 0) > since);
        },
      },
    ],
    debrief: 'A required rule is a hard filter: no node passed, so the pod waited, and the event named the rule. A preferred rule only changes the score: with four pods and three nodes, two of them shared a node, with no event and no warning, because nothing failed. That is the trade. Required can leave you short of replicas; preferred can leave you with all your eggs closer together than you think.',
  },
};
