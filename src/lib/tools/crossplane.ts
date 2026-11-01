// Crossplane: whether a composite's green status means the values you asked for reached the resources it built.
// Cards are from the sources in src/content/lessons/tools/crossplane.mdx; any card
// marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const CROSSPLANE_DECK: Deck = {
  id: 'tool-crossplane', title: 'Did the request reach the resource?', xp: 40,
  cards: [
    {
      id: 'typo', title: 'Every app scraped at /metrics',
      body: 'A Composition patch reads fromFieldPath spec.monitoring.metricPath and has no policy set. The claims set spec.monitoring.metricsPath: /stats. Every ServiceMonitor scrapes /metrics, and every composite shows SYNCED True, READY True.',
      options: [
        { id: 'a', text: 'A Crossplane bug: a patch that does nothing should show up as an error', why: 'This is the documented default, not a bug. A missing source field under the Optional policy is meant to be a no-op.' },
        { id: 'b', text: 'Fine: /metrics is the template default, and the claims will catch up', why: 'Nothing will catch up. The patch reads a field no claim will ever have, so it never runs.' },
        { id: 'c', text: 'The patch reads a misspelled path, so under the Optional default it is skipped. Fix the path and make the patch Required', why: 'Supported. The default fromFieldPath policy is Optional, which makes the patch a no-op when the field does not exist; Required turns that into an error on the composite.' },
      ],
      answer: 'c', source: 'Crossplane docs v1.20 (and v2.4): patch policies; Crossplane v1.15.0 PatchPolicy',
    },
    {
      id: 'default', title: 'No serviceName given',
      body: "In tilt's Composition, the HTTPRoute template's backend is first set from spec.name. A second patch copies spec.ingress.serviceName over it, with policy fromFieldPath: Optional. A DevApplication leaves serviceName out, and its route points at the Service named after the app.",
      options: [
        { id: 'a', text: 'Working as intended: the Optional patch is skipped, so the earlier patch from spec.name stands as the default', why: 'Supported. Skipping a patch when its source field is missing is what Optional is for: here it deliberately leaves the default in place.' },
        { id: 'b', text: 'Broken: the serviceName patch should have failed the composite', why: 'It would only fail with policy Required. This patch is marked Optional on purpose, because serviceName is optional.' },
        { id: 'c', text: 'Broken: the route needs serviceName or it has no backend at all', why: 'The earlier patch already set the backend from spec.name. The second patch only overrides it when serviceName is given.' },
      ],
      answer: 'a', source: 'tilt helm/crossplane/compositions/composition.yaml; Crossplane docs v1.20: patch policies',
    },
    {
      id: 'orphan', title: 'Deleted, still billing',
      body: 'A team deletes a claim for a cloud database. The claim and its managed resource are gone from the cluster, but the database is still running in the cloud account and still costs money. The managed resource had deletionPolicy: Orphan.',
      options: [
        { id: 'a', text: 'Crossplane failed to delete it, so retry the delete', why: 'Nothing failed. The resource was told to leave the external database in place, and it did.' },
        { id: 'b', text: 'Expected: Orphan means leave the external resource when deleting the managed resource. Clean it up, or use Delete', why: 'Supported. The managed resources docs define Orphan as leaving the external resource when the managed resource is deleted; Delete is the default.' },
        { id: 'c', text: 'The provider lost its credentials partway through the delete', why: 'A credentials failure would leave the managed resource stuck in the cluster with an error, not gone.' },
      ],
      answer: 'b', source: 'Crossplane docs v1.20: Managed resources, deletionPolicy',
    },
  ],
  debrief: 'Green on a composite means Crossplane reconciled it and the composed resources are ready, not that every value you asked for arrived. Optional patches are how defaults work, and also how a misspelled path disappears without a trace; mark the patches that matter Required. And check what a delete leaves behind.',
};

export const CROSSPLANE_DECK_MISSION = deckMission(CROSSPLANE_DECK);
