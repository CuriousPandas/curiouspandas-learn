// NetSim's missions, played start to finish the way a learner would and judged
// the way the panel judges them: in order, every step against the latest state,
// and no tick may be lost on the way. A mission elsewhere on the site once
// re-judged an early step after a later one changed it, and nobody could finish.
// Each mission's tempting shortcut is played too, and must not pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NET_MISSIONS, installController, policyGoal, type NetState } from '../src/lib/kube-net/missions.ts';
import { run } from '../src/lib/kube-net/kubectl.ts';

function ticks(id: string, s: NetState) {
  let n = 0;
  for (const st of NET_MISSIONS[id].steps) { if (!st.done(s)) break; n++; }
  return n;
}

type Act = string | ((s: NetState) => void);
function play(id: string, acts: Act[]) {
  const s = NET_MISSIONS[id].setup();
  let best = 0;
  const outs: string[] = [];
  for (const a of acts) {
    if (typeof a === 'string') outs.push(run(s.ctx, a).map((l) => l.text).join('\n'));
    else a(s);
    const n = ticks(id, s);
    assert.ok(n >= best, `${id}: a tick was lost after ${String(a)} (${best} -> ${n})`);
    best = n;
  }
  return { s, n: best, outs };
}
const all = (id: string) => NET_MISSIONS[id].steps.length;

test('every NetSim mission used by a lesson exists, and every mission is used', () => {
  const dir = join(import.meta.dirname, '..', 'src', 'content', 'lessons', 'kubernetes');
  const used = ['pods-and-services', 'cluster-dns', 'network-policies', 'ingress'].flatMap((l) => [...readFileSync(join(dir, `${l}.mdx`), 'utf8').matchAll(/<NetSim[^>]*mission="([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(used.sort(), Object.keys(NET_MISSIONS).sort());
});

test('net-services: played to the end', () => {
  const r = play('kube-net-services', [
    'kubectl get svc',
    'kubectl exec client -- curl -sS -m 5 http://web',
    'kubectl get endpointslices',
    `kubectl patch svc web -p '{"spec":{"ports":[{"port":80,"targetPort":8080}]}}'`,
    'kubectl exec client -- curl -sS -m 5 http://web',
    'curl http://172.18.0.3:30292',
    'kubectl create deployment web-green --image=panda/web:2.0 --replicas=2',
    'kubectl set selector svc web app=web-green',
    'kubectl exec client -- curl -sS -m 5 http://web',
  ]);
  assert.equal(r.n, all('kube-net-services'));
  assert.match(r.outs[1], /^curl: \(7\) Failed to connect to web port 80 after 3 ms: Could not connect to server\ncommand terminated with exit code 7$/);
  assert.match(r.outs.at(-1)!, /\(v2\.0\)/);
});

test('net-services: someone who fixes the port before ever curling is not stranded', () => {
  const r = play('kube-net-services', [
    'kubectl get svc', 'kubectl describe svc web',
    `kubectl patch svc web -p '{"spec":{"ports":[{"port":80,"targetPort":8080}]}}'`,
    'kubectl exec client -- curl -sS -m 5 http://web',
  ]);
  assert.equal(r.n, 4);
});

test('net-services: curling the pod IP directly, or a new Service, does not pass for the web Service', () => {
  const s = NET_MISSIONS['kube-net-services'].setup();
  const pod = s.ctx.net.podsIn('shop').find((p) => p.owner === 'web')!;
  for (const l of ['kubectl get svc', 'kubectl exec client -- curl -sS -m 5 http://web', 'kubectl get endpointslices', `kubectl exec client -- curl -sS -m 5 http://${pod.ip}:8080`,
    'kubectl expose deployment web --name=web2 --port=80 --target-port=8080', 'kubectl exec client -- curl -sS -m 5 http://web2']) run(s.ctx, l);
  assert.equal(ticks('kube-net-services', s), 3);
  // Blue/green by curling the green pods' own Service does not pass either.
  const g = NET_MISSIONS['kube-net-services'].setup();
  for (const l of ['kubectl get svc', 'kubectl exec client -- curl -sS -m 5 http://web', 'kubectl get endpointslices', `kubectl patch svc web -p '{"spec":{"ports":[{"port":80,"targetPort":8080}]}}'`, 'kubectl exec client -- curl -sS -m 5 http://web', 'curl http://172.18.0.3:30292',
    'kubectl create deployment web-green --image=panda/web:2.0', 'kubectl expose deployment web-green --port=80 --target-port=8080', 'kubectl exec client -- curl -sS -m 5 http://web-green']) run(g.ctx, l);
  assert.equal(ticks('kube-net-services', g), 5);
});

test('net-dns: played to the end', () => {
  const r = play('kube-net-dns', [
    'kubectl exec client -- curl -sS -m 5 http://web',
    'kubectl exec client -- curl -sS -m 5 http://web.shop',
    'kubectl exec client -- nslookup web.shop',
    'kubectl exec client -- nslookup web.shop.svc.cluster.local',
    'kubectl exec client -- nslookup web-pods.shop.svc.cluster.local',
    'kubectl -n kube-system scale deployment coredns --replicas=0',
    'kubectl exec client -- curl -sS -m 5 http://web.shop',
    'kubectl exec client -- curl -sS -m 5 http://10.96.98.211',
    'kubectl -n kube-system scale deployment coredns --replicas=2',
    'kubectl exec client -- curl -sS -m 5 http://web.shop',
  ]);
  assert.equal(r.n, all('kube-net-dns'));
  assert.equal(r.outs[0], 'curl: (6) Could not resolve host: web\ncommand terminated with exit code 6');
  // busybox's nslookup does not search for a dotted name: measured on 1.36.1.
  assert.match(r.outs[2], /\*\* server can't find web\.shop: NXDOMAIN/);
});

test('net-dns: bringing DNS back without ever trying the IP does not finish', () => {
  const s = NET_MISSIONS['kube-net-dns'].setup();
  for (const l of ['kubectl exec client -- curl -sS -m 5 http://web', 'kubectl exec client -- curl -sS -m 5 http://web.shop', 'kubectl exec client -- nslookup web.shop.svc.cluster.local',
    'kubectl exec client -- nslookup web-pods.shop.svc.cluster.local', 'kubectl -n kube-system scale deployment coredns --replicas=0', 'kubectl exec client -- curl -sS -m 5 http://web.shop',
    'kubectl -n kube-system scale deployment coredns --replicas=2', 'kubectl exec client -- curl -sS -m 5 http://web.shop']) run(s.ctx, l);
  assert.equal(ticks('kube-net-dns', s), 5);
});

const FIXED = (src: string) => src.replace('app: CHANGE-ME\n    ports:\n    - protocol: TCP\n      port: 8080\n---', 'app: web\n    ports:\n    - protocol: TCP\n      port: 8080\n---').replace(/app: CHANGE-ME/, 'app: api');

test('net-policy: played to the end, and the goal holds whether or not anything enforces it', () => {
  const r = play('kube-net-policy', [
    'kubectl exec client -- curl -sS -m 5 http://api',
    'kubectl apply -f deny-all.yaml',
    'kubectl exec client -- curl -sS -m 5 http://api',
    'kubectl apply -f allow-dns.yaml',
    'kubectl exec client -- curl -sS -m 5 http://api',
    (s) => { s.ctx.files['web-to-api.yaml'] = FIXED(s.ctx.files['web-to-api.yaml']); },
    'kubectl apply -f web-to-api.yaml',
    'kubectl exec deploy/web -- curl -sS -m 5 http://api',
    'kubectl exec client -- curl -sS -m 5 http://api',
    (s) => { s.ctx.net.enforcing = false; },
    'kubectl exec client -- curl -sS -m 5 http://api',
  ]);
  assert.equal(r.n, all('kube-net-policy'));
  // Real on tilt with -m 5 and egress denied: the resolver's ~5 s outlasts curl's timer.
  assert.equal(r.outs[2], 'curl: (28) Resolving timed out after 5003 milliseconds\ncommand terminated with exit code 28');
  assert.equal(r.outs[4], 'curl: (28) Connection timed out after 5032 milliseconds\ncommand terminated with exit code 28');
  assert.match(r.outs[5], /^networkpolicy\.networking\.k8s\.io\/api-from-web created\nnetworkpolicy\.networking\.k8s\.io\/web-to-api created$/);
  assert.match(r.outs[6], /served_by/);
  assert.match(r.outs[7], /\(28\)/);
  assert.match(r.outs[8], /served_by/);
});

test('net-policy: the shortcuts fail step 4', () => {
  const base = ['kubectl exec client -- curl -sS -m 5 http://api', 'kubectl apply -f deny-all.yaml', 'kubectl exec client -- curl -sS -m 5 http://api', 'kubectl apply -f allow-dns.yaml', 'kubectl exec client -- curl -sS -m 5 http://api'];
  // Deleting deny-all makes web -> api work, and lets the client in too.
  const a = NET_MISSIONS['kube-net-policy'].setup();
  for (const l of [...base, 'kubectl delete netpol default-deny allow-dns', 'kubectl exec deploy/web -- curl -sS -m 5 http://api']) run(a.ctx, l);
  assert.equal(ticks('kube-net-policy', a), 3);
  // Allowing api in from every pod in the namespace lets the client in.
  const b = NET_MISSIONS['kube-net-policy'].setup();
  for (const l of base) run(b.ctx, l);
  b.ctx.files['open.yaml'] = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: open\nspec:\n  podSelector: {}\n  ingress:\n  - {}\n  egress:\n  - {}\n';
  for (const l of ['kubectl apply -f open.yaml', 'kubectl exec deploy/web -- curl -sS -m 5 http://api']) run(b.ctx, l);
  assert.equal(ticks('kube-net-policy', b), 3);
  assert.match(NET_MISSIONS['kube-net-policy'].steps[3].why!(b), /client can still reach api/);
  // Only the ingress half: web's egress is still denied.
  const c = NET_MISSIONS['kube-net-policy'].setup();
  for (const l of base) run(c.ctx, l);
  c.ctx.files['half.yaml'] = FIXED(c.ctx.files['web-to-api.yaml']).split('---')[0];
  for (const l of ['kubectl apply -f half.yaml', 'kubectl exec deploy/web -- curl -sS -m 5 http://api']) run(c.ctx, l);
  assert.equal(ticks('kube-net-policy', c), 3);
  assert.equal(policyGoal(c.ctx.net).webToApi, false);
});

test('net-policy in the ambient mesh: the app port alone fails step 4, 15008 on both ends passes', () => {
  // The review's case: shop labelled ambient, egress 8080, ingress 8080 + 15008.
  // The sandbox once let web reach api with that; tilt timed it out.
  const base = ['kubectl label ns shop istio.io/dataplane-mode=ambient', 'kubectl exec client -- curl -sS -m 5 http://api', 'kubectl apply -f deny-all.yaml', 'kubectl exec client -- curl -sS -m 5 http://api', 'kubectl apply -f allow-dns.yaml', 'kubectl exec client -- curl -sS -m 5 http://api'];
  const withPorts = (src: string, ing: string, eg: string) => {
    const [a, b] = FIXED(src).split('---');
    return a.replace('      port: 8080\n', ing) + '---' + b.replace('      port: 8080\n', eg);
  };
  const P = (...ps: number[]) => ps.map((p) => `      port: ${p}\n`).join('    - protocol: TCP\n');
  const a = NET_MISSIONS['kube-net-policy'].setup();
  for (const l of base) run(a.ctx, l);
  assert.equal(ticks('kube-net-policy', a), 3);
  a.ctx.files['web-to-api.yaml'] = withPorts(a.ctx.files['web-to-api.yaml'], P(8080, 15008), P(8080));
  const out = run(a.ctx, 'kubectl apply -f web-to-api.yaml').map((l) => l.text).join('\n');
  assert.match(out, /api-from-web created/);
  assert.match(run(a.ctx, 'kubectl exec deploy/web -- curl -sS -m 5 http://api').map((l) => l.text).join('\n'), /\(28\) Operation timed out .* with 0 bytes received/);
  assert.equal(ticks('kube-net-policy', a), 3);
  assert.match(NET_MISSIONS['kube-net-policy'].steps[3].why!(a), /port 15008/);
  // Right: 15008 on both ends, with the app port kept.
  const b = NET_MISSIONS['kube-net-policy'].setup();
  for (const l of base) run(b.ctx, l);
  b.ctx.files['web-to-api.yaml'] = withPorts(b.ctx.files['web-to-api.yaml'], P(8080, 15008), P(8080, 15008));
  for (const l of ['kubectl apply -f web-to-api.yaml', 'kubectl exec deploy/web -- curl -sS -m 5 http://api']) run(b.ctx, l);
  assert.equal(ticks('kube-net-policy', b), 4);
  for (const l of ['kubectl exec client -- curl -sS -m 5 http://api']) run(b.ctx, l);
  b.ctx.net.enforcing = false;
  run(b.ctx, 'kubectl exec client -- curl -sS -m 5 http://api');
  assert.equal(ticks('kube-net-policy', b), all('kube-net-policy'));
  // Differently shaped and also right: 15008 only on both ends (real: enough on tilt).
  const c = NET_MISSIONS['kube-net-policy'].setup();
  for (const l of base) run(c.ctx, l);
  c.ctx.files['web-to-api.yaml'] = withPorts(c.ctx.files['web-to-api.yaml'], P(15008), P(15008));
  for (const l of ['kubectl apply -f web-to-api.yaml', 'kubectl exec deploy/web -- curl -sS -m 5 http://api']) run(c.ctx, l);
  assert.equal(ticks('kube-net-policy', c), 4);
  // In the mesh, step 2's symptom is a connect timeout: ztunnel answered the name.
  const d = NET_MISSIONS['kube-net-policy'].setup();
  const outs = base.slice(0, 4).map((l) => run(d.ctx, l).map((x) => x.text).join('\n'));
  assert.equal(outs[3], 'curl: (28) Operation timed out after 5032 milliseconds with 0 bytes received\ncommand terminated with exit code 28');
});

test('net-policy: CHANGE-ME left in place applies, and selects nobody', () => {
  const s = NET_MISSIONS['kube-net-policy'].setup();
  const out = run(s.ctx, 'kubectl apply -f web-to-api.yaml').map((l) => l.text).join('\n');
  assert.match(out, /api-from-web created/);
  assert.equal(policyGoal(s.ctx.net).webToApi, false);
});

test('net-ingress: played to the end', () => {
  const r = play('kube-net-ingress', [
    `kubectl create ingress shop --rule='shop.localhost/*=web:80'`,
    'kubectl get ingress',
    'curl http://shop.localhost',
    installController,
    'kubectl get ingressclass',
    'kubectl get ingress',
    `kubectl patch ingress shop -p '{"spec":{"ingressClassName":"panda"}}'`,
    'curl http://shop.localhost',
  ]);
  assert.equal(r.n, all('kube-net-ingress'));
  assert.match(r.outs[1], /^NAME   CLASS    HOSTS            ADDRESS   PORTS   AGE\nshop   <none>   shop\.localhost             80      \d+s$/);
  assert.equal(r.outs[2], 'curl: (7) Failed to connect to shop.localhost port 80 after 3 ms: Could not connect to server');
  // With the controller installed, the class-less Ingress is still unclaimed.
  assert.match(r.outs[4], /^NAME   CLASS    HOSTS            ADDRESS   PORTS   AGE\nshop   <none>   shop\.localhost             80 /);
  assert.match(r.outs.at(-1)!, /hello from web-/);
});

test('net-ingress: an Ingress created after the class is made default gets it; the old one does not', () => {
  const s = NET_MISSIONS['kube-net-ingress'].setup();
  run(s.ctx, `kubectl create ingress shop --rule='shop.localhost/*=web:80'`);
  installController(s);
  s.ctx.net.classes.get('panda')!.isDefault = true;
  run(s.ctx, `kubectl create ingress shop2 --rule='shop2.localhost/*=web:80'`);
  const out = run(s.ctx, 'kubectl get ingress').map((l) => l.text).join('\n');
  assert.match(out, /\nshop {4}<none> {3}shop\.localhost {16}80 /);
  assert.match(out, /\nshop2 {3}panda {4}shop2\.localhost {3}localhost {3}80 /);
});
