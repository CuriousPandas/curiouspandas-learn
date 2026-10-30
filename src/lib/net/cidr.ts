// IPv4 addresses and CIDR blocks as plain 32-bit numbers. An address is four
// bytes; a /n block is every address that shares its first n bits (RFC 4632).
// Unsigned arithmetic throughout: JavaScript's bitwise operators return signed
// 32-bit numbers, so anything above 127.255.255.255 came out negative until
// every result went through >>> 0.

export function parseIp(text: string): number {
  const parts = text.trim().split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255))
    throw new Error(`"${text.trim()}" is not an IPv4 address (four numbers 0-255, separated by dots)`);
  return parts.reduce((n, p) => ((n << 8) | Number(p)) >>> 0, 0);
}

export const formatIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

export const maskOf = (prefix: number) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

export type Block = {
  input: string; prefix: number; network: number; broadcast: number; mask: number;
  size: number; first: number; last: number; usable: number; aligned: boolean;
};

export function parseCidr(text: string): Block {
  const m = text.trim().match(/^([^/]+)\/(\d{1,2})$/);
  if (!m) throw new Error(`"${text.trim()}" needs a prefix length, like 10.244.1.0/24`);
  const prefix = Number(m[2]);
  if (prefix > 32) throw new Error(`/${prefix} is not a prefix length: IPv4 has 32 bits`);
  const ip = parseIp(m[1]);
  const mask = maskOf(prefix);
  const network = (ip & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  const broadcast = (network + size - 1) >>> 0;
  // /31 and /32 have no network/broadcast pair to set aside (RFC 3021 for /31).
  const usable = prefix >= 31 ? size : size - 2;
  const first = prefix >= 31 ? network : network + 1;
  const last = prefix >= 31 ? broadcast : broadcast - 1;
  return { input: text.trim(), prefix, network, broadcast, mask, size, first, last, usable, aligned: ip === network };
}

export const contains = (b: Block, ip: number) => ((ip & b.mask) >>> 0) === b.network;
export const covers = (outer: Block, inner: Block) => outer.prefix <= inner.prefix && contains(outer, inner.network);
export const cidrText = (b: Block) => `${formatIp(b.network)}/${b.prefix}`;

// Special-purpose ranges a learner meets first (RFC 6890 keeps the full registry).
export const SPECIAL: { cidr: string; kind: 'private' | 'loopback' | 'link-local' | 'shared'; note: string; rfc: string }[] = [
  { cidr: '10.0.0.0/8', kind: 'private', note: 'private (home, office, cluster networks)', rfc: 'RFC 1918' },
  { cidr: '172.16.0.0/12', kind: 'private', note: 'private (note: 172.16 to 172.31 only)', rfc: 'RFC 1918' },
  { cidr: '192.168.0.0/16', kind: 'private', note: 'private (most home routers)', rfc: 'RFC 1918' },
  { cidr: '127.0.0.0/8', kind: 'loopback', note: 'loopback: this machine talking to itself', rfc: 'RFC 1122' },
  { cidr: '169.254.0.0/16', kind: 'link-local', note: 'link-local: "no DHCP answered", or a cloud metadata address', rfc: 'RFC 3927' },
  { cidr: '100.64.0.0/10', kind: 'shared', note: 'shared address space: carrier-grade NAT', rfc: 'RFC 6598' },
];

export function classify(ip: number) {
  const hit = SPECIAL.find((s) => contains(parseCidr(s.cidr), ip));
  return hit ?? { cidr: '', kind: 'public' as const, note: 'public: routable on the internet', rfc: '' };
}

// The bits, grouped by byte, with the network part marked: what "/24" means.
export function bits(ip: number, prefix: number): { bit: string; network: boolean }[] {
  return Array.from({ length: 32 }, (_, i) => ({ bit: String((ip >>> (31 - i)) & 1), network: i < prefix }));
}

// The cluster the mission is set in. kind's defaults: pods from 10.244.0.0/16,
// Services from 10.96.0.0/16, and the controller manager hands each node a
// /24 of the pod range (--node-cidr-mask-size defaults to 24).
export const CLUSTER = {
  podRange: '10.244.0.0/16',
  serviceRange: '10.96.0.0/16',
  nodes: [
    { name: 'control-plane', podCidr: '10.244.0.0/24', pods: ['10.244.0.5', '10.244.0.6'] },
    { name: 'worker', podCidr: '10.244.1.0/24', pods: ['10.244.1.4', '10.244.1.17', '10.244.1.200'] },
    { name: 'worker2', podCidr: '10.244.2.0/24', pods: ['10.244.2.8', '10.244.2.9'] },
  ],
};

export type RuleCheck = { coversTarget: boolean; leaks: string[]; block: Block | null; error: string | null };

// The mission's firewall rule: allow exactly the pods on `worker`. A rule that
// covers them is not enough - /16 does, and also lets every other pod in.
export function checkRule(text: string, target = 'worker'): RuleCheck {
  let block: Block;
  try { block = parseCidr(text); } catch (e) { return { coversTarget: false, leaks: [], block: null, error: (e as Error).message }; }
  const node = CLUSTER.nodes.find((n) => n.name === target)!;
  const coversTarget = node.pods.every((p) => contains(block, parseIp(p)));
  const leaks = CLUSTER.nodes.filter((n) => n.name !== target).flatMap((n) => n.pods.filter((p) => contains(block, parseIp(p))).map((p) => `${p} (${n.name})`));
  return { coversTarget, leaks, block, error: null };
}
