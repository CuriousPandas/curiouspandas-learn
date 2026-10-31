// Flux: whether a learner reads a suspended object's stale Ready as stale, and
// trusts a matching generation. Cards are from the sources in
// src/content/lessons/tools/flux.mdx; any card marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const FLUX_DECK: Deck = {
  id: 'tool-flux', title: 'Is Flux acting on this, or just reporting?', xp: 40,
  cards: [
    {
      id: 'suspended-ready', title: 'Merged an hour ago',
      body: 'A change to a HelmRelease\'s values merged an hour ago; the interval is 5m. flux get helmreleases shows READY True and SUSPENDED True. helm get values still shows the old value.',
      options: [
        { id: 'a', text: 'Flux is slow today; wait for the next interval', why: 'Waiting will not help. A suspended object is not reconciled at any interval until it is resumed.' },
        { id: 'b', text: 'It is suspended: no new release until flux resume, and Ready describes the last one', why: 'Supported. Flux docs: while suspended, changes will not result in a new Helm release, and nothing rewrites the status.' },
        { id: 'c', text: 'Helm rejected the new values without saying so', why: 'Helm never saw them. A rejected upgrade would show up as a failed reconcile, not as an untouched release.' },
      ],
      answer: 'b', source: 'Flux docs v2.10 - HelmReleases, Suspend; GitRepositories, Suspending and resuming',
    },
    {
      id: 'generation-match', title: 'The numbers agree',
      body: 'flux get shows SUSPENDED False and READY True for a HelmRelease. Its metadata.generation is 7 and its status.observedGeneration is 7.',
      options: [
        { id: 'a', text: 'Fine: Flux has reconciled the current spec, and Ready is about this version', why: 'Supported. observedGeneration is the latest generation Flux reconciled to a ready or stalled state; matching means the status is current.' },
        { id: 'b', text: 'Suspicious: Ready might be left over from an old spec', why: 'That is the right worry when the numbers differ. Here they match and nothing is suspended, so the status is current.' },
        { id: 'c', text: 'Unknown until you check the pods by hand', why: 'Not needed for this question. The generation fields exist so you do not have to infer status from pods.' },
      ],
      answer: 'a', source: 'Flux docs v2.10 - HelmReleases, Observed Generation; Kubernetes API conventions',
    },
    {
      id: 'outlives-incident', title: 'A week after the incident',
      body: 'During an incident someone ran flux suspend on a HelmRelease to hot-fix it by hand. Its YAML in git has no suspend field at all. A week later, nobody has touched it.',
      options: [
        { id: 'a', text: 'The next apply of the YAML cleared the suspension', why: 'The YAML never mentions suspend, so applying it does not remove the field. That is our reading of the docs note, so treat it as inferred.' },
        { id: 'b', text: 'Flux resumes suspended objects after a timeout', why: 'There is no timeout in the docs. Suspend lasts until it is set to false, removed, or resumed with flux resume.' },
        { id: 'c', text: 'It is still suspended, and will stay so until someone resumes it', why: 'Supported. Constructed from the Flux docs: the field resumes only when set to false or removed, and a hot patch survives when git does not declare it.' },
      ],
      answer: 'c', source: 'Flux docs v2.10 - HelmReleases, Suspending and resuming (hot patching note); constructed',
    },
  ],
  debrief: 'Suspend is a documented escape hatch, and it stops the status as well as the work. Ready alone cannot tell you whether Flux is acting; SUSPENDED and generation against observedGeneration can. And a suspension set by hand lasts until someone undoes it.',
};

export const FLUX_DECK_MISSION = deckMission(FLUX_DECK);
