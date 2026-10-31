// Expeditions: routes across the trails for one kind of learner. A trail is a
// subject; an expedition picks lessons from many, in an order where nothing is
// used before it is taught. That order is checked, not trusted: every lesson's
// builds_on (in its frontmatter) must appear earlier in the same expedition, or
// the build fails (src/lib/expeditions.ts). A 'soon' expedition is held to the
// same rule, so the plan stays honest before it ships.
//
// The bonus XP is 10 per lesson, worked out rather than written here, so a
// longer expedition cannot quietly be worth less than a shorter one.
//
// An expedition's id is part of a progress id ("expedition-<id>"), so renaming
// one needs an entry in src/lib/progress-renames.ts like any other.

export type ExpeditionPlan = {
  id: string;
  title: string;
  /** Who it is for, in their words. */
  who: string;
  tagline: string;
  badge: string;
  icon: string;
  hue: number;
  status: 'ready' | 'soon';
  lessons: string[];
  /** Said on the page: what was left out, and why. */
  note?: string;
};

export const EXPEDITIONS: ExpeditionPlan[] = [
  {
    id: 'first-steps', title: 'First Steps', who: 'I have never opened a terminal.', badge: 'Trailhead', icon: 'compass', hue: 90, status: 'ready',
    tagline: 'A shell, your first commits and what a web request really does - the ground floor for everything else.',
    lessons: [
      'linux/files-and-paths', 'linux/pipes',
      'git/what-is-git', 'git/branches', 'git/conflicts',
      'web/request-journey', 'web/status-codes-lie',
    ],
  },
  {
    id: 'platform-engineer', title: 'Platform Engineer', who: 'I want to run the systems other people ship on.', badge: 'Summit', icon: 'wheel', hue: 220, status: 'ready',
    tagline: 'From a Linux process to a self-healing cluster with GitOps, pipelines and error budgets.',
    lessons: [
      'linux/files-and-paths', 'linux/processes-and-signals', 'linux/permissions', 'linux/pipes',
      'git/what-is-git', 'git/branches', 'git/conflicts', 'git/inside-git', 'git/collaborate', 'git/branching-strategies', 'git/merge-rebase-squash',
      'web/request-journey', 'web/status-codes-lie', 'web/tls-trust',
      'network/ip-and-subnets', 'network/ports-and-tcp', 'network/dns-deep', 'network/load-balancers',
      'containers/what-is-a-container', 'containers/layers-and-cache', 'containers/tags-and-digests',
      'kubernetes/desired-state', 'kubernetes/scheduling', 'kubernetes/restarts', 'kubernetes/admission', 'kubernetes/rollouts',
      'delivery/pipelines', 'delivery/infrastructure-as-code', 'delivery/release-strategies', 'delivery/release-automation',
      'platform/gitops', 'platform/observability', 'platform/service-mesh', 'platform/policy-and-security', 'platform/bring-it-home',
      'sre/slos', 'sre/three-signals', 'sre/autoscaling',
    ],
  },
  {
    id: 'ai-builder', title: 'AI Builder', who: 'I want to build things with models, not just use them.', badge: 'Model Maker', icon: 'spark', hue: 330, status: 'ready',
    tagline: 'How a model learns, how an LLM writes one token at a time, and how to trust an agent with real work.',
    lessons: [
      'ml/what-is-learning', 'ml/neural-networks', 'ml/overfitting',
      'llm/tokens', 'llm/next-token', 'llm/attention', 'llm/serving-vllm',
      'agents/what-is-an-agent', 'agents/tools', 'agents/workflows-vs-agents', 'agents/guardrails-and-evals', 'agents/business-agents',
      'frontiers/alignment', 'frontiers/superintelligence',
    ],
    note: 'Run your own model is not on this expedition: it needs the full platform from the Platform Engineer expedition running on your machine. It is in the LLMs trail when you are ready.',
  },
  {
    id: 'founder', title: 'Founder', who: 'I have an idea and no team yet.', badge: 'Trailblazer', icon: 'flag', hue: 30, status: 'ready',
    tagline: 'Check the problem is real, ship the smallest thing, price it, and let agents carry some of the load.',
    lessons: [
      'launch/validate', 'launch/mvp', 'launch/pricing', 'launch/first-users',
      'llm/tokens', 'agents/what-is-an-agent', 'agents/workflows-vs-agents', 'agents/business-agents',
      'git/what-is-git', 'security/secrets-in-git', 'security/passwords-and-hashing',
      'databases/sql-basics', 'resilience/rpo-rto', 'resilience/backups-that-restore',
      'launch/business-basics',
    ],
  },
  {
    id: 'web-developer', title: 'Web Developer', who: 'I build apps and want to understand what is under them.', badge: 'Pathfinder', icon: 'globe', hue: 205, status: 'soon',
    tagline: 'Git as a team, the web below your framework, data that survives, and shipping it safely.',
    lessons: [
      'git/what-is-git', 'git/branches', 'git/conflicts', 'git/inside-git', 'git/collaborate', 'git/branching-strategies', 'git/merge-rebase-squash',
      'web/request-journey', 'web/status-codes-lie', 'web/tls-trust',
      'databases/sql-basics', 'databases/indexes', 'databases/transactions', 'databases/replication',
      'security/secrets-in-git', 'security/passwords-and-hashing', 'security/web-flaws', 'security/identity',
      'linux/processes-and-signals', 'containers/what-is-a-container', 'containers/layers-and-cache', 'containers/tags-and-digests',
      'delivery/pipelines', 'delivery/release-automation',
    ],
  },
  {
    id: 'on-call', title: 'On-Call', who: 'I get paged when it breaks.', badge: 'Night Watch', icon: 'gauge', hue: 175, status: 'soon',
    tagline: 'Read what is actually failing, decide how reliable is enough, and recover without blame.',
    lessons: [
      'web/request-journey', 'web/status-codes-lie',
      'network/ports-and-tcp', 'network/dns-deep', 'network/load-balancers',
      'linux/processes-and-signals', 'containers/what-is-a-container',
      'kubernetes/desired-state', 'kubernetes/scheduling', 'kubernetes/restarts', 'kubernetes/rollouts',
      'platform/observability', 'sre/slos', 'sre/three-signals', 'sre/autoscaling',
      'databases/sql-basics', 'databases/replication',
      'resilience/rpo-rto', 'resilience/backups-that-restore', 'resilience/dr-strategies', 'resilience/business-continuity', 'resilience/incidents',
    ],
  },
  {
    id: 'security', title: 'Security', who: 'I want to know how things get broken into.', badge: 'Gatekeeper', icon: 'lock', hue: 0, status: 'soon',
    tagline: 'The flaws attackers use, from leaked secrets to poisoned images, and the controls that stop them.',
    lessons: [
      'git/what-is-git', 'security/secrets-in-git', 'security/passwords-and-hashing', 'security/identity',
      'databases/sql-basics', 'security/web-flaws',
      'network/ports-and-tcp', 'web/request-journey', 'web/tls-trust',
      'linux/processes-and-signals', 'containers/what-is-a-container', 'containers/layers-and-cache', 'containers/tags-and-digests', 'security/supply-chain',
      'kubernetes/desired-state', 'kubernetes/scheduling', 'kubernetes/admission', 'platform/policy-and-security', 'security/cluster-access',
    ],
  },
  {
    id: 'leader', title: 'Leader', who: 'I manage engineers and want their vocabulary.', badge: 'Compass', icon: 'star', hue: 270, status: 'soon',
    tagline: 'Enough of how it works to ask good questions about reliability, risk, recovery and price.',
    lessons: [
      'web/request-journey', 'web/status-codes-lie',
      'sre/slos', 'resilience/rpo-rto', 'resilience/dr-strategies', 'resilience/business-continuity', 'resilience/incidents',
      'security/supply-chain', 'frontiers/superintelligence', 'launch/pricing',
    ],
  },
  {
    // Trail Crew, not anything with "Scrum Master" in it: that reads as a
    // credential next to Scrum Alliance's and Scrum.org's certification marks,
    // and the evidence points at how a team works together, not at a role.
    id: 'teamwork', title: 'Teamwork', who: 'I want the team I am on to work well together.', badge: 'Trail Crew', icon: 'crew', hue: 60, status: 'soon',
    tagline: "How work flows, what agile's own sources say, and what the evidence says actually makes teams work.",
    lessons: [
      'agile/manifesto', 'agile/scrum-guide', 'agile/flow', 'agile/forecasts', 'agile/xp',
      'launch/validate', 'launch/mvp', 'agile/teams', 'resilience/incidents', 'agile/scaling', 'agile/in-name-only',
    ],
  },
];
