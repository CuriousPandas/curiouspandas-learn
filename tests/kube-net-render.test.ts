// The render lab and the API lab against the real tools. Expected text was
// copied from runs on 2026-11-02 in WSL: Helm 4.1.4 (`helm template` with the
// same small chart the sandbox ships), kubectl 1.37.2's Kustomize v5.8.1
// (`kubectl kustomize` on the same base), and kubectl against Kubernetes
// 1.36.1. Then both labs' missions are played start to finish, with their
// shortcuts, judged in order the way the panel judges them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helmTemplate, kustomize, renderedReplicas, parseSet, changedLines } from '../src/lib/kube-net/render.ts';
import { applyVerdict, warning, APIS } from '../src/lib/kube-net/api.ts';
import { RENDER_MISSION, API_MISSION, renderHelm, renderKustomize, applyApi, BAMBOO, ENDPOINTS, OLD_INGRESS, type RenderState, type ApiState } from '../src/lib/kube-net/lab-missions.ts';

const helm = (set = '', valuesFile = '', schema = false) => helmTemplate({ release: 'shop', valuesFile, set, schema });

test('helm template renders the chart byte for byte as Helm 4.1.4 did', () => {
  const r = helm();
  assert.ok(r.ok);
  assert.equal(r.output, `---
# Source: web/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop-web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: shop-web
  template:
    metadata:
      labels:
        app: shop-web
    spec:
      containers:
      - name: web
        image: "panda/web:1.0"
`);
});

test('helm values: the typo is ignored; the rest behave as measured', () => {
  assert.equal(renderedReplicas(helm('replicaCont=3')), 1);
  assert.equal(renderedReplicas(helm('', 'replicaCont: 3\n')), 1);
  assert.equal(renderedReplicas(helm('replicaCount=3')), 3);
  assert.equal(renderedReplicas(helm('replicaCount=three')), 'three');
  // Real: --set replicaCount=null rendered "  replicas: " with nothing after it.
  const n = helm('replicaCount=null');
  assert.ok(n.ok && /^ {2}replicas: $/m.test(n.output));
  // Real, Helm 4.1.4: 2.10 stayed 2.10 (Helm 3 is not claimed either way).
  const t = helm('image.tag=2.10');
  assert.ok(t.ok && t.output.includes('image: "panda/web:2.10"'));
  assert.deepEqual(parseSet('a.b=1,c=true,d=x'), [{ path: ['a', 'b'], value: 1 }, { path: ['c'], value: true }, { path: ['d'], value: 'x' }]);
  // -f values override the chart; --set overrides -f.
  assert.equal(renderedReplicas(helm('replicaCount=4', 'replicaCount: 2\n')), 4);
});

test('values.schema.json errors are Helm 4.1.4\'s, word for word', () => {
  const head = "Error: values don't meet the specifications of the schema(s) in the following chart(s):\nweb:\n";
  const a = helm('replicaCont=3', '', true);
  assert.ok(!a.ok && a.error === head + "- at '': additional properties 'replicaCont' not allowed\n");
  const b = helm('replicaCount=three', '', true);
  assert.ok(!b.ok && b.error === head + "- at '/replicaCount': got string, want integer\n");
  const c = helm('image.tagg=2.0', '', true);
  assert.ok(!c.ok && c.error === head + "- at '/image': additional properties 'tagg' not allowed\n");
  assert.ok(helm('image.tag=2.0', '', true).ok, 'a correct value passes the schema');
});

const PREFIX_REPLICAS = `apiVersion: v1
data:
  GREETING: hello
kind: ConfigMap
metadata:
  name: prod-web-settings
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prod-web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - args:
        - --config-from=web-settings
        envFrom:
        - configMapRef:
            name: prod-web-settings
        image: panda/web:1.0
        name: web
`;

test('kubectl kustomize output, byte for byte, including the args it did not rename', () => {
  const r = kustomize('resources:\n- ../base\nnamePrefix: prod-\nreplicas:\n- name: web\n  count: 3\n');
  assert.ok(r.ok);
  assert.equal(r.output, PREFIX_REPLICAS);
  // Real: the replicas entry may use the new name too.
  const r2 = kustomize('resources:\n- ../base\nnamePrefix: prod-\nreplicas:\n- name: prod-web\n  count: 3\n');
  assert.ok(r2.ok && r2.output === PREFIX_REPLICAS);
  // nameSuffix, real: web-v2 and web-settings-v2, args untouched.
  const s = kustomize('resources:\n- ../base\nnameSuffix: -v2\n');
  assert.ok(s.ok && s.output.includes('  name: web-settings-v2\n') && s.output.includes('  name: web-v2\n') && s.output.includes('- --config-from=web-settings\n') && s.output.includes('name: web-settings-v2\n        image'));
  // A strategic-merge patch to the container's image, real output line.
  const p = kustomize('resources:\n- ../base\npatches:\n- patch: |-\n    apiVersion: apps/v1\n    kind: Deployment\n    metadata:\n      name: web\n    spec:\n      template:\n        spec:\n          containers:\n          - name: web\n            image: panda/web:2.0\n');
  assert.ok(p.ok && p.output.includes('        image: panda/web:2.0\n        name: web\n'));
  // images with newName and newTag.
  const im = kustomize('resources:\n- ../base\nimages:\n- name: panda/web\n  newName: registry.example/panda/web\n  newTag: "2.0"\n');
  assert.ok(im.ok && im.output.includes('image: registry.example/panda/web:2.0'));
});

test('Kustomize is strict about targets and silent about images, as v5.8.1 was', () => {
  const err = (k: string) => { const r = kustomize(k); return r.ok ? '' : r.error; };
  assert.equal(err('resources:\n- ../base\npatches:\n- patch: |-\n    apiVersion: apps/v1\n    kind: Deployment\n    metadata:\n      name: webb\n    spec:\n      replicas: 3\n'),
    'error: no resource matches strategic merge patch "Deployment.v1.apps/webb.[noNs]": no matches for Id Deployment.v1.apps/webb.[noNs]; failed to find unique target for patch Deployment.v1.apps/webb.[noNs]');
  assert.equal(err('resources:\n- ../base\nreplicas:\n- name: webb\n  count: 3\n'),
    'error: resource with name webb does not match a config with the following GVK [Deployment.[noVer].[noGrp] StatefulSet.[noVer].[noGrp] ReplicaSet.[noVer].[noGrp] ReplicationController.[noVer].[noGrp]]');
  assert.equal(err('resources:\n- ../base\nnamPrefix: prod-\n'), 'error: invalid Kustomization: json: unknown field "namPrefix"');
  assert.equal(err('resources:\n- ../base\nimages:\n- name: panda/web\n  newTag: 2.0\n'), 'error: invalid Kustomization: json: cannot unmarshal number into Go struct field Image.images.newTag of type string');
  assert.equal(err('resources:\n- ../base\nreplicas:\n- name: web\n  count: "3"\n'), 'error: invalid Kustomization: json: cannot unmarshal string into Go struct field Replica.replicas.count of type int64');
  assert.equal(err(''), 'error: kustomization.yaml is empty');
  // Silent: a misspelt image name changes nothing, exit 0, no warning printed.
  const r = kustomize('resources:\n- ../base\nimages:\n- name: panda/webb\n  newTag: "2.0"\n');
  assert.ok(r.ok && r.output.includes('image: panda/web:1.0') && !/warn/i.test(r.output));
  // A field Kustomize has but the sandbox does not model is refused by name.
  assert.match(err('resources:\n- ../base\ncommonLabels:\n  env: prod\n'), /Kustomize knows "commonLabels", but this sandbox does not model it/);
});

test('the diff marks only changed lines', () => {
  assert.deepEqual([...changedLines('a\nb\nc', 'a\nB\nc')], [1]);
  assert.deepEqual([...changedLines('a\nb', 'a\nb')], []);
});

// ---- API lab -------------------------------------------------------------------------

test('API verdicts on 1.36 match the real cluster', () => {
  const v = applyVerdict('networking.k8s.io/v1beta1', 'Ingress', 'old', 36, false, 'STDIN');
  assert.deepEqual(v.lines.map((l) => l.text), ['error: resource mapping not found for name: "old" namespace: "" from "STDIN": no matches for kind "Ingress" in version "networking.k8s.io/v1beta1"', 'ensure CRDs are installed first']);
  assert.equal(applyVerdict('autoscaling/v2beta2', 'HorizontalPodAutoscaler', 'old', 36, false, 'STDIN').lines[0].text, 'error: resource mapping not found for name: "old" namespace: "" from "STDIN": no matches for kind "HorizontalPodAutoscaler" in version "autoscaling/v2beta2"');
  assert.equal(applyVerdict('panda.example.com/v1', 'Bamboo', 'snack', 36, false, 'STDIN').lines[0].text, 'error: resource mapping not found for name: "snack" namespace: "" from "STDIN": no matches for kind "Bamboo" in version "panda.example.com/v1"');
  const ep = applyVerdict('v1', 'Endpoints', 'legacy', 36, false);
  // Real: "Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice" then "endpoints/legacy created".
  assert.deepEqual(ep.lines.map((l) => [l.kind, l.text]), [['err', 'Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice'], ['out', 'endpoints/legacy created']]);
  assert.equal(applyVerdict('networking.k8s.io/v1', 'Ingress', 'shop', 36, false).lines[0].text, 'ingress.networking.k8s.io/shop created');
});

test('warnings for older versions are built the way the 1.36.1 source builds them, from the lifecycle files', () => {
  const by = (gv: string, kind: string) => APIS.find((a) => `${a.group}/${a.version}` === gv && a.kind === kind)!;
  assert.equal(warning(by('networking.k8s.io/v1beta1', 'Ingress')), 'networking.k8s.io/v1beta1 Ingress is deprecated in v1.19+, unavailable in v1.22+; use networking.k8s.io/v1 Ingress');
  assert.equal(warning(by('batch/v1beta1', 'CronJob')), 'batch/v1beta1 CronJob is deprecated in v1.21+, unavailable in v1.25+; use batch/v1 CronJob');
  assert.equal(warning(by('autoscaling/v2beta2', 'HorizontalPodAutoscaler')), 'autoscaling/v2beta2 HorizontalPodAutoscaler is deprecated in v1.23+, unavailable in v1.26+; use autoscaling/v2 HorizontalPodAutoscaler');
  assert.equal(applyVerdict('networking.k8s.io/v1beta1', 'Ingress', 'old', 21, false).kind, 'warned');
  assert.equal(applyVerdict('networking.k8s.io/v1beta1', 'Ingress', 'old', 22, false).kind, 'missing');
  // Not yet deprecated means no warning: v2beta2 on 1.21 is plain.
  assert.equal(applyVerdict('autoscaling/v2beta2', 'HorizontalPodAutoscaler', 'h', 21, false).kind, 'created');
  // Not yet served: autoscaling/v2 on 1.21.
  assert.equal(applyVerdict('autoscaling/v2', 'HorizontalPodAutoscaler', 'h', 21, false).kind, 'missing');
});

// ---- the two labs' missions, played --------------------------------------------------

function ticks<S>(steps: { done: (s: S) => boolean }[], s: S) { let n = 0; for (const st of steps) { if (!st.done(s)) break; n++; } return n; }

test('pkg-render: played to the end without losing a tick', () => {
  const s: RenderState = RENDER_MISSION.setup();
  let best = 0;
  const step = (f: () => void) => { f(); const n = ticks(RENDER_MISSION.steps, s); assert.ok(n >= best, 'a tick was lost'); best = n; };
  step(() => { s.helm.set = 'replicaCont=3'; renderHelm(s); });
  step(() => { s.helm.set = 'replicaCount=3'; renderHelm(s); });
  step(() => { s.helm.schema = true; s.helm.set = 'replicaCont=3'; renderHelm(s); });
  step(() => { s.overlay = 'resources:\n- ../base\nnamePrefix: prod-\nreplicas:\n- name: web\n  count: 3\n'; renderKustomize(s); });
  step(() => { s.overlay += 'images:\n- name: panda/webb\n  newTag: "2.0"\n'; renderKustomize(s); });
  step(() => { s.overlay = s.overlay.replace('panda/webb', 'panda/web'); renderKustomize(s); });
  assert.equal(best, RENDER_MISSION.steps.length);
});

test('pkg-render: shortcuts and wrong answers do not pass', () => {
  const s: RenderState = RENDER_MISSION.setup();
  // replicaCount=three is not 3.
  s.helm.set = 'replicaCont=3'; renderHelm(s);
  s.helm.set = 'replicaCount=three'; renderHelm(s);
  assert.equal(ticks(RENDER_MISSION.steps, s), 1);
  // Setting the value in my-values.yaml is a right answer too.
  s.helm.set = ''; s.helm.valuesFile = 'replicaCount: 3\n'; renderHelm(s);
  assert.equal(ticks(RENDER_MISSION.steps, s), 2);
  // The schema step needs the typo to be refused, not just any error.
  s.helm.schema = true; s.helm.set = 'image.tagg=2'; renderHelm(s);
  assert.equal(ticks(RENDER_MISSION.steps, s), 2);
  // An overlay that patches replicas but never prefixes names doesn't pass step 4.
  s.helm.set = 'replicaCont=3'; renderHelm(s);
  s.overlay = 'resources:\n- ../base\nreplicas:\n- name: web\n  count: 3\n'; renderKustomize(s);
  assert.equal(ticks(RENDER_MISSION.steps, s), 3);
});

test('api-removed: played to the end, and the migration must fix the spec too', () => {
  const s: ApiState = API_MISSION.setup();
  let best = 0;
  const step = (f: () => void) => { f(); const n = ticks(API_MISSION.steps, s); assert.ok(n >= best, 'a tick was lost'); best = n; };
  step(() => applyApi(s));
  step(() => { s.minor = 21; applyApi(s); });
  // Changing only the apiVersion is refused by strict decoding, as on 1.36.1.
  s.minor = 36;
  s.manifest = OLD_INGRESS.replace('v1beta1', 'v1');
  const half = applyApi(s);
  assert.equal(half.lines[0].text, 'Error from server (BadRequest): error when creating "old.yaml": Ingress in version "v1" cannot be handled as a Ingress: strict decoding error: unknown field "spec.backend"');
  assert.equal(ticks(API_MISSION.steps, s), 2);
  step(() => { s.manifest = 'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: shop\nspec:\n  defaultBackend:\n    service:\n      name: web\n      port:\n        number: 80\n'; applyApi(s); });
  step(() => { s.manifest = BAMBOO; applyApi(s); });
  step(() => { s.crd = true; applyApi(s); });
  step(() => { s.manifest = ENDPOINTS; applyApi(s); });
  assert.equal(best, API_MISSION.steps.length);
});

test('api-removed: applying v1 on 1.21 does not count as the migration to 1.36', () => {
  const s: ApiState = API_MISSION.setup();
  applyApi(s); s.minor = 21; applyApi(s);
  s.manifest = 'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: shop\nspec:\n  defaultBackend:\n    service:\n      name: web\n      port:\n        number: 80\n';
  applyApi(s);
  assert.equal(ticks(API_MISSION.steps, s), 2);
});
