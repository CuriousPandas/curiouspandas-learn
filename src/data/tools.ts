// The Tool Atlas: every tool the TemplateMechanics/tilt platform can run, plus
// the core it always runs. `tilt` is the key in tilt-config.json, so the atlas
// can say exactly how to switch each one on. CNCF maturity is NOT written here:
// it comes from scripts/sync-cncf.mjs reading the CNCF's own landscape data, so
// it cannot go stale silently or be remembered wrong.

export type Tool = {
  id: string;
  name: string;
  category: string;
  what: string;
  /** Name as it appears in cncf/landscape, when it differs from `name`. */
  landscape?: string;
  /** "flux_apps.keda" etc. Absent for the always-on core. */
  tilt?: string;
  /** Which tilt profile brings it up when it is part of the core. */
  profile?: 'minimal' | 'observability' | 'gitops';
  lesson?: string;
  /** Subprojects the landscape does not list alone: kubernetes-sigs repos, Flux's Flagger. */
  partOf?: string;
  /** The tool's learning path: lesson ids in order, ending with its own lesson
   * in the tools trail. Checked like an expedition (src/lib/curriculum.ts):
   * every lesson must be written, and none may come before what it builds on. */
  path?: string[];
};

export const TOOLS: Tool[] = [
  // ---- the core every profile builds on
  { id: 'kubernetes', name: 'Kubernetes', category: 'Orchestration', what: 'Runs containers across machines and keeps them matching what you declared.', profile: 'minimal', lesson: '/learn/kubernetes/desired-state/', path: ['linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'kubernetes/scheduling', 'kubernetes/restarts', 'kubernetes/admission', 'kubernetes/rollouts', 'tools/kubernetes'] },
  { id: 'kind', name: 'kind', partOf: 'Kubernetes (kubernetes-sigs)', category: 'Developer Tools', what: 'Kubernetes in Docker: a whole cluster as containers on your laptop.', profile: 'minimal', path: ['linux/processes-and-signals', 'containers/what-is-a-container', 'containers/layers-and-cache', 'containers/tags-and-digests', 'kubernetes/desired-state', 'tools/kind'] },
  { id: 'tilt', name: 'Tilt', category: 'Developer Tools', what: 'Watches your files and rebuilds and redeploys to the cluster as you save.', profile: 'minimal', path: ['linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'linux/files-and-paths', 'platform/bring-it-home', 'tools/tilt'] },
  { id: 'helm', name: 'Helm', category: 'Orchestration', what: 'Packages Kubernetes apps as versioned, configurable charts.', profile: 'minimal', path: ['linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'git/what-is-git', 'platform/gitops', 'tools/helm'] },
  { id: 'flux', name: 'Flux', category: 'GitOps', what: 'Keeps the cluster matching what is in git, and installs Helm charts declaratively.', profile: 'minimal', lesson: '/learn/platform/gitops/', path: ['linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'git/what-is-git', 'platform/gitops', 'tools/flux'] },
  { id: 'gateway-api', name: 'Gateway API', partOf: 'Kubernetes (kubernetes-sigs)', category: 'Networking', what: 'The Kubernetes standard for routing traffic in from outside, by hostname and path.', profile: 'minimal', path: ['linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'network/ports-and-tcp', 'network/load-balancers', 'tools/gateway-api'] },
  { id: 'istio', name: 'Istio', category: 'Networking', what: 'A service mesh: encrypts and controls traffic between services without changing them.', profile: 'minimal', lesson: '/learn/platform/service-mesh/', path: ['web/request-journey', 'web/tls-trust', 'linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'platform/service-mesh', 'tools/istio'] },
  { id: 'cert-manager', name: 'cert-manager', category: 'Security & Policy', what: 'Issues and renews TLS certificates automatically, including from your own CA.', profile: 'minimal', lesson: '/learn/web/tls-trust/', path: ['web/request-journey', 'web/tls-trust', 'linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'tools/cert-manager'] },
  { id: 'prometheus', name: 'Prometheus', category: 'Observability', what: 'Scrapes and stores metrics, and answers questions about them over time.', profile: 'observability', lesson: '/learn/platform/observability/', path: ['linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'platform/observability', 'sre/slos', 'tools/prometheus'] },
  { id: 'grafana', name: 'Grafana', category: 'Observability', what: 'Dashboards over metrics, logs and traces.', profile: 'observability', path: ['linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'platform/observability', 'sre/three-signals', 'tools/grafana'] },
  { id: 'loki', name: 'Loki', landscape: 'Grafana Loki', category: 'Observability', what: 'Stores logs indexed only by labels, which keeps it cheap.', profile: 'observability', path: ['linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'platform/observability', 'sre/three-signals', 'tools/loki'] },
  { id: 'tempo', name: 'Tempo', landscape: 'Grafana Tempo', category: 'Observability', what: 'Stores distributed traces: the path one request took through every service.', profile: 'observability', path: ['linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'platform/observability', 'sre/three-signals', 'tools/tempo'] },
  { id: 'kiali', name: 'Kiali', category: 'Observability', what: 'Draws the service mesh: who talks to whom, and whether it is encrypted.', profile: 'observability', path: ['web/request-journey', 'web/tls-trust', 'linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'platform/service-mesh', 'tools/kiali'] },
  { id: 'metrics-server', name: 'metrics-server', partOf: 'Kubernetes (kubernetes-sigs)', category: 'Observability', what: 'The live CPU and memory numbers that autoscalers and kubectl top read.', profile: 'observability', path: ['linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'kubernetes/scheduling', 'sre/autoscaling', 'tools/metrics-server'] },
  { id: 'crossplane', name: 'Crossplane', category: 'Infrastructure', what: 'Defines your own Kubernetes APIs that create infrastructure and apps.', profile: 'gitops', path: ['delivery/infrastructure-as-code', 'linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'tools/crossplane'] },
  { id: 'flagger', name: 'Flagger', partOf: 'Flux', category: 'GitOps', what: 'Progressive delivery: shifts traffic to a new version and rolls back on bad metrics.', profile: 'gitops', path: ['linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'kubernetes/rollouts', 'delivery/release-strategies', 'tools/flagger'] },
  { id: 'external-secrets', name: 'External Secrets Operator', landscape: 'external-secrets', category: 'Security & Policy', what: 'Copies secrets from a vault or cloud store into Kubernetes Secrets.', profile: 'gitops', path: ['git/what-is-git', 'security/secrets-in-git', 'linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'tools/external-secrets'] },
  { id: 'cloudnative-pg', name: 'CloudNativePG', category: 'Databases', what: 'Runs PostgreSQL on Kubernetes with failover and backups handled by an operator.', profile: 'gitops', path: ['databases/sql-basics', 'databases/replication', 'linux/processes-and-signals', 'containers/what-is-a-container', 'kubernetes/desired-state', 'tools/cloudnative-pg'] },

  // ---- toggles in tilt-config.json
  { id: 'harbor', name: 'Harbor', category: 'CI/CD', what: 'A container registry with vulnerability scanning and access control.', tilt: 'crossplane_apps.harbor' },
  { id: 'jenkins', name: 'Jenkins', category: 'CI/CD', what: 'The long-standing automation server for build and deploy pipelines.', tilt: 'crossplane_apps.jenkins' },
  { id: 'langfuse', name: 'Langfuse', category: 'AI/ML', what: 'Traces and evaluates LLM calls: prompts, outputs, cost and latency.', tilt: 'crossplane_apps.langfuse', lesson: '/learn/llm/run-your-own/' },
  { id: 'qdrant', name: 'Qdrant', category: 'AI/ML', what: 'A vector database: finds text by meaning, the retrieval half of RAG.', tilt: 'crossplane_apps.qdrant', lesson: '/learn/llm/run-your-own/' },
  { id: 'localstack', name: 'LocalStack', category: 'Cloud Emulators', what: 'Emulates AWS services locally (some features need a LocalStack account).', tilt: 'crossplane_apps.localstack' },
  { id: 'ollama', name: 'Ollama', category: 'AI/ML', what: 'Downloads and runs open language models locally behind a simple API.', tilt: 'flux_apps.ollama', lesson: '/learn/llm/run-your-own/' },
  { id: 'kyverno', name: 'Kyverno', category: 'Security & Policy', what: 'Policies as Kubernetes resources: validate, mutate or block what gets created.', tilt: 'flux_apps.kyverno', lesson: '/learn/platform/policy-and-security/' },
  { id: 'falco', name: 'Falco', category: 'Security & Policy', what: 'Watches system calls at runtime and alerts on suspicious behaviour.', tilt: 'flux_apps.falco', lesson: '/learn/platform/policy-and-security/' },
  { id: 'policy-reporter', name: 'Policy Reporter', partOf: 'Kyverno', category: 'Security & Policy', what: 'A UI and alerts for Kyverno policy results.', tilt: 'flux_apps.policy-reporter' },
  { id: '1pass', name: '1Password Connect', category: 'Security & Policy', what: 'Serves secrets from 1Password to the cluster.', tilt: 'flux_apps.1pass' },
  { id: 'keda', name: 'KEDA', category: 'Infrastructure', what: 'Scales workloads on events - queue length, schedules, metrics - down to zero.', tilt: 'flux_apps.keda' },
  { id: 'velero', name: 'Velero', category: 'Infrastructure', what: 'Backs up and restores cluster resources and volumes.', tilt: 'flux_apps.velero' },
  { id: 'trivy', name: 'Trivy', category: 'Security & Policy', what: 'Scans images and clusters for vulnerabilities and misconfigurations.', tilt: 'flux_apps.trivy', lesson: '/learn/platform/policy-and-security/' },
  { id: 'otel-collector', name: 'OpenTelemetry Collector', landscape: 'OpenTelemetry', category: 'Observability', what: 'Receives, processes and forwards metrics, logs and traces in one standard format.', tilt: 'flux_apps.otel-collector' },
  { id: 'nats', name: 'NATS', category: 'Messaging', what: 'Fast, lightweight messaging between services.', tilt: 'flux_apps.nats' },
  { id: 'dapr', name: 'Dapr', category: 'Infrastructure', what: 'Building blocks for distributed apps - state, pub/sub, retries - behind one API.', tilt: 'flux_apps.dapr' },
  { id: 'argo-workflows', name: 'Argo Workflows', landscape: 'Argo', category: 'CI/CD', what: 'Runs multi-step workflows as Kubernetes pods.', tilt: 'flux_apps.argo-workflows' },
  { id: 'argocd', name: 'Argo CD', landscape: 'Argo', category: 'GitOps', what: 'GitOps delivery with a UI: syncs the cluster to git and shows the drift.', tilt: 'flux_apps.argocd' },
  { id: 'opencost', name: 'OpenCost', category: 'Observability', what: 'Shows what each namespace and workload costs to run.', tilt: 'flux_apps.opencost' },
  { id: 'thanos', name: 'Thanos', category: 'Observability', what: 'Long-term, highly available storage for Prometheus metrics.', tilt: 'flux_apps.thanos' },
  { id: 'headlamp', name: 'Headlamp', category: 'Developer Portal', what: 'A friendly web UI for exploring and managing a cluster.', tilt: 'flux_apps.headlamp' },
  { id: 'backstage', name: 'Backstage', category: 'Developer Portal', what: 'A developer portal: a catalog of every service, its owners and its docs.', tilt: 'raw_apps.backstage' },
  { id: 'mongodb', name: 'MongoDB', category: 'Databases', what: 'A document database storing JSON-like records.', tilt: 'raw_apps.mongodb' },
  { id: 'postgresql', name: 'PostgreSQL', category: 'Databases', what: 'The open-source relational database most teams reach for first.', tilt: 'raw_apps.postgresql' },
  { id: 'redis', name: 'Redis', category: 'Databases', what: 'An in-memory store for caches, queues and counters.', tilt: 'raw_apps.redis' },
  { id: 'rabbitmq', name: 'RabbitMQ', category: 'Messaging', what: 'A message broker: queues that decouple who sends work from who does it.', tilt: 'raw_apps.rabbitmq' },
  { id: 'mssql', name: 'Microsoft SQL Server', category: 'Databases', what: 'Microsoft\'s relational database, in its Linux container edition.', tilt: 'raw_apps.mssql' },
  { id: 'keycloak', name: 'Keycloak', category: 'Identity', what: 'Single sign-on and identity: logins, users, groups, OAuth and OIDC.', tilt: 'raw_apps.keycloak' },
  { id: 'airflow', name: 'Apache Airflow', category: 'Workflow', what: 'Schedules and monitors data pipelines written as Python.', tilt: 'raw_apps.airflow' },
  { id: 'jupyterhub', name: 'JupyterHub', category: 'AI/ML', what: 'Notebooks for many users at once - the classic place to try ML code.', tilt: 'raw_apps.jupyterhub' },
  { id: 'wordpress', name: 'WordPress', category: 'Demo Apps', what: 'The blog engine, here as a familiar app to deploy and break.', tilt: 'raw_apps.wordpress' },
  { id: 'mailhog', name: 'MailHog', category: 'Developer Tools', what: 'Catches email your apps send, so you can read it without sending it.', tilt: 'raw_apps.mailhog' },
  { id: 'azurite', name: 'Azurite', category: 'Cloud Emulators', what: 'Emulates Azure Storage locally.', tilt: 'raw_apps.azurite' },
  { id: 'gcp-emulators', name: 'GCP emulators', category: 'Cloud Emulators', what: 'Google Cloud\'s local emulators for services such as Pub/Sub.', tilt: 'raw_apps.gcp-emulators' },
  { id: 'wazuh', name: 'Wazuh', category: 'Security & Policy', what: 'Security monitoring and SIEM: collects and correlates security events.', tilt: 'raw_apps.wazuh' },
  { id: 'knative', name: 'Knative', category: 'Infrastructure', what: 'Serverless on Kubernetes: scale to zero and back on demand.', tilt: 'raw_apps.knative' },
  { id: 'kubevirt', name: 'KubeVirt', category: 'Infrastructure', what: 'Runs virtual machines as Kubernetes resources, next to containers.', tilt: 'raw_apps.kubevirt' },
];
