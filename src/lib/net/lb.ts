// A load balancer in front of a pool, simulated request by request in
// simulated time - no timers, so a batch of 30 is deterministic and testable.
//
// Two algorithms, as NGINX documents them: round robin (the default), and
// least connections, which passes each request "to the server with the least
// number of active connections". The trap the mission is built on falls out
// of that definition: a crashed backend refuses instantly, so it never has an
// active connection, so least-connections keeps choosing it.

export type Algo = 'round-robin' | 'least-conn';
export type Backend = { name: string; pool: 'web' | 'api'; crashed: boolean; down: boolean; fails: number; passes: number; active: number[]; served: number; errors: number };
export type Result = { at: number; path: string; backend: string; status: number | 'refused' };

// Longer than the gap between arrivals, as real pages are: healthy backends
// are nearly always busy. At 0.35 s they were often idle, shared the ties, and
// the least-connections trap barely showed (web-2 took 47%, not most).
export const SERVE_S = 0.8;      // a healthy request takes this long
export const ARRIVE_S = 0.1;     // one new request every 100 ms
export const CHECK_EVERY_S = 0.5;
export const FALL = 2;           // failed checks before a backend is pulled
export const RISE = 2;           // passed checks before it is trusted again

export class Balancer {
  now = 0;
  rr = 0;
  algo: Algo = 'round-robin';
  healthChecks = false;
  layer: 'L4' | 'L7' = 'L4';
  apiRule = false;
  backends: Backend[];
  log: Result[] = [];
  private nextCheck = 0;

  constructor(scenario: 'dead' | 'routes') {
    const b = (name: string, pool: 'web' | 'api', crashed = false): Backend => ({ name, pool, crashed, down: false, fails: 0, passes: 0, active: [], served: 0, errors: 0 });
    this.backends = scenario === 'dead'
      ? [b('web-1', 'web'), b('web-2', 'web', true), b('web-3', 'web')]
      : [b('web-1', 'web'), b('web-2', 'web'), b('api-1', 'api')];
  }

  private check() {
    for (const be of this.backends) {
      if (be.crashed) { be.fails++; be.passes = 0; if (be.fails >= FALL) be.down = true; }
      else { be.passes++; be.fails = 0; if (be.down && be.passes >= RISE) be.down = false; }
    }
  }

  private candidates(path: string): Backend[] {
    // Only an L7 balancer reads the request, so only it can route by path. At
    // L4 it sees an address and a port, and every backend is a candidate.
    let pool = this.backends;
    if (this.layer === 'L7' && this.apiRule) pool = pool.filter((b) => (path.startsWith('/api') ? b.pool === 'api' : b.pool === 'web'));
    if (this.healthChecks) { const up = pool.filter((b) => !b.down); if (up.length) pool = up; }
    return pool;
  }

  private pick(pool: Backend[]): Backend {
    for (const b of pool) b.active = b.active.filter((end) => end > this.now);
    if (this.algo === 'least-conn') {
      const least = Math.min(...pool.map((b) => b.active.length));
      pool = pool.filter((b) => b.active.length === least);
    }
    // Ties, and plain round robin, take turns in pool order.
    const b = pool[this.rr % pool.length];
    this.rr++;
    return b;
  }

  send(path: string): Result {
    if (this.healthChecks) while (this.nextCheck <= this.now) { this.check(); this.nextCheck += CHECK_EVERY_S; }
    const be = this.pick(this.candidates(path));
    let status: Result['status'];
    if (be.crashed) status = 'refused';
    else {
      be.active.push(this.now + SERVE_S);
      // A web server has no /api, and the API has no home page.
      status = (path.startsWith('/api') ? be.pool === 'api' : be.pool === 'web') ? 200 : 404;
    }
    if (status !== 200) be.errors++;
    be.served++;
    const r = { at: this.now, path, backend: be.name, status };
    this.log.push(r);
    this.now = Math.round((this.now + ARRIVE_S) * 1000) / 1000;
    return r;
  }

  // Every fourth request in the routes scenario is an API call. Not every
  // third: with three backends, round robin then delivered each API call to
  // api-1 by coincidence and blind balancing looked like routing.
  batch(n = 30, scenario: 'dead' | 'routes' = 'dead'): Result[] {
    return Array.from({ length: n }, (_, i) => this.send(scenario === 'routes' && i % 4 === 3 ? '/api/orders' : '/'));
  }
}

export const errorRate = (rs: Result[]) => rs.length ? rs.filter((r) => r.status !== 200).length / rs.length : 0;
export const share = (rs: Result[], name: string) => rs.length ? rs.filter((r) => r.backend === name).length / rs.length : 0;
