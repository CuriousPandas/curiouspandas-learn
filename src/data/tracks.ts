// The curriculum map. Every lesson is listed here whether or not it is written,
// because a learner deciding where to start deserves to see the whole forest.
// status 'ready' must have an MDX file and 'soon' must not; the lesson route
// throws at build time otherwise (src/lib/curriculum.ts), so a finished lesson
// cannot hide and an empty one cannot pass for finished.

export type Tier = 'browser' | 'browser-plus' | 'machine' | 'codespace';

export const TIERS: Record<Tier, { label: string; short: string; detail: string }> = {
  browser: { label: 'Runs in your browser', short: 'Browser', detail: 'Any laptop, Chromebook or phone. Nothing to install, nothing leaves your device.' },
  'browser-plus': { label: 'Browser, uses your GPU', short: 'Browser+', detail: 'Optional extras that need WebGPU or a bit more memory. The page checks first and tells you plainly if your device cannot.' },
  machine: { label: 'On your machine', short: 'Your machine', detail: 'The real tools on your own computer: a terminal for git and Linux, or, for the cluster labs, Docker, kind and Tilt via TemplateMechanics/tilt (about 15 GB of free disk and 8 GB of RAM).' },
  codespace: { label: 'In a free cloud dev box', short: 'Codespace', detail: 'For when your machine cannot run the platform: a dev container on your own free cloud quota. Planned, not built yet.' },
};

export type LessonPlan = { slug: string; title: string; status: 'ready' | 'soon' };
export type Track = { id: string; title: string; tagline: string; icon: string; hue: number; lessons: LessonPlan[] };

export const TRACKS: Track[] = [
  {
    id: 'linux', title: 'Linux & the Shell', tagline: 'Files, processes and pipes - the ground every other tool stands on.', icon: 'terminal', hue: 90,
    lessons: [
      { slug: 'files-and-paths', title: 'Everything is a file', status: 'ready' },
      { slug: 'processes-and-signals', title: 'Processes, signals and exit codes', status: 'ready' },
      { slug: 'permissions', title: 'Who may touch this file', status: 'ready' },
      { slug: 'pipes', title: 'Small tools, joined by pipes', status: 'ready' },
    ],
  },
  {
    id: 'git', title: 'Git', tagline: 'Save every version of everything, and never fear an experiment again.', icon: 'branch', hue: 150,
    lessons: [
      { slug: 'what-is-git', title: 'Snapshots with names', status: 'ready' },
      { slug: 'branches', title: 'Branches are just names', status: 'ready' },
      { slug: 'conflicts', title: 'Conflicts are honesty', status: 'ready' },
      { slug: 'inside-git', title: 'Look inside .git', status: 'ready' },
      { slug: 'collaborate', title: 'Remotes, pull requests and review', status: 'soon' },
    ],
  },
  {
    id: 'network', title: 'Networking', tagline: 'Addresses, ports and handshakes - how machines find and talk to each other.', icon: 'network', hue: 240,
    lessons: [
      { slug: 'ip-and-subnets', title: 'Addresses and subnets', status: 'soon' },
      { slug: 'ports-and-tcp', title: 'Ports, sockets and the handshake', status: 'soon' },
      { slug: 'dns-deep', title: 'How a name becomes an address', status: 'soon' },
      { slug: 'load-balancers', title: 'Load balancers and proxies', status: 'soon' },
    ],
  },
  {
    id: 'web', title: 'How the Web Works', tagline: 'DNS, HTTP and TLS - and why a 200 can still be broken.', icon: 'globe', hue: 205,
    lessons: [
      { slug: 'request-journey', title: 'What happens when you press Enter', status: 'ready' },
      { slug: 'status-codes-lie', title: 'A 200 can still be broken', status: 'ready' },
      { slug: 'tls-trust', title: 'Two TLS errors, one message', status: 'ready' },
    ],
  },
  {
    id: 'containers', title: 'Containers', tagline: 'A process that thinks it is alone - and the images that ship it.', icon: 'box', hue: 25,
    lessons: [
      { slug: 'what-is-a-container', title: 'A process that thinks it is alone', status: 'ready' },
      { slug: 'layers-and-cache', title: 'Layers and the build cache', status: 'ready' },
      { slug: 'tags-and-digests', title: 'Tags move, digests do not', status: 'ready' },
    ],
  },
  {
    id: 'kubernetes', title: 'Kubernetes', tagline: 'A machine for keeping promises - and reading why it could not.', icon: 'wheel', hue: 220,
    lessons: [
      { slug: 'desired-state', title: 'Desired state and self-healing', status: 'ready' },
      { slug: 'scheduling', title: 'Why won\'t it schedule?', status: 'ready' },
      { slug: 'restarts', title: 'Why did it restart?', status: 'ready' },
      { slug: 'admission', title: 'The pods that were never born', status: 'ready' },
      { slug: 'rollouts', title: 'A typo is not an outage', status: 'ready' },
    ],
  },
  {
    id: 'delivery', title: 'Delivery: CI/CD & IaC', tagline: 'From a pushed commit to running in production - and back out again safely.', icon: 'send', hue: 300,
    lessons: [
      { slug: 'pipelines', title: 'A pipeline on every push', status: 'soon' },
      { slug: 'infrastructure-as-code', title: 'Plan, apply, drift', status: 'soon' },
      { slug: 'release-strategies', title: 'Canary, blue-green and the rollback', status: 'soon' },
    ],
  },
  {
    id: 'platform', title: 'Platform & CNCF', tagline: 'GitOps, observability, meshes and policy - the tools that run the tools.', icon: 'layers', hue: 275,
    lessons: [
      { slug: 'gitops', title: 'Git as the source of truth', status: 'ready' },
      { slug: 'observability', title: 'The dashboard that lies', status: 'ready' },
      { slug: 'service-mesh', title: 'Meshes, mTLS and invisible proof', status: 'ready' },
      { slug: 'policy-and-security', title: 'Policy, scanning and runtime security', status: 'ready' },
      { slug: 'bring-it-home', title: 'Run the real platform', status: 'ready' },
    ],
  },
  {
    // Every exercise attacks a toy inside the page and is taught from the
    // defender's side. Nothing here points a learner at a system they do not own.
    id: 'security', title: 'Security', tagline: 'How things get broken into - and the habits that stop it.', icon: 'lock', hue: 0,
    lessons: [
      { slug: 'secrets-in-git', title: 'Deleted is not gone', status: 'ready' },
      { slug: 'passwords-and-hashing', title: 'Why slow hashes win', status: 'ready' },
      { slug: 'web-flaws', title: 'When input becomes code', status: 'ready' },
      { slug: 'supply-chain', title: 'Trusting what you ship', status: 'ready' },
      { slug: 'cluster-access', title: 'Who can do what in a cluster', status: 'ready' },
      { slug: 'identity', title: 'Who are you, really?', status: 'ready' },
    ],
  },
  {
    id: 'ml', title: 'Machine Learning', tagline: 'A function with knobs, and the maths that turns them.', icon: 'spark', hue: 330,
    lessons: [
      { slug: 'what-is-learning', title: 'Learning is turning knobs', status: 'ready' },
      { slug: 'neural-networks', title: 'Why hidden layers exist', status: 'ready' },
      { slug: 'overfitting', title: 'Memorising is not learning', status: 'ready' },
    ],
  },
  {
    id: 'llm', title: 'LLMs & Inference', tagline: 'Tokens, attention, and why serving a model is a memory problem.', icon: 'chat', hue: 45,
    lessons: [
      { slug: 'tokens', title: 'Text becomes tokens', status: 'ready' },
      { slug: 'next-token', title: 'One token at a time', status: 'ready' },
      { slug: 'attention', title: 'Attention, without the maths first', status: 'ready' },
      { slug: 'serving-vllm', title: 'Why vLLM is fast', status: 'ready' },
      { slug: 'run-your-own', title: 'Run your own model', status: 'ready' },
    ],
  },
  {
    id: 'frontiers', title: 'SI Frontiers', tagline: 'Agents, alignment and superintelligence - what is known, and what is not.', icon: 'compass', hue: 180,
    lessons: [
      { slug: 'agents', title: 'Agents are loops with tools', status: 'ready' },
      { slug: 'alignment', title: 'Getting what you asked for', status: 'ready' },
      { slug: 'superintelligence', title: 'Superintelligence, honestly', status: 'ready' },
    ],
  },
];

export const trackById = (id: string) => TRACKS.find((t) => t.id === id);
