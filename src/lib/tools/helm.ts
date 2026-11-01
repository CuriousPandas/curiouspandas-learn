// Helm: whether a learner can tell a CRD that Helm left alone by design from a
// broken upgrade. Cards are from the sources in src/content/lessons/tools/helm.mdx;
// any card marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const HELM_DECK: Deck = {
  id: 'tool-helm', title: 'Did the upgrade change the CRD?', xp: 40,
  cards: [
    {
      id: 'crd-unchanged', title: 'A green upgrade, an old schema',
      body: 'You ran helm upgrade on an operator. The release is at revision 4 and the controller pod runs the new image. But the live CRD\'s schema lacks the field that the new chart\'s crds/ directory added.',
      options: [
        { id: 'a', text: 'Helm hit an error and hid it', why: 'Nothing failed. Leaving crds/ alone on upgrade is documented behaviour, not a swallowed error.' },
        { id: 'b', text: 'Expected: Helm only creates CRDs from crds/ on install, so they need upgrading another way', why: 'Supported. Helm\'s docs: CRDs are never installed on upgrade or rollback, and existing ones are left regardless of version.' },
        { id: 'c', text: 'The API server is caching the old CRD and will catch up', why: 'There is no cache to wait out. The stored CRD is the old one, because nothing has replaced it.' },
      ],
      answer: 'b', source: 'Helm docs 4.3.1 - Charts, Limitations on CRDs',
    },
    {
      id: 'createreplace', title: 'Flux opted in',
      body: 'Flagger\'s HelmRelease on tilt sets install.crds: Create and upgrade.crds: CreateReplace. After a chart bump, the canaries.flagger.app CRD has the new chart\'s schema.',
      options: [
        { id: 'a', text: 'Working as intended: CreateReplace tells Flux to replace existing CRDs on upgrade', why: 'Supported. Flux docs: CreateReplace creates new CRDs and updates (replaces) existing ones, but does not delete any.' },
        { id: 'b', text: 'A bug: Helm should never change a CRD', why: 'Helm itself would not, but here Flux applies the CRDs under an explicit policy. That is the point of the setting.' },
        { id: 'c', text: 'Someone ran kubectl apply on the CRD by hand', why: 'No hand step is needed. The HelmRelease policy explains the change, and it is in the repo for anyone to read.' },
      ],
      answer: 'a', source: 'Flux docs v2.10 - HelmReleases, Controlling the lifecycle of CRDs; tilt helm/flagger/base/helm-release.yaml',
    },
    {
      id: 'uninstall-keeps', title: 'Uninstalled, still there',
      body: 'You helm uninstall an operator\'s release. Its pods and Services go, but its CRDs and every custom resource of those kinds are still in the cluster.',
      options: [
        { id: 'a', text: 'The uninstall failed halfway', why: 'The uninstall finished: it removed what was in the release. CRDs from crds/ were never part of it.' },
        { id: 'b', text: 'Another release recreated them straight away', why: 'Possible in theory, but there is no need to guess: this is what Helm always does with CRDs.' },
        { id: 'c', text: 'By design: Helm never deletes CRDs, because that would delete every object of that kind', why: 'Supported. Helm\'s docs: deleting a CRD deletes all of its contents across all namespaces, so Helm will not.' },
      ],
      answer: 'c', source: 'Helm docs 4.3.1 - Charts, Limitations on CRDs; Best practices, Custom Resource Definitions',
    },
  ],
  debrief: 'Helm treats crds/ as install-only: never upgraded, never deleted, whatever the chart version says. That protects your data and means a green upgrade can leave an old schema behind. Something else has to own CRD upgrades, such as a Flux HelmRelease set to CreateReplace.',
};

export const HELM_DECK_MISSION = deckMission(HELM_DECK);
