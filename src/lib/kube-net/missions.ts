// Missions for NetSim. Like every mission on the site they judge what the
// learner did to the cluster, never the words they typed, and each one's
// tempting shortcut is tested to fail in tests/kube-net-missions.test.ts.
// Steps judged on history (a request that happened) stay ticked when a later
// step changes the cluster; steps judged on state are only ones no later step
// undoes. That rule exists because a mission elsewhere on the site once
// re-judged an earlier step after a later one changed it, and nobody could finish.

import type { Mission } from '../missions.ts';
import { Net, AMBIENT_LABEL, type Pod } from './net.ts';
import { run, syncIngress, type Ctx, type Event, type Files } from './kubectl.ts';

export type NetState = { ctx: Ctx; controllerAt: number };
export type NetMission = Mission<NetState> & {
  /** Namespace kubectl uses when -n is not given (as if set in the kubeconfig context). */
  ns: string;
  files?: Files;
  controls?: ('cni' | 'ingress-controller')[];
  matrix?: { from: string[]; to: string[] };
};

type Curl = Extract<Event, { type: 'curl' }>;
const curls = (s: NetState) => s.ctx.events.filter((e): e is Curl => e.type === 'curl');
const lookups = (s: NetState) => s.ctx.events.filter((e): e is Extract<Event, { type: 'lookup' }> => e.type === 'lookup');
const cmds = (s: NetState) => s.ctx.events.filter((e): e is Extract<Event, { type: 'cmd' }> => e.type === 'cmd');
const ranKind = (s: NetState, verb: string, kinds: string[], name?: string) => cmds(s).some((c) => c.verb === verb && kinds.includes(c.kind ?? '') && (!name || c.name === name));
const hostOf = (url: string) => /^(?:https?:\/\/)?([^/:]+)/.exec(url)?.[1] ?? '';
const owner = (p?: Pod) => p?.owner;

function setup(ns: string, build: (net: Net) => void, files?: Files): () => NetState {
  return () => {
    const net = new Net();
    build(net);
    net.t += 600;
    return { ctx: { net, files: { ...(files ?? {}) }, ns, events: [] }, controllerAt: -1 };
  };
}

const client = (net: Net, ns: string) => net.addPod({ name: 'client', ns, labels: { run: 'client' }, image: 'curlimages/curl:8.11.1' });

/** Installs the toy Ingress controller: a pod, and an IngressClass that is not the default. */
export function installController(s: NetState) {
  const net = s.ctx.net;
  if (net.ingressController) return;
  net.addNamespace('ingress-panda');
  net.addPod({ name: 'panda-ingress-controller-7d9c6b8f5d-x2k4q', ns: 'ingress-panda', labels: { app: 'panda-ingress' }, image: 'toy/ingress-controller', owner: 'panda-ingress-controller' });
  net.classes.set('panda', { name: 'panda', controller: 'example.com/panda-ingress', isDefault: false, created: net.t });
  net.ingressController = { className: 'panda', ip: 'localhost' };
  syncIngress(net);
  s.controllerAt = s.ctx.events.length;
}

// ---- pods-and-services ------------------------------------------------------

export const SERVICES_MISSION: NetMission = {
  id: 'kube-net-services', title: 'Pending forever, and refused inside', xp: 70, ns: 'shop',
  setup: setup('shop', (net) => {
    net.addNamespace('shop');
    net.createDeployment('shop', 'web', 'panda/web:1.0', 2);
    net.services.set('shop/web', { name: 'web', ns: 'shop', type: 'LoadBalancer', clusterIP: '10.96.98.211', selector: { app: 'web' }, labels: { app: 'web' }, ports: [{ port: 80, targetPort: 80, nodePort: 30292, protocol: 'TCP' }], created: net.t });
    client(net, 'shop');
  }),
  steps: [
    { text: 'The web Service was created ten minutes ago. Look at its EXTERNAL-IP', hint: 'kubectl get svc', done: (s) => ranKind(s, 'get', ['services']) },
    { text: 'Forget the outside for now: curl the Service from the client pod', hint: 'kubectl exec client -- curl -sS -m 5 http://web', done: (s) => curls(s).some((c) => !c.host && c.from === 'shop/client' && (c.attempt.ok ? c.attempt.via?.name === 'web' : hostOf(c.url) === 'web' || hostOf(c.url) === '10.96.98.211')) },
    { text: 'Find which pod addresses and port the Service sends traffic to', hint: 'kubectl get endpointslices  or  kubectl describe svc web', done: (s) => ranKind(s, 'get', ['endpointslices', 'endpoints']) || ranKind(s, 'describe', ['services'], 'web') },
    { text: 'Fix the Service so curl from the client gets an answer', hint: `kubectl patch svc web -p '{"spec":{"ports":[{"port":80,"targetPort":8080}]}}'`, done: (s) => curls(s).some((c) => !c.host && c.attempt.ok && c.attempt.via?.name === 'web' && owner(c.attempt.pod) === 'web') },
    { text: 'Reach it from your machine without a load balancer: every LoadBalancer Service also has a node port', hint: 'kubectl get svc web  then  curl http://172.18.0.3:30292', done: (s) => curls(s).some((c) => c.host && c.attempt.ok && owner(c.attempt.pod) === 'web') },
    { text: 'Blue/green: run panda/web:2.0 as web-green, then switch the web Service over to it', hint: 'kubectl create deployment web-green --image=panda/web:2.0 --replicas=2  then  kubectl set selector svc web app=web-green', done: (s) => curls(s).some((c) => c.attempt.ok && c.attempt.via?.name === 'web' && owner(c.attempt.pod) === 'web-green') },
  ],
  debrief: 'EXTERNAL-IP stays <pending> because nothing on kind implements LoadBalancer, and nothing reports that as an error. The refusal inside was a different fault: the Service had endpoints, but targetPort 80 pointed at a port the pods never opened. A Service is only a selector and a port mapping. Change the selector and every request moves to other pods at once, which is all blue/green is.',
};

// ---- cluster-dns ------------------------------------------------------------

export const DNS_MISSION: NetMission = {
  id: 'kube-net-dns', title: 'Works by IP, not by name', xp: 70, ns: 'tools',
  setup: setup('tools', (net) => {
    net.addNamespace('shop');
    net.addNamespace('tools');
    net.createDeployment('shop', 'web', 'panda/web:1.0', 2);
    net.services.set('shop/web', { name: 'web', ns: 'shop', type: 'ClusterIP', clusterIP: '10.96.98.211', selector: { app: 'web' }, labels: { app: 'web' }, ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }], created: net.t });
    net.services.set('shop/web-pods', { name: 'web-pods', ns: 'shop', type: 'ClusterIP', clusterIP: 'None', selector: { app: 'web' }, labels: { app: 'web' }, ports: [{ port: 8080, targetPort: 8080, protocol: 'TCP' }], created: net.t });
    client(net, 'tools');
  }),
  steps: [
    { text: 'You are in the tools namespace. From the client pod, curl the web Service by its short name', hint: 'kubectl exec client -- curl -sS -m 5 http://web', done: (s) => curls(s).some((c) => c.from === 'tools/client' && hostOf(c.url) === 'web') },
    { text: 'Now reach it: add the namespace to the name', hint: 'kubectl exec client -- curl -sS -m 5 http://web.shop', done: (s) => curls(s).some((c) => c.from === 'tools/client' && c.attempt.ok && c.attempt.via?.name === 'web' && !/^\d/.test(hostOf(c.url))) },
    { text: 'Ask DNS directly with nslookup, using the Service\'s full name', hint: 'kubectl exec client -- nslookup web.shop.svc.cluster.local', done: (s) => lookups(s).some((l) => l.found && l.ips.includes('10.96.98.211')) },
    { text: 'Look up the headless Service web-pods: one name, one answer per ready pod', hint: 'kubectl exec client -- nslookup web-pods.shop.svc.cluster.local', done: (s) => lookups(s).some((l) => l.found && l.ips.length >= 2 && !l.ips.includes('10.96.98.211')) },
    { text: 'Break DNS: scale CoreDNS to zero, then curl web.shop again', hint: 'kubectl -n kube-system scale deployment coredns --replicas=0  then  kubectl exec client -- curl -sS -m 5 http://web.shop', done: (s) => curls(s).some((c) => c.dnsReplicas === 0 && !c.attempt.ok && c.attempt.stage === 'dns') },
    { text: 'While DNS is down, reach web by its cluster IP. Then bring CoreDNS back and use the name again', hint: 'kubectl exec client -- curl -sS -m 5 http://10.96.98.211  then  kubectl -n kube-system scale deployment coredns --replicas=2', done: (s) => {
      const cs = curls(s);
      const byIp = cs.findIndex((c) => c.dnsReplicas === 0 && c.attempt.ok && /^\d/.test(hostOf(c.url)));
      return byIp >= 0 && cs.slice(byIp + 1).some((c) => c.dnsReplicas > 0 && c.attempt.ok && !/^\d/.test(hostOf(c.url)));
    } },
  ],
  debrief: 'A short name is tried against the search list of the pod\'s own namespace first, so web from tools asks for web.tools.svc.cluster.local and gets NXDOMAIN. web.shop works because the next search domain completes it. busybox\'s nslookup skips the search list for any name with a dot, which is why the full name is the one to test with. With CoreDNS gone the Service never stopped working: only the name did, and every client reported it as "could not resolve host".',
};

// ---- network-policies -------------------------------------------------------

const DENY_ALL = `# Selects every pod in the namespace and allows nothing in either direction.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
`;
const ALLOW_DNS = `# Lets every pod in shop send DNS queries to CoreDNS in kube-system.
# One list item with both selectors means "pods labelled k8s-app=kube-dns
# in the namespace kube-system". Two items would mean either one.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
`;
const WEB_TO_API = `# Two halves: web must be allowed out, and api must let it in.
# Fill in the selectors and the port.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-from-web
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: CHANGE-ME
    ports:
    - protocol: TCP
      port: 8080
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: web-to-api
spec:
  podSelector:
    matchLabels:
      app: web
  policyTypes:
  - Egress
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: CHANGE-ME
    ports:
    - protocol: TCP
      port: 8080
`;

const podOf = (net: Net, ns: string, ownerName: string) => net.podsIn(ns).find((p) => p.owner === ownerName || p.name === ownerName);

/** What the policies in shop say, enforced or not: the mission's goal state. */
export function policyGoal(net: Net) {
  const web = podOf(net, 'shop', 'web'), api = podOf(net, 'shop', 'api'), cl = podOf(net, 'shop', 'client');
  const dns = net.podsIn('kube-system').find((p) => p.labels['k8s-app'] === 'kube-dns');
  if (!web || !api || !cl || !dns) return { webToApi: false, clientToApi: true, clientToWeb: true, webDns: false, isolated: false };
  return {
    webToApi: net.policyAllows(web, api, 8080, 'TCP').ok,
    clientToApi: net.policyAllows(cl, api, 8080, 'TCP').ok,
    clientToWeb: net.policyAllows(cl, web, 8080, 'TCP').ok,
    // In the ambient mesh ztunnel answers Service names itself, so web
    // resolves api without allow-dns (measured on tilt); out of it, web needs it.
    webDns: net.policyAllows(web, dns, 53, 'UDP').ok || net.inMesh('shop'),
    // Still default-deny: the client may not reach anything it was not given.
    isolated: net.policiesFor(cl, 'Egress').length > 0 && net.policiesFor(api, 'Ingress').length > 0,
  };
}

export const POLICY_MISSION: NetMission = {
  id: 'kube-net-policy', title: 'Default deny, then just enough', xp: 90, ns: 'shop',
  files: { 'deny-all.yaml': DENY_ALL, 'allow-dns.yaml': ALLOW_DNS, 'web-to-api.yaml': WEB_TO_API },
  controls: ['cni'],
  matrix: { from: ['client', 'web', 'api'], to: ['web', 'api', 'dns'] },
  setup: setup('shop', (net) => {
    net.addNamespace('shop');
    net.createDeployment('shop', 'web', 'panda/web:1.0', 1);
    net.createDeployment('shop', 'api', 'panda/api:1.0', 1);
    net.services.set('shop/web', { name: 'web', ns: 'shop', type: 'ClusterIP', clusterIP: '10.96.98.211', selector: { app: 'web' }, labels: { app: 'web' }, ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }], created: net.t });
    net.services.set('shop/api', { name: 'api', ns: 'shop', type: 'ClusterIP', clusterIP: '10.96.141.7', selector: { app: 'api' }, labels: { app: 'api' }, ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }], created: net.t });
    client(net, 'shop');
  }, { 'deny-all.yaml': DENY_ALL, 'allow-dns.yaml': ALLOW_DNS, 'web-to-api.yaml': WEB_TO_API }),
  steps: [
    { text: 'No policies yet. From the client pod, curl the api Service', hint: 'kubectl exec client -- curl -sS -m 5 http://api', done: (s) => curls(s).some((c) => c.from === 'shop/client' && c.attempt.ok && owner(c.attempt.pod) === 'api') },
    { text: 'Apply deny-all.yaml and curl api again', hint: 'kubectl apply -f deny-all.yaml  then  kubectl exec client -- curl -sS -m 5 http://api', done: (s) => curls(s).some((c) => !c.host && c.from.startsWith('shop/') && c.policies > 0 && c.enforcing && !c.attempt.ok && c.attempt.how === 'timeout') },
    { text: 'Apply allow-dns.yaml. Names resolve again; does the request get through?', hint: 'kubectl apply -f allow-dns.yaml  then  kubectl exec client -- curl -sS -m 5 http://api', done: (s) => curls(s).some((c) => !c.host && c.from.startsWith('shop/') && c.enforcing && !c.attempt.ok && c.attempt.stage === 'connect' && !!c.attempt.policy && !/^\d/.test(hostOf(c.url))) },
    { text: 'Edit web-to-api.yaml so web can call api and the client still can\'t, apply it, and prove it from a web pod', hint: 'Replace both CHANGE-ME values  then  kubectl apply -f web-to-api.yaml  then  kubectl exec deploy/web -- curl -sS -m 5 http://api', done: (s) => {
      const g = policyGoal(s.ctx.net);
      return g.webToApi && g.webDns && !g.clientToApi && !g.clientToWeb && g.isolated && curls(s).some((c) => c.enforcing && c.attempt.ok && c.from.startsWith('shop/web-') && owner(c.attempt.pod) === 'api');
    }, why: (s) => {
      const g = policyGoal(s.ctx.net);
      if (!g.isolated) return 'deny-all is gone, so nothing is isolated any more. Apply it again.';
      if (g.clientToApi) return 'The client can still reach api: the ingress rule lets in more than web.';
      if (!g.webDns) return 'web can no longer resolve names: allow-dns must still apply to it.';
      if (!g.webToApi) return s.ctx.net.inMesh('shop')
        ? 'The policies still block web → api. shop is in the ambient mesh, so the connection travels on port 15008, and both web\'s egress and api\'s ingress must allow that port.'
        : 'The policies still block web → api. Both halves must allow it: web\'s egress and api\'s ingress.';
      return '';
    } },
    { text: 'Now switch the network plugin to one that ignores NetworkPolicy, and curl api from the client', hint: 'Untick the "Network plugin" switch  then  kubectl exec client -- curl -sS -m 5 http://api', done: (s) => curls(s).some((c) => !c.enforcing && c.policies > 0 && c.from === 'shop/client' && c.attempt.ok && owner(c.attempt.pod) === 'api') },
  ],
  debrief: 'Default deny took DNS with it, because egress to CoreDNS is traffic like any other. That is outside the mesh. In tilt\'s ambient namespaces ztunnel answers Service names itself, so the same deny shows up as a timeout, and in the mesh both ends must also allow port 15008. Allowing DNS fixed the names and nothing else: both ends of a connection must allow it, web\'s egress and api\'s ingress. And with a plugin that doesn\'t enforce NetworkPolicy, every policy you wrote was still there, still listed by kubectl, and blocked nothing. The only test is the connection that should fail.',
};

// ---- ingress ----------------------------------------------------------------

export const INGRESS_MISSION: NetMission = {
  id: 'kube-net-ingress', title: 'An Ingress with nothing behind it', xp: 70, ns: 'shop',
  controls: ['ingress-controller'],
  setup: setup('shop', (net) => {
    net.addNamespace('shop');
    net.createDeployment('shop', 'web', 'panda/web:1.0', 2);
    net.services.set('shop/web', { name: 'web', ns: 'shop', type: 'ClusterIP', clusterIP: '10.96.98.211', selector: { app: 'web' }, labels: { app: 'web' }, ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }], created: net.t });
    client(net, 'shop');
  }),
  steps: [
    { text: 'Create an Ingress named shop that sends shop.localhost to the web Service on port 80', hint: `kubectl create ingress shop --rule='shop.localhost/*=web:80'`, done: (s) => [...s.ctx.net.ingresses.values()].some((i) => i.ns === 'shop' && i.rules.some((r) => r.host === 'shop.localhost' && r.paths.some((p) => p.service === 'web' && (p.port === 80 || p.port === 'http')))) },
    { text: 'Look at its ADDRESS, then try http://shop.localhost from your machine', hint: 'kubectl get ingress  then  curl http://shop.localhost', done: (s) => ranKind(s, 'get', ['ingresses']) && curls(s).some((c) => c.host && hostOf(c.url).endsWith('localhost')) },
    { text: 'Install the Ingress controller, then list the IngressClasses it brought', hint: 'The "Install Ingress controller" button  then  kubectl get ingressclass', done: (s) => s.controllerAt >= 0 && s.ctx.events.slice(s.controllerAt).some((e) => e.type === 'cmd' && e.verb === 'get' && e.kind === 'ingressclasses') },
    { text: 'The controller still ignores your Ingress. Make it claim it, so ADDRESS fills in', hint: `kubectl patch ingress shop -p '{"spec":{"ingressClassName":"panda"}}'`, done: (s) => [...s.ctx.net.ingresses.values()].some((i) => i.ns === 'shop' && i.address !== '' && i.rules.some((r) => r.host === 'shop.localhost')) },
    { text: 'curl http://shop.localhost from your machine again', hint: 'curl http://shop.localhost', done: (s) => curls(s).some((c) => c.host && c.attempt.ok && owner(c.attempt.pod) === 'web' && hostOf(c.url) === 'shop.localhost') },
  ],
  debrief: 'The Ingress was stored and valid from the first command, and nothing served it: no controller, so no address, no event and no error. Even with a controller installed, this one ignores an Ingress with no class, as many do unless told otherwise, and marking a class as the default fills the field in only on Ingresses created afterwards. Gateway API fixed exactly this: a route reports in its own status whether a Gateway accepted it.',
};

export const NET_MISSIONS: Record<string, NetMission> = Object.fromEntries([SERVICES_MISSION, DNS_MISSION, POLICY_MISSION, INGRESS_MISSION].map((m) => [m.id, m]));

/** Runs one line against a mission's state, the way the widget does. */
export function step(s: NetState, line: string) { return run(s.ctx, line); }
export function setEnforcing(s: NetState, on: boolean) { s.ctx.net.enforcing = on; }
export { AMBIENT_LABEL };
