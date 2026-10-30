import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockList } from 'node:net';
import { parseIp, formatIp, parseCidr, contains, classify, checkRule, bits } from '../src/lib/net/cidr.ts';
import { connect, ssListen, type Server } from '../src/lib/net/tcp.ts';
import { Dns, OLD_IP, NEW_IP } from '../src/lib/net/dns.ts';
import { Balancer, errorRate, share } from '../src/lib/net/lb.ts';

// ---- addresses and subnets -------------------------------------------------

test('a /24 around a pod address: network, broadcast, 254 usable', () => {
  const b = parseCidr('10.244.1.37/24');
  assert.equal(formatIp(b.network), '10.244.1.0');
  assert.equal(formatIp(b.broadcast), '10.244.1.255');
  assert.equal(formatIp(b.mask), '255.255.255.0');
  assert.equal(b.usable, 254);
  assert.equal(b.aligned, false);
  assert.equal(parseCidr('10.244.0.0/16').size, 65536);
});

test('/31 and /32 set nothing aside; /0 is the whole space', () => {
  assert.equal(parseCidr('192.0.2.0/31').usable, 2);
  assert.equal(parseCidr('192.0.2.7/32').usable, 1);
  assert.equal(parseCidr('0.0.0.0/0').size, 2 ** 32);
});

test('addresses above 127.255.255.255 stay positive (signed 32-bit bitwise ops made them negative)', () => {
  assert.equal(parseIp('255.255.255.255'), 4294967295);
  assert.equal(formatIp(parseIp('203.0.113.10')), '203.0.113.10');
  assert.equal(parseCidr('192.168.0.0/16').network, parseIp('192.168.0.0'));
});

test('bad input is refused by name, not misread', () => {
  assert.throws(() => parseIp('10.244.1'), /not an IPv4 address/);
  assert.throws(() => parseIp('10.244.1.256'), /not an IPv4 address/);
  assert.throws(() => parseCidr('10.244.1.0'), /prefix length/);
  assert.throws(() => parseCidr('10.0.0.0/33'), /32 bits/);
});

test('containment agrees with node:net BlockList across random addresses and prefixes', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0);
  for (let i = 0; i < 4000; i++) {
    const net = formatIp(rnd()), prefix = rnd() % 33, ip = formatIp(rnd() % 2 ? rnd() : (parseIp(net) ^ (rnd() % 256)) >>> 0);
    const bl = new BlockList();
    bl.addSubnet(formatIp(parseCidr(`${net}/${prefix}`).network), prefix, 'ipv4');
    assert.equal(contains(parseCidr(`${net}/${prefix}`), parseIp(ip)), bl.check(ip, 'ipv4'), `${ip} in ${net}/${prefix}`);
  }
});

test('private ranges are exactly RFC 1918 - 172.16/12 stops at 172.31', () => {
  assert.equal(classify(parseIp('10.0.0.1')).kind, 'private');
  assert.equal(classify(parseIp('172.31.255.255')).kind, 'private');
  assert.equal(classify(parseIp('172.32.0.1')).kind, 'public');
  assert.equal(classify(parseIp('192.168.1.1')).kind, 'private');
  assert.equal(classify(parseIp('127.0.0.1')).kind, 'loopback');
  assert.equal(classify(parseIp('169.254.169.254')).kind, 'link-local');
  assert.equal(classify(parseIp('100.64.0.1')).kind, 'shared');
  assert.equal(classify(parseIp('8.8.8.8')).kind, 'public');
});

test('bits mark the network part', () => {
  const b = bits(parseIp('10.244.1.37'), 24);
  assert.equal(b.filter((x) => x.network).length, 24);
  assert.equal(b.map((x) => x.bit).join(''), '00001010111101000000000100100101');
});

test('mission: /16 covers the worker but lets every other pod in; /24 is exact', () => {
  const wide = checkRule('10.244.0.0/16');
  assert.equal(wide.coversTarget, true);
  assert.ok(wide.leaks.length > 0, 'the tempting fix must not pass');
  const exact = checkRule('10.244.1.0/24');
  assert.equal(exact.coversTarget, true);
  assert.deepEqual(exact.leaks, []);
  assert.equal(checkRule('10.244.1.0/25').coversTarget, false, '10.244.1.200 is outside /25');
  assert.ok(checkRule('10.244.0.0/23').leaks.some((l) => l.includes('control-plane')));
  assert.match(checkRule('10.244.1.0').error ?? '', /prefix length/);
});

// ---- TCP -------------------------------------------------------------------

const srv = (over: Partial<Server> = {}): Server => ({ running: true, bind: '0.0.0.0', port: 8080, firewall: 'allow', ...over });

test('listening on all addresses: the three-way handshake', () => {
  const a = connect(srv(), 'other', 8080);
  assert.equal(a.outcome, 'connected');
  assert.deepEqual(a.packets.map((p) => p.flags), ['SYN', 'SYN, ACK', 'ACK']);
  assert.equal(a.exit, 0);
});

test('bound to 127.0.0.1: the same machine connects, another is refused - fast', () => {
  assert.equal(connect(srv({ bind: '127.0.0.1' }), 'same', 8080).outcome, 'connected');
  const a = connect(srv({ bind: '127.0.0.1' }), 'other', 8080);
  assert.equal(a.outcome, 'refused');
  assert.equal(a.exit, 7);
  assert.match(a.packets.at(-1)!.flags, /RST/);
  assert.ok(a.ms < 50);
  assert.match(a.curl, /^curl: \(7\) Failed to connect to 10\.0\.0\.5 port 8080 after \d+ ms: Could not connect to server$/);
});

test('wrong port and stopped program are refusals too', () => {
  assert.equal(connect(srv(), 'other', 80).outcome, 'refused');
  assert.equal(connect(srv({ running: false }), 'other', 8080).outcome, 'refused');
  assert.deepEqual(ssListen(srv({ running: false })).length, 1);
  assert.match(ssListen(srv({ bind: '127.0.0.1' }))[1], /LISTEN .*127\.0\.0\.1:8080/);
});

test('a dropping firewall: retransmits at 1 s then 3 s, then curl gives up with 28', () => {
  const a = connect(srv({ firewall: 'drop' }), 'other', 8080, 5);
  assert.equal(a.outcome, 'timeout');
  assert.deepEqual(a.packets.map((p) => p.t), [0, 1000, 3000]);
  assert.equal(a.exit, 28);
  assert.match(a.curl, /^curl: \(28\) Connection timed out after 5002 milliseconds$/);
});

test('a rejecting firewall looks like nothing listening; loopback skips the firewall', () => {
  const r = connect(srv({ firewall: 'reject' }), 'other', 8080);
  assert.equal(r.outcome, 'refused');
  assert.match(r.packets.at(-1)!.flags, /ICMP/);
  assert.equal(connect(srv({ firewall: 'drop' }), 'same', 8080).outcome, 'connected');
});

// ---- DNS -------------------------------------------------------------------

test('first lookup walks root, TLD, zone; the second comes from cache with less TTL', () => {
  const d = new Dns();
  assert.equal(d.lookup().hops.length, 3);
  d.wait(600);
  const again = d.lookup();
  assert.equal(again.fromCache, true);
  assert.equal(again.hops.length, 0);
  assert.equal(again.ttlLeft, 3000);
});

test('a changed record keeps resolving to the old address until the TTL runs out', () => {
  const d = new Dns();
  d.lookup();
  d.moveTo();
  const stale = d.lookup();
  assert.equal(stale.answer, OLD_IP);
  assert.equal(stale.stale, true);
  d.wait(3600);
  assert.equal(d.lookup().answer, NEW_IP);
});

test('mission: switching off the old server right after the move strands an hour of caches', () => {
  const d = new Dns();
  d.moveTo();
  assert.equal(d.staleWindow(), 3600);
  assert.equal(d.shutDownOld().safe, false);
});

test('mission: lowering the TTL only helps once the old TTL has passed', () => {
  const rushed = new Dns();
  rushed.setTtl(60); rushed.moveTo();
  assert.equal(rushed.staleWindow(), 3600, 'lowered and moved at once: caches still hold the 1-hour answer');
  const planned = new Dns();
  planned.setTtl(60); planned.wait(3600); planned.moveTo();
  assert.equal(planned.staleWindow(), 60);
  planned.wait(60);
  assert.equal(planned.shutDownOld().safe, true);
});

test('before any move there is no safe moment to switch off', () => {
  assert.equal(new Dns().staleWindow(), Infinity);
});

// ---- load balancing ----------------------------------------------------------

test('round robin with a crashed backend: one request in three fails', () => {
  const lb = new Balancer('dead');
  const rs = lb.batch(30);
  assert.equal(errorRate(rs), 1 / 3);
});

test('least connections makes it worse: the crashed backend is never busy, so it wins', () => {
  const rr = errorRate(new Balancer('dead').batch(30));
  const lb = new Balancer('dead');
  lb.algo = 'least-conn';
  const rs = lb.batch(30);
  assert.ok(share(rs, 'web-2') > 0.5, `web-2 got ${share(rs, 'web-2')}`);
  assert.ok(errorRate(rs) > rr);
});

test('health checks pull the crashed backend: the next batch has no errors', () => {
  for (const algo of ['round-robin', 'least-conn'] as const) {
    const lb = new Balancer('dead');
    lb.algo = algo; lb.healthChecks = true;
    lb.batch(30);
    assert.equal(lb.backends[1].down, true);
    assert.equal(errorRate(lb.batch(30)), 0, algo);
  }
});

test('a recovered backend comes back only after it passes checks again', () => {
  const lb = new Balancer('dead');
  lb.healthChecks = true;
  lb.batch(30);
  lb.backends[1].crashed = false;
  lb.send('/');
  assert.equal(lb.backends[1].down, true, 'one pass is not enough');
  lb.batch(10);
  assert.equal(lb.backends[1].down, false);
});

test('routing by path needs L7 and a rule; an L4 balancer cannot see the path', () => {
  const l4 = new Balancer('routes');
  assert.ok(errorRate(l4.batch(30, 'routes')) > 0);
  const l7 = new Balancer('routes');
  l7.layer = 'L7';
  assert.ok(errorRate(l7.batch(30, 'routes')) > 0, 'L7 without a rule still spreads blindly');
  l7.apiRule = true;
  const rs = l7.batch(30, 'routes');
  assert.equal(errorRate(rs), 0);
  assert.ok(rs.filter((r) => r.path.startsWith('/api')).every((r) => r.backend === 'api-1'));
  const l4rule = new Balancer('routes');
  l4rule.apiRule = true;
  assert.ok(errorRate(l4rule.batch(30, 'routes')) > 0, 'a rule an L4 balancer cannot read does nothing');
});
