# Writes tests/fixtures/kube-net-yaml.json: YAML documents and what PyYAML 6.0.3
# reads them as. tests/kube-net-yaml.test.ts holds the sandbox's reader to it.
# Run with a Python that has PyYAML:  python -I tests/fixtures/kube-net-yaml.py
#
# Two parts. "cases" are hand-written: manifests from the lessons, and each trap
# the reader refuses. "fuzz" is generated from a fixed seed, using only features
# the reader claims to support, so every one of them must parse identically.

import json, random, sys, os
import yaml

HAND = [
    "a: 1\nb: two\n",
    "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: default-deny\nspec:\n  podSelector: {}\n  policyTypes:\n  - Ingress\n  - Egress\n",
    "spec:\n  egress:\n  - to:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: kube-system\n      podSelector:\n        matchLabels:\n          k8s-app: kube-dns\n    ports:\n    - protocol: UDP\n      port: 53\n",
    "ports:\n- port: \"80\"\n- port: 80\n- port: http\n",
    "args: [\"--config-from=web-settings\"]\nlist: [a, 'b c', 3]\nmap: {a: 1, b: x}\nempty: []\nnone: {}\n",
    "patches:\n- patch: |-\n    apiVersion: apps/v1\n    kind: Deployment\n    metadata:\n      name: web\n    spec:\n      replicas: 3\n",
    "keep: |\n  line one\n  line two\nnext: x\n",
    "# comment\na: 1 # trailing\nb: 'it''s'\nc: \"say \\\"hi\\\"\"\nd: ~\ne: null\nf: true\ng: False\n",
    "tag: \"1.0\"\nver: 1.0\nneg: -3\nzero: 0\n",
    "a:\n  b:\n    c:\n    - x\n    - z\n  d: e\n",
    "- a\n- b: 1\n  c: 2\n- - nested\n  - list\n",
    "url: http://example.com:8080/path\nhost: shop.localhost\n",
    "a: 1\n---\nb: 2\n",
    "key with spaces: value with spaces\n",
]
# Each of these is read one way by YAML 1.1 and another by YAML 1.2, or uses a
# feature the reader doesn't have. The reader must refuse them, never guess.
REFUSE = [
    "enabled: yes\n", "mode: on\n", "perm: 0777\n", "big: 1_000\n", "e: 1e3\n", "t: 12:30\n",
    "a: &x 1\nb: *x\n", "a: !!str 1\n", "f: >\n  folded\n", "a: 1\na: 2\n", "a:\tb\n",
    "? complex\n: key\n", "nan: .nan\n", "inf: .inf\n", "hex: 0x1F\n", "x: -\n", "y: n\n",
]

def gen(rng, depth):
    """A random document built only from supported features."""
    words = ["web", "api", "shop", "kube-dns", "app", "v1", "panda/web:1.0", "10.96.0.10", "a-b", "x.y"]
    def scalar():
        r = rng.random()
        if r < 0.3: return rng.choice(words)
        if r < 0.45: return str(rng.randint(-50, 70000))
        if r < 0.55: return rng.choice(["true", "false", "null", "~"])
        if r < 0.65: return "%d.%d" % (rng.randint(0, 9), rng.randint(0, 99))
        if r < 0.8: return "'" + rng.choice(words + ["it''s", "a: b", "# not a comment", "yes", "0777"]) + "'"
        return '"' + rng.choice(words + ["80", "on", "tab\\tsep", "q\\\"uote"]) + '"'
    def node(ind, d):
        pad = " " * ind
        if d <= 0 or rng.random() < 0.25:
            return None
        if rng.random() < 0.5:
            lines = []
            used = set()
            for _ in range(rng.randint(1, 4)):
                k = rng.choice(["name", "port", "spec", "items", "labels", "to", "from", "image"])
                if k in used: continue
                used.add(k)
                child = node(ind + 2, d - 1)
                if child is None:
                    lines.append(f"{pad}{k}: {scalar()}")
                else:
                    lines.append(f"{pad}{k}:\n{child[1]}")
            return ("map", "\n".join(lines))
        else:
            lines = []
            for _ in range(rng.randint(1, 3)):
                child = node(ind + 2, d - 1)
                if child is None:
                    lines.append(f"{pad}- {scalar()}")
                elif child[0] == "map":
                    body = child[1]
                    first, _, rest = body.partition("\n")
                    lines.append(f"{pad}- {first.strip()}" + (("\n" + rest) if rest else ""))
                else:
                    lines.append(f"{pad}-\n{child[1]}")
            return ("seq", "\n".join(lines))
    top = None
    while top is None or top[0] != "map":
        top = node(0, depth)
    return top[1] + "\n"

def safe(v):
    # JSON has no NaN or infinity; the refusal cases only need to show what
    # PyYAML made of them, so those become strings.
    if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))): return repr(v)
    if isinstance(v, dict): return {str(k): safe(x) for k, x in v.items()}
    if isinstance(v, list): return [safe(x) for x in v]
    if not isinstance(v, (str, int, float, bool, type(None))): return str(v)
    return v

def load(src):
    try:
        docs = [safe(d) for d in yaml.safe_load_all(src) if d is not None]
        return {"ok": docs}
    except yaml.YAMLError as e:
        return {"error": str(e).splitlines()[0]}

rng = random.Random(20261102)
fuzz = [gen(rng, 4) for _ in range(400)]
out = {
    "pyyaml": yaml.__version__,
    "cases": [{"src": s, **load(s)} for s in HAND],
    "refuse": [{"src": s, **load(s)} for s in REFUSE],
    "fuzz": [{"src": s, **load(s)} for s in fuzz],
}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kube-net-yaml.json")
with open(path, "w", encoding="utf8") as f:
    json.dump(out, f, indent=1, default=str)
print(f"wrote {len(HAND)} cases, {len(REFUSE)} refusals, {len(fuzz)} fuzz docs with PyYAML {yaml.__version__}")
