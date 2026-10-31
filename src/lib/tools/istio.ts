// Istio: what an ambient workload accepts, and which PeerAuthentication settings change it. Cards are from
// the sources in src/content/lessons/tools/istio.mdx; any card marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const ISTIO_DECK: Deck = {
  id: 'tool-istio', title: 'Who can still get in?', xp: 40,
  cards: [
    {
      id: 'no-policy', title: 'In the mesh, no policy',
      body: 'Every app namespace is labelled for the ambient mesh and every pod\'s redirection annotation says enabled. kubectl get peerauthentication --all-namespaces says No resources found. A reviewer asks whether an app will refuse a plain HTTP call from a pod outside the mesh.',
      options: [
        { id: 'a', text: 'Yes: enrolment means ztunnel only lets mTLS through', why: 'Enrolment puts the pod\'s traffic through ztunnel; it does not set what the pod accepts. Istio says HBONE being configured does not mean plaintext is rejected.' },
        { id: 'b', text: 'Yes, but only after the pods are restarted', why: 'Restarting affects whether a pod is captured, not which mTLS mode applies. The mode comes from PeerAuthentication, and there is none.' },
        { id: 'c', text: 'No: with no PeerAuthentication the default mode is PERMISSIVE, which accepts plaintext too', why: 'Supported. Istio\'s ambient docs say the default policy is PERMISSIVE, which accepts mTLS from within the mesh and plain text from without.' },
      ],
      answer: 'c', source: 'Istio 1.28 docs: Use Layer 4 security policy; Verify mutual TLS is enabled',
    },
    {
      id: 'strict-refuses', title: 'A job that stopped working',
      body: 'The payments namespace has just been given a PeerAuthentication with mode STRICT. A reporting job in a namespace that is not in the mesh now fails to connect to payments, while calls from enrolled namespaces still work.',
      options: [
        { id: 'a', text: 'Working as intended: STRICT accepts only mTLS, and the job is a plaintext caller from outside the mesh', why: 'Supported. In STRICT mode workloads only accept mutual TLS traffic. The refused job is exactly what PERMISSIVE was letting in; enrol it or decide it should not call payments.' },
        { id: 'b', text: 'A broken mesh: STRICT should not affect callers outside it', why: 'Callers outside the mesh are the only ones STRICT changes things for. Mesh traffic was already mTLS.' },
        { id: 'c', text: 'A certificate problem in payments', why: 'Mesh callers still connect, so payments\' identity and certificates are fine. The refused caller never offered mTLS at all.' },
      ],
      answer: 'a', source: 'Istio 1.28 docs: Security concepts (peer authentication modes); Mutual TLS migration',
    },
    {
      id: 'disable', title: 'Switching mTLS off to debug',
      body: 'To read raw traffic while debugging, someone applies a PeerAuthentication with mode DISABLE to an ambient namespace. kubectl accepts it, and the traffic between its pods is still encrypted.',
      options: [
        { id: 'a', text: 'Istio needs a few minutes to push the new mode to ztunnel', why: 'Waiting will not help. The mode is not supported in ambient mode at all, so there is nothing to push.' },
        { id: 'b', text: 'In ambient mode DISABLE cannot be used: HBONE implies mTLS, and such policies are ignored', why: 'Supported. Istio\'s ambient L4 policy page says it is not possible to use the DISABLE mode in a policy, and such policies will be ignored. Accepted by the API server, inert in the mesh.' },
        { id: 'c', text: 'The policy needs to go in istio-system to take effect', why: 'Moving it to the root namespace makes it mesh-wide; it is still a DISABLE policy, and still ignored in ambient mode.' },
      ],
      answer: 'b', source: 'Istio 1.28 docs: Use Layer 4 security policy, peer authentication',
    },
  ],
  debrief: 'Joining the mesh changes how traffic is carried, not what a workload accepts. With no PeerAuthentication every workload is PERMISSIVE and takes plaintext from outside the mesh. STRICT closes that, at the cost of refusing every caller you have not enrolled. And in ambient mode DISABLE is ignored, so not every policy kubectl accepts does anything.',
};

export const ISTIO_DECK_MISSION = deckMission(ISTIO_DECK);
