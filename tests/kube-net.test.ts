// NetSim's terminal against a real cluster. Every expected string below was
// copied from a run on tilt (kind, Kubernetes 1.36.1, kindnet, kube-proxy,
// Istio 1.28.3 ambient) with kubectl 1.37.2, curlimages/curl:8.11.1 and
// busybox 1.36.1, on 2026-11-02/03, in a scratch namespace. Where the sandbox
// replaces a name or address (shop for the scratch namespace, 8080 for
// podinfo's 9898), the comment says so; the shape is the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net, AMBIENT_LABEL } from '../src/lib/kube-net/net.ts';
import { run, words, type Ctx } from '../src/lib/kube-net/kubectl.ts';
import { applyManifest } from '../src/lib/kube-net/manifests.ts';

function cluster(build?: (n: Net) => void, files: Record<string, string> = {}): Ctx {
  const net = new Net();
  net.addNamespace('shop');
  net.createDeployment('shop', 'web', 'panda/web:1.0', 2);
  net.addPod({ name: 'client', ns: 'shop', labels: { run: 'client' }, image: 'curlimages/curl:8.11.1' });
  build?.(net);
  return { net, files, ns: 'shop', events: [] };
}
const sh = (c: Ctx, line: string) => run(c, line).map((l) => l.text).join('\n');
const errs = (c: Ctx, line: string) => run(c, line).filter((l) => l.kind === 'err').map((l) => l.text).join('\n');

// ---- Services --------------------------------------------------------------

test('kubectl expose and get svc print the real columns, and LoadBalancer stays <pending>', () => {
  const c = cluster();
  assert.equal(sh(c, 'kubectl expose deploy web --port=80 --target-port=8080'), 'service/web exposed');
  assert.equal(sh(c, 'kubectl expose deploy web --name=web-lb --type=LoadBalancer --port=80 --target-port=8080'), 'service/web-lb exposed');
  assert.equal(sh(c, 'kubectl expose deploy web --name=web-headless --cluster-ip=None --port=80 --target-port=8080'), 'service/web-headless exposed');
  const out = sh(c, 'kubectl get svc');
  // Real: "web-lb   LoadBalancer   10.96.212.15   <pending>     80:30292/TCP   7s"
  assert.match(out, /^NAME {11}TYPE {11}CLUSTER-IP {5}EXTERNAL-IP {3}PORT\(S\) {8}AGE$/m);
  assert.match(out, /^web-lb {9}LoadBalancer {3}10\.96\.\d+\.\d+ +<pending> {5}80:3\d{4}\/TCP {3}\d+s$/m);
  assert.match(out, /^web-headless {3}ClusterIP {6}None {11}<none> {8}80\/TCP {9}\d+s$/m);
  assert.match(sh(c, 'kubectl get svc -o wide'), /AGE {3}SELECTOR\n/);
  assert.match(sh(c, 'kubectl get svc -o wide'), / app=web$/m);
  // Real describe svc: no events for a LoadBalancer nobody serves.
  const d = sh(c, 'kubectl describe svc web-lb');
  for (const l of ['Type:                     LoadBalancer', 'Port:                     <unset>  80/TCP', 'TargetPort:               8080/TCP', 'External Traffic Policy:  Cluster', 'Events:                   <none>']) assert.ok(d.includes(l), l);
});

test('curl through a Service: refused on the wrong targetPort, as curl 8.11.1 says it', () => {
  const c = cluster();
  sh(c, 'kubectl expose deploy web --name=web-wrong --port=80 --target-port=80');
  // Real: curl: (7) Failed to connect to web-wrong port 80 after 3 ms: Could not connect to server
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web-wrong'), 'curl: (7) Failed to connect to web-wrong port 80 after 3 ms: Could not connect to server\ncommand terminated with exit code 7');
  // The EndpointSlice lists the pods with the wrong port (real: PORTS 8080 for web-wrong).
  assert.match(sh(c, 'kubectl get endpointslices'), /^web-wrong-\w{5} {3}IPv4 {10}80 {6}10\.244\.1\.\d+,10\.244\.1\.\d+ {3}\d+s$/m);
  assert.equal(sh(c, `kubectl patch svc web-wrong -p '{"spec":{"ports":[{"port":80,"targetPort":8080}]}}'`), 'service/web-wrong patched');
  assert.match(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web-wrong'), /^hello from web-/);
  assert.match(sh(c, 'kubectl exec client -- curl -sS -m 5 -o /dev/null -w %{http_code}\\n http://web-wrong'), /^200$/);
});

test('a Service with no endpoints: <unset> in the slice, an empty Endpoints line, and refused', () => {
  const c = cluster((n) => n.services.set('shop/nobody', { name: 'nobody', ns: 'shop', type: 'ClusterIP', clusterIP: '10.96.202.32', selector: { app: 'nobody' }, labels: { app: 'nobody' }, ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }], created: 0 }));
  // Real: nobody-dpwhn   IPv4   <unset>   <unset>   1s
  assert.match(sh(c, 'kubectl get endpointslices'), /^nobody-\w{5} {3}IPv4 {10}<unset> {3}<unset> /m);
  assert.match(sh(c, 'kubectl describe svc nobody'), /^Endpoints:$/m);
  assert.equal(errs(c, 'kubectl exec client -- curl -sS -m 5 http://nobody'), 'curl: (7) Failed to connect to nobody port 80 after 3 ms: Could not connect to server\ncommand terminated with exit code 7');
});

test('get endpoints warns that v1 Endpoints is deprecated, word for word', () => {
  const c = cluster();
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  const r = run(c, 'kubectl get endpoints');
  assert.deepEqual(r[0], { text: 'Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice', kind: 'err' });
  assert.match(r.map((l) => l.text).join('\n'), /^NAME {3}ENDPOINTS {25}AGE\nweb {4}10\.244\.1\.\d+:8080,10\.244\.1\.\d+:8080 {3}\d+s$/m);
});

test('readiness: an unready pod leaves describe svc but stays listed in get endpointslices', () => {
  const c = cluster();
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  const pod = c.net.podsIn('shop').find((p) => p.owner === 'web')!;
  sh(c, `kubectl exec client -- curl -sS -m 5 -X POST http://${pod.ip}:8080/readyz/disable`);
  assert.equal(pod.ready, false);
  const other = c.net.podsIn('shop').find((p) => p.owner === 'web' && p !== pod)!;
  assert.match(sh(c, 'kubectl describe svc web'), new RegExp(`^Endpoints: +${other.ip.replace(/\./g, '\\.')}:8080$`, 'm'));
  assert.ok(sh(c, 'kubectl get endpointslices').includes(pod.ip), 'measured: the unready address is still listed');
  assert.match(sh(c, 'kubectl get pods'), new RegExp(`^${pod.name} +0/1 +Running +0 `, 'm'));
});

test('headless: DNS returns pod IPs, and the Service port is not translated', () => {
  const c = cluster();
  sh(c, 'kubectl expose deploy web --name=web-headless --cluster-ip=None --port=80 --target-port=8080');
  // Real (podinfo on 9898 here 8080): curl http://web-headless -> (7) on port 80; :9898 -> 200.
  assert.match(errs(c, 'kubectl exec client -- curl -sS -m 5 http://web-headless'), /^curl: \(7\) Failed to connect to web-headless port 80 after 3 ms/);
  assert.match(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web-headless:8080'), /^hello from/);
  const ns = sh(c, 'kubectl exec client -- nslookup web-headless.shop.svc.cluster.local');
  // Real: one Name/Address pair per ready pod.
  assert.equal((ns.match(/^Name:\tweb-headless\.shop\.svc\.cluster\.local\nAddress: 10\.244\.1\.\d+$/gm) ?? []).length, 2);
});

test('a host can reach a node port, not a cluster IP or a pod IP', () => {
  const c = cluster();
  sh(c, 'kubectl expose deploy web --type=NodePort --port=80 --target-port=8080');
  const np = c.net.service('shop', 'web')!.ports[0].nodePort;
  assert.match(sh(c, `curl http://172.18.0.3:${np}`), /^hello from web-/);
  assert.match(errs(c, `curl http://${c.net.service('shop', 'web')!.clusterIP}`), /only exists inside the cluster/);
});

// ---- DNS -----------------------------------------------------------------------

test('resolv.conf and cross-namespace names, as on tilt', () => {
  const c = cluster((n) => { n.addNamespace('tools'); n.addPod({ name: 'probe', ns: 'tools', labels: {}, image: 'busybox:1.36' }); });
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  assert.equal(sh(c, 'kubectl -n tools exec probe -- cat /etc/resolv.conf'), 'search tools.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5');
  // Real: curl http://hello from another namespace -> (6); http://hello.hello -> 200.
  assert.equal(sh(c, 'kubectl -n tools exec probe -- curl -sS -m 5 http://web'), 'curl: (6) Could not resolve host: web\ncommand terminated with exit code 6');
  assert.match(sh(c, 'kubectl -n tools exec probe -- curl -sS -m 5 http://web.shop'), /^hello from/);
  // Real busybox 1.36.1: a dotted name is not searched.
  assert.equal(sh(c, 'kubectl -n tools exec probe -- nslookup web.shop'), "Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\n** server can't find web.shop: NXDOMAIN\n\n** server can't find web.shop: NXDOMAIN\n\ncommand terminated with exit code 1");
  // Real: found, then NXDOMAIN for each other search domain, then exit 1.
  const short = sh(c, 'kubectl exec client -- nslookup web');
  assert.match(short, /^Server:\t\t10\.96\.0\.10\nAddress:\t10\.96\.0\.10:53\n\nName:\tweb\.shop\.svc\.cluster\.local\nAddress: 10\.96\.\d+\.\d+\n/);
  assert.match(short, /\*\* server can't find web\.svc\.cluster\.local: NXDOMAIN/);
  assert.match(short, /command terminated with exit code 1$/);
  // Real: the full name answers cleanly, exit 0.
  assert.doesNotMatch(sh(c, 'kubectl exec client -- nslookup web.shop.svc.cluster.local'), /exit code|NXDOMAIN/);
  // "pods insecure": a dashed pod IP under <ns>.pod answers itself (real: 200 on podinfo).
  const ip = c.net.podsIn('shop').find((p) => p.owner === 'web')!.ip;
  assert.match(sh(c, `kubectl exec client -- curl -sS -m 5 http://${ip.replace(/\./g, '-')}.shop.pod.cluster.local:8080`), /^hello from/);
});

test('DNS with no CoreDNS pods: curl (6), the IP still works, nslookup is refused', () => {
  const c = cluster();
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  assert.equal(sh(c, 'kubectl -n kube-system scale deployment coredns --replicas=0'), 'deployment.apps/coredns scaled');
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 30 http://web'), 'curl: (6) Could not resolve host: web\ncommand terminated with exit code 6');
  assert.match(sh(c, `kubectl exec client -- curl -sS -m 5 http://${c.net.service('shop', 'web')!.clusterIP}`), /^hello from/);
  // Real, with a DNS Service that had no pods behind it.
  assert.equal(sh(c, 'kubectl exec client -- nslookup web.shop.svc.cluster.local'), ";; connection timed out; no servers could be reached\n\nnslookup: write to '10.96.0.10': Connection refused\ncommand terminated with exit code 1");
});

// ---- NetworkPolicy --------------------------------------------------------------

const DENY_IN = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: default-deny-ingress\nspec:\n  podSelector: {}\n  policyTypes:\n  - Ingress\n';
const DENY_OUT = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: default-deny-egress\nspec:\n  podSelector: {}\n  policyTypes:\n  - Egress\n';

test('default deny: ingress times out; egress takes DNS with it; allowing DNS leaves a timeout', () => {
  const c = cluster(undefined, { 'in.yaml': DENY_IN, 'out.yaml': DENY_OUT, 'dns.yaml': 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: allow-dns\nspec:\n  podSelector: {}\n  policyTypes:\n  - Egress\n  egress:\n  - to:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: kube-system\n      podSelector:\n        matchLabels:\n          k8s-app: kube-dns\n    ports:\n    - protocol: UDP\n      port: 53\n    - protocol: TCP\n      port: 53\n' });
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  assert.equal(sh(c, 'kubectl apply -f in.yaml'), 'networkpolicy.networking.k8s.io/default-deny-ingress created');
  assert.equal(sh(c, 'kubectl apply -f in.yaml'), 'networkpolicy.networking.k8s.io/default-deny-ingress unchanged');
  // Real: curl: (28) Connection timed out after 5032 milliseconds
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web'), 'curl: (28) Connection timed out after 5032 milliseconds\ncommand terminated with exit code 28');
  // Real, with no -m: gave up after 2 min 20 s with this message.
  assert.match(sh(c, 'kubectl exec client -- curl -sS http://web'), /curl: \(28\) Failed to connect to web port 80 after 139636 ms: Could not connect to server/);
  assert.equal(sh(c, 'kubectl delete netpol default-deny-ingress'), 'networkpolicy.networking.k8s.io "default-deny-ingress" deleted from shop namespace');
  sh(c, 'kubectl apply -f out.yaml');
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 20 http://web'), 'curl: (6) Could not resolve host: web\ncommand terminated with exit code 6');
  // Real: with -m 5 the timer runs out before the resolver gives up.
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web'), 'curl: (28) Resolving timed out after 5003 milliseconds\ncommand terminated with exit code 28');
  // Real busybox nslookup with egress denied: no "write to" line.
  assert.equal(sh(c, 'kubectl exec client -- nslookup web.shop.svc.cluster.local'), ';; connection timed out; no servers could be reached\n\ncommand terminated with exit code 1');
  sh(c, 'kubectl apply -f dns.yaml');
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web'), 'curl: (28) Connection timed out after 5032 milliseconds\ncommand terminated with exit code 28');
  assert.match(sh(c, 'kubectl exec client -- nslookup web.shop.svc.cluster.local'), /^Server:/);
});

test('policies match pod ports after the Service translates, and both ends must allow', () => {
  const c = cluster(undefined, {
    'in.yaml': DENY_IN,
    'allow.yaml': 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: allow-client-to-web\nspec:\n  podSelector:\n    matchLabels:\n      app: web\n  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels:\n          run: client\n    ports:\n    - protocol: TCP\n      port: 8080\n',
  });
  c.net.addPod({ name: 'bb', ns: 'shop', labels: { run: 'bb' }, image: 'busybox:1.36' });
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  sh(c, 'kubectl apply -f in.yaml');
  sh(c, 'kubectl apply -f allow.yaml');
  // Real: client (run=client) got 200 through the Service on 80; bb timed out.
  assert.match(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web'), /^hello from/);
  assert.match(sh(c, 'kubectl exec bb -- curl -sS -m 5 http://web'), /\(28\)/);
  const d = sh(c, 'kubectl describe netpol allow-client-to-web');
  // Real describe shape.
  assert.match(d, /Spec:\n  PodSelector:     app=web\n  Allowing ingress traffic:\n    To Port: 8080\/TCP\n    From:\n      PodSelector: run=client\n  Not affecting egress traffic\n  Policy Types: Ingress$/);
  // Real: listed in name order, whatever order they were created in.
  assert.match(sh(c, 'kubectl get netpol'), /^NAME {19}POD-SELECTOR {3}AGE\nallow-client-to-web {4}app=web {8}\d+s\ndefault-deny-ingress {3}<none> {9}\d+s$/);
});

test('one peer with two selectors is AND; two peers are OR; describe shows one From per peer', () => {
  const net = new Net();
  for (const n of ['a', 'b']) net.addNamespace(n, { team: n });
  const server = net.addPod({ name: 'server', ns: 'a', labels: { app: 'server' }, image: 'panda/web:1.0' });
  const inB = net.addPod({ name: 'client', ns: 'b', labels: { role: 'client' }, image: 'panda/web:1.0' });
  const otherB = net.addPod({ name: 'other', ns: 'b', labels: {}, image: 'panda/web:1.0' });
  const and = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: p\nspec:\n  podSelector: {}\n  ingress:\n  - from:\n    - namespaceSelector:\n        matchLabels:\n          team: b\n      podSelector:\n        matchLabels:\n          role: client\n';
  applyManifest(net, and, 'and.yaml', 'a');
  assert.equal(net.policyAllows(inB, server, 8080, 'TCP').ok, true);
  assert.equal(net.policyAllows(otherB, server, 8080, 'TCP').ok, false);
  applyManifest(net, and.replace('      podSelector:', '    - podSelector:'), 'or.yaml', 'a');
  assert.equal(net.policyAllows(otherB, server, 8080, 'TCP').ok, true, 'OR: any pod in team b');
  const d = run({ net, files: {}, ns: 'a', events: [] }, 'kubectl describe netpol p').map((l) => l.text).join('\n');
  // Real (kubectl 1.37.2): each peer gets its own From: line.
  assert.match(d, /    From:\n      NamespaceSelector: team=b\n    From:\n      PodSelector: role=client\n/);
});

test('policyTypes default: Ingress always, Egress only with egress rules', () => {
  const net = new Net();
  net.addNamespace('x');
  applyManifest(net, 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: e\nspec:\n  podSelector: {}\n  egress:\n  - {}\n', 'e.yaml', 'x');
  assert.deepEqual(net.policies.get('x/e')!.types, ['Ingress', 'Egress']);
  applyManifest(net, 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: i\nspec:\n  podSelector: {}\n', 'i.yaml', 'x');
  assert.deepEqual(net.policies.get('x/i')!.types, ['Ingress']);
});

test('ambient mesh: mesh traffic arrives on 15008, and failures read as the mesh reports them', () => {
  const c = cluster(undefined, {
    'in.yaml': DENY_IN,
    'app.yaml': 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: allow-8080\nspec:\n  podSelector:\n    matchLabels:\n      app: web\n  policyTypes:\n  - Ingress\n  ingress:\n  - ports:\n    - protocol: TCP\n      port: 8080\n',
    'hbone.yaml': 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: allow-hbone\nspec:\n  podSelector: {}\n  policyTypes:\n  - Ingress\n  ingress:\n  - ports:\n    - protocol: TCP\n      port: 15008\n',
  });
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  sh(c, 'kubectl expose deploy web --name=web-bad --port=80 --target-port=80');
  assert.equal(sh(c, 'kubectl label ns shop istio.io/dataplane-mode=ambient'), 'namespace/shop labeled');
  // Real in the mesh: a refusal behind ztunnel is a reset.
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web-bad'), 'curl: (56) Recv failure: Connection reset by peer\ncommand terminated with exit code 56');
  sh(c, 'kubectl apply -f in.yaml');
  sh(c, 'kubectl apply -f app.yaml');
  // Real: allowing 9898 (here 8080) alone: "(28) Operation timed out after 5032 milliseconds with 0 bytes received".
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web'), 'curl: (28) Operation timed out after 5032 milliseconds with 0 bytes received\ncommand terminated with exit code 28');
  sh(c, 'kubectl apply -f hbone.yaml');
  assert.match(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web'), /^hello from/);
});

// Measured on tilt (Istio 1.28.3 ambient, kindnet) on 2026-11-03, in scratch
// namespace fix-k8s-2, each with a new client pod (podinfo's 9898 is 8080 here).
const EGRESS = (ports: string) => `apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: client-egress\nspec:\n  podSelector:\n    matchLabels:\n      run: client\n  policyTypes:\n  - Egress\n  egress:\n  - to:\n    - podSelector:\n        matchLabels:\n          app: web\n    ports:\n${ports}`;

test('ambient mesh: the source\'s egress sees port 15008 too, not the app port', () => {
  // The sandbox once checked egress against the app port in the mesh, so an
  // egress rule for 8080 alone passed here while tilt timed it out 3 times in 3.
  const c = cluster(undefined, {
    'app.yaml': EGRESS('    - protocol: TCP\n      port: 8080\n'),
    'both.yaml': EGRESS('    - protocol: TCP\n      port: 8080\n    - protocol: TCP\n      port: 15008\n'),
    'hbone.yaml': EGRESS('    - protocol: TCP\n      port: 15008\n'),
  });
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  sh(c, 'kubectl label ns shop istio.io/dataplane-mode=ambient');
  sh(c, 'kubectl apply -f app.yaml');
  // Real: curl: (28) Operation timed out after 5028 milliseconds with 0 bytes received
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web'), 'curl: (28) Operation timed out after 5032 milliseconds with 0 bytes received\ncommand terminated with exit code 28');
  sh(c, 'kubectl apply -f both.yaml');
  assert.match(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web'), /^hello from/);
  sh(c, 'kubectl apply -f hbone.yaml');
  assert.match(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web'), /^hello from/, 'real: 15008 alone was enough');
  // Out of the mesh the app port is what egress sees (real: 9898 alone gave
  // 200; that run also allowed DNS, so here the cluster IP stands in for the name).
  sh(c, 'kubectl label ns shop istio.io/dataplane-mode-');
  sh(c, 'kubectl apply -f app.yaml');
  assert.match(sh(c, `kubectl exec client -- curl -sS -m 5 http://${c.net.service('shop', 'web')!.clusterIP}`), /^hello from/);
});

test('ambient mesh: under a default-deny egress, ztunnel still answers Service names', () => {
  // The sandbox once sent mesh pods' DNS through egress policy, and printed
  // "Could not resolve host" where tilt resolved the name and then timed out.
  const c = cluster((n) => {
    n.addNamespace('other', { [AMBIENT_LABEL]: 'ambient' });
    n.createDeployment('other', 'api', 'panda/api:1.0', 1);
    n.services.set('other/api', { name: 'api', ns: 'other', type: 'ClusterIP', clusterIP: '10.96.141.7', selector: { app: 'api' }, labels: { app: 'api' }, ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }], created: 0 });
  }, { 'out.yaml': DENY_OUT });
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  sh(c, 'kubectl expose deploy web --name=web-pods --cluster-ip=None --port=8080');
  sh(c, 'kubectl label ns shop istio.io/dataplane-mode=ambient');
  sh(c, 'kubectl apply -f out.yaml');
  const want28 = 'curl: (28) Operation timed out after 5032 milliseconds with 0 bytes received\ncommand terminated with exit code 28';
  // Real: "Host web:80 was resolved ... Connected to web", then (28) with 0 bytes received.
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web'), want28);
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web.shop.svc.cluster.local'), want28);
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 5 http://api.other'), want28, 'real: hello.hello resolved from another namespace');
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web-pods:8080'), want28, 'real: a headless short name resolved to the pod IP');
  // Real: with -m 20, -m 40 and no -m, ztunnel reset the connection after 10.6 to 15.1 s.
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 20 http://web'), 'curl: (56) Recv failure: Connection reset by peer\ncommand terminated with exit code 56');
  assert.equal(sh(c, 'kubectl exec client -- curl -sS http://web'), 'curl: (56) Recv failure: Connection reset by peer\ncommand terminated with exit code 56');
  // Real: names ztunnel doesn't know go on to CoreDNS, which the deny blocks.
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 5 http://nosuchsvc'), 'curl: (28) Resolving timed out after 5003 milliseconds\ncommand terminated with exit code 28');
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 20 http://nosuchsvc'), 'curl: (6) Could not resolve host: nosuchsvc\ncommand terminated with exit code 6');
  const ip = c.net.podsIn('shop').find((p) => p.owner === 'web')!.ip.replace(/\./g, '-');
  assert.match(sh(c, `kubectl exec client -- curl -sS -m 20 http://${ip}.shop.pod.cluster.local:8080`), /^curl: \(6\) Could not resolve host/);
  // busybox's mesh output has a shape this sandbox doesn't model: refused by name.
  assert.match(errs(c, 'kubectl exec client -- nslookup web'), /ambient mesh.*doesn't model/);
  // Out of the mesh, the same deny still takes DNS with it.
  sh(c, 'kubectl label ns shop istio.io/dataplane-mode-');
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 20 http://web'), 'curl: (6) Could not resolve host: web\ncommand terminated with exit code 6');
});

test('ambient mesh: a dropped connection with no -m ends in a reset, not the 2 min 20 s timeout', () => {
  // The sandbox once printed the out-of-mesh "after 139636 ms" line here.
  const c = cluster(undefined, { 'in.yaml': DENY_IN });
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  sh(c, 'kubectl label ns shop istio.io/dataplane-mode=ambient');
  sh(c, 'kubectl apply -f in.yaml');
  assert.equal(sh(c, 'kubectl exec client -- curl -sS http://web'), 'curl: (56) Recv failure: Connection reset by peer\ncommand terminated with exit code 56');
  assert.equal(sh(c, 'kubectl exec client -- curl -sS -m 40 http://web'), 'curl: (56) Recv failure: Connection reset by peer\ncommand terminated with exit code 56');
});

test('a plugin that ignores NetworkPolicy: everything is stored, nothing is blocked', () => {
  const c = cluster(undefined, { 'in.yaml': DENY_IN });
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  sh(c, 'kubectl apply -f in.yaml');
  c.net.enforcing = false;
  assert.match(sh(c, 'kubectl get netpol'), /default-deny-ingress/);
  assert.match(sh(c, 'kubectl exec client -- curl -sS -m 5 http://web'), /^hello from/);
});

// ---- apply: the API server's validation, word for word ------------------------------

test('apply refuses what the API server refuses, with its words (1.36.1, --dry-run=server)', () => {
  const np = (spec: string, name = 'p') => `apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: ${name}\nspec:\n${spec}`;
  const cases: [string, string][] = [
    [np('  podSelector: {}\n  ingres: []\n  egres: []\n', 'two'), 'Error from server (BadRequest): error when creating "f.yaml": NetworkPolicy in version "v1" cannot be handled as a NetworkPolicy: strict decoding error: unknown field "spec.egres", unknown field "spec.ingres"'],
    [np('  podSelector: {}\n  policyTypes: [Ingres]\n', 'typo'), 'The NetworkPolicy "typo" is invalid: spec.policyTypes[0]: Unsupported value: "Ingres": supported values: "Ingress", "Egress"'],
    [np('  podSelector: {}\n  ingress:\n  - ports:\n    - port: "80"\n      protocol: TCP\n', 'typo'), 'The NetworkPolicy "typo" is invalid: spec.ingress[0].ports[0].port: Invalid value: "80": must contain at least one letter (a-z)'],
    [np('  podSelector: {}\n  ingress:\n  - from:\n    - ipBlock:\n        cidr: 10.0.0.0/8\n      podSelector: {}\n', 'badpeer'), 'The NetworkPolicy "badpeer" is invalid: spec.ingress[0].from[0]: Forbidden: may not specify both ipBlock and another peer'],
    [np('  podSelector: {}\n  ingress:\n  - from:\n    - ipBlock:\n        cidr: 10.0.0.1/33\n', 'badcidr'), 'The NetworkPolicy "badcidr" is invalid: spec.ingress[0].from[0].ipBlock.cidr: Invalid value: "10.0.0.1/33": must be a valid CIDR value, (e.g. 10.9.8.0/24 or 2001:db8::/64)'],
    [np('  podSelector: {}\n  ingress:\n  - ports:\n    - port: 80\n      protocol: tcp\n'), 'The NetworkPolicy "p" is invalid: spec.ingress[0].ports[0].protocol: Unsupported value: "tcp": supported values: "TCP", "UDP", "SCTP"'],
    [np('  podSelector: {}\n  ingress:\n  - ports:\n    - port: 70000\n'), 'The NetworkPolicy "p" is invalid: spec.ingress[0].ports[0].port: Invalid value: 70000: must be between 1 and 65535, inclusive'],
    [np('  podSelector:\n    matchExpressions:\n    - {key: app, operator: Equals, values: [web]}\n'), 'The NetworkPolicy "p" is invalid: spec.podSelector.matchExpressions[0].operator: Invalid value: "Equals": not a valid selector operator'],
    [np('  podSelector:\n    matchExpressions:\n    - {key: app, operator: In}\n'), "The NetworkPolicy \"p\" is invalid: spec.podSelector.matchExpressions[0].values: Required value: must be specified when `operator` is 'In' or 'NotIn'"],
    [np('  podSelector:\n    matchExpressions:\n    - {key: app, operator: Exists, values: [web]}\n'), "The NetworkPolicy \"p\" is invalid: spec.podSelector.matchExpressions[0].values: Forbidden: may not be specified when `operator` is 'Exists' or 'DoesNotExist'"],
    [np('  podSelector: {}\n  ingress:\n  - from:\n    - {}\n'), 'The NetworkPolicy "p" is invalid: spec.ingress[0].from[0]: Required value: must specify a peer'],
    [np('  podSelector:\n    matchLabels:\n      version: 2\n'), 'Error from server (BadRequest): error when creating "f.yaml": NetworkPolicy in version "v1" cannot be handled as a NetworkPolicy: json: cannot unmarshal number into Go struct field LabelSelector.spec.podSelector.matchLabels of type string'],
    [np('  podSelector: web\n'), 'Error from server (BadRequest): error when creating "f.yaml": NetworkPolicy in version "v1" cannot be handled as a NetworkPolicy: json: cannot unmarshal string into Go struct field NetworkPolicySpec.spec.podSelector of type v1.LabelSelector'],
    [np('  podSelector: {}\n  egress:\n  - ports:\n    - port: 9000\n      endPort: 8000\n'), 'The NetworkPolicy "p" is invalid: spec.egress[0].ports[0].endPort: Invalid value: 9000: must be greater than or equal to `port`'],
    ['apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: i\nspec:\n  rules:\n  - http:\n      paths:\n      - path: /\n        pathType: prefix\n        backend:\n          service: {name: web, port: {number: 80}}\n', 'The Ingress "i" is invalid: spec.rules[0].http.paths[0].pathType: Unsupported value: "prefix": supported values: "Exact", "ImplementationSpecific", "Prefix"'],
    ['apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: i\nspec:\n  rules:\n  - http:\n      paths:\n      - path: /\n        pathType: Prefix\n', 'The Ingress "i" is invalid: spec.rules[0].http.paths[0].backend: Invalid value: "": resource or service backend is required'],
    ['apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: shop\nspec:\n  backend:\n    serviceName: web\n    servicePort: 80\n', 'Error from server (BadRequest): error when creating "f.yaml": Ingress in version "v1" cannot be handled as a Ingress: strict decoding error: unknown field "spec.backend"'],
    ['apiVersion: networking.k8s.io/v1beta1\nkind: Ingress\nmetadata:\n  name: old\n', 'error: resource mapping not found for name: "old" namespace: "" from "f.yaml": no matches for kind "Ingress" in version "networking.k8s.io/v1beta1"\nensure CRDs are installed first'],
    ['apiVersion: networking.k8s.io/v1\nmetadata: {name: p}\n', 'error: error validating "f.yaml": error validating data: kind not set; if you choose to ignore these errors, turn validation off with --validate=false'],
    ['apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: p, namespace: nosuchns}\nspec:\n  podSelector: {}\n', 'Error from server (NotFound): error when creating "f.yaml": namespaces "nosuchns" not found'],
    ['apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nspec:\n  podSelector: {}\n', 'error: error when retrieving current configuration of:\nResource: "networking.k8s.io/v1, Resource=networkpolicies", GroupVersionKind: "networking.k8s.io/v1, Kind=NetworkPolicy"\nName: "", Namespace: "shop"\nfrom server for: "f.yaml": resource name may not be empty'],
  ];
  for (const [src, want] of cases) {
    const c = cluster(undefined, { 'f.yaml': src });
    assert.equal(errs(c, 'kubectl apply -f f.yaml'), want, src);
  }
  // Only an explicit -n conflicts with the object's namespace (real wording).
  const c = cluster(undefined, { 'f.yaml': 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: p, namespace: other}\nspec:\n  podSelector: {}\n' });
  c.net.addNamespace('other');
  assert.equal(errs(c, 'kubectl apply -f f.yaml -n shop'), `error: the namespace from the provided object "other" does not match the namespace "shop". You must pass '--namespace=other' to perform this operation.`);
  assert.equal(sh(c, 'kubectl apply -f f.yaml'), 'networkpolicy.networking.k8s.io/p created');
});

test('the update form of the unknown-field error keeps the real tail', () => {
  const c = cluster(undefined, { 'f.yaml': DENY_IN });
  sh(c, 'kubectl apply -f f.yaml');
  c.files['f.yaml'] = DENY_IN + '  ingres: []\n';
  assert.match(errs(c, 'kubectl apply -f f.yaml'), /^The request is invalid: patch: Invalid value: "map\[\.\.\.\]": strict decoding error: unknown field "spec\.ingres"$/);
});

// ---- Ingress ----------------------------------------------------------------------

test('create ingress and get ingress, as kubectl 1.37.2 prints them', () => {
  const c = cluster();
  assert.equal(sh(c, `kubectl create ingress tls-ing --rule='shop.localhost/*=web:80,tls=shop-tls'`), 'ingress.networking.k8s.io/tls-ing created');
  // Real: tls-ing   <none>   shop.localhost             80, 443   1s
  assert.match(sh(c, 'kubectl get ingress tls-ing'), /^NAME {6}CLASS {4}HOSTS {12}ADDRESS {3}PORTS {5}AGE\ntls-ing {3}<none> {3}shop\.localhost {13}80, 443 {3}\d+s$/);
  assert.equal(errs(c, `kubectl create ingress bad --rule='shop.localhost/*=web'`), 'error: rule shop.localhost/*=web is invalid and should be in format host/path=svcname:svcport[,tls[=secret]]');
  assert.equal(sh(c, 'kubectl get ingressclass'), 'No resources found');
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  const [a, b] = c.net.podsIn('shop').filter((p) => p.owner === 'web').map((p) => p.ip);
  // Real, byte for byte apart from names and IPs (cat -A on kubectl 1.37.2's output).
  assert.equal(sh(c, 'kubectl describe ingress tls-ing'), [
    'Name:             tls-ing', 'Labels:           <none>', 'Namespace:        shop', 'Address:          ', 'Ingress Class:    <none>', 'Default backend:  <default>',
    'TLS:', '  shop-tls terminates shop.localhost', 'Rules:', '  Host            Path  Backends', '  ----            ----  --------', '  shop.localhost  ',
    `                  /   web:80 (${a}:8080,${b}:8080)`, 'Annotations:      <none>', 'Events:           <none>',
  ].join('\n'));
});

// ---- refusing by name ---------------------------------------------------------------

test('what the terminal can\'t do, it refuses by name, and never silently ignores', () => {
  const c = cluster();
  assert.throws(() => words('kubectl get pods | grep web'), /no pipes/);
  assert.match(errs(c, 'kubectl get pods | grep web'), /no pipes/);
  assert.match(errs(c, 'kubectl get pods --watch'), /^error: unknown flag: --watch/);
  assert.match(errs(c, 'kubectl get pods -o yaml'), /tables only/);
  assert.match(errs(c, 'kubectl run x --image=busybox'), /kubectl run is not in this sandbox/);
  assert.match(errs(c, 'kubectl exec client -- curl --insecure http://web'), /option --insecure is not in this sandbox/);
  assert.match(errs(c, 'kubectl exec client -- curl https://web'), /plain HTTP only/);
  assert.match(errs(c, 'kubectl exec client curl http://web'), /Use exec \[POD\] -- \[COMMAND\] instead/);
  assert.match(errs(c, 'kubectl exec client -- wget http://web'), /wget is not in this sandbox/);
  assert.match(errs(c, 'kubectl get svc nosuch'), /^Error from server \(NotFound\): services "nosuch" not found$/);
  assert.match(errs(c, 'kubectl exec nosuch -- curl http://web'), /^Error from server \(NotFound\): pods "nosuch" not found$/);
  assert.equal(sh(c, 'kubectl get ingress'), 'No resources found in shop namespace.');
  assert.match(errs(c, 'kubectl get nosuchkind'), /the server doesn't have a resource type "nosuchkind"/);
});

test('kinds and commands Kubernetes has are refused as sandbox limits, not as the server\'s words', () => {
  // The sandbox once answered `get all`, `rs`, `events` and `configmap` with
  // the server's "doesn't have a resource type", and `version` with "unknown
  // command": false statements about Kubernetes. All of them work on tilt.
  const c = cluster();
  for (const k of ['all', 'rs', 'events', 'configmap', 'secrets', 'statefulsets', 'crd']) {
    const e = errs(c, `kubectl get ${k}`);
    assert.match(e, new RegExp(`^This sandbox doesn't model ${k}\\. A real cluster has it`), k);
    assert.doesNotMatch(e, /the server doesn't have/, k);
  }
  assert.match(errs(c, 'kubectl describe cm x'), /This sandbox doesn't model cm/);
  assert.match(errs(c, 'kubectl delete rs x'), /This sandbox doesn't model rs/);
  for (const v of ['version', 'api-resources', 'cluster-info', 'top']) assert.match(errs(c, `kubectl ${v}`), new RegExp(`^kubectl ${v} is not in this sandbox \\(a real kubectl has it\\)`), v);
  // Names no Kubernetes serves still get the real words (kubectl 1.37.2).
  assert.equal(errs(c, 'kubectl get foo'), `error: the server doesn't have a resource type "foo"`);
  assert.equal(errs(c, 'kubectl frobnicate'), 'error: unknown command "frobnicate" for "kubectl"');
  // Group-qualified names work as they do for real.
  assert.match(sh(c, 'kubectl get deployments.apps'), /^NAME +READY/);
  assert.match(sh(c, 'kubectl get netpol.networking.k8s.io'), /^No resources found in shop namespace\.$/);
});

test('POST to a path the panda images do not serve is refused by name, not as a connection failure', () => {
  // The sandbox once printed "(7) Failed to connect" for POST /foo, after the
  // connection had worked. Real podinfo 6.9.1 answered 404 (and 405 for POST /).
  const c = cluster();
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  const e = errs(c, 'kubectl exec client -- curl -sS -m 5 -X POST http://web/foo');
  assert.match(e, /^The request reached web-.*a real server would answer it with an HTTP status/);
  assert.doesNotMatch(e, /\(7\)/);
  assert.match(errs(c, 'kubectl exec client -- curl -sS -m 5 -X POST http://web/'), /doesn't model what POST \/ returns/);
});

test('kubectl patch on a Service: the real validation text, warnings for unknown fields, all or nothing', () => {
  const c = cluster();
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  // Real (1.36.1); the sandbox once said "at least one letter or number (a-z, 0-9)".
  assert.equal(errs(c, `kubectl patch svc web -p '{"spec":{"ports":[{"port":80,"targetPort":"8080"}]}}'`), 'The Service "web" is invalid: spec.ports[0].targetPort: Invalid value: "8080": must contain at least one letter (a-z)');
  // Real (kubectl 1.37.2): a warning, and the rest applies. The sandbox once refused with BadRequest.
  assert.equal(sh(c, `kubectl patch svc web -p '{"spec":{"ports":[{"port":80,"bogus":1}]}}'`), 'Warning: unknown field "spec.ports[0].bogus"\nservice/web patched (no change)');
  // Real: several warnings come sorted.
  assert.equal(sh(c, `kubectl patch svc web -p '{"spec":{"zeta":1,"bogus":2,"ports":[{"port":80,"targetPort":8080,"bogus":1}]}}'`), 'Warning: unknown field "spec.bogus"\nWarning: unknown field "spec.ports[0].bogus"\nWarning: unknown field "spec.zeta"\nservice/web patched (no change)');
  assert.equal(sh(c, `kubectl patch svc web -p '{"spec":{"selector":{"tier":"x"},"bogus":1}}'`), 'Warning: unknown field "spec.bogus"\nservice/web patched');
  assert.equal(c.net.service('shop', 'web')!.selector!.tier, 'x');
  // A patch that fails part-way changes nothing: the selector half is not kept.
  sh(c, `kubectl patch svc web -p '{"spec":{"selector":{"tier":null}}}'`);
  assert.match(errs(c, `kubectl patch svc web -p '{"spec":{"selector":{"tier":"y"},"ports":[{"port":80,"targetPort":"80"}]}}'`), /must contain at least one letter/);
  assert.equal(c.net.service('shop', 'web')!.selector!.tier, undefined);
  // A port item with no numeric port can't be merged: refused by name, never a NaN port.
  assert.match(errs(c, `kubectl patch svc web -p '{"spec":{"ports":[{"targetPort":8080}]}}'`), /matches patched ports by a numeric "port"/);
  assert.equal(c.net.service('shop', 'web')!.ports.length, 1);
});

test('the kubernetes Service has the API server endpoint; -l and --show-labels are never ignored', () => {
  const c = cluster();
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  // Real (1.36.1 on kind): kubernetes   172.18.0.2:6443. The sandbox once showed <none>.
  assert.match(sh(c, 'kubectl get endpoints -n default'), /\nkubernetes {3}172\.18\.0\.2:6443 {3}\S+$/);
  // Real: NAME kubernetes, PORTS 6443, ENDPOINTS 172.18.0.2, LABELS kubernetes.io/service-name=kubernetes.
  assert.match(sh(c, 'kubectl get endpointslices -n default --show-labels'), /^NAME {9}ADDRESSTYPE {3}PORTS {3}ENDPOINTS {4}AGE {3}LABELS\nkubernetes {3}IPv4 {10}6443 {4}172\.18\.0\.2 {3}\S+ +kubernetes\.io\/service-name=kubernetes$/);
  assert.match(sh(c, 'kubectl describe svc kubernetes -n default'), /^Endpoints: +172\.18\.0\.2:6443$/m);
  // Real labels on a controller-made slice: the Service's, plus two the controller adds, sorted.
  assert.match(sh(c, 'kubectl get endpointslices --show-labels'), / app=web,endpointslice\.kubernetes\.io\/managed-by=endpointslice-controller\.k8s\.io,kubernetes\.io\/service-name=web$/m);
  // The sandbox once ignored every -l on endpointslices except service-name.
  assert.equal(sh(c, 'kubectl get endpointslices -l app=nothing'), 'No resources found in shop namespace.');
  assert.match(sh(c, 'kubectl get endpointslices -l app=web'), /^NAME +ADDRESSTYPE.*\nweb-\w{5} /);
  assert.match(sh(c, 'kubectl get svc --show-labels'), /AGE {3}LABELS\nweb .* app=web$/);
  // Kinds whose labels the sandbox doesn't keep refuse, rather than listing everything.
  assert.match(errs(c, 'kubectl get netpol -l app=nothing'), /doesn't keep labels on networkpolicies/);
  assert.match(errs(c, 'kubectl get deploy --show-labels'), /--show-labels for pods, namespaces, services and endpointslices/);
  // Real: tilt's kube-dns slice lists both 53s: "53,53,9153".
  assert.match(sh(c, 'kubectl get endpointslices -n kube-system'), /\nkube-dns-\w{5} {3}IPv4 {10}53,53,9153 /);
  // curl to the API server's Service is refused by name.
  assert.match(errs(c, 'kubectl exec client -- curl -sS -m 5 http://10.96.0.1:443'), /leads to the API server/);
});

test('apply validates an Ingress backend the way 1.36.1 does', () => {
  const head = 'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: i\n';
  const cases: [string, string][] = [
    [head, 'The Ingress "i" is invalid: spec: Invalid value: null: either `defaultBackend` or `rules` must be specified'],
    [head + 'spec:\n  defaultBackend:\n    service:\n      name: web\n', 'The Ingress "i" is invalid: spec.defaultBackend: Required value: port name or number is required'],
    [head + 'spec:\n  rules:\n  - http:\n      paths:\n      - path: /\n        pathType: Prefix\n        backend:\n          service:\n            name: web\n', 'The Ingress "i" is invalid: spec.rules[0].http.paths[0].backend: Required value: port name or number is required'],
  ];
  for (const [src, want] of cases) assert.equal(errs(cluster(undefined, { 'f.yaml': src }), 'kubectl apply -f f.yaml'), want, src);
});

test('an internal exception shows as a bug in the sandbox, not a command error', () => {
  const c = cluster();
  // Sabotage the model so the next command throws something unexpected.
  (c.net as unknown as { podsIn: () => never }).podsIn = () => { throw new TypeError('boom'); };
  assert.match(errs(c, 'kubectl get pods'), /^A bug in the sandbox, not in your command: boom/);
});

test('5000 random command lines: every one gets an answer, none trips a sandbox bug', () => {
  // Seeded, so a failure names a line that can be replayed.
  let seed = 20261102;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const vocab = ['get', 'describe', 'create', 'expose', 'patch', 'set', 'selector', 'scale', 'label', 'delete', 'apply', 'exec', 'curl', 'nslookup',
    'svc', 'pods', 'deploy', 'netpol', 'ingress', 'ingressclass', 'endpointslices', 'endpoints', 'ns', 'nodes', 'web', 'client', 'shop', 'kube-system', 'coredns',
    '-n', '-A', '-o', 'wide', '--', '-sS', '-m', '5', '--port=80', '--target-port=8080', '--type=NodePort', '--replicas=0', '--replicas=2', '-f', 'f.yaml',
    'http://web', 'http://web.shop', 'http://10.96.0.10', 'web.shop.svc.cluster.local', '-p', `'{"spec":{"selector":{"app":"x"}}}'`, `'{"spec":{"ports":[{"port":80,"targetPort":8080}]}}'`,
    'deployment', '--rule=a.localhost/*=web:80', '--image=panda/web:2.0', 'app=web', 'istio.io/dataplane-mode=ambient', '-X', 'POST', '/readyz/disable', 'cat', '/etc/resolv.conf'];
  const c = cluster(undefined, { 'f.yaml': DENY_IN });
  sh(c, 'kubectl expose deploy web --port=80 --target-port=8080');
  for (let i = 0; i < 5000; i++) {
    const line = ['kubectl', ...Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => pick(vocab))].join(' ');
    const out = run(c, line);
    assert.ok(out.length > 0, `no output for: ${line}`);
    const bug = out.find((l) => l.text.startsWith('A bug in the sandbox'));
    assert.ok(!bug, `${line}\n${bug?.text}`);
  }
});
