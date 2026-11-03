// The manifests the storage lessons start from. They are the shapes run on a
// real kind cluster (Kubernetes 1.36.1, local-path provisioner) while these
// lessons were written; the sandbox reads them with its own YAML reader, which
// tests/kube-yaml.test.ts holds to the `yaml` package.

// tilt's wazuh chart once named Docker Desktop's class; on kind it does not
// exist (TemplateMechanics/tilt helm/wazuh/pvcs.yaml records the incident).
export const INDEXER = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: indexer-data
spec:
  storageClassName: hostpath
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: indexer
spec:
  containers:
  - name: app
    image: panda/indexer:1.0
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: indexer-data
`;

// The decoy: a claim on the default class with nobody using it yet. Pending is
// the right state for it.
export const SCRATCH = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: scratch
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
`;

export const WEB = `apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  clusterIP: None
  selector:
    app: web
  ports:
  - port: 80
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: web
spec:
  serviceName: web
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
      - name: app
        image: panda/web:1.0
        volumeMounts:
        - name: data
          mountPath: /data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 1Gi
`;

export const FILES: Record<string, string> = { 'indexer.yaml': INDEXER, 'scratch.yaml': SCRATCH, 'web.yaml': WEB };
