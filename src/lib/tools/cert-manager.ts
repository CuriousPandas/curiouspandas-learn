// cert-manager: whether a certificate will actually be issued and renewed, read from its status.
// Cards are from the sources in src/content/lessons/tools/cert-manager.mdx; any card
// marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const CERT_MANAGER_DECK: Deck = {
  id: 'tool-cert-manager', title: 'Will this certificate be there next month?', xp: 40,
  cards: [
    {
      id: 'kindless', title: 'Not Ready for an hour',
      body: 'A Certificate in namespace shop has issuerRef name: company-ca and no kind. company-ca is a ClusterIssuer and it is Ready. An hour later the Certificate is still READY False and its Secret does not exist.',
      options: [
        { id: 'a', text: 'Give it time: the CA is slow, and cert-manager will get there', why: 'Waiting will not help. The request is pending on an issuer that does not exist, and it will stay pending.' },
        { id: 'b', text: 'kind defaulted to Issuer, so cert-manager is looking for an Issuer called company-ca in shop. Add kind: ClusterIssuer', why: 'Supported. The Certificate docs say the default kind is Issuer, a locally namespaced Issuer, and an Issuer must be in the same namespace as the Certificate.' },
        { id: 'c', text: 'The ClusterIssuer is broken: delete it and create it again', why: 'The ClusterIssuer is Ready and is never consulted. Recreating it changes nothing about the reference that points elsewhere.' },
      ],
      answer: 'b', source: 'cert-manager docs v1.16: Certificate resource, Issuer, API reference',
    },
    {
      id: 'deleted', title: 'Tidied away',
      body: 'During a clean-up someone deletes the Certificate for api.example.com. The next day HTTPS on api.example.com still works perfectly, and the Secret is still there.',
      options: [
        { id: 'a', text: 'All good: cert-manager keeps renewing the Secret on its own', why: 'cert-manager renews Certificates, not Secrets. With the Certificate gone, nothing is left to renew it.' },
        { id: 'b', text: 'cert-manager will notice the Secret and recreate the Certificate', why: 'Nothing recreates a deleted Certificate. Only whatever applied it in the first place, such as a GitOps controller, could put it back.' },
        { id: 'c', text: 'It works for now, but nothing will renew it, so it will stop working when it expires', why: 'Supported. By default cert-manager does not delete the Secret when its Certificate is deleted. The docs say services keep working, but the certificate will no longer be renewed.' },
      ],
      answer: 'c', source: 'cert-manager docs v1.16: Certificate resource, cleaning up Secrets',
    },
    {
      id: 'renewal', title: 'A new request, all by itself',
      body: 'The wildcard Certificate has duration 2160h and renewBefore 720h. About 60 days after it was issued, a new CertificateRequest appears and the certificate in the Secret changes. Afterwards kubectl get certificate shows READY True.',
      options: [
        { id: 'a', text: 'Working as intended: renewBefore started a reissue 30 days ahead of expiry', why: 'Supported. A Certificate is renewed ahead of expiry, and renewBefore sets how far ahead. Each reissue goes through a new CertificateRequest.' },
        { id: 'b', text: 'Something changed the Certificate spec, so someone should find out who', why: 'A spec edit is one trigger for a reissue, but the timing here matches renewBefore exactly. No edit is needed to explain it.' },
        { id: 'c', text: 'The old certificate was revoked, so cert-manager had to replace it in a hurry', why: 'Nothing here points to revocation. A reissue at duration minus renewBefore is the normal renewal schedule.' },
      ],
      answer: 'a', source: 'cert-manager docs v1.16: Certificate resource, FAQ (renewal); tilt wildcard Certificate',
    },
  ],
  debrief: 'A working padlock today says nothing about next month. cert-manager only issues and renews what a Ready Certificate asks for: a kind left out points at an issuer that does not exist, and a deleted Certificate leaves its Secret serving with nothing renewing it. Read READY on the Certificate, and follow it down to the CertificateRequest when it is False.',
};

export const CERT_MANAGER_DECK_MISSION = deckMission(CERT_MANAGER_DECK);
