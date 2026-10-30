// Missions for the security track's widgets, in the same shape as
// src/lib/missions.ts: they check the state the learner produced, never the
// words they typed, and the fix that merely makes the error go away does not
// pass. Binding cluster-admin "fixes" the forbidden error; the audit fails it.

import type { Mission } from '../missions.ts';
import { INCIDENTS, key, type Result } from '../supply/chain.ts';
import { Authz, audit, APP_SUBJECT } from '../rbac/rbac.ts';
import type { Verdict } from '../jwt/jwt.ts';

// ---- supply chain ----------------------------------------------------------

export type SupplyState = { history: Result[] };

const blocksAll = (h: Result[], k: string) => INCIDENTS.every((i) => h.some((r) => r.incident === i.id && key(r.controls) === k && r.outcome === 'blocked'));

export const SUPPLY_MISSION: Mission<SupplyState> = {
  id: 'supply-five', title: 'Five ways in', xp: 60,
  setup: () => ({ history: [] }),
  steps: [
    { text: 'Install during the maintainer takeover with every control off', hint: 'Pick "Maintainer takeover", untick all three, then Install', done: (s) => s.history.some((r) => r.incident === 'takeover' && r.controls.length === 0) },
    { text: 'Try the lockfile alone against the takeover - read what it really buys you', hint: 'Tick only "Lockfile + npm ci", then Install', done: (s) => s.history.some((r) => r.incident === 'takeover' && key(r.controls) === 'lockfile') },
    { text: 'Stop the backdoored release tarball', hint: 'The source is clean, so reading it will not help. What would prove the tarball came from the source?', done: (s) => s.history.some((r) => r.incident === 'tarball' && r.outcome === 'blocked') },
    { text: 'Find one set of controls that blocks all five', hint: 'Tick a set, then "Run all five"', done: (s) => s.history.some((r) => blocksAll(s.history, key(r.controls))) },
    { text: 'Drop any one control from that set and watch something get through', hint: 'Untick one, then "Run all five" again', done: (s) => s.history.some((r) => r.controls.length === 2 && r.outcome !== 'blocked') },
  ],
  debrief: 'No control covered everything. The lockfile stopped bytes changing under you, provenance tied artifacts to their source, and review caught names nobody meant to add. Each one was blind to something the others saw - which is why real projects run all three.',
};

// ---- cluster access ----------------------------------------------------------

export type RbacState = { authz: Authz; history: string[] };

const asked = (h: string[], re: RegExp) => h.some((l) => /auth\s+can-i/.test(l) && re.test(l) && l.includes(APP_SUBJECT));
const checks = (s: RbacState) => Object.fromEntries(audit(s.authz).map((c) => [c.id, c.got === c.want]));

export const RBAC_MISSION: Mission<RbacState> = {
  id: 'rbac-least', title: 'Just enough access', xp: 60,
  setup: () => ({ authz: new Authz(), history: [] }),
  steps: [
    { text: 'The reporter app logs "forbidden". Ask the API server whether it may read shop-settings', hint: 'kubectl auth can-i get configmaps/shop-settings -n shop --as=system:serviceaccount:shop:reporter', done: (s) => asked(s.history, /configmaps?\/shop-settings/) },
    { text: 'Give the app access so it works', hint: 'Any binding will do for now - even the one you should never ship', done: (s) => checks(s).works },
    { text: 'Make sure it cannot read Secrets, change its settings or reach kube-system', hint: 'cluster-admin and edit both fail this. Delete the binding and grant less', done: (s) => { const c = checks(s); return c.works && c.secrets && c.write && c.elsewhere; } },
    { text: 'Narrow it to the one ConfigMap it reads - nothing else in shop', hint: 'kubectl create role settings-reader --verb=get --resource=configmaps --resource-name=shop-settings -n shop  then  kubectl create rolebinding reporter-settings --role=settings-reader --serviceaccount=shop:reporter -n shop', done: (s) => Object.values(checks(s)).every(Boolean) },
    { text: 'Prove it: ask whether the app can read Secrets in shop', hint: 'kubectl auth can-i get secrets -n shop --as=system:serviceaccount:shop:reporter', done: (s) => asked(s.history, /\bsecrets?\b/) },
  ],
  debrief: 'cluster-admin made the error disappear and handed a stolen token from that pod the whole cluster. The grant that ships is only the verbs the app uses, on one resource, one name, in one namespace - the same shape as the Role tilt\'s own config server runs with.',
};

// ---- identity / JWT ----------------------------------------------------------

export type JwtEvent = { token: 'signed' | 'edited' | 'none' | 'other-app'; naive: Verdict; strict: Verdict; role?: unknown };
export type JwtState = { history: JwtEvent[] };

export const JWT_MISSION: Mission<JwtState> = {
  id: 'jwt-forge', title: 'Forge an admin', xp: 50,
  setup: () => ({ history: [] }),
  steps: [
    { text: 'Send the token you were issued - both APIs accept it', hint: 'Send to both APIs', done: (s) => s.history.some((e) => e.token === 'signed' && e.naive.ok && e.strict.ok) },
    { text: 'Change your role to admin and send it without re-signing', hint: 'Edit "role": "viewer" to "admin" in the payload, then send', done: (s) => s.history.some((e) => e.token === 'edited' && e.role === 'admin' && !e.naive.ok && !e.strict.ok) },
    { text: 'Get the naive API to accept an admin token anyway - then read why the strict one refused it', hint: 'Keep "role": "admin", then "Strip signature, alg: none"', done: (s) => s.history.some((e) => e.token === 'none' && e.role === 'admin' && e.naive.ok) },
    { text: 'Send a validly signed token that was issued for a different app', hint: '"Token for another app"', done: (s) => s.history.some((e) => e.token === 'other-app' && e.naive.ok && !e.strict.ok) },
  ],
  debrief: 'The signature only protects you if the server, not the token, decides how to check it. The strict API pinned the algorithm, then checked who issued the token and who it was for. A perfectly signed token for someone else\'s app is still not a ticket into yours.',
};
