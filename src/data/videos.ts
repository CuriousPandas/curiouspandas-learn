// Every demo video on the site, listed once. <Watch> in a lesson and the
// /videos/ page both read from here, so the two cannot show different cuts:
// when the id lived in the lesson's own tag, a re-upload meant finding every
// place the old id was written, and a missed one would keep playing the old
// cut with nothing to say so.
//
// A video belongs to exactly one lesson and that lesson must embed it
// (tests/videos.test.ts). A video listed here and embedded nowhere would show
// on /videos/ and link to a lesson that never mentions it.

export type Video = {
  /** The lesson it is embedded in, as track/slug. Also its key. */
  lesson: string;
  /** The 11-character YouTube id. Public or unlisted: a private one plays for nobody. */
  youtube: string;
  title: string;
  /** Our own image under public/, shown until play is pressed. */
  poster: string;
  minutes: number;
  /** One or two sentences for /videos/: what is on screen, so a reviewer can tell cuts apart. */
  about: string;
};

export const VIDEOS: Video[] = [
  {
    lesson: 'platform/observability',
    youtube: 'FdmrItMGvBU',
    title: 'The dashboard that lies, on a real cluster',
    poster: '/video/platform-observability.jpg',
    minutes: 2,
    about: 'Tilt lab 08 on a real cluster. One word changes in a ServiceMonitor, every pod stays green, and Prometheus is quietly left with no target until the lab grader says so.',
  },
  {
    lesson: 'kubernetes/restarts',
    youtube: '71pV2dyBWmY',
    title: 'Why did it restart?, on a real cluster',
    poster: '/video/kubernetes-restarts.jpg',
    minutes: 2,
    about: 'Tilt lab 09 on a real cluster. Two pods crash-loop with the same exit code, 137. The termination reason and the events show one ran out of memory and the other was killed by its own health check, and each gets a different fix.',
  },
  {
    lesson: 'platform/service-mesh',
    youtube: 'HVx9IU8jwp0',
    title: 'In the mesh, or not?, on a real cluster',
    poster: '/video/platform-service-mesh.jpg',
    minutes: 2,
    about: 'Tilt lab 03 on a real cluster. One label comes off a namespace and a running pod leaves the mesh in about two seconds, with the same name, the same start time and no restart. Kubernetes shows nothing wrong, and Kiali is the only dashboard that changes.',
  },
  {
    lesson: 'delivery/release-strategies',
    youtube: 'aRiHnqR5w20',
    title: 'The release nobody saw, on a real cluster',
    poster: '/video/delivery-release-strategies.jpg',
    minutes: 3,
    about: 'Tilt lab 06 on a real cluster. Flagger moves a good release to a quarter of the traffic, then half, then promotes it. A release with an image that does not exist is marked failed while the page keeps serving the old version, and it takes a new good release to clear it.',
  },
];

export function videoFor(lesson: string): Video {
  const v = VIDEOS.find((x) => x.lesson === lesson);
  if (!v) throw new Error(`no video for lesson "${lesson}" in src/data/videos.ts (have: ${VIDEOS.map((x) => x.lesson).join(', ')})`);
  return v;
}
