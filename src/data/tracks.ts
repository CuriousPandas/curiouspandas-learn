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
export type TrackGroup = 'systems' | 'foundations';
export type Track = { id: string; group?: TrackGroup; title: string; tagline: string; icon: string; hue: number; lessons: LessonPlan[] };

// Two maps, because they answer different questions. Thirty-odd cards in one grid
// told a beginner nothing about where they stood.
export const TRACK_GROUPS: { id: TrackGroup; title: string; blurb: string }[] = [
  { id: 'systems', title: 'Build and run real systems', blurb: 'Roughly in order: each trail leans on the ones before it.' },
  { id: 'foundations', title: 'How computers and programs work', blurb: 'The ideas underneath everything else. New to code? Start with Programming from Zero.' },
];
export const groupOf = (t: { group?: TrackGroup }): TrackGroup => t.group ?? 'systems';

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
      { slug: 'collaborate', title: 'Remotes, pull requests and review', status: 'ready' },
      { slug: 'branching-strategies', title: 'Git Flow, GitHub Flow and trunk-based', status: 'ready' },
      { slug: 'merge-rebase-squash', title: 'Merge, rebase or squash', status: 'ready' },
    ],
  },
  {
    id: 'network', title: 'Networking', tagline: 'Addresses, ports and handshakes - how machines find and talk to each other.', icon: 'network', hue: 240,
    lessons: [
      { slug: 'ip-and-subnets', title: 'Addresses and subnets', status: 'ready' },
      { slug: 'ports-and-tcp', title: 'Ports, sockets and the handshake', status: 'ready' },
      { slug: 'dns-deep', title: 'How a name becomes an address', status: 'ready' },
      { slug: 'load-balancers', title: 'Load balancers and proxies', status: 'ready' },
    ],
  },
  {
    id: 'web', title: 'How the Web Works', tagline: 'DNS, HTTP and TLS - and why a 200 can still be broken.', icon: 'globe', hue: 205,
    lessons: [
      { slug: 'request-journey', title: 'What happens when you press Enter', status: 'ready' },
      { slug: 'status-codes-lie', title: 'A 200 can still be broken', status: 'ready' },
      { slug: 'tls-trust', title: 'Two TLS errors, one exit code', status: 'ready' },
    ],
  },
  {
    id: 'databases', title: 'Databases', tagline: 'Where the data lives - and how not to lose it, corrupt it or wait on it.', icon: 'database', hue: 120,
    lessons: [
      { slug: 'sql-basics', title: 'Tables, queries and joins', status: 'ready' },
      { slug: 'indexes', title: 'Why one query takes 2 ms and another 20 s', status: 'ready' },
      { slug: 'transactions', title: 'Transactions and the lost update', status: 'ready' },
      { slug: 'replication', title: 'Replicas, lag and why a replica is not a backup', status: 'ready' },
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
      { slug: 'pipelines', title: 'A pipeline on every push', status: 'ready' },
      { slug: 'infrastructure-as-code', title: 'Plan, apply, drift', status: 'ready' },
      { slug: 'release-strategies', title: 'Canary, blue-green and the rollback', status: 'ready' },
      { slug: 'release-automation', title: 'Commit messages that cut releases', status: 'ready' },
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
    id: 'sre', title: 'SRE & Observability', tagline: 'How reliable is reliable enough - and how you would know.', icon: 'gauge', hue: 165,
    lessons: [
      { slug: 'slos', title: 'SLOs and the error budget', status: 'ready' },
      { slug: 'three-signals', title: 'Logs, metrics and traces', status: 'ready' },
      { slug: 'autoscaling', title: 'Scaling before it hurts', status: 'ready' },
    ],
  },
  {
    id: 'resilience', title: 'Resilience: DR & Business Continuity', tagline: 'When the building, the region or the backups fail - what you lose, and how fast you are back.', icon: 'lifebuoy', hue: 345,
    lessons: [
      { slug: 'rpo-rto', title: 'How much can you lose?', status: 'ready' },
      { slug: 'backups-that-restore', title: 'Backups that actually restore', status: 'ready' },
      { slug: 'dr-strategies', title: 'From backup-and-restore to active-active', status: 'ready' },
      { slug: 'business-continuity', title: 'Keeping the business running', status: 'ready' },
      { slug: 'incidents', title: 'Incidents and blameless postmortems', status: 'ready' },
    ],
  },
  {
    // Lessons 6 and 7 come first because the rest point at them: the Strangler
    // Lab is where "compared, not compared, served by" gets taught.
    id: 'change', title: 'Changing Running Software', tagline: 'Replace a system while people are using it - and prove each step did what it said.', icon: 'vine', hue: 315,
    lessons: [
      { slug: 'rewrite-or-evolve', title: 'Most rewrites ship late, and some never ship', status: 'ready' },
      { slug: 'characterization-tests', title: 'Pin what it does before you change what it should do', status: 'ready' },
      { slug: 'branch-by-abstraction', title: 'Branch by abstraction, and delete the flag', status: 'ready' },
      { slug: 'expand-contract-schemas', title: 'A sub-second migration, a 15-second outage', status: 'ready' },
      { slug: 'evolving-apis', title: "Every observable behaviour is somebody's contract", status: 'ready' },
      { slug: 'prove-it-in-production', title: 'A mirror that compares nothing', status: 'ready' },
      { slug: 'strangler-fig', title: 'Strangle it one route at a time', status: 'ready' },
      { slug: 'boundaries-and-teams', title: 'Your architecture copies your org chart', status: 'ready' },
      { slug: 'decommissioning', title: 'Switching it off is the riskiest change', status: 'ready' },
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
    // Agents here run against simulated models and tools in the page: no API
    // keys, no calls out (the sandbox test forbids fetch). The real thing is a
    // "Do it for real" on the learner's own machine and account.
    id: 'agents', title: 'Build AI Agents', tagline: 'A model, a loop and some tools - and how to trust it with real work.', icon: 'bot', hue: 15,
    lessons: [
      { slug: 'what-is-an-agent', title: 'A model, a loop and some tools', status: 'ready' },
      { slug: 'tools', title: 'Tools: how a model touches the world', status: 'ready' },
      { slug: 'workflows-vs-agents', title: 'Workflows first, agents when you must', status: 'ready' },
      { slug: 'guardrails-and-evals', title: 'Guardrails, approvals and evals', status: 'ready' },
      { slug: 'business-agents', title: 'Agents that help run a business', status: 'ready' },
    ],
  },
  {
    id: 'frontiers', title: 'SI Frontiers', tagline: 'Alignment and superintelligence - what is known, and what is not.', icon: 'compass', hue: 180,
    lessons: [
      { slug: 'alignment', title: 'Getting what you asked for', status: 'ready' },
      { slug: 'superintelligence', title: 'Superintelligence, honestly', status: 'ready' },
    ],
  },
  {
    id: 'launch', title: 'Idea to Market', tagline: 'From a problem worth solving to people paying for the solution.', icon: 'flag', hue: 75,
    lessons: [
      { slug: 'validate', title: 'Is the problem real?', status: 'ready' },
      { slug: 'mvp', title: 'The smallest thing worth shipping', status: 'ready' },
      { slug: 'pricing', title: 'Pricing and the numbers that keep you alive', status: 'ready' },
      { slug: 'first-users', title: 'Launch and find your first users', status: 'ready' },
      { slug: 'business-basics', title: 'The boring essentials: company, terms, taxes', status: 'ready' },
    ],
  },
  {
    // One lesson per Tool Atlas tool: what it is for, how it quietly goes wrong,
    // and running it for real on tilt. Each closes that tool's learning path
    // (src/data/tools.ts). Titles here are the tool names until each is written.
    id: 'tools', title: 'One Tool at a Time', tagline: 'The tools the tilt platform runs, one by one: what each is for, and how each quietly goes wrong.', icon: 'wrench', hue: 195,
    lessons: [
      { slug: 'kubernetes', title: 'A Kubernetes Service that selects nobody', status: 'ready' },
      { slug: 'kind', title: 'kind and the Kubernetes version nobody chose', status: 'ready' },
      { slug: 'tilt', title: 'Tilt stays green and never re-runs', status: 'ready' },
      { slug: 'helm', title: 'Helm upgraded the chart, not its CRDs', status: 'ready' },
      { slug: 'flux', title: 'A suspended Flux release still says Ready', status: 'ready' },
      { slug: 'gateway-api', title: 'Gateway API and the route that attached to nothing', status: 'ready' },
      { slug: 'istio', title: 'Istio and the mesh that still accepts plaintext', status: 'ready' },
      { slug: 'cert-manager', title: "cert-manager and the issuer it couldn't find", status: 'ready' },
      { slug: 'prometheus', title: "Prometheus and the alert that can't fire on nothing", status: 'ready' },
      { slug: 'grafana', title: "Grafana and the data source that can't answer", status: 'ready' },
      { slug: 'loki', title: 'Loki and the log line that never arrived', status: 'ready' },
      { slug: 'tempo', title: 'Tempo and the request nobody sampled', status: 'ready' },
      { slug: 'kiali', title: 'Kiali and the graph that only shows what was measured', status: 'ready' },
      { slug: 'metrics-server', title: 'metrics-server and the autoscaler that reads unknown', status: 'ready' },
      { slug: 'crossplane', title: 'Crossplane and the patch that silently did nothing', status: 'ready' },
      { slug: 'flagger', title: 'Flagger skipped the analysis and said Succeeded', status: 'ready' },
      { slug: 'external-secrets', title: 'External Secrets and the value that stopped updating', status: 'ready' },
      { slug: 'cloudnative-pg', title: "CloudNativePG and the Ready replica that's behind", status: 'ready' },
    ],
  },
  {
    // Flow and forecasts come first because the Flow Lab is the measuring
    // instrument the other lessons point at.
    id: 'agile', title: 'Agile, Scrum & Flow', tagline: 'What the guides actually say, what the evidence actually shows - and how to tell a team working from one performing.', icon: 'crew', hue: 60,
    lessons: [
      { slug: 'manifesto', title: 'Four values and a "while"', status: 'ready' },
      { slug: 'scrum-guide', title: 'Scrum as written, not as rumoured', status: 'ready' },
      { slug: 'flow', title: 'Count the work, then limit it', status: 'ready' },
      { slug: 'forecasts', title: 'Forecasts, not promises', status: 'ready' },
      { slug: 'xp', title: 'The engineering Scrum leaves out', status: 'ready' },
      { slug: 'teams', title: 'What the evidence says about teams', status: 'ready' },
      { slug: 'scaling', title: 'Frameworks for many teams', status: 'ready' },
      { slug: 'in-name-only', title: "Agile in name only: how you'd know", status: 'ready' },
    ],
  },
  // ---- How computers and programs work --------------------------------------
  // Measured against CS2023 (src/data/cs2023-coverage.json, shown at /coverage/):
  // every lesson below closes at least one of its knowledge units, and
  // tests/cs-coverage.test.ts fails when the map and this list disagree.
  {
    id: 'programming', group: 'foundations', title: 'Programming from Zero', tagline: 'Your first line of code to your first real program, in the browser, with nothing to install.', icon: 'play', hue: 45,
    lessons: [
      { slug: 'first-program', title: 'Tell a computer what to do', status: 'soon' },
      { slug: 'values-and-variables', title: 'Values, names and types', status: 'soon' },
      { slug: 'decisions', title: 'If, and the else you forgot', status: 'soon' },
      { slug: 'loops', title: 'Doing it again, and knowing when to stop', status: 'soon' },
      { slug: 'functions', title: 'Functions: name a job, reuse it', status: 'soon' },
      { slug: 'lists', title: 'Lists of things', status: 'soon' },
      { slug: 'records-and-maps', title: 'Records, maps and sets', status: 'soon' },
      { slug: 'text', title: 'Text is harder than it looks', status: 'soon' },
      { slug: 'input-and-errors', title: 'Bad input and things going wrong', status: 'soon' },
      { slug: 'debugging', title: 'Read the error, then use the debugger', status: 'soon' },
      { slug: 'your-first-tests', title: 'Write the test that could fail', status: 'soon' },
      { slug: 'readable-code', title: 'Code your future self can read', status: 'soon' },
      { slug: 'recursion', title: 'A function that calls itself', status: 'soon' },
      { slug: 'real-program', title: 'Build a whole small program', status: 'soon' },
      { slug: 'shell-scripts', title: 'From one-liners to a shell script', status: 'soon' },
      { slug: 'whose-code', title: 'Copying, credit, and code an AI wrote', status: 'soon' },
    ],
  },
  {
    id: 'algorithms', group: 'foundations', title: 'Algorithms & Data Structures', tagline: 'Why one way of doing a job takes a second and another takes a century.', icon: 'branch', hue: 275,
    lessons: [
      { slug: 'what-is-an-algorithm', title: 'A recipe a machine cannot misread', status: 'soon' },
      { slug: 'counting-steps', title: 'Count the steps, not the seconds', status: 'ready' },
      { slug: 'arrays-and-lists', title: 'Arrays, linked lists and the cost of inserting', status: 'soon' },
      { slug: 'stacks-and-queues', title: 'Stacks, queues and who goes next', status: 'soon' },
      { slug: 'searching', title: 'Binary search, and the bug everybody writes', status: 'soon' },
      { slug: 'sorting', title: 'Five ways to sort, and the wall at n log n', status: 'soon' },
      { slug: 'divide-and-conquer', title: 'Split it, solve it, stitch it back', status: 'soon' },
      { slug: 'hash-tables', title: 'Hash tables and the collision', status: 'soon' },
      { slug: 'trees-and-heaps', title: 'Trees, heaps and priority queues', status: 'soon' },
      { slug: 'graphs', title: 'Graphs: the shape of nearly everything', status: 'soon' },
      { slug: 'shortest-paths', title: 'Shortest paths, and how a map app answers', status: 'soon' },
      { slug: 'greedy', title: 'Greedy choices, and when they lie', status: 'soon' },
      { slug: 'dynamic-programming', title: 'Stop solving the same problem twice', status: 'soon' },
      { slug: 'growth-classes', title: 'From constant to exponential: best, worst and average', status: 'soon' },
      { slug: 'algorithms-and-people', title: 'When an algorithm decides about a person', status: 'soon' },
    ],
  },
  {
    id: 'computer', group: 'foundations', title: 'How a Machine Computes', tagline: 'From a single bit to a working CPU and a tiny compiler, every layer simulated in your browser.', icon: 'cpu', hue: 15,
    lessons: [
      { slug: 'bits-and-bases', title: 'Everything is bits', status: 'soon' },
      { slug: 'negative-numbers', title: 'Negative numbers and the overflow that wraps', status: 'soon' },
      { slug: 'floating-point', title: 'Why 0.1 + 0.2 is not 0.3', status: 'soon' },
      { slug: 'text-and-images-as-bytes', title: 'Text, Unicode and pictures as bytes', status: 'soon' },
      { slug: 'gates', title: 'One gate to build them all', status: 'soon' },
      { slug: 'adder', title: 'Build an adder from gates', status: 'soon' },
      { slug: 'clocks-and-memory', title: 'Flip-flops, registers and the clock', status: 'soon' },
      { slug: 'toy-cpu', title: 'Fetch, decode, execute', status: 'soon' },
      { slug: 'assembly', title: 'Assembly: jumps, calls and the stack', status: 'soon' },
      { slug: 'pipelining', title: 'Pipelines, hazards and the branch it guessed', status: 'soon' },
      { slug: 'caches', title: 'The same loop, fifty times slower', status: 'soon' },
      { slug: 'latency-numbers', title: 'Memory, disk, network: a sense of scale', status: 'soon' },
      { slug: 'tiny-compiler-parse', title: 'A tiny compiler, part one: text to tree', status: 'soon' },
      { slug: 'tiny-compiler-generate', title: 'A tiny compiler, part two: tree to machine code', status: 'soon' },
      { slug: 'speculation-leak', title: 'The secret the cache gave away', status: 'soon' },
      { slug: 'many-small-brains', title: 'Multicore, SIMD and why GPUs exist', status: 'soon' },
      { slug: 'energy', title: 'What a computation costs in joules', status: 'soon' },
      { slug: 'qubits', title: 'A qubit in your browser', status: 'soon' },
    ],
  },
  {
    id: 'math', group: 'foundations', title: 'Maths for Computing', tagline: 'Logic, proof, chance, statistics, vectors and rates of change, starting from school algebra and always in code.', icon: 'compass', hue: 195,
    lessons: [
      { slug: 'logic', title: 'And, or, not, and the trap in implies', status: 'soon' },
      { slug: 'sets-and-functions', title: 'Sets, relations and functions', status: 'soon' },
      { slug: 'proof', title: 'How you know it is true for every number', status: 'soon' },
      { slug: 'counting', title: 'Counting without counting', status: 'soon' },
      { slug: 'modular-arithmetic', title: 'Clock arithmetic', status: 'soon' },
      { slug: 'chance', title: 'Sample spaces, events and independence', status: 'soon' },
      { slug: 'bayes', title: 'Bayes, and the test that is 99% accurate', status: 'soon' },
      { slug: 'random-variables', title: 'Expected value and the shape of chance', status: 'soon' },
      { slug: 'describing-data', title: 'Mean, median, spread, and the average that lies', status: 'soon' },
      { slug: 'samples-and-tests', title: 'Samples, confidence and the A/B test', status: 'soon' },
      { slug: 'correlation-and-regression', title: 'Correlation, regression and the line through the noise', status: 'soon' },
      { slug: 'vectors', title: 'Vectors: arrows and lists of numbers', status: 'soon' },
      { slug: 'matrices', title: 'Matrices move things', status: 'soon' },
      { slug: 'what-a-matrix-does-best', title: 'Eigenvectors and SVD on a table of ratings', status: 'soon' },
      { slug: 'rates-of-change', title: 'A derivative is a slope you can compute', status: 'soon' },
      { slug: 'adding-up-slices', title: 'An integral is a lot of thin slices', status: 'soon' },
      { slug: 'many-knobs', title: 'Gradients and the chain rule behind backprop', status: 'soon' },
    ],
  },
  {
    id: 'limits', group: 'foundations', title: 'Limits of Computing', tagline: 'What no program can ever do, what none can do quickly, and what a bit of information really is.', icon: 'flag', hue: 340,
    lessons: [
      { slug: 'finite-automata', title: 'Machines that only remember a state', status: 'soon' },
      { slug: 'regex-engine', title: 'Build a regex engine, and meet what it cannot match', status: 'soon' },
      { slug: 'grammars', title: 'Grammars and the stack that parses them', status: 'soon' },
      { slug: 'turing-machines', title: 'The simplest machine that can do anything', status: 'soon' },
      { slug: 'lambda-calculus', title: 'Computing with nothing but functions', status: 'soon' },
      { slug: 'halting', title: 'The program no one can write', status: 'soon' },
      { slug: 'p-vs-np', title: 'Easy to check, hard to find', status: 'soon' },
      { slug: 'coping-with-hard-problems', title: 'Reductions, and what you do instead of giving up', status: 'soon' },
      { slug: 'information', title: 'How many bits is a surprise?', status: 'soon' },
      { slug: 'compression', title: 'Huffman, and the file no one can shrink', status: 'soon' },
    ],
  },
  {
    id: 'concurrency', group: 'foundations', title: 'Concurrency & Agreement', tagline: 'Two things at once on one machine, then many machines trying to agree.', icon: 'crew', hue: 60,
    lessons: [
      { slug: 'threads-and-races', title: 'Two threads, one counter, the wrong answer', status: 'soon' },
      { slug: 'locks', title: 'Locks, and what they cost', status: 'soon' },
      { slug: 'deadlock', title: 'Deadlock: everyone polite, nobody moving', status: 'soon' },
      { slug: 'producers-and-consumers', title: 'Semaphores, condition variables and the bounded queue', status: 'soon' },
      { slug: 'memory-ordering', title: 'Your CPU reordered that', status: 'soon' },
      { slug: 'async-and-event-loops', title: 'One thread, many waits: the event loop', status: 'soon' },
      { slug: 'message-passing', title: 'Share nothing: channels and RPC', status: 'soon' },
      { slug: 'speedup', title: 'Amdahl and the core that did not help', status: 'soon' },
      { slug: 'map-reduce', title: 'Divide the work across machines', status: 'soon' },
      { slug: 'logical-clocks', title: 'No clock agrees, so count events instead', status: 'soon' },
      { slug: 'consistency-and-partitions', title: 'Linearizable, eventual, and the network that split', status: 'soon' },
      { slug: 'consensus', title: 'Getting five machines to agree on one thing', status: 'soon' },
      { slug: 'safety-and-liveness', title: 'Nothing bad, and something good, eventually', status: 'soon' },
    ],
  },
  {
    id: 'languages', group: 'foundations', title: 'Programming Languages & Paradigms', tagline: 'Why languages differ, what each idea buys you, and what happens underneath when your code runs.', icon: 'chat', hue: 300,
    lessons: [
      { slug: 'what-a-language-is', title: 'Syntax, meaning, compiled and interpreted', status: 'soon' },
      { slug: 'types', title: 'What a type system actually promises', status: 'soon' },
      { slug: 'type-safety', title: 'The bug the compiler caught, and the one it did not', status: 'soon' },
      { slug: 'objects', title: 'Objects: data that carries its behaviour', status: 'soon' },
      { slug: 'inheritance-and-dispatch', title: 'Inheritance, interfaces and which method runs', status: 'soon' },
      { slug: 'functional', title: 'Functions as values: map, filter and immutability', status: 'soon' },
      { slug: 'closures-and-laziness', title: 'Closures, laziness and infinite lists', status: 'soon' },
      { slug: 'logic-programming', title: 'Say what is true, let it find the answer', status: 'soon' },
      { slug: 'event-driven', title: 'Events and handlers', status: 'soon' },
      { slug: 'stack-and-heap', title: 'Stack, heap and where your variables live', status: 'soon' },
      { slug: 'garbage-collection', title: 'Who frees the memory', status: 'soon' },
      { slug: 'tiny-interpreter', title: 'Write an interpreter: scope, binding and calls', status: 'soon' },
      { slug: 'program-analysis', title: 'What a linter can know, and what it never can', status: 'soon' },
      { slug: 'language-design', title: 'Exceptions, macros and domain-specific languages', status: 'soon' },
      { slug: 'who-languages-are-for', title: 'Who a language welcomes and who it shuts out', status: 'soon' },
    ],
  },
  {
    id: 'os', group: 'foundations', title: 'Inside the Operating System', tagline: 'What the kernel is doing behind the shell you already know.', icon: 'terminal', hue: 130,
    lessons: [
      { slug: 'what-an-os-does', title: 'Referee, illusionist and librarian', status: 'soon' },
      { slug: 'system-calls', title: 'The door between your program and the kernel', status: 'soon' },
      { slug: 'process-internals', title: 'fork, exec and the life of a process', status: 'soon' },
      { slug: 'cpu-scheduling', title: 'Who runs next: FCFS, round robin and starvation', status: 'soon' },
      { slug: 'virtual-memory', title: 'Every process thinks it owns the machine', status: 'soon' },
      { slug: 'page-replacement', title: 'Which page goes, and when the machine thrashes', status: 'soon' },
      { slug: 'interrupts-and-devices', title: 'Interrupts, DMA and buffers', status: 'soon' },
      { slug: 'file-systems-inside', title: 'Inodes, blocks and what rm really does', status: 'soon' },
      { slug: 'journaling', title: 'Pull the plug mid-write', status: 'soon' },
      { slug: 'redundancy', title: 'RAID, checksums and the bit that flipped', status: 'soon' },
      { slug: 'protection-models', title: 'Rings, capabilities and least privilege', status: 'soon' },
      { slug: 'virtual-machines', title: 'How one machine pretends to be several', status: 'soon' },
      { slug: 'real-time', title: 'The deadline that must not be missed', status: 'soon' },
      { slug: 'open-source-kernels', title: 'Linux: who builds it, who pays and who patches it', status: 'soon' },
    ],
  },
  {
    id: 'network-internals', group: 'foundations', title: 'Networks from the Wire Up', tagline: 'Beneath the sockets: how packets cross the world, share the air and get attacked.', icon: 'network', hue: 225,
    lessons: [
      { slug: 'packets-and-layers', title: 'Packets, layers and who runs the internet', status: 'soon' },
      { slug: 'udp-and-reliability', title: 'Building reliable delivery on an unreliable wire', status: 'soon' },
      { slug: 'flow-and-congestion', title: 'Flow control, congestion and the slow start', status: 'soon' },
      { slug: 'app-architectures', title: 'Client-server, peer-to-peer, CDNs and the edge', status: 'soon' },
      { slug: 'routing', title: 'Longest prefix wins: how routers choose', status: 'soon' },
      { slug: 'nat-and-bgp', title: 'NAT, BGP and the internet of networks', status: 'soon' },
      { slug: 'ethernet-and-switches', title: 'Frames, MAC addresses and switches', status: 'soon' },
      { slug: 'sharing-the-air', title: 'Wi-Fi and the collision you cannot hear', status: 'soon' },
      { slug: 'cells-and-handover', title: 'Cell towers and staying connected on the move', status: 'soon' },
      { slug: 'network-attacks', title: 'Spoofing, sniffing, machine-in-the-middle and DoS', status: 'soon' },
    ],
  },
  {
    id: 'data-internals', group: 'foundations', title: 'Inside the Database', tagline: 'How to model data, what the engine does with your query, and life beyond one server.', icon: 'database', hue: 100,
    lessons: [
      { slug: 'modeling', title: 'Boxes and lines before tables', status: 'soon' },
      { slug: 'keys-and-constraints', title: 'Keys and constraints: rules the database enforces', status: 'soon' },
      { slug: 'normalization', title: 'One fact in one place, and when to break that', status: 'soon' },
      { slug: 'follow-a-query', title: 'Follow one query through the engine', status: 'soon' },
      { slug: 'pages-and-b-trees', title: 'Pages, B-trees and the buffer pool', status: 'soon' },
      { slug: 'join-algorithms', title: 'How a join really runs, and how the planner picks', status: 'soon' },
      { slug: 'acid-and-recovery', title: 'ACID, and surviving a crash mid-commit', status: 'soon' },
      { slug: 'nosql', title: 'Key-value, documents and when not to', status: 'soon' },
      { slug: 'sharding', title: 'Splitting one database across machines', status: 'soon' },
      { slug: 'search-and-text', title: 'JSON, inverted indexes and Bloom filters', status: 'soon' },
      { slug: 'data-lifecycle', title: 'From creation to deletion, on purpose', status: 'soon' },
      { slug: 'exploring-data', title: 'Look at the data before you trust the model', status: 'soon' },
      { slug: 'anonymity', title: 'Anonymised data that was not, and differential privacy', status: 'soon' },
    ],
  },
  {
    id: 'craft', group: 'foundations', title: 'Software Craft', tagline: 'The everyday engineering between a program that runs and a system people can rely on.', icon: 'wrench', hue: 35,
    lessons: [
      { slug: 'requirements', title: 'Writing down what it must do', status: 'soon' },
      { slug: 'design-principles', title: 'Coupling, cohesion and hiding information', status: 'soon' },
      { slug: 'architecture-styles', title: 'Layers, events and pipelines: choosing a shape', status: 'soon' },
      { slug: 'refactoring', title: 'Refactoring: change the shape, not the behaviour', status: 'soon' },
      { slug: 'kinds-of-test', title: 'Unit, integration, system and the test pyramid', status: 'soon' },
      { slug: 'fuzzing-and-properties', title: 'Let the machine write the test cases', status: 'soon' },
      { slug: 'reliability-numbers', title: 'Faults, failures and mean time between them', status: 'soon' },
      { slug: 'contracts', title: 'Preconditions, postconditions and invariants', status: 'soon' },
      { slug: 'model-checking', title: 'Check every interleaving, not just the lucky one', status: 'soon' },
      { slug: 'working-together', title: 'Disagreement, pairing and meetings that decide', status: 'soon' },
      { slug: 'writing-docs', title: 'Documentation someone will actually use', status: 'soon' },
      { slug: 'system-design', title: 'From requirements to a high-level design', status: 'soon' },
    ],
  },
  {
    id: 'security-foundations', group: 'foundations', title: 'Security Foundations', tagline: 'The principles and the cryptography underneath the practical Security track.', icon: 'lock', hue: 355,
    lessons: [
      { slug: 'cia-and-threat-models', title: 'Confidentiality, integrity, availability, and who is attacking', status: 'soon' },
      { slug: 'symmetric-encryption', title: 'From Caesar to AES', status: 'soon' },
      { slug: 'public-key', title: 'Agreeing on a secret in front of everyone', status: 'soon' },
      { slug: 'signatures-and-macs', title: 'Proving who wrote it and that nobody changed it', status: 'soon' },
      { slug: 'memory-safety', title: 'Overflow a buffer, in a toy machine', status: 'soon' },
      { slug: 'access-control-models', title: 'Who decides: DAC, MAC, roles and attributes', status: 'soon' },
      { slug: 'malware-and-people', title: 'Viruses, worms and the email that fooled you', status: 'soon' },
      { slug: 'forensics', title: 'Reconstruct what happened from what was left behind', status: 'soon' },
      { slug: 'governance', title: 'Policies, controls and who answers for risk', status: 'soon' },
      { slug: 'law-and-disclosure', title: 'Computer crime, disclosure and doing it responsibly', status: 'soon' },
    ],
  },
  {
    id: 'ai-foundations', group: 'foundations', title: 'AI Beyond Neural Nets', tagline: 'Search, logic, uncertainty and planning, plus the classic learning methods the LLM track skips.', icon: 'bot', hue: 260,
    lessons: [
      { slug: 'what-counts-as-intelligence', title: 'The Turing test and kinds of agent', status: 'soon' },
      { slug: 'search-as-thinking', title: 'State spaces, heuristics and A*', status: 'soon' },
      { slug: 'adversarial-search', title: 'Minimax: planning against someone who hits back', status: 'soon' },
      { slug: 'knowledge-and-logic', title: 'Writing down what a machine knows', status: 'soon' },
      { slug: 'reasoning-under-uncertainty', title: 'Bayes nets and hidden Markov models', status: 'soon' },
      { slug: 'planning', title: 'From goal to a sequence of actions', status: 'soon' },
      { slug: 'classic-ml', title: 'Trees, nearest neighbours and honest metrics', status: 'soon' },
      { slug: 'clustering', title: 'Finding groups nobody labelled', status: 'soon' },
      { slug: 'reinforcement-learning', title: 'Learning from reward, and rewards that get gamed', status: 'soon' },
      { slug: 'language-before-llms', title: 'Grammars, tags and how NLP worked before transformers', status: 'soon' },
      { slug: 'seeing', title: 'Convolutions: how a machine starts to see', status: 'soon' },
      { slug: 'generated-images', title: 'Diffusion, generated pictures and how to read them', status: 'soon' },
      { slug: 'fairness-and-explanation', title: 'Biased data, fair outcomes and explaining a decision', status: 'soon' },
    ],
  },
  {
    id: 'graphics', group: 'foundations', title: 'Graphics & Visualization', tagline: 'Pixels, cameras, light and motion, drawn in the browser, plus the charts that tell the truth or do not.', icon: 'spark', hue: 320,
    lessons: [
      { slug: 'pixels-and-colour', title: 'Pixels, colour and the eye that reads them', status: 'soon' },
      { slug: 'transforms', title: 'Move, rotate, project: 3D with matrices', status: 'soon' },
      { slug: 'rasterizing', title: 'From triangle to pixels', status: 'soon' },
      { slug: 'ray-tracing', title: 'Follow the light backwards', status: 'soon' },
      { slug: 'shading', title: 'Light, materials and shadows', status: 'soon' },
      { slug: 'meshes-and-shapes', title: 'Meshes, curves and shapes defined by maths', status: 'soon' },
      { slug: 'animation', title: 'Keyframes, easing and skeletons', status: 'soon' },
      { slug: 'particles-and-physics', title: 'Particles, integration and the collision', status: 'soon' },
      { slug: 'image-filters', title: 'Blur and sharpen: filters on real pixels', status: 'soon' },
      { slug: 'charts-that-tell-the-truth', title: 'Charts that tell the truth, and charts that do not', status: 'soon' },
      { slug: 'input-and-feedback', title: 'Input, feedback and the interface loop', status: 'soon' },
      { slug: 'stereo-and-presence', title: 'Two eyes, one screen, and motion sickness', status: 'soon' },
      { slug: 'deepfakes-and-pictures', title: 'Pictures that lie and scans that leak', status: 'soon' },
    ],
  },
  {
    id: 'hci', group: 'foundations', title: 'Designing for People', tagline: 'Who is using it, what they can do, and how to find out if it works for them.', icon: 'star', hue: 170,
    lessons: [
      { slug: 'who-it-is-for', title: 'Personas, journeys and what people really do', status: 'soon' },
      { slug: 'prototypes', title: 'Paper first: cheap prototypes and iteration', status: 'soon' },
      { slug: 'interface-principles', title: 'Patterns, constraints and the usability trade-off', status: 'soon' },
      { slug: 'usability-tests', title: 'Watch five people use it', status: 'soon' },
      { slug: 'measuring-experience', title: 'Numbers, themes and the ethics of asking', status: 'soon' },
      { slug: 'accessibility', title: 'Use this page with a screen reader', status: 'soon' },
      { slug: 'inclusive-design', title: 'Designing for people who are not you', status: 'soon' },
      { slug: 'dark-patterns', title: 'Dark patterns and who answers for a design', status: 'soon' },
    ],
  },
  {
    id: 'specialized', group: 'foundations', title: 'Building for Specific Platforms', tagline: 'The same ideas under very different constraints: the web page, the phone, the game, the chip, the robot and the notebook.', icon: 'layers', hue: 80,
    lessons: [
      { slug: 'what-a-platform-constrains', title: 'What every platform takes away from you', status: 'soon' },
      { slug: 'html-and-css', title: 'A web page from nothing: HTML and CSS', status: 'soon' },
      { slug: 'dom-and-javascript', title: 'Make the page respond: the DOM', status: 'soon' },
      { slug: 'a-small-web-app', title: 'A small web app, and what frameworks are for', status: 'soon' },
      { slug: 'mobile-constraints', title: 'Batteries, flaky networks and small screens', status: 'soon' },
      { slug: 'game-loop', title: 'The game loop, in sixteen milliseconds', status: 'soon' },
      { slug: 'microcontroller', title: 'A simulated microcontroller', status: 'soon' },
      { slug: 'robot-sense-plan-act', title: 'A robot in a canvas: sense, plan, act', status: 'soon' },
      { slug: 'robot-where-am-i', title: 'Noisy sensors: where is the robot?', status: 'soon' },
      { slug: 'notebooks-and-data-platforms', title: 'Notebooks and data platforms', status: 'soon' },
      { slug: 'platform-responsibility', title: 'Tracking, notifications and whose attention it is', status: 'soon' },
    ],
  },
  {
    id: 'society', group: 'foundations', title: 'Computing & Society', tagline: 'What computing does to people, what it owes them, and how to reason about it.', icon: 'globe', hue: 210,
    lessons: [
      { slug: 'why-ethics', title: 'Thinking it through: ethics in computing', status: 'soon' },
      { slug: 'professional-duties', title: 'Codes, liability and saying no', status: 'soon' },
      { slug: 'social-context', title: 'Networks, platforms and the digital divide', status: 'soon' },
      { slug: 'intellectual-property', title: 'Copyright, patents, trade secrets and licences', status: 'soon' },
      { slug: 'privacy-and-liberty', title: 'Privacy, surveillance and civil liberties', status: 'soon' },
      { slug: 'sustainability', title: 'The carbon and e-waste behind your code', status: 'soon' },
      { slug: 'history', title: 'A short history of computing and who made it', status: 'soon' },
      { slug: 'economies', title: 'Network effects, monopolies and the attention economy', status: 'soon' },
      { slug: 'who-gets-to-build', title: 'Diversity, equity and who gets to build', status: 'soon' },
      { slug: 'presenting-your-work', title: 'Explaining technical work to people who decide', status: 'soon' },
    ],
  },
];

export const trackById = (id: string) => TRACKS.find((t) => t.id === id);
