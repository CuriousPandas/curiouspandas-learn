// Tilt: what a green local_resource does and does not prove after an edit. Cards are from the sources in
// src/content/lessons/tools/tilt.mdx; any card marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const TILT_DECK: Deck = {
  id: 'tool-tilt', title: 'Did your edit reach the cluster?', xp: 40,
  cards: [
    {
      id: 'no-deps', title: 'Saved, green, unchanged',
      body: 'A local_resource runs kubectl apply -k on a directory and lists no deps. You change a value in that directory and save. The resource stays green, its log shows nothing new, and the live object still has the old value.',
      options: [
        { id: 'a', text: 'The API server rejected the change without saying so', why: 'Nothing was sent to it. There is no new run in the log, so kubectl apply never ran again.' },
        { id: 'b', text: 'Without deps the resource ran once at tilt up and is not watching that directory', why: 'Supported. Tilt docs say a local resource without deps runs only once, on tilt up or when its definition changes; deps are the files Tilt watches.' },
        { id: 'c', text: 'Tilt batches changes and applies them every few minutes', why: 'Tilt reacts to changes in the files it watches. It has no timer that would eventually pick this one up.' },
      ],
      answer: 'b', source: 'Tilt docs - Local Resource, File dependencies',
    },
    {
      id: 'with-deps', title: 'An edit that re-ran',
      body: 'The hello-world resource lists examples/hello-world in its deps. You change the message in deployment.yaml and save. The resource runs again by itself, its log shows the apply and the rollout, and the page shows the new message.',
      options: [
        { id: 'a', text: 'Working as intended: a change to a watched dep re-runs the command', why: 'Supported. The API reference says Tilt watches the files in deps and runs the cmd when they change, and the page proves the change landed.' },
        { id: 'b', text: 'A problem: Tilt should wait for you to press update', why: 'That is manual trigger mode, which this resource does not use. The default, automatic mode runs on every change to a dep.' },
        { id: 'c', text: 'A problem: the change skipped git, so the cluster has drifted', why: 'On this platform Tilt applies from your local checkout by design. Drift would be the live object differing from your files; here they match.' },
      ],
      answer: 'a', source: 'Tilt docs - Tiltfile API reference, local_resource',
    },
    {
      id: 'trigger', title: 'Forcing it',
      body: 'You have edited a directory that a deps-less resource applies, and you know Tilt will not notice. You run tilt trigger with that resource name.',
      options: [
        { id: 'a', text: 'Nothing happens, because the resource has no deps', why: 'deps decide what starts a run automatically. tilt trigger starts one by hand, whatever the deps.' },
        { id: 'b', text: 'Tilt rebuilds the whole platform from scratch', why: 'Triggering is per resource. Only the named resource runs again.' },
        { id: 'c', text: 'The resource runs its command again, applying the directory as it is now', why: 'Supported. The CLI reference says tilt trigger forces a full rebuild of the named resource when it has no pending manual changes.' },
      ],
      answer: 'c', source: 'Tilt docs - CLI reference, tilt trigger',
    },
  ],
  debrief: 'A Tilt resource re-runs when something it watches changes, and only then. Green is the result of the last run, which for a resource without deps was at tilt up. The proof that an edit landed is a new run in the log and the change visible in the running system.',
};

export const TILT_DECK_MISSION = deckMission(TILT_DECK);
