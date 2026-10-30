import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disaster, cheapestCost, lastBackupBefore, WEDNESDAY_H, hm, clock } from '../src/lib/resilience/rpo.ts';
import { Office } from '../src/lib/resilience/backups.ts';
import { drill, cheapestPatternFor, PATTERNS, fmtMin } from '../src/lib/resilience/dr.ts';
import { trueMtd, tabletop, IDS, recoveryOrder, type BiaState } from '../src/lib/resilience/bia.ts';
import { staffing, postmortem, sevOk, FACTORS } from '../src/lib/resilience/incident.ts';
import { RPO_MISSION, BACKUP_MISSION, DR_MISSION, BIA_MISSION, INCIDENT_MISSION } from '../src/lib/resilience/missions.ts';
import type { Mission } from '../src/lib/missions.ts';

const doneUpTo = <S>(m: Mission<S>, s: S) => { let n = 0; for (const st of m.steps) { if (!st.done(s)) break; n++; } return n; };

// ---- RPO / RTO ---------------------------------------------------------------

test('a disaster at 14:50 on nightly 02:00 backups loses 12 h 50 min; the worst case is a full day', () => {
  const o = disaster('orders', 'nightly', 'restore', 14 + 50 / 60);
  assert.equal(hm(o.lostH), '12 h 50 min');
  assert.equal(o.worstLostH, 24);
  assert.equal(o.rpoMet, false);
  assert.equal(clock(14 + 50 / 60), '14:50');
});

test('just after a backup little is lost - which is why RPO is judged on the worst case', () => {
  const o = disaster('orders', 'nightly', 'restore', 2 + 10 / 60);
  assert.equal(hm(o.lostH), '10 min');
  assert.equal(o.rpoMet, false, 'one lucky disaster does not make nightly backups meet a 1-hour RPO');
});

test('weekly backups on Sunday 02:00 are three and a half days stale by Wednesday afternoon', () => {
  assert.equal(lastBackupBefore('weekly', WEDNESDAY_H + 14), 2);
  assert.equal(disaster('site', 'weekly', 'rebuild', 14).lostH, WEDNESDAY_H + 12);
});

test('the cheapest setup differs per system: orders needs hourly + runbook, payroll needs nightly + rebuild', () => {
  assert.equal(cheapestCost('orders'), 250);
  assert.equal(cheapestCost('payroll'), 40);
  assert.equal(disaster('orders', 'hourly', 'restore', 9).cheapest, true);
  assert.equal(disaster('payroll', 'nightly', 'rebuild', 9).cheapest, true);
});

test('rpo mission: buying everything meets the targets but not "for the least money"', () => {
  const s = RPO_MISSION.setup();
  s.outcomes.push(disaster('orders', 'nightly', 'restore', 14.8));
  s.outcomes.push(disaster('orders', 'quarter', 'standby', 14.8));
  assert.equal(doneUpTo(RPO_MISSION, s), 2);
  s.outcomes.push(disaster('orders', 'hourly', 'restore', 14.8));
  s.outcomes.push(disaster('payroll', 'quarter', 'standby', 14.8));
  assert.equal(doneUpTo(RPO_MISSION, s), 3, 'orders-grade protection is overkill for payroll');
  s.outcomes.push(disaster('payroll', 'nightly', 'rebuild', 14.8));
  assert.equal(doneUpTo(RPO_MISSION, s), 4);
});

// ---- backups -----------------------------------------------------------------

test('3-2-1 counts copies, media types and an offsite copy', () => {
  const o = new Office();
  assert.equal(o.rule321().met, false);
  o.toggle('usb', true); o.toggle('cloud', true);
  assert.deepEqual(o.rule321(), { copies: 3, media: 3, offsite: true, met: true });
});

test('a copy on the same disk dies with the disk', () => {
  const o = new Office();
  o.toggle('same-disk', true);
  assert.equal(o.hit('disk').survived, false);
  o.toggle('usb', true);
  assert.equal(o.hit('disk').from, 'usb');
});

test('ransomware: every reachable copy is lost, even many of them; only offline survives', () => {
  const o = new Office();
  for (const c of ['same-disk', 'usb', 'sync', 'cloud'] as const) o.toggle(c, true);
  o.fix(); // cannot fix before a drill
  const r = o.hit('ransomware');
  assert.equal(r.survived, false);
  assert.match(r.why, /admin login|could reach it/);
  o.toggle('offline', true);
  assert.equal(o.hit('ransomware').from, 'offline');
});

test('a working, versioned cloud backup still falls to ransomware: the admin login can delete it', () => {
  // The first version of the ransomware test only used the broken cloud job,
  // so it passed even when cloud backups were made unreachable.
  const o = new Office();
  o.toggle('cloud', true);
  o.drill(); o.fix();
  assert.equal(o.hit('disk').from, 'cloud', 'the fixed job really works');
  const r = o.hit('ransomware');
  assert.equal(r.survived, false);
  assert.match(r.why, /admin login/);
});

test('the broken cloud job: looks fine, fails late-delete until a drill finds and fixes it', () => {
  const o = new Office();
  o.toggle('cloud', true); o.toggle('offline', true); o.toggle('sync', true);
  assert.equal(o.hit('late-delete').survived, false, 'sync copied the deletion, offline is a week old, cloud is broken');
  assert.equal(o.canFix(), false, 'nobody knows it is broken yet');
  const lines = o.drill();
  assert.equal(lines.find((l) => l.copy === 'cloud')!.ok, false);
  o.fix();
  assert.equal(o.hit('late-delete').from, 'cloud');
});

test('backup mission in order, and more connected copies never pass the ransomware step', () => {
  const s = BACKUP_MISSION.setup();
  s.office.toggle('usb', true); s.office.hit('disk');
  s.office.toggle('sync', true); s.office.toggle('cloud', true); s.office.hit('ransomware');
  assert.equal(doneUpTo(BACKUP_MISSION, s), 1);
  s.office.toggle('offline', true); s.office.hit('ransomware');
  assert.equal(doneUpTo(BACKUP_MISSION, s), 2);
  s.office.hit('late-delete');
  assert.equal(doneUpTo(BACKUP_MISSION, s), 2, 'not before the drill');
  s.office.drill(); s.office.fix();
  assert.equal(doneUpTo(BACKUP_MISSION, s), 3);
  s.office.hit('late-delete');
  assert.equal(doneUpTo(BACKUP_MISSION, s), 4);
});

// ---- DR patterns -------------------------------------------------------------

test('the four patterns get costlier and faster in the whitepaper\'s order', () => {
  const ps = Object.values(PATTERNS);
  for (let i = 1; i < ps.length; i++) {
    assert.ok(ps[i].cost > ps[i - 1].cost);
    assert.ok(ps[i].rtoMin < ps[i - 1].rtoMin && ps[i].rpoMin < ps[i - 1].rpoMin);
  }
});

test('the cheapest sufficient pattern: wiki backup, shop pilot light, payments warm standby (not active/active)', () => {
  assert.equal(cheapestPatternFor('wiki'), 'backup');
  assert.equal(cheapestPatternFor('shop'), 'pilot');
  assert.equal(cheapestPatternFor('payments'), 'warm');
  const aa = drill('payments', 'active', false, 'region');
  assert.equal(aa.met, true);
  assert.equal(aa.cheapestPattern, false);
});

test('replication copies corruption: without point-in-time backups, failover recovers nothing', () => {
  const r = drill('shop', 'warm', false, 'corruption');
  assert.equal(r.met, false);
  assert.equal(fmtMin(r.rpoMin), 'never');
  assert.equal(drill('shop', 'pilot', true, 'corruption').met, true);
  assert.equal(drill('shop', 'backup', true, 'corruption').met, false, 'rebuilding a whole region misses a 2-hour RTO');
});

test('dr mission: active/active for payments meets the targets and still fails the step', () => {
  const s = DR_MISSION.setup();
  s.results.push(drill('wiki', 'backup', false, 'region'), drill('shop', 'pilot', false, 'region'), drill('payments', 'active', false, 'region'));
  assert.equal(doneUpTo(DR_MISSION, s), 2);
  s.results.push(drill('payments', 'warm', false, 'region'), drill('shop', 'active', false, 'corruption'));
  assert.equal(doneUpTo(DR_MISSION, s), 3);
  s.results.push(drill('shop', 'pilot', true, 'corruption'));
  assert.equal(doneUpTo(DR_MISSION, s), 4);
});

// ---- business impact analysis -------------------------------------------------

test('true MTD is the last checkpoint before severe', () => {
  assert.deepEqual(Object.fromEntries(IDS.map((p) => [p, trueMtd(p)])), { orders: '4h', shipping: '1d', payroll: '1d', suppliers: '3d', support: '3d', newsletter: 'longer' });
  assert.deepEqual(recoveryOrder().slice(0, 3), ['orders', 'shipping', 'payroll']);
});

test('tabletop judges by true impact; a workaround that needs the broken system fails', () => {
  assert.equal(tabletop({}).filter((l) => !l.ok).map((l) => l.p).join(), 'orders,shipping');
  const bad = tabletop({ orders: 'email-in', shipping: 'paper' });
  assert.match(bad.find((l) => l.p === 'orders')!.note, /order system is the thing that is down/);
  assert.ok(tabletop({ orders: 'phone', shipping: 'paper' }).every((l) => l.ok));
  assert.equal(tabletop({ orders: 'phone', shipping: 'paper' }).find((l) => l.p === 'payroll')!.affected, false);
});

test('bia mission: guessing "longer" everywhere does not pass step 1', () => {
  const s: BiaState = BIA_MISSION.setup();
  for (const p of IDS) s.mtd[p] = 'longer';
  assert.equal(doneUpTo(BIA_MISSION, s), 0);
  for (const p of IDS) s.mtd[p] = trueMtd(p);
  s.runs.push(tabletop({ orders: 'email-in' }));
  assert.equal(doneUpTo(BIA_MISSION, s), 2);
  s.runs.push(tabletop({ orders: 'phone', shipping: 'paper' }));
  assert.equal(doneUpTo(BIA_MISSION, s), 3);
});

// ---- incidents ----------------------------------------------------------------

test('severity: many customers unable to pay is SEV-2 or higher', () => {
  assert.equal(sevOk(3), false);
  assert.equal(sevOk(2), true);
  assert.equal(sevOk(1), true);
});

test('staffing: the best fixer as commander fails, one person in two roles fails', () => {
  assert.equal(staffing({ ic: 0, resolver: 3, comms: 1, scribe: 2 }).ok, false);
  assert.equal(staffing({ ic: 2, resolver: 0, comms: 1, scribe: 1 }).ok, false);
  assert.equal(staffing({ ic: 2, resolver: 1, comms: 0, scribe: 3 }).ok, false, 'the support lead cannot fix payments');
  assert.equal(staffing({ ic: 2, resolver: 0, comms: 1, scribe: 3 }).ok, true);
});

test('postmortem: any blame fails; every systemic factor is needed', () => {
  const systemic = FACTORS.map((f, i) => (f.blame ? -1 : i)).filter((i) => i >= 0);
  assert.equal(postmortem([...systemic, 1]).ok, false);
  assert.equal(postmortem(systemic.slice(0, 2)).ok, false);
  assert.equal(postmortem(systemic).ok, true);
});

test('incident mission steps tick only in order', () => {
  const s = INCIDENT_MISSION.setup();
  s.sev = 3; s.staffing = { ok: true }; s.update = 1; s.pm = { ok: true };
  assert.equal(doneUpTo(INCIDENT_MISSION, s), 0);
  s.sev = 2;
  assert.equal(doneUpTo(INCIDENT_MISSION, s), 4);
  s.update = 2;
  assert.equal(doneUpTo(INCIDENT_MISSION, s), 2);
});
