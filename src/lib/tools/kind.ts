// kind: what decides a kind cluster's Kubernetes version, and what "no error" means. Cards are from the sources in
// src/content/lessons/tools/kind.mdx; any card marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const KIND_DECK: Deck = {
  id: 'tool-kind', title: 'Which cluster did kind actually build?', xp: 40,
  cards: [
    {
      id: 'unpinned', title: 'Same file, two versions',
      body: 'Two students create clusters from the same kind config, which sets no image on its nodes. kubectl get nodes shows v1.27.3 on one laptop and v1.37.0 on the other.',
      options: [
        { id: 'a', text: 'One of them edited the config file', why: 'They did not need to. With no image in the file, the file says nothing about the version, so identical files can still differ.' },
        { id: 'b', text: 'They run different kind releases, and each used its own default node image', why: 'Supported. kind v0.20.0 defaults to a v1.27.3 node image and v0.33.0 to 1.37.0, per their release notes; the node image is the Kubernetes version.' },
        { id: 'c', text: 'Their Docker versions differ', why: 'Docker runs the node containers, but the Kubernetes inside them comes from the node image, which kind chooses.' },
      ],
      answer: 'b', source: 'kind release notes v0.20.0 and v0.33.0; kind Quick Start',
    },
    {
      id: 'pinned', title: 'A pinned node image',
      body: 'A team config sets image on every node to a kindest/node tag with its @sha256 digest, copied from the release notes of the kind version the whole team has installed. Everyone gets the same Kubernetes version.',
      options: [
        { id: 'a', text: 'Working as intended: this is how kind docs say to set the version', why: 'Supported. The Quick Start says to use the sha256 for the version you want, and the v0.33.0 notes say the digest is what guarantees an image built for that release.' },
        { id: 'b', text: 'Redundant: the tag alone already guarantees the image', why: 'The release notes say the opposite: you must use the digest to guarantee an image built for the release. A tag is a name that can be repointed.' },
        { id: 'c', text: 'Broken: kind ignores the image field in a config file', why: 'It does not. Setting the node image in the config is the documented way to choose the Kubernetes version.' },
      ],
      answer: 'a', source: 'kind Quick Start, Setting Kubernetes version; kind v0.33.0 release notes',
    },
    {
      id: 'delete-typo', title: 'A clean delete',
      body: 'A clean-up script runs kind delete cluster --name tiltdve, a typo for tiltdev. It exits without an error. The next morning the tiltdev cluster is still running.',
      options: [
        { id: 'a', text: 'kind deleted it and it was recreated overnight', why: 'Nothing recreates a kind cluster on its own. The cluster that is running is the one that was never deleted.' },
        { id: 'b', text: 'The delete failed and kind hid the error', why: 'Nothing failed. kind did what it promises: no cluster called tiltdve existed, so there was nothing to delete.' },
        { id: 'c', text: 'Deleting a cluster that does not exist is deliberately not an error, so the typo deleted nothing', why: 'Supported. The Quick Start says this is by design, so clean-up is idempotent. The price is that a wrong name looks exactly like success.' },
      ],
      answer: 'c', source: 'kind Quick Start, Deleting a Cluster',
    },
  ],
  debrief: 'kind does exactly what the command says, and no more. A config without an image means "my default", a tag without a digest means "whatever that name points at", and a delete of the wrong name means "nothing to do". Each of those finishes cleanly.',
};

export const KIND_DECK_MISSION = deckMission(KIND_DECK);
