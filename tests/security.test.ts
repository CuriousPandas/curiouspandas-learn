import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INCIDENTS, install, treeFor, key, type Control } from '../src/lib/supply/chain.ts';
import { Authz, kubectlAuth, audit, APP_SUBJECT } from '../src/lib/rbac/rbac.ts';
import { sign, unsigned, decode, verifyNaive, verifyStrict, claims, encodeJson, b64url, unb64url } from '../src/lib/jwt/jwt.ts';
import { SUPPLY_MISSION, RBAC_MISSION, JWT_MISSION, type SupplyState, type RbacState, type JwtState } from '../src/lib/security/missions.ts';

// ---- supply chain -----------------------------------------------------------

test('every control is blind to something - no single control blocks all five', () => {
  for (const c of ['lockfile', 'provenance', 'review'] as Control[]) {
    const through = INCIDENTS.filter((i) => install(i.id, [c]).outcome !== 'blocked');
    assert.ok(through.length > 0, `${c} alone blocked everything, so the lesson's point would be false`);
  }
});

test('all three together block all five, and dropping any one lets something through', () => {
  assert.ok(INCIDENTS.every((i) => install(i.id, ['lockfile', 'provenance', 'review']).outcome === 'blocked'));
  for (const drop of ['lockfile', 'provenance', 'review'] as Control[]) {
    const rest = (['lockfile', 'provenance', 'review'] as Control[]).filter((c) => c !== drop);
    assert.ok(INCIDENTS.some((i) => install(i.id, rest).outcome !== 'blocked'), `without ${drop} everything was still blocked - ${drop} would be pointless`);
  }
});

test('a lockfile only delays a takeover - a delay is not a defence', () => {
  assert.equal(install('takeover', ['lockfile']).outcome, 'delayed');
  assert.equal(install('takeover', []).outcome, 'missed');
  // The xz shape: locked after release, so the lockfile hashes the backdoor.
  assert.equal(install('tarball', ['lockfile']).outcome, 'missed');
  assert.equal(install('tarball', ['provenance']).outcome, 'blocked');
});

test('the takeover adds a transitive package; a typosquat replaces the name you meant', () => {
  const t = treeFor('takeover');
  const bad = t.find((r) => r.bad)!;
  assert.equal(bad.name, 'toy-flatmap');
  assert.ok(bad.added && bad.depth === 3);
  assert.ok(treeFor('typosquat').some((r) => r.name === 'toy-cross-envv' && r.bad));
  assert.ok(!treeFor('typosquat').some((r) => r.name === 'toy-cross-env'));
  // Every package name is fictional: real names would accuse real maintainers.
  for (const i of INCIDENTS) for (const r of treeFor(i.id)) assert.match(r.name, /^toy-/);
});

test('supply mission: ticking everything on the first try does not skip the lesson', () => {
  const s: SupplyState = { history: INCIDENTS.map((i) => install(i.id, ['lockfile', 'provenance', 'review'])) };
  assert.equal(SUPPLY_MISSION.steps[0].done(s), false, 'never saw what happens with no controls');
  s.history.push(install('takeover', []), install('takeover', ['lockfile']));
  s.history.push(...INCIDENTS.map((i) => install(i.id, ['lockfile', 'review'])));
  assert.ok(SUPPLY_MISSION.steps.every((st) => st.done(s)));
  assert.equal(key(['review', 'lockfile', 'review']), 'lockfile+review');
});

// ---- RBAC ------------------------------------------------------------------

const k = (z: Authz, line: string) => kubectlAuth(z, line).map((l) => l.text).join('\n');
const CAN = 'kubectl auth can-i get configmaps/shop-settings -n shop --as=system:serviceaccount:shop:reporter';

test('no binding, no access: service accounts start with nothing', () => {
  assert.equal(k(new Authz(), CAN), 'no');
});

test('cluster-admin makes it work and fails every least-privilege check (the fix that should not ship)', () => {
  const z = new Authz();
  k(z, 'kubectl create clusterrolebinding reporter-admin --clusterrole=cluster-admin --serviceaccount=shop:reporter');
  assert.equal(k(z, CAN), 'yes');
  const failed = audit(z).filter((c) => c.got !== c.want).map((c) => c.id);
  assert.deepEqual(failed, ['secrets', 'write', 'others', 'elsewhere']);
});

test('view in the namespace: no Secrets, no writes, but every ConfigMap - resourceNames is what narrows it', () => {
  const z = new Authz();
  k(z, 'kubectl create rolebinding reporter-view --clusterrole=view --serviceaccount=shop:reporter -n shop');
  const failed = audit(z).filter((c) => c.got !== c.want).map((c) => c.id);
  assert.deepEqual(failed, ['others']);
});

test('a RoleBinding to a ClusterRole grants it only in the binding\'s namespace', () => {
  const z = new Authz();
  k(z, 'kubectl create rolebinding reporter-edit --clusterrole=edit --serviceaccount=shop:reporter -n shop');
  assert.equal(z.can({ subject: APP_SUBJECT, verb: 'get', resource: 'secrets', namespace: 'shop' }), true);
  assert.equal(z.can({ subject: APP_SUBJECT, verb: 'get', resource: 'secrets', namespace: 'kube-system' }), false);
});

test('the least-privilege Role passes everything; list cannot match a named rule', () => {
  const z = new Authz();
  k(z, 'kubectl create role settings-reader --verb=get --resource=configmaps --resource-name=shop-settings -n shop');
  k(z, 'kubectl create rolebinding reporter-settings --role=settings-reader --serviceaccount=shop:reporter -n shop');
  assert.ok(audit(z).every((c) => c.got === c.want), JSON.stringify(audit(z)));
  assert.equal(z.can({ subject: APP_SUBJECT, verb: 'list', resource: 'configmaps', namespace: 'shop' }), false);
});

test('a binding to a role that does not exist is accepted, grants nothing, and says so', () => {
  const z = new Authz();
  const out = k(z, 'kubectl create rolebinding oops --role=typo-role --serviceaccount=shop:reporter -n shop');
  assert.match(out, /created/);
  assert.match(out, /grants nothing/);
  assert.equal(k(z, CAN), 'no');
});

test('rbac mission: cluster-admin ticks "works" but not the least-privilege steps', () => {
  const s: RbacState = { authz: new Authz(), history: [CAN] };
  kubectlAuth(s.authz, 'kubectl create clusterrolebinding reporter-admin --clusterrole=cluster-admin --serviceaccount=shop:reporter');
  assert.equal(RBAC_MISSION.steps[1].done(s), true);
  assert.equal(RBAC_MISSION.steps[2].done(s), false);
  kubectlAuth(s.authz, 'kubectl delete clusterrolebinding reporter-admin');
  kubectlAuth(s.authz, 'kubectl create role settings-reader --verb=get --resource=configmaps --resource-name=shop-settings -n shop');
  kubectlAuth(s.authz, 'kubectl create rolebinding reporter-settings --role=settings-reader --serviceaccount=shop:reporter -n shop');
  s.history.push('kubectl auth can-i get secrets -n shop --as=system:serviceaccount:shop:reporter');
  assert.ok(RBAC_MISSION.steps.every((st) => st.done(s)));
});

// ---- JWT -------------------------------------------------------------------

test('base64url round-trips without padding or + and /', () => {
  const bytes = Uint8Array.from([251, 255, 191, 0, 1]);
  const s = b64url(bytes);
  assert.doesNotMatch(s, /[+/=]/);
  assert.deepEqual([...unb64url(s)], [...bytes]);
});

test('a signed token verifies; one changed character in the payload breaks it', async () => {
  const t = await sign(claims());
  assert.equal((await verifyStrict(t)).ok, true);
  const [h, , sig] = t.split('.');
  const forged = `${h}.${encodeJson(claims({ role: 'admin' }))}.${sig}`;
  assert.equal((await verifyNaive(forged)).ok, false);
  assert.match((await verifyStrict(forged)).reason, /signature/);
});

test('alg none: the naive verifier accepts a forged admin, the strict one refuses on the algorithm', async () => {
  const forged = unsigned(claims({ role: 'admin' }));
  const naive = await verifyNaive(forged);
  assert.equal(naive.ok, true);
  assert.equal(naive.claims?.role, 'admin');
  const strict = await verifyStrict(forged);
  assert.equal(strict.ok, false);
  assert.match(strict.reason, /alg "none" is not on this server's allow-list/);
});

test('a correctly signed token for another audience is refused by the strict verifier only', async () => {
  const t = await sign(claims({ aud: 'billing-app' }));
  assert.equal((await verifyNaive(t)).ok, true);
  assert.match((await verifyStrict(t)).reason, /audience/);
});

test('expired tokens are refused', async () => {
  const now = 2_000_000_000;
  const t = await sign(claims({ exp: now - 1 }, now - 3600));
  assert.match((await verifyStrict(t, { now })).reason, /expired/);
});

test('decode explains malformed tokens instead of throwing a stack trace at a learner', () => {
  assert.throws(() => decode('abc.def'), /3 parts/);
  assert.throws(() => decode('!!.e30.x'), /header is not base64url/);
});

test('jwt mission walks from honest token to forged admin to wrong audience', async () => {
  const s: JwtState = { history: [] };
  const send = async (token: string, kind: JwtState['history'][number]['token'], role: unknown) =>
    s.history.push({ token: kind, role, naive: await verifyNaive(token), strict: await verifyStrict(token) });
  const good = await sign(claims());
  await send(good, 'signed', 'viewer');
  const [h, , sig] = good.split('.');
  await send(`${h}.${encodeJson(claims({ role: 'admin' }))}.${sig}`, 'edited', 'admin');
  await send(unsigned(claims({ role: 'admin' })), 'none', 'admin');
  assert.equal(JWT_MISSION.steps[3].done(s), false);
  await send(await sign(claims({ aud: 'billing-app' })), 'other-app', 'viewer');
  assert.ok(JWT_MISSION.steps.every((st) => st.done(s)));
});
