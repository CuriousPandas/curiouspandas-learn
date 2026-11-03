// The storage sandbox's YAML reader, held to the `yaml` package (the parser
// Astro itself installs). Every document the sandbox accepts must parse to
// exactly what `yaml` gives; anything it cannot read must be refused with a
// line number, never read differently. A reader that quietly dropped a key
// would let a learner's storageClassName vanish and the mission still pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as realParse, parseAllDocuments } from 'yaml';
import { parseYaml, YamlError } from '../src/lib/kube-storage/yaml.ts';
import { FILES as STORAGE_FILES } from '../src/lib/kube-storage/files.ts';

const real = (src: string) => parseAllDocuments(src).map((d) => {
  if (d.errors.length) throw new Error(d.errors[0].message);
  return d.toJS();
}).filter((v) => v !== null);

function agree(src: string, label: string) {
  let mine: unknown;
  try { mine = parseYaml(src); } catch (e) {
    if (e instanceof YamlError) { assert.match(e.message, /^error: line \d+: /, label); return 'refused'; }
    throw e;
  }
  let theirs: unknown;
  try { theirs = real(src); } catch (e) {
    assert.fail(`${label}: the sandbox accepted YAML the real parser rejects (${(e as Error).message}):\n${src}`);
  }
  assert.deepEqual(mine, theirs, `${label}:\n${src}`);
  return 'same';
}

const CORPUS: Record<string, string> = {
  pvc: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data   # a comment
spec:
  storageClassName: hostpath
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
`,
  seqUnderKey: `spec:\n  containers:\n  - name: app\n    image: "busybox:1.36"\n    command: [sh, -c, "echo hi > /data/x"]\n    ports:\n      - containerPort: 80\n`,
  multiDoc: `---\na: 1\n---\nb: [x, 'y z', "q"]\n...\n`.replace('...\n', ''),
  quotes: `a: 'it''s'\nb: "say \\"hi\\""\nc: "#not a comment"\nd: x#y\n`,
  scalars: `a: true\nb: False\nc: ~\nd:\ne: -12\nf: 7\ng: "yes"\nh: 1Gi\ni: 10.244.0.0\nj: "1"\n`,
  emptyMap: `metadata: {}\nlist: []\n`,
  nested: `a:\n  - b: 1\n    c:\n      - d\n      - e\n  - f\n`,
  dashAlone: `a:\n-\n  b: 1\n- c\n`,
  trailingComma: `a: [x, z,]\n`,
  spacesAfterDash: `a:\n-   b: 1\n    c: 2\n`,
};

const REFUSED: Record<string, RegExp> = {
  'a: &x 1\nb: *x\n': /anchors/,
  'a: |\n  text\n': /block scalars/,
  'a: >\n  text\n': /block scalars/,
  'a: {b: 1}\n': /flow mappings/,
  'a: !!str 1\n': /tags/,
  'a:\n\tb: 1\n': /tabs/,
  'a: 1\na: 2\n': /duplicate key/,
  'a: 1.5\n': /number/,
  'a: "open\n': /double-quoted|unterminated/,
  'a: b: c\n': /looks like a key/,
  'a: [[1]]\n': /nested flow/,
  'a: plain\n  continued\n': /already has a value|multi-line/,
  // YAML 1.1 (go-yaml, which kubectl uses) and 1.2 (the yaml package) disagree on these.
  'a: yes\n': /true or false/,
  'a: off\n': /true or false/,
  'a: 010\n': /different number/,
  'a: 1:20\n': /different number/,
  'a: 1_000\n': /different number/,
  'a: 2026-11-02\n': /date/,
};

test('the sandbox reads every corpus document exactly as the yaml package does', () => {
  for (const [k, src] of Object.entries(CORPUS)) assert.equal(agree(src, k), 'same', k);
});

test('it refuses what it cannot read, by name and line', () => {
  for (const [src, re] of Object.entries(REFUSED)) {
    assert.throws(() => parseYaml(src), (e: Error) => e instanceof YamlError && re.test(e.message) && /line \d+/.test(e.message), src);
  }
});

test('every manifest the storage lessons ship parses identically', () => {
  for (const [name, src] of Object.entries(STORAGE_FILES)) assert.equal(agree(src, name), 'same', name);
});

// Mutations of the shipped files: what a learner editing them might produce.
// Each one must be read as `yaml` reads it, or refused - never read differently.
test('fuzz: edits to the shipped manifests are read the same or refused', () => {
  let seed = 20261102;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const edits = [
    (l: string) => l.replace(/^(\s*)/, '$1 '),
    (l: string) => l.replace(/^ /, ''),
    (l: string) => l + ' # note',
    (l: string) => l.replace(/: (.+)$/, ': "$1"'),
    (l: string) => l.replace(/: (.+)$/, ": '$1'"),
    (l: string) => l.replace(/: .+$/, ':'),
    (l: string) => l.replace(/: (\S+)$/, ': [$1]'),
    (l: string) => l.replace(/- /, '-   '),
    (l: string) => l.replace(/:/, ''),
    (l: string) => l + ':',
    (l: string) => l.replace(/\w+/, 'true'),
    (l: string) => l.replace(/\w+$/, '12'),
    (l: string) => l.replace(/\w+$/, '"quoted #hash"'),
    () => '',
    () => '---',
  ];
  const counts = { same: 0, refused: 0 };
  const files = Object.values(STORAGE_FILES).concat(Object.values(CORPUS));
  for (let k = 0; k < 4000; k++) {
    const lines = files[rnd(files.length)].split('\n');
    for (let j = 0, m = 1 + rnd(3); j < m; j++) { const at = rnd(lines.length); lines[at] = edits[rnd(edits.length)](lines[at]); }
    counts[agree(lines.join('\n'), `mutation ${k}`)]++;
  }
  // Most edits must still be readable, or the reader is refusing its way to agreement.
  assert.ok(counts.same > counts.refused, JSON.stringify(counts));
});

test('the reference parser is really there (a missing one must fail, not skip)', () => {
  assert.deepEqual(realParse('a: [1, b]'), { a: [1, 'b'] });
});
