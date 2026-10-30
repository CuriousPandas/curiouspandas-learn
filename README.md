# Curious Pandas

**Learn tech by breaking things.** A free, open learning site that goes from your
first git commit to Kubernetes, the CNCF toolbox, neural networks and how vLLM
serves a language model. Every lesson is something you can poke, break and fix
in the browser, and the infrastructure lessons end with doing it for real on
[TemplateMechanics/tilt](https://github.com/TemplateMechanics/tilt).

Lives at **learn.curiouspandas.dev**.

## Why it stays free

Free hands-on learning sites tend to die from the same cause: one lab machine
per learner, paid for by the site. This one never runs compute for anyone.

| Tier | Where it runs | What it covers |
|---|---|---|
| Browser | any device | every lesson's core: real-hash git, a cluster sim, a neural net, a tokenizer, a model-server sim |
| Browser+ | the learner's GPU (WebGPU) | optional extras only, feature-detected |
| Your machine | Docker + kind + Tilt | the "Do it for real" tilt labs (about 15 GB of disk and 8 GB of spare RAM) |
| Codespace | the learner's own free cloud quota | planned, not built |

Every XP point and badge can be earned on the first tier. Progress lives in
`localStorage` only: no accounts, analytics, cookies or third-party requests.

## How it is sandboxed

Short answer: there is no container, VM or remote shell to escape, because
nothing real runs. Every terminal and lab on the site is a simulator written in
TypeScript, running in the learner's own browser tab.

- **Terminals are interpreters, not shells.** A line like `git commit -m "x"` is
  tokenised (`src/lib/git/shell.ts`, `src/lib/kube/kubectl.ts`) and dispatched to
  an allow-list of commands implemented against an in-memory model. Anything not
  on the list is refused by name ("real git has this, this sandbox does not
  yet", or "command not found"), never silently ignored. Typed text
  is never evaluated as JavaScript, never sent anywhere, and only ever reaches
  the page as text nodes, never as HTML.
- **One exception, deliberately: SQL.** On the two database consoles, typed
  SQL is executed - by SQLite compiled to WebAssembly (`sql.js`, bundled and
  served from this site), against a small in-memory database, inside a Web
  Worker that is terminated after 4 seconds so a runaway query cannot hang the
  tab. It has no network and no access to the page; reloading discards it.
- **The models are faithful where it matters.** The git engine writes real
  blob/tree/commit objects with SHA-1 in JavaScript, and `tests/git-parity.test.ts`
  replays sessions through the real `git` binary to prove the hashes and merge
  results match. The cluster is a tick loop of controller, scheduler and
  kubelet over plain objects, with failure messages copied from real clusters.
  The neural net, tokenizer and vLLM memory simulator are small pure functions.
- **No backend.** The site is static files on GitHub Pages: no API, no
  accounts, no analytics, no cookies, and no requests to any other host.
  Progress lives in `localStorage`; an imported progress file is parsed,
  validated and shown as text, and a corrupt store is reported, never
  overwritten.
- **Bounded work on the learner's device.** The simulations that run on their
  own (cluster, GitOps, metrics) pause when scrolled off screen or the tab is
  hidden. The rest run only after the learner presses Run or Train, and stop
  when finished or paused.
- **The real tools stay on the learner's machine.** "Do it for real" sections
  point at [TemplateMechanics/tilt](https://github.com/TemplateMechanics/tilt),
  which runs a kind cluster locally. The site never connects to it.

How each claim is held in place, so it cannot quietly stop being true:

| Claim | Pinned by |
|---|---|
| Nothing typed is run as code; no network calls; no cookies | `tests/sandbox.test.ts` fails on `eval`, `new Function`, `fetch`, XHR, WebSockets, beacons or `document.cookie` anywhere in `src/` |
| HTML is only built from the site's own strings | the same test keeps a hand-reviewed list of the files that use `innerHTML`; a new one fails until reviewed |
| No request ever leaves for another host | `scripts/check-site.mjs` fails any page that requests a third-party URL |

Not done: there is no Content-Security-Policy. GitHub Pages cannot send
response headers; a `<meta>` CSP is possible but needs hashes for Astro's
inline scripts, and has not been added yet.

## What is checked, and how

| Claim | Pinned by |
|---|---|
| Playground hashes are real git hashes | `tests/git-parity.test.ts` replays sessions through the git binary: commits, trees, merges, conflict files |
| The cluster sim fails the way real clusters fail | `tests/kube.test.ts`: two exit-137 crashes with opposite fixes, quota refusals visible only as events, stalled rollouts that keep serving |
| Every mission can be finished, and the wrong fix does not pass | `tests/missions.test.ts` plays each mission from its own hints |
| The ML and serving lessons' claims | `tests/ai.test.ts`: backprop vs a numerical gradient, XOR needs a hidden layer, paging beats reserving |
| A corrupt progress store is never overwritten | `tests/progress.test.ts` |
| A renamed lesson, quiz or mission never strands a learner's progress | `tests/progress-ids.test.ts`: every id ever shipped is in `tests/progress-ids.json`; one that disappears needs an entry in `src/lib/progress-renames.ts`, which moves learners' records on their next visit. After adding content, run `node scripts/progress-ids.ts --write` |
| Expeditions never use a lesson before what it builds on | `tests/expeditions.test.ts` and the build itself check each lesson's `builds_on` against every expedition's order, planned ones included |
| Pages actually work in a browser | `scripts/check-site.mjs` renders every page, drives every widget, asserts on screen text, checks every internal link and 375 px overflow - in Chromium, WebKit (every iPhone browser) and Firefox |
| Readable and navigable for everyone | the same script runs axe (WCAG 2.1 A/AA) on every page in light and dark mode, and fails on any serious or critical violation |
| CNCF maturity in the Tool Atlas | `scripts/sync-cncf.mjs` reads the CNCF landscape and writes a dated snapshot |

## Develop

Node 24 (see `.nvmrc`; Astro 7 needs at least 22.23.4).

```bash
npm ci
npm run dev            # http://localhost:4321
npm test               # engines, parity with git, missions
npm run check          # typecheck
npm run build && npm run check:site   # screenshots land in .site-check/<engine>/ - look at them
BROWSER=webkit npm run check:site      # also firefox; needs: npx playwright install webkit firefox
npm run sync:cncf      # refresh CNCF maturity, then review the diff
```

## Deploying

Every push to `main` runs the full verification. The exact `dist/` it checked
is published to GitHub Pages, and nothing is rebuilt between check and
deploy. Two one-time settings live outside the repo, recorded here so the setup
can be rebuilt:

```bash
gh api -X POST repos/CuriousPandas/curiouspandas-learn/pages -f build_type=workflow
gh api -X PUT  repos/CuriousPandas/curiouspandas-learn/pages -f cname=learn.curiouspandas.dev
# after DNS resolves and GitHub reports the certificate as approved:
gh api -X PUT  repos/CuriousPandas/curiouspandas-learn/pages -F https_enforced=true
```

DNS is on Cloudflare: one record in the curiouspandas.dev zone, `learn` CNAME
`curiouspandas.github.io`, set **DNS only** (grey cloud) - proxied, GitHub
cannot issue the certificate, and `.dev` only loads over HTTPS. The apex is
left free on purpose, for other projects. Verify `curiouspandas.dev` in the
CuriousPandas org's Pages settings (a TXT record): that covers every
subdomain, so no other GitHub account can claim one.

If the custom domain was set before its DNS record existed, GitHub may never
request a certificate (`https_certificate` stays null and HTTPS serves the
`*.github.io` certificate). Setting `cname` to null and back makes it try again.

## Adding a lesson

1. List it in `src/data/tracks.ts`, with status `soon` until it is written.
2. Write `src/content/lessons/<track>/<slug>.mdx`. Any component in
   `src/components/` is available by name (`<Quiz>`, `<Callout>`,
   `<DoItForReal>`, `<GitPlayground mission=...>`, `<KubeSim mission=...>`, ...).
3. Flip the status to `ready`. The build fails if the plan and the files
   disagree in either direction.
4. Any number you state goes in `sources:`, and any new widget gets an engine
   test and a `check-site` scenario.

## Licence

MIT, copyright [Sallux](https://sallux.dev). See [LICENSE](LICENSE).
