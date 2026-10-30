// First users for the same idea. Three places to launch, one month later. The
// rates are this toy's illustration, not measured benchmarks: the point is the
// shape - a big launch to the wrong crowd wins on sign-ups and loses on the
// users who are still there in week four.

export type Channel = 'big-launch' | 'forum' | 'ads';
export type Onboarding = 'self' | 'by-hand';

// label is short enough for a phone's dropdown; detail is the full description.
export const CHANNELS: Record<Channel, { label: string; detail: string; visitors: number; signup: number; activation: number; retention: number }> = {
  'big-launch': { label: 'A big tech news site', detail: 'A launch post on a big general tech news site', visitors: 5000, signup: 0.08, activation: 0.10, retention: 0.20 },
  forum: { label: "The shop owners' forum", detail: 'Answering questions in the forum where shop owners already ask about outages', visitors: 300, signup: 0.15, activation: 0.40, retention: 0.60 },
  ads: { label: 'Paid ads', detail: 'Paid search and social ads aimed at small shops', visitors: 2000, signup: 0.04, activation: 0.20, retention: 0.40 },
};

// Setting up each new user's first check with them on a call: it doubles
// activation here, and costs half an hour of your time per sign-up.
const BY_HAND_ACTIVATION = 2;
const MAX_ACTIVATION = 0.9;
const HOURS_PER_SIGNUP = 0.5;

export type Launch = { channel: Channel; onboarding: Onboarding; visitors: number; signups: number; activated: number; retained: number; hours: number };

export function launch(channel: Channel, onboarding: Onboarding): Launch {
  const c = CHANNELS[channel];
  const signups = Math.round(c.visitors * c.signup);
  const act = onboarding === 'by-hand' ? Math.min(MAX_ACTIVATION, c.activation * BY_HAND_ACTIVATION) : c.activation;
  const activated = Math.round(signups * act);
  const retained = Math.round(activated * c.retention);
  return { channel, onboarding, visitors: c.visitors, signups, activated, retained, hours: onboarding === 'by-hand' ? signups * HOURS_PER_SIGNUP : 0 };
}

/** The channel worth doubling down on: most users still active in week four. */
export function bestChannel(): Channel {
  const all = (Object.keys(CHANNELS) as Channel[]).map((ch) => launch(ch, 'by-hand'));
  return all.sort((a, b) => b.retained - a.retained)[0].channel;
}
