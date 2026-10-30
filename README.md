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

## What is checked, and how

| Claim | Pinned by |
|---|---|
| Playground hashes are real git hashes | `tests/git-parity.test.ts` replays sessions through the git binary: commits, trees, merges, conflict files |
| The cluster sim fails the way real clusters fail | `tests/kube.test.ts`: two exit-137 crashes with opposite fixes, quota refusals visible only as events, stalled rollouts that keep serving |
| Every mission can be finished, and the wrong fix does not pass | `tests/missions.test.ts` plays each mission from its own hints |
| The ML and serving lessons' claims | `tests/ai.test.ts`: backprop vs a numerical gradient, XOR needs a hidden layer, paging beats reserving |
| A corrupt progress store is never overwritten | `tests/progress.test.ts` |
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

MIT. See [LICENSE](LICENSE).
