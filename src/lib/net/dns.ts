// One name, one recursive resolver with a cache, and the servers it asks.
// A full lookup walks root -> TLD -> the zone's own server (RFC 1034 5.3.3);
// the answer is then cached for its TTL, the seconds a record "may be cached
// before it should be discarded" (RFC 1035 4.1.3). Changing a record changes
// the zone's server only: every cache keeps the old answer until it expires.

export const NAME = 'shop.bamboo.example';
export const OLD_IP = '203.0.113.10';
export const NEW_IP = '203.0.113.20';

export type Hop = { server: string; asked: string; said: string };
export type Lookup = { at: number; answer: string; fromCache: boolean; ttlLeft: number; hops: Hop[]; stale: boolean };

export class Dns {
  now = 0;
  zone = { ip: OLD_IP, ttl: 3600 };
  // What this resolver remembers: the answer and when it stops trusting it.
  cache: { ip: string; expires: number } | null = null;
  changedAt: number | null = null;
  oldServerUp = true;
  log: Lookup[] = [];
  // Every TTL the zone has handed out, and from when. Other resolvers asked
  // at moments we cannot see, so the safe moment to switch off the old server
  // depends on all of them, not just this one.
  private ttls: { from: number; ttl: number }[] = [{ from: -Infinity, ttl: 3600 }];

  lookup(): Lookup {
    const c = this.cache;
    let l: Lookup;
    if (c && c.expires > this.now) {
      l = { at: this.now, answer: c.ip, fromCache: true, ttlLeft: c.expires - this.now, hops: [], stale: false };
    } else {
      const hops: Hop[] = [
        { server: 'a root server', asked: `${NAME} A?`, said: 'not mine - ask the .example servers' },
        { server: '.example servers', asked: `${NAME} A?`, said: 'not mine - ask ns1.bamboo.example' },
        { server: 'ns1.bamboo.example', asked: `${NAME} A?`, said: `${this.zone.ip}, cache it for ${this.zone.ttl} s` },
      ];
      this.cache = { ip: this.zone.ip, expires: this.now + this.zone.ttl };
      l = { at: this.now, answer: this.zone.ip, fromCache: false, ttlLeft: this.zone.ttl, hops, stale: false };
    }
    l.stale = l.answer !== this.zone.ip;
    this.log.push(l);
    return l;
  }

  wait(seconds: number) { this.now += seconds; }

  // Takes effect for the next cache fill only. An answer already cached keeps
  // the TTL it was given - which is why TTLs are lowered well ahead of a move.
  setTtl(seconds: number) {
    this.zone.ttl = seconds;
    this.ttls.push({ from: this.now, ttl: seconds });
  }

  moveTo(ip = NEW_IP) {
    if (this.zone.ip === ip) return;
    this.zone.ip = ip;
    this.changedAt = this.now;
  }

  // The last moment any resolver anywhere could still hand out the old
  // address: one that asked at moment q kept it until q + (TTL in force at q).
  // Within each stretch of one TTL, the latest asker wins.
  lastStaleMoment(): number {
    const until = this.changedAt ?? this.now;
    let last = -Infinity;
    this.ttls.forEach((p, i) => {
      if (p.from >= until) return;
      const end = Math.min(this.ttls[i + 1]?.from ?? Infinity, until);
      last = Math.max(last, end + p.ttl);
    });
    return last;
  }

  // Seconds from now until no cache can hold the old address. Infinite
  // before the record has even moved.
  staleWindow(): number {
    if (this.changedAt === null) return Infinity;
    return Math.max(0, this.lastStaleMoment() - this.now);
  }

  shutDownOld(): { safe: boolean; stillCached: number } {
    const w = this.staleWindow();
    this.oldServerUp = false;
    return { safe: w === 0, stillCached: w };
  }
}
