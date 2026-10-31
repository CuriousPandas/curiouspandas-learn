// External Secrets Operator: whether the Kubernetes Secret still matches the store, read from the ExternalSecret.
// Cards are from the sources in src/content/lessons/tools/external-secrets.mdx; any card
// marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const EXTERNAL_SECRETS_DECK: Deck = {
  id: 'tool-external-secrets', title: 'Is this Secret still telling the truth?', xp: 40,
  cards: [
    {
      id: 'moved', title: 'The key moved house',
      body: 'Payments rotated an API key: the new key went to a new path in the vault, and the old entry was deleted. Pods still work. The Kubernetes Secret holds the old key, and kubectl get externalsecret shows SecretSyncedError, READY False.',
      options: [
        { id: 'a', text: 'Nothing to do: ESO will pick up the new key at the next refresh', why: 'The ExternalSecret still points at the old path. Every refresh will look there and fail the same way.' },
        { id: 'b', text: 'The ExternalSecret cannot find its key. Under the default Retain the Secret keeps its last value. Point remoteRef at the new path', why: 'Supported. The docs say Retain keeps the secret when the provider secrets are deleted, and that a missing provider secret puts the ExternalSecret into SecretSyncedError.' },
        { id: 'c', text: 'ESO has deleted the Secret, and the pods are running on a cached copy', why: 'The Secret is still there; Retain is exactly the policy that keeps it. Delete would have removed it.' },
      ],
      answer: 'b', source: 'ESO docs v2.10.0: Lifecycle, deletion policy',
    },
    {
      id: 'interval', title: 'Ten minutes behind',
      body: 'An ExternalSecret has refreshInterval: 1h. The value in the vault was changed 10 minutes ago and the Secret still has the old one. kubectl get externalsecret shows SecretSynced, READY True, last sync 25 minutes ago.',
      options: [
        { id: 'a', text: 'Working as intended: ESO polls, so the change arrives at the next refresh, or sooner with the force-sync annotation', why: 'Supported. ESO is pull-based and does not watch providers; Periodic refreshes at each interval, and the docs show a force-sync annotation for an immediate refresh.' },
        { id: 'b', text: 'Broken: ESO should have pushed the change as soon as the vault changed', why: 'ESO does not watch providers. A change reaches the cluster only when a refresh runs.' },
        { id: 'c', text: 'Broken: READY True with an old value means the store is returning stale data', why: 'The last sync worked, and it ran before the change. Nothing is failing; the next refresh has not happened yet.' },
      ],
      answer: 'a', source: 'ESO docs v2.10.0: Lifecycle, behaviour matrix; ExternalSecret, manual refresh',
    },
    {
      id: 'zero', title: 'Refresh as fast as possible',
      body: 'To get changes through quicker, someone set refreshInterval: 0 on an ExternalSecret. Weeks later the value in the vault changes, and the Secret never follows. The ExternalSecret is READY True.',
      options: [
        { id: 'a', text: 'The store is unreachable, so ESO falls back to the cached value', why: 'An unreachable store would put the ExternalSecret into an error, not leave it READY True.' },
        { id: 'b', text: 'Zero means as often as possible, so ESO must be overloaded', why: 'Zero does not mean constantly. The docs give it the opposite meaning.' },
        { id: 'c', text: 'An interval of 0 means sync once: it behaves like CreatedOnce', why: 'Supported. The docs say that, for backwards compatibility, a refresh interval of 0 results in the same behaviour as CreatedOnce.' },
      ],
      answer: 'c', source: 'ESO docs v2.10.0: Lifecycle, refresh policy',
    },
  ],
  debrief: 'A Kubernetes Secret has no status, so only the ExternalSecret can say whether it still matches the store. ESO pulls on an interval, an interval of 0 means sync once, and under the default Retain a value gone from the store leaves the old one in place with the error recorded only on the ExternalSecret.',
};

export const EXTERNAL_SECRETS_DECK_MISSION = deckMission(EXTERNAL_SECRETS_DECK);
