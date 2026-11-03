// A cluster's network, for the networking lessons: pods with IPs, Services and
// the EndpointSlices computed from them, cluster DNS, NetworkPolicy and Ingress.
// Nothing here runs on a clock: every change takes effect at once, where a real
// cluster takes a second or two. The lessons say so.
//
// Separate from src/lib/kube/ on purpose. That model is about scheduling and
// restarts and changes under another lesson batch; this one is about where a
// packet goes. The shapes it prints were copied from Kubernetes 1.36.1 (kind,
// kindnet, kube-proxy) with kubectl 1.37.2, and tests/kube-net.test.ts pins them.

import { parseIp, parseCidr, contains, formatIp } from '../net/cidr.ts';

export type Labels = Record<string, string>;
export type Expr = { key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values?: string[] };
export type Selector = { matchLabels?: Labels; matchExpressions?: Expr[] };

export type Image = { listen: number; portName: string; body: (pod: Pod) => string };
// Images the sandbox knows. panda/web answers on 8080 like podinfo answers on
// 9898, including podinfo's POST /readyz/disable, which fails the readiness
// probe without restarting anything.
export const IMAGES: Record<string, Image> = {
  'panda/web:1.0': { listen: 8080, portName: 'http', body: (p) => `hello from ${p.name} (v1.0)` },
  'panda/web:2.0': { listen: 8080, portName: 'http', body: (p) => `hello from ${p.name} (v2.0)` },
  'panda/api:1.0': { listen: 8080, portName: 'http', body: (p) => `{"orders": 3, "served_by": "${p.name}"}` },
  'curlimages/curl:8.11.1': { listen: 0, portName: '', body: () => '' },
  'busybox:1.36': { listen: 0, portName: '', body: () => '' },
};

export type Pod = { name: string; ns: string; labels: Labels; ip: string; node: string; image: string; ready: boolean; owner?: string; created: number };
export type Deployment = { name: string; ns: string; image: string; replicas: number; labels: Labels; hash: string; created: number };
export type SvcPort = { name?: string; port: number; targetPort: number | string; nodePort?: number; protocol: 'TCP' | 'UDP' };
export type Service = {
  name: string; ns: string; type: 'ClusterIP' | 'NodePort' | 'LoadBalancer'; clusterIP: string; selector: Labels | null;
  ports: SvcPort[]; externalIP?: string; labels: Labels; created: number; system?: boolean;
  /** Addresses written by hand rather than from a selector: the kubernetes Service's API server endpoint. */
  staticEndpoints?: { ip: string; port: number }[];
};
export type Peer = { podSelector?: Selector; namespaceSelector?: Selector; ipBlock?: { cidr: string; except?: string[] } };
export type PolicyPort = { protocol: 'TCP' | 'UDP'; port?: number | string; endPort?: number };
export type Rule = { peers: Peer[] | null; ports: PolicyPort[] | null };
export type Policy = { name: string; ns: string; podSelector: Selector; types: ('Ingress' | 'Egress')[]; ingress: Rule[]; egress: Rule[]; created: number; raw: unknown };
export type IngressPath = { path: string; pathType: string; service: string; port: number | string };
export type IngressRule = { host?: string; paths: IngressPath[] };
export type Ingress = { name: string; ns: string; className: string | null; rules: IngressRule[]; tls: { hosts: string[]; secretName?: string }[]; address: string; created: number; raw: unknown };
export type IngressClass = { name: string; controller: string; isDefault: boolean; created: number };

export const NODES = [
  { name: 'kind-control-plane', ip: '172.18.0.2', podCIDR: '10.244.0.0/24' },
  { name: 'kind-worker', ip: '172.18.0.3', podCIDR: '10.244.1.0/24' },
];
export const DNS_IP = '10.96.0.10';
export const CLUSTER_DOMAIN = 'cluster.local';
// Istio ambient's fixed probe source (istio.io/latest/docs/ambient/usage/networkpolicy/).
export const AMBIENT_PROBE_IP = '169.254.7.127';
export const HBONE_PORT = 15008;
export const AMBIENT_LABEL = 'istio.io/dataplane-mode';

/** A short, stable, lowercase-alphanumeric suffix, like the random ones Kubernetes makes. */
export function suffix(seed: string, len: number): string {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const alpha = 'bcdfghjklmnpqrstvwxz2456789';
  let out = '';
  for (let i = 0; i < len; i++) { h = Math.imul(h ^ (h >>> 13), 2246822519) >>> 0; out += alpha[h % alpha.length]; }
  return out;
}

export function selects(sel: Selector, labels: Labels): boolean {
  for (const [k, v] of Object.entries(sel.matchLabels ?? {})) if (labels[k] !== v) return false;
  for (const e of sel.matchExpressions ?? []) {
    const has = Object.prototype.hasOwnProperty.call(labels, e.key);
    if (e.operator === 'Exists' && !has) return false;
    if (e.operator === 'DoesNotExist' && has) return false;
    if (e.operator === 'In' && !(has && (e.values ?? []).includes(labels[e.key]))) return false;
    if (e.operator === 'NotIn' && has && (e.values ?? []).includes(labels[e.key])) return false;
  }
  return true;
}

export const selectorText = (s: Selector | Labels | null): string => {
  if (!s) return '<none>';
  const sel: Selector = 'matchLabels' in s || 'matchExpressions' in s ? s as Selector : { matchLabels: s as Labels };
  const parts = Object.entries(sel.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
  for (const e of sel.matchExpressions ?? []) {
    if (e.operator === 'Exists') parts.push(e.key);
    else if (e.operator === 'DoesNotExist') parts.push(`!${e.key}`);
    else parts.push(`${e.key} ${e.operator.toLowerCase()} (${(e.values ?? []).join(',')})`);
  }
  return parts.length ? parts.join(',') : '<none>';
};

export type Endpoint = { pod: Pod; ready: boolean };

/** What a connection attempt came to. `stage` says where it stopped, for missions and verdicts. */
export type Attempt =
  | { ok: true; body: string; pod: Pod; via?: Service }
  | { ok: false; stage: 'dns'; how: 'nxdomain' | 'timeout'; name: string }
  | { ok: false; stage: 'connect'; how: 'refused' | 'timeout'; why: string; pod?: Pod; via?: Service; policy?: 'egress' | 'ingress' };

export type Lookup = { name: string; tried: string[]; answer?: { fqdn: string; ips: string[] }; how?: 'nxdomain' | 'timeout'; ztunnel?: boolean };

export class Net {
  t = 0;
  namespaces = new Map<string, { labels: Labels; created: number }>();
  pods = new Map<string, Pod>();
  deployments = new Map<string, Deployment>();
  services = new Map<string, Service>();
  policies = new Map<string, Policy>();
  ingresses = new Map<string, Ingress>();
  classes = new Map<string, IngressClass>();
  secrets = new Set<string>();
  /** Whether the network plugin enforces NetworkPolicy. kindnet does since kind v0.24; plenty of plugins don't. */
  enforcing = true;
  /** Whether anything implements type: LoadBalancer. On kind, nothing does unless you install cloud-provider-kind. */
  lbController = false;
  corednsReplicas = 2;
  ingressController: { className: string; ip: string } | null = null;
  private nextIp = new Map<string, number>();
  private nextVip = 20;
  private nextNodePort = 30292;
  private nextLb = 240;

  constructor() {
    for (const ns of ['default', 'kube-system', 'kube-public', 'kube-node-lease']) this.addNamespace(ns);
    // CoreDNS: two pods behind the kube-dns Service, as kind ships it.
    for (let i = 0; i < 2; i++) this.addPod({ name: `coredns-668d6bf9bc-${suffix('coredns' + i, 5)}`, ns: 'kube-system', labels: { 'k8s-app': 'kube-dns' }, image: 'coredns', node: NODES[0].name, owner: 'coredns' });
    this.services.set('kube-system/kube-dns', {
      name: 'kube-dns', ns: 'kube-system', type: 'ClusterIP', clusterIP: DNS_IP, selector: { 'k8s-app': 'kube-dns' }, labels: { 'k8s-app': 'kube-dns', 'kubernetes.io/cluster-service': 'true', 'kubernetes.io/name': 'CoreDNS' },
      ports: [{ name: 'dns', port: 53, targetPort: 53, protocol: 'UDP' }, { name: 'dns-tcp', port: 53, targetPort: 53, protocol: 'TCP' }, { name: 'metrics', port: 9153, targetPort: 9153, protocol: 'TCP' }],
      created: 0, system: true,
    });
    // Labels and the API server endpoint as tilt shows them (1.36.1): the
    // kubernetes Service has no selector, and the API server writes its own
    // address into its Endpoints and EndpointSlice. An earlier version left
    // them empty, so `get endpoints -n default` said <none>.
    this.services.set('default/kubernetes', { name: 'kubernetes', ns: 'default', type: 'ClusterIP', clusterIP: '10.96.0.1', selector: null, labels: { component: 'apiserver', provider: 'kubernetes' }, ports: [{ name: 'https', port: 443, targetPort: 6443, protocol: 'TCP' }], created: 0, system: true, staticEndpoints: [{ ip: NODES[0].ip, port: 6443 }] });
  }

  tick(seconds = 3) { this.t += seconds; }

  addNamespace(name: string, labels: Labels = {}) {
    if (!this.namespaces.has(name)) this.namespaces.set(name, { labels: { 'kubernetes.io/metadata.name': name, ...labels }, created: this.t });
  }
  nsLabels(ns: string): Labels { return this.namespaces.get(ns)?.labels ?? {}; }
  inMesh(ns: string) { return this.nsLabels(ns)[AMBIENT_LABEL] === 'ambient'; }

  addPod(p: { name: string; ns: string; labels: Labels; image: string; node?: string; owner?: string }): Pod {
    const node = NODES.find((n) => n.name === (p.node ?? NODES[1].name))!;
    const n = this.nextIp.get(node.name) ?? (node === NODES[0] ? 2 : 5);
    this.nextIp.set(node.name, n + 1);
    const base = parseCidr(node.podCIDR).network;
    const pod: Pod = { name: p.name, ns: p.ns, labels: p.labels, ip: formatIp(base + n), node: node.name, image: p.image, ready: true, owner: p.owner, created: this.t };
    this.pods.set(`${p.ns}/${p.name}`, pod);
    return pod;
  }

  createDeployment(ns: string, name: string, image: string, replicas: number): Deployment {
    const d: Deployment = { name, ns, image, replicas, labels: { app: name }, hash: suffix(`${ns}/${name}/${image}`, 10).replace(/[a-z]/g, (c) => 'abcdef'[c.charCodeAt(0) % 6]), created: this.t };
    this.deployments.set(`${ns}/${name}`, d);
    this.reconcile(d);
    return d;
  }

  /** Brings a Deployment's pods to its replica count. Scaling down removes the newest first. */
  reconcile(d: Deployment) {
    const mine = [...this.pods.values()].filter((p) => p.ns === d.ns && p.owner === d.name);
    for (const p of mine.slice(d.replicas).reverse()) this.pods.delete(`${p.ns}/${p.name}`);
    for (let i = mine.length; i < d.replicas; i++) {
      this.addPod({ name: `${d.name}-${d.hash}-${suffix(`${d.ns}/${d.name}/${i}/${this.t}`, 5)}`, ns: d.ns, labels: { ...d.labels, 'pod-template-hash': d.hash }, image: d.image, owner: d.name });
    }
  }

  scaleCoreDns(n: number) {
    this.corednsReplicas = n;
    const mine = [...this.pods.values()].filter((p) => p.ns === 'kube-system' && p.owner === 'coredns');
    for (const p of mine.slice(n)) this.pods.delete(`${p.ns}/${p.name}`);
    for (let i = mine.length; i < n; i++) this.addPod({ name: `coredns-668d6bf9bc-${suffix('coredns' + i + this.t, 5)}`, ns: 'kube-system', labels: { 'k8s-app': 'kube-dns' }, image: 'coredns', node: NODES[0].name, owner: 'coredns' });
  }

  allocVip() { return `10.96.${Math.floor(this.nextVip / 250) + 100}.${(this.nextVip++ % 250) + 2}`; }
  allocNodePort() { return this.nextNodePort++; }
  allocLb() { return `172.18.0.${this.nextLb++}`; }

  /** Gives every LoadBalancer Service an address, if something implements them. */
  syncLoadBalancers() {
    for (const s of this.services.values()) {
      if (s.type !== 'LoadBalancer') { delete s.externalIP; continue; }
      if (this.lbController && !s.externalIP) s.externalIP = this.allocLb();
      if (!this.lbController) delete s.externalIP;
    }
  }

  podsIn(ns?: string) { return [...this.pods.values()].filter((p) => !ns || p.ns === ns); }
  pod(ns: string, name: string) { return this.pods.get(`${ns}/${name}`); }
  service(ns: string, name: string) { return this.services.get(`${ns}/${name}`); }
  podByIp(ip: string) { return [...this.pods.values()].find((p) => p.ip === ip); }
  nodeByIp(ip: string) { return NODES.find((n) => n.ip === ip); }

  /** The endpoints a Service's EndpointSlice would list: every selected pod, each marked ready or not. */
  endpoints(s: Service): Endpoint[] {
    if (!s.selector) return [];
    const sel = s.selector;
    return this.podsIn(s.ns).filter((p) => Object.keys(sel).length && selects({ matchLabels: sel }, p.labels)).map((pod) => ({ pod, ready: pod.ready }));
  }

  /** A Service port's target on a pod: a number, or a named container port looked up on that pod. */
  targetOn(sp: SvcPort, pod: Pod): number | null {
    if (typeof sp.targetPort === 'number') return sp.targetPort;
    const img = IMAGES[pod.image];
    return img && img.portName === sp.targetPort ? img.listen : null;
  }

  // ---- DNS ------------------------------------------------------------------

  searchList(ns: string) { return [`${ns}.svc.${CLUSTER_DOMAIN}`, `svc.${CLUSTER_DOMAIN}`, CLUSTER_DOMAIN]; }

  /** One exact query against CoreDNS's kubernetes plugin. Null is NXDOMAIN. */
  answer(fqdn: string): string[] | null {
    const n = fqdn.replace(/\.$/, '').toLowerCase();
    let m = /^([a-z0-9-]+)\.([a-z0-9-]+)\.svc\.cluster\.local$/.exec(n);
    if (m) {
      const s = this.service(m[2], m[1]);
      if (!s) return null;
      if (s.clusterIP === 'None') {
        const ips = this.endpoints(s).filter((e) => e.ready).map((e) => e.pod.ip);
        return ips.length ? ips : null;
      }
      return [s.clusterIP];
    }
    // "pods insecure" in kind's Corefile: any dashed IP under <ns>.pod answers itself.
    m = /^(\d+)-(\d+)-(\d+)-(\d+)\.([a-z0-9-]+)\.pod\.cluster\.local$/.exec(n);
    if (m && this.namespaces.has(m[5])) return [`${m[1]}.${m[2]}.${m[3]}.${m[4]}`];
    return null;
  }

  /**
   * Whether a pod's DNS query reaches CoreDNS. With no CoreDNS pods, kube-proxy
   * rejects the packet at once; with a policy in the way, it's dropped and the
   * resolver waits. Measured: busybox nslookup prints an extra "write to ...:
   * Connection refused" line only in the first case; curl says (6) either way.
   */
  dnsPath(from: Pod): 'ok' | 'refused' | 'dropped' {
    const dns = this.service('kube-system', 'kube-dns')!;
    const target = this.endpoints(dns).find((e) => e.ready);
    if (!target) return 'refused';
    return this.policyAllows(from, target.pod, 53, 'UDP').ok || !this.enforcing ? 'ok' : 'dropped';
  }
  dnsReachable(from: Pod): boolean { return this.dnsPath(from) === 'ok'; }

  /**
   * The candidate names a resolver tries, in order. `style` is the app's
   * resolver (curl, wget: search list first when the name has fewer than
   * ndots=5 dots, then the name itself), or busybox 1.36's nslookup, which,
   * as measured on 1.36.1, applies the search list only to names with no dot
   * at all and queries dotted names exactly as typed.
   */
  candidates(name: string, ns: string, style: 'app' | 'nslookup'): string[] {
    if (name.endsWith('.')) return [name.slice(0, -1)];
    const search = this.searchList(ns).map((d) => `${name}.${d}`);
    if (style === 'nslookup') return name.includes('.') ? [name] : search;
    const dots = name.split('.').length - 1;
    return dots < 5 ? [...search, name] : [name, ...search];
  }

  /**
   * What ztunnel's DNS proxy answers by itself for a pod in the ambient mesh.
   * Istio's docs: DNS proxying "is enabled by default in ambient mode from
   * Istio 1.25 onwards", and when the proxy can handle a request it "will
   * directly return a response to the application, avoiding a roundtrip to the
   * upstream DNS server". tilt's istio-cni-config has AMBIENT_DNS_CAPTURE "true".
   * Measured on tilt (Istio 1.28.3), under a default-deny egress: `web` (same
   * namespace), `hello.hello`, the full name, and a headless Service's short
   * name (answered with the pod IP) all resolved; a pod's dashed DNS name and
   * names that exist nowhere did not, because those go on to CoreDNS. Which
   * aliases ztunnel knows beyond those measured is not modelled: anything else
   * goes upstream here.
   */
  ztunnelAnswer(clientNs: string, name: string): { fqdn: string; ips: string[] } | null {
    const n = name.replace(/\.$/, '').toLowerCase();
    for (const s of this.services.values()) {
      const fqdn = `${s.name}.${s.ns}.svc.${CLUSTER_DOMAIN}`;
      if (n !== fqdn && n !== `${s.name}.${s.ns}` && !(n === s.name && s.ns === clientNs)) continue;
      const ips = this.answer(fqdn);
      return ips ? { fqdn, ips } : null;
    }
    return null;
  }

  lookup(from: Pod, name: string, style: 'app' | 'nslookup'): Lookup {
    const tried = this.candidates(name, from.ns, style);
    // The proxy sits in front of the policy: its answer never leaves the pod,
    // so a default-deny egress doesn't stop it (measured). An earlier version
    // sent mesh pods' queries through egress policy like any other, and so
    // reproduced "could not resolve host" where tilt resolves the name.
    const z = this.inMesh(from.ns) ? this.ztunnelAnswer(from.ns, name) : null;
    if (z) return { name, tried: tried.slice(0, 1), answer: z, ztunnel: true };
    if (!this.dnsReachable(from)) return { name, tried, how: 'timeout' };
    for (const c of tried) {
      const ips = this.answer(c);
      if (ips) return { name, tried: tried.slice(0, tried.indexOf(c) + 1), answer: { fqdn: c, ips } };
    }
    return { name, tried, how: 'nxdomain' };
  }

  // ---- NetworkPolicy --------------------------------------------------------

  policiesFor(pod: Pod, dir: 'Ingress' | 'Egress') {
    return [...this.policies.values()].filter((p) => p.ns === pod.ns && p.types.includes(dir) && selects(p.podSelector, pod.labels));
  }

  private peerMatches(peer: Peer, policyNs: string, other: { pod?: Pod; ip: string }): boolean {
    if (peer.ipBlock) {
      const ip = parseIp(other.ip);
      if (!contains(parseCidr(peer.ipBlock.cidr), ip)) return false;
      return !(peer.ipBlock.except ?? []).some((e) => contains(parseCidr(e), ip));
    }
    if (!other.pod) return false;
    const nsOk = peer.namespaceSelector ? selects(peer.namespaceSelector, this.nsLabels(other.pod.ns)) : other.pod.ns === policyNs;
    const podOk = peer.podSelector ? selects(peer.podSelector, other.pod.labels) : true;
    return nsOk && podOk;
  }

  private portMatches(pp: PolicyPort, port: number, proto: 'TCP' | 'UDP', dest: Pod) {
    if ((pp.protocol ?? 'TCP') !== proto) return false;
    if (pp.port === undefined) return true;
    if (typeof pp.port === 'string') {
      const img = IMAGES[dest.image];
      return !!img && img.portName === pp.port && img.listen === port;
    }
    return pp.endPort !== undefined ? port >= pp.port && port <= pp.endPort : port === pp.port;
  }

  private rulesAllow(rules: Rule[], policyNs: string, other: { pod?: Pod; ip: string }, port: number, proto: 'TCP' | 'UDP', dest: Pod) {
    return rules.some((r) =>
      (r.peers === null || r.peers.some((p) => this.peerMatches(p, policyNs, other))) &&
      (r.ports === null || r.ports.some((pp) => this.portMatches(pp, port, proto, dest))));
  }

  /**
   * What the policies say about one connection, whether or not anything
   * enforces them. Both ends must allow it: the source's egress and the
   * destination's ingress. A pod with no policy selecting it for a direction
   * is open in that direction.
   */
  policyAllows(src: Pod, dst: Pod, port: number, proto: 'TCP' | 'UDP'): { ok: boolean; side?: 'egress' | 'ingress' } {
    // In ambient mode, mesh-to-mesh traffic travels between the two pods on
    // HBONE port 15008, not the app's port, and that is the port both ends'
    // policies see: the destination's ingress (istio.io's ambient
    // NetworkPolicy page, and measured) and the source's egress (measured on
    // tilt, Istio 1.28.3, kindnet, fresh client pods: egress allowing only
    // 9898 timed out three times in three, adding 15008 gave 200, and 15008
    // alone gave 200). The Istio page discusses only inbound traffic. An
    // earlier version checked egress against the app port, so a rule tilt
    // drops passed here.
    const hbone = this.inMesh(src.ns) && this.inMesh(dst.ns) && dst.ns !== 'kube-system';
    const arrives = hbone ? HBONE_PORT : port;
    const eg = this.policiesFor(src, 'Egress');
    if (eg.length && !eg.some((p) => this.rulesAllow(p.egress, p.ns, { pod: dst, ip: dst.ip }, arrives, proto, dst))) return { ok: false, side: 'egress' };
    const ing = this.policiesFor(dst, 'Ingress');
    if (ing.length && !ing.some((p) => this.rulesAllow(p.ingress, p.ns, { pod: src, ip: src.ip }, arrives, proto, dst))) return { ok: false, side: 'ingress' };
    return { ok: true };
  }

  // ---- connections ----------------------------------------------------------

  /** Resolves a host as typed in a URL, from a pod. */
  resolve(from: Pod, host: string): { ips: string[] } | { fail: 'nxdomain' | 'timeout' } {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { ips: [host] };
    const l = this.lookup(from, host, 'app');
    return l.answer ? { ips: l.answer.ips } : { fail: l.how! };
  }

  /** Where a destination IP and port lead: a Service's endpoint, a node port, or a pod directly. */
  route(ip: string, port: number, rr = 0): { pod: Pod; port: number; via?: Service } | { none: string; via?: Service } {
    const svc = [...this.services.values()].find((s) => s.clusterIP === ip || (s.externalIP && s.externalIP === ip));
    const node = this.nodeByIp(ip);
    if (svc) {
      if (svc.staticEndpoints) return { none: 'apiserver', via: svc };
      const sp = svc.ports.find((p) => p.port === port && p.protocol === 'TCP');
      if (!sp) return { none: 'no such port on the Service', via: svc };
      return this.toEndpoint(svc, sp, rr);
    }
    if (node) {
      const hit = [...this.services.values()].map((s) => ({ s, sp: s.ports.find((p) => p.nodePort === port) })).find((x) => x.sp);
      if (!hit) return { none: 'nothing listens on that node port' };
      return this.toEndpoint(hit.s, hit.sp!, rr);
    }
    const pod = this.podByIp(ip);
    if (pod) return { pod, port };
    return { none: 'no route to that address' };
  }

  private toEndpoint(svc: Service, sp: SvcPort, rr: number) {
    const ready = this.endpoints(svc).filter((e) => e.ready);
    // kube-proxy rejects connections to a Service with no ready endpoints.
    if (!ready.length) return { none: 'the Service has no ready endpoints', via: svc };
    const ep = ready[rr % ready.length].pod;
    const tp = this.targetOn(sp, ep);
    if (tp === null) return { none: `the pod has no port named "${sp.targetPort}"`, via: svc };
    return { pod: ep, port: tp, via: svc };
  }

  private rr = 0;

  /** An HTTP request from a pod to host:port, as far as it gets. */
  connect(from: Pod, host: string, port: number): Attempt {
    const r = this.resolve(from, host);
    if ('fail' in r) return { ok: false, stage: 'dns', how: r.fail, name: host };
    const dest = this.route(r.ips[this.rr % r.ips.length], port, this.rr++);
    if ('none' in dest) return { ok: false, stage: 'connect', how: 'refused', why: dest.none, via: dest.via };
    const pol = this.policyAllows(from, dest.pod, dest.port, 'TCP');
    if (!pol.ok && this.enforcing) return { ok: false, stage: 'connect', how: 'timeout', why: `blocked by ${pol.side} policy`, pod: dest.pod, via: dest.via, policy: pol.side };
    const img = IMAGES[dest.pod.image];
    if (!img || img.listen !== dest.port) return { ok: false, stage: 'connect', how: 'refused', why: `nothing listens on ${dest.pod.ip}:${dest.port}`, pod: dest.pod, via: dest.via };
    return { ok: true, body: img.body(dest.pod), pod: dest.pod, via: dest.via };
  }
}
