// Renders every built page in a real browser and drives every widget.
//
// A static site returns 200 for a page whose scripts all threw, so status
// codes prove nothing here. For each page this reports the heading, how much
// text is visible, console errors, failed requests and a screenshot; then it
// types into the playgrounds and asserts on what appears on screen.
//
//   npm run build && npm run check:site            (screenshots in .site-check/)
//   SITE_URL=https://learn.curiouspandas.dev npm run check:site   (check the live site)
//   BROWSER=webkit npm run check:site              (Safari's engine; also firefox)
//
// WebKit matters most: every browser on an iPhone is WebKit underneath, and
// phones are where most learners will meet this site first.

import * as engines from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import { readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ENGINE = process.env.BROWSER ?? 'chromium';
if (!['chromium', 'webkit', 'firefox'].includes(ENGINE)) throw new Error(`BROWSER must be chromium, webkit or firefox, not ${ENGINE}`);
// One folder per engine, so a WebKit run never overwrites Chromium's evidence.
const OUT = join('.site-check', ENGINE);
mkdirSync(OUT, { recursive: true });

function pages(dir, base = dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return pages(p, base);
    if (!f.endsWith('.html')) return [];
    const rel = '/' + relative(base, p).replace(/\\/g, '/');
    return [rel === '/404.html' ? rel : rel.replace(/index\.html$/, '')];
  });
}

let server;
let base = process.env.SITE_URL;
if (!base) {
  const port = process.env.CHECK_PORT ?? '4329';
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['node_modules/astro/bin/astro.mjs', 'preview', '--port', port, '--host', '127.0.0.1'], { stdio: 'pipe' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await engines[ENGINE].launch();
const failures = [];
const report = [];
const fail = (page, msg) => { failures.push(`${page}: ${msg}`); };

async function visit(path, { dark = false, width = 1280 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: dark ? 'dark' : 'light' });
  const page = await ctx.newPage();
  const errors = [], failed = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/404.html') && !(path === '/404.html')) failed.push(`${r.status()} ${r.url()}`); });
  await page.goto(base + path, { waitUntil: 'networkidle' });
  return { ctx, page, errors, failed };
}

// A page's requests all succeeding says nothing about where its links go. Every
// internal link must name a built page (or a file in public/).
const known = new Set([...pages('dist'), '/favicon.svg']);
for (const path of pages('dist')) {
  const { ctx, page, errors, failed } = await visit(path);
  const h1 = (await page.locator('h1').first().textContent().catch(() => null))?.trim() ?? null;
  const text = (await page.locator('main').innerText().catch(() => '')).trim();
  const shot = join(OUT, (path.replace(/\//g, '_').replace(/^_|_$/g, '') || 'home') + '.png');
  await page.screenshot({ path: shot, fullPage: true });
  // Horizontal scroll at phone width is a layout bug a desktop screenshot hides.
  await page.setViewportSize({ width: 375, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  // "No sideways scroll" says nothing about whether a widget is usable at
  // phone width, so keep the picture too.
  await page.screenshot({ path: shot.replace(/\.png$/, '.phone.png'), fullPage: true });
  // Name the culprits, or "scrolls sideways" is a hunt every time.
  const wide = overflow > 1 ? await page.evaluate(() => [...document.querySelectorAll('main *')]
    .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('[style*="overflow"], pre, .graph, .term-out, table'))
    .slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} right=${Math.round(e.getBoundingClientRect().right)}`)) : [];
  report.push({ path, h1, chars: text.length, errors, failed, overflow, wide, shot });
  // Accessibility, in both colour schemes: the site shipped 73 serious axe
  // violations (gold text at 2.6:1, links nested in links) that no other check
  // here could see. axe reads structure and computed colour, which do not vary
  // by engine, so one engine's run is enough and the others skip the minutes.
  await page.setViewportSize({ width: 1280, height: 900 });
  // Buttons fade their background over 150ms. Switching scheme and measuring at
  // once caught them mid-fade on CI's slower runner: light text on a still-light
  // button, 9 failures that no settled page shows. Measure the settled colours.
  if (ENGINE === 'chromium') await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  if (ENGINE === 'chromium') for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    for (const v of violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'))
      fail(path, `a11y (${scheme}) ${v.id}: ${v.help} - ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}${v.nodes.length > 3 ? ` +${v.nodes.length - 3} more` : ''}`);
  }
  if (!h1) fail(path, 'no h1');
  if (text.length < 200 && path !== '/404.html') fail(path, `only ${text.length} characters visible`);
  if (errors.length) fail(path, `console errors: ${errors.join(' | ')}`);
  if (failed.length) fail(path, `failed requests: ${failed.join(' | ')}`);
  if (overflow > 1) fail(path, `scrolls sideways by ${overflow}px at 375px wide: ${wide.join(', ')}`);
  // Diagrams: ids must be unique on a page (they key the SVG title, desc and
  // arrowhead ids - a duplicate silently borrows another diagram's arrows), and
  // each must draw at least one box.
  const diagrams = await page.evaluate(() => [...document.querySelectorAll('[data-diagram]')].map((d) => ({ id: d.getAttribute('data-diagram'), boxes: d.querySelectorAll('.d-node').length })));
  const seen = new Set();
  for (const d of diagrams) {
    if (seen.has(d.id)) fail(path, `two diagrams share the id "${d.id}"`);
    seen.add(d.id);
    if (!d.boxes) fail(path, `diagram "${d.id}" drew no boxes`);
  }
  for (const href of await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')))) {
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    const target = href.split('#')[0];
    if (!known.has(target)) fail(path, `links to ${href}, which is not a page`);
  }
  await ctx.close();
}

// ---- drive the widgets --------------------------------------------------

async function scenario(name, path, fn, opts) {
  const { ctx, page, errors } = await visit(path, opts);
  try {
    await fn(page);
    if (errors.length) fail(name, `console errors: ${errors.join(' | ')}`);
    await page.screenshot({ path: join(OUT, `scenario-${name}.png`), fullPage: false });
    report.push({ scenario: name, ok: true });
  } catch (e) {
    await page.screenshot({ path: join(OUT, `scenario-${name}-FAILED.png`), fullPage: true });
    fail(name, e.message.split('\n')[0]);
  }
  await ctx.close();
}

const type = async (page, root, cmd) => {
  const input = page.locator(`${root} .term-in input`).first();
  await input.fill(cmd);
  await input.press('Enter');
};
const expectText = async (page, sel, re, timeout = 8000) => {
  const loc = page.locator(sel).first();
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    last = (await loc.innerText().catch(() => '')) ?? '';
    if (re.test(last)) return last;
    await page.waitForTimeout(150);
  }
  throw new Error(`${sel} never matched ${re} (last: ${JSON.stringify(last.slice(-200))})`);
};

await scenario('git-first-commit', '/learn/git/what-is-git/', async (page) => {
  const r = '[data-git-playground]';
  // Hints start collapsed. A display rule once overrode [hidden] and every
  // answer was printed under its question.
  const shownHints = await page.locator(`${r} .m-steps code:visible`).count();
  if (shownHints) throw new Error(`${shownHints} mission hints visible before anyone asked`);
  await type(page, r, 'git init');
  await type(page, r, 'echo "x" > untracked.txt');
  // Styles on script-created elements: Astro's scoped CSS never reached them.
  const color = await page.locator(`${r} [data-area="work"] li.new`).evaluate((e) => getComputedStyle(e).color);
  const ink = await page.evaluate(() => getComputedStyle(document.body).color);
  if (color === ink) throw new Error('untracked file is not coloured - widget styles are not applying');
  await type(page, r, 'rm untracked.txt');
  for (const c of ['git init', 'echo "hello, panda" > hello.txt', 'git status', 'git add hello.txt', 'git commit -m "my first commit"', 'git log']) await type(page, r, c);
  await expectText(page, `${r} .term-out`, /\(HEAD -> main\)/);
  await expectText(page, `${r} [data-graph]`, /my first commit/);
  await expectText(page, `${r} .m-steps`, /Read the history/);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 6) throw new Error('mission did not tick all 6 steps');
  await expectText(page, 'header [data-xp]', /^[1-9]/);
  // Commit hashes depend on the real clock here, but a blob does not:
  // printf 'hello, panda\n' | git hash-object --stdin
  await type(page, r, 'git hash-object hello.txt');
  await expectText(page, `${r} .term-out`, /81fb69a93b2424a66b496ff611d002ae8b6039e4/);
});

await scenario('git-conflict', '/learn/git/conflicts/', async (page) => {
  const r = '[data-git-playground]';
  await type(page, r, 'git merge snack');
  await expectText(page, `${r} .term-out`, /CONFLICT \(content\): Merge conflict in menu\.txt/);
  await type(page, r, 'cat menu.txt');
  await expectText(page, `${r} .term-out`, /<<<<<<< HEAD/);
  for (const c of ['echo "bamboo" > menu.txt', 'echo "apples" >> menu.txt', 'echo "pears" >> menu.txt', 'git add menu.txt', 'git commit -m "both fruits"']) await type(page, r, c);
  await expectText(page, `${r} .m-debrief`, /two parents/);
});

await scenario('kube-self-heal', '/learn/kubernetes/desired-state/', async (page) => {
  const r = '[data-kube-sim]';
  await page.selectOption(`${r} [data-speed]`, '150');
  await type(page, r, 'kubectl create deployment hello --image=panda/hello:1.0 --replicas=3');
  await page.waitForFunction(() => document.querySelectorAll('[data-kube-sim] .pod.ok').length === 3, null, { timeout: 15000 });
  const podBg = await page.locator(`${r} .pod.ok`).first().evaluate((e) => getComputedStyle(e).backgroundColor);
  if (/rgb\(2[34]\d, 2[34]\d, 2[34]\d\)|rgba\(0, 0, 0, 0\)/.test(podBg)) throw new Error(`Ready pods render as plain buttons (${podBg}) - widget styles are not applying`);
  const name = await page.locator(`${r} .pod.ok`).first().getAttribute('title').then((t) => t.split('\n')[0]);
  // The cluster view once rebuilt every pod each tick: clicks that straddled a
  // tick did nothing (WebKit timed out here) and keyboard focus fell off.
  await page.locator(`${r} .pod.ok`).first().focus();
  await page.waitForTimeout(600);
  if (!(await page.evaluate(() => document.activeElement?.classList.contains('pod')))) throw new Error('keyboard focus fell off a pod when the cluster ticked');
  await type(page, r, `kubectl delete pod ${name}`);
  await expectText(page, `${r} .m-debrief`, /That loop/, 20000);
  await page.locator(`${r} .pod`).first().click();
  await expectText(page, `${r} .term-out`, /Events:/);
});

await scenario('vllm-race', '/learn/llm/serving-vllm/', async (page) => {
  const r = '[data-kvsim]';
  await page.click(`${r} [data-race]`);
  const text = await expectText(page, `${r} [data-race-out]`, /paged · continuous \(vLLM\)/);
  const steps = [...text.matchAll(/(\d+) steps/g)].map((m) => Number(m[1]));
  if (!(steps[3] < steps[0])) throw new Error(`vLLM combo was not fastest-than-baseline: ${steps}`);
  await page.click(`${r} [data-play]`);
  await page.waitForTimeout(800);
  await expectText(page, `${r} [data-running]`, /^[1-9]/);
  await expectText(page, `${r} .kvc-out, [data-kvcalc] [data-out]`, /128\.0 KiB|0\.1 MiB|MiB per token|KiB/);
});

await scenario('neural-train', '/playground/', async (page) => {
  const r = '[data-nn]';
  const before = await page.locator(`${r} [data-loss]`).innerText();
  await page.click(`${r} [data-play]`);
  await page.waitForTimeout(2500);
  await page.click(`${r} [data-play]`);
  const after = await page.locator(`${r} [data-loss]`).innerText();
  const epoch = Number(await page.locator(`${r} [data-epoch]`).innerText());
  if (!(epoch > 50)) throw new Error(`only ${epoch} epochs ran`);
  if (!(Number(after) < Number(before))) throw new Error(`loss did not fall: ${before} -> ${after}`);
});

await scenario('tokens', '/playground/', async (page) => {
  const r = '[data-tokenlab]';
  const many = Number(await page.locator(`${r} [data-toks]`).innerText());
  await page.locator(`${r} [data-merges]`).fill('0');
  const chars = Number(await page.locator(`${r} [data-toks]`).innerText());
  if (!(chars > many)) throw new Error(`0 merges gave ${chars} tokens, 120 gave ${many}`);
});

await scenario('home-hash', '/', async (page) => {
  await page.locator('[data-hash-toy] textarea').fill('hello');
  // echo "hello" | git hash-object --stdin  ==  ce013625030ba8dba906f756967f9e9ca394464a
  await expectText(page, '[data-hash-toy] [data-out]', /^ce013625030ba8dba906f756967f9e9ca394464a$/);
});

await scenario('dark-mode-lesson', '/learn/git/what-is-git/', async (page) => {
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  if (bg === 'rgb(247, 245, 239)') throw new Error('dark scheme requested but body is the light background');
}, { dark: true });

await scenario('phone-kube', '/learn/kubernetes/desired-state/', async (page) => {
  // Play the mission at phone width, so the screenshot shows a working cluster
  // rather than the top of the lesson.
  const r = '[data-kube-sim]';
  // The sim pauses while off screen (battery). On a phone it starts below the
  // fold, and fill() types without scrolling, so look at it first like a person.
  await page.locator(`${r} .term-in input`).scrollIntoViewIfNeeded();
  await page.selectOption(`${r} [data-speed]`, '150');
  await type(page, r, 'kubectl create deployment hello --image=panda/hello:1.0 --replicas=3');
  await page.waitForFunction(() => document.querySelectorAll('[data-kube-sim] .pod.ok').length === 3, null, { timeout: 15000 });
  await page.locator(`${r} [data-nodes]`).scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) throw new Error(`scrolls sideways by ${overflow}px`);
  const box = await page.locator(`${r} .pod.ok`).first().boundingBox();
  if (!box || box.width < 24 || box.height < 24) throw new Error(`pods are too small to tap on a phone: ${JSON.stringify(box)}`);
}, { width: 375 });


await scenario('layer-cache', '/learn/containers/layers-and-cache/', async (page) => {
  const r = '[data-layer-cache]';
  await expectText(page, `${r} [data-total]`, /first build/);
  // Copy-everything-first: a code edit must rebuild the install.
  await page.click(`${r} [data-edit="src/server.js"]`);
  const naive = await expectText(page, `${r} [data-steps]`, /RUN npm ci/);
  if (!/REBUILT\s*RUN npm ci/.test(naive)) throw new Error(`naive order kept npm ci cached: ${naive}`);
  // Package-files-first: the next code edit keeps the install cached and wins the mission.
  await page.click(`${r} [data-preset="friendly"]`);
  await page.click(`${r} [data-edit="src/server.js"]`);
  const friendly = await expectText(page, `${r} [data-steps]`, /CACHED\s*RUN npm ci/);
  if (!/REBUILT\s*COPY \. \./.test(friendly)) throw new Error(`COPY . . should have rebuilt after the edit: ${friendly}`);
  await expectText(page, `${r} [data-goal]`, /Done/);
  // Script-created rows must actually be styled (scoped CSS never reached them once).
  const bg = await page.locator(`${r} .lc-steps .hit .tag`).first().evaluate((e) => getComputedStyle(e).backgroundColor);
  if (bg === 'rgba(0, 0, 0, 0)') throw new Error('CACHED tags are unstyled - widget styles are not applying');
});

await scenario('request-journey', '/learn/web/status-codes-lie/', async (page) => {
  const r = '[data-journey]';
  // Starts on the empty shell: exit 0, status 200, and only the body check catches it.
  await expectText(page, `${r} [data-facts]`, /exit code\s*0[\s\S]*HTTP status\s*200/);
  const rows = await expectText(page, `${r} [data-checkrows]`, /body contains/);
  if (!/status is 200\s*passes\s*fooled/.test(rows)) throw new Error(`status check should be fooled by the shell: ${rows}`);
  if (!/body contains "Bamboo shop"\s*fails\s*caught it/.test(rows)) throw new Error(`body check should catch the shell: ${rows}`);
  await page.click(`${r} [data-pick="dns"]`);
  await expectText(page, `${r} [data-trace]`, /curl: \(6\) Could not resolve host/);
  await page.click(`${r} [data-pick="500"]`);
  const r500 = await expectText(page, `${r} [data-checkrows]`, /curl exited 0/);
  if (!/curl exited 0\s*passes\s*fooled/.test(r500)) throw new Error(`exit-code check should be fooled by a 500: ${r500}`);
});

await scenario('tls-verify-codes', '/learn/web/tls-trust/', async (page) => {
  const r = '[data-journey]';
  await expectText(page, `${r} [data-facts]`, /62 \(hostname mismatch\)/);
  await page.click(`${r} [data-pick="tls-trust"]`);
  await expectText(page, `${r} [data-facts]`, /20 \(unable to get local issuer certificate\)/);
  await expectText(page, `${r} [data-facts]`, /exit code\s*60/);
});



// ---- kubernetes + platform track (fork-k8s) -----------------------------
// Each KubeSim lesson: complete at least one mission step by typing, and see
// the cluster's own words on screen.

const doneSteps = (page, r) => page.locator(`${r} .m-steps li.done`).count();

await scenario('kube-pending', '/learn/kubernetes/scheduling/', async (page) => {
  const r = '[data-kube-sim]';
  await type(page, r, 'kubectl get pods -o wide');
  await expectText(page, `${r} .term-out`, /Pending/);
  const pending = await page.locator(`${r} [data-pending] .pod`).first().getAttribute('title').then((t) => t.split('\n')[0]);
  await type(page, r, `kubectl describe pod ${pending}`);
  await expectText(page, `${r} .term-out`, /0\/2 nodes are available: 2 Insufficient cpu\./);
  if (await doneSteps(page, r) < 2) throw new Error('find + describe did not tick two steps');
  await page.selectOption(`${r} [data-speed]`, '150');
  await type(page, r, 'kubectl get nodes');
  await type(page, r, 'kubectl set resources deployment big --requests=cpu=500m');
  await expectText(page, `${r} .m-debrief`, /places pods by what they/, 25000);
});

await scenario('kube-two-crashes', '/learn/kubernetes/restarts/', async (page) => {
  const r = '[data-kube-sim]';
  await type(page, r, 'kubectl get pods');
  // Between restarts the pod briefly reads Running; the restart count is the steady signal.
  await expectText(page, `${r} .term-out`, /starved-\S+\s+0\/1\s+\S+\s+[1-9]/);
  const starved = (await page.locator(`${r} .term-out`).innerText()).match(/starved-[a-z0-9]+-[a-z0-9]+/)[0];
  await type(page, r, `kubectl describe pod ${starved}`);
  await expectText(page, `${r} .term-out`, /Reason:\s+OOMKilled[\s\S]*Exit Code:\s+137/);
  if (await doneSteps(page, r) < 2) throw new Error('describing starved did not tick its step');
});

await scenario('kube-quota', '/learn/kubernetes/admission/', async (page) => {
  const r = '[data-kube-sim]';
  await type(page, r, 'kubectl get deploy');
  await expectText(page, `${r} .term-out`, /quota-demo\s+3\/6/);
  await type(page, r, 'kubectl get events');
  await expectText(page, `${r} .term-out`, /exceeded quota: pandas/);
  if (await doneSteps(page, r) < 2) throw new Error('finding the refusal did not tick two steps');
});

await scenario('kube-rollout', '/learn/kubernetes/rollouts/', async (page) => {
  const r = '[data-kube-sim]';
  await page.selectOption(`${r} [data-speed]`, '150');
  await type(page, r, 'kubectl set image deployment/hello app=panda/hello:2.O');
  await page.waitForFunction(() => document.querySelectorAll('[data-kube-sim] .pod.bad').length > 0, null, { timeout: 15000 });
  if (await page.locator(`${r} .pod.ok`).count() !== 3) throw new Error('old version stopped serving during a bad rollout');
  await type(page, r, 'kubectl rollout status deployment/hello');
  await expectText(page, `${r} .term-out`, /Waiting for deployment "hello" rollout to finish/);
  if (await doneSteps(page, r) < 3) throw new Error('typo + watch + status did not tick three steps');
});

await scenario('gitops-drift', '/learn/platform/gitops/', async (page) => {
  const r = '[data-gitops]';
  await page.click(`${r} [data-edit="replicas"]`);
  await expectText(page, `${r} [data-drift]`, /Live differs from git/);
  await expectText(page, `${r} [data-log]`, /Kustomization corrected drift: replicas 7 -> 2/, 8000);
  await expectText(page, `${r} [data-drift]`, /Live matches git/);
  await page.selectOption(`${r} [data-mode]`, 'helm');
  await page.click(`${r} [data-edit="replicas"]`);
  await page.waitForTimeout(6000);
  await expectText(page, `${r} [data-drift]`, /Live differs from git/);
  if (!(await page.locator(`${r} [data-goal="survive"].done`).count())) throw new Error('helm survival goal did not tick');
});

await scenario('obs-empty-dashboard', '/learn/platform/observability/', async (page) => {
  const r = '[data-scrape]';
  if (!(await page.locator(`${r} [data-nodata]`).isHidden())) throw new Error('panel empty before anything was broken');
  await page.click(`${r} [data-break]`);
  await expectText(page, `${r} .sc-k8s`, /servicemonitor\/hello exists/);
  if (await page.locator(`${r} [data-nodata]`).isHidden()) throw new Error('panel still drew data after the break');
  await page.click(`${r} [data-targets]`);
  await expectText(page, `${r} [data-targetbox]`, /No target for serviceMonitor/);
  await page.selectOption(`${r} [data-port]`, 'http');
  await expectText(page, `${r} [data-targetbox]`, /UP/);
  await page.waitForTimeout(2500);
  await expectText(page, 'header [data-xp]', /^[1-9]/);
});


await scenario('attention', '/learn/llm/attention/', async (page) => {
  const r = '[data-attention]';
  // The last word is selected first: "hungry" must look hardest at "panda".
  const top = async () => {
    const rows = await page.locator(`${r} [data-bars] .bar`).evaluateAll((els) => els.map((e) => [e.querySelector('code').textContent, parseFloat(e.querySelector('span').textContent)]));
    return rows.sort((a, b) => b[1] - a[1])[0][0];
  };
  if (await top() !== 'panda') throw new Error(`"hungry" looked hardest at ${await top()}, not panda`);
  await page.selectOption(`${r} [data-sentence]`, 'tasty');
  if (await top() !== 'bamboo') throw new Error(`"tasty" looked hardest at ${await top()}, not bamboo`);
  await page.locator(`${r} .attn-words .w`, { hasText: /^it$/ }).click();
  const pct = await page.locator(`${r} [data-bars] .bar`).evaluateAll((els) => Object.fromEntries(els.map((e) => [e.querySelector('code').textContent, e.querySelector('span').textContent])));
  if (pct.panda !== pct.bamboo) throw new Error(`"it" should split evenly: panda ${pct.panda}, bamboo ${pct.bamboo}`);
  // Script-created words must be styled (scoped CSS never reaches them).
  const outline = await page.locator(`${r} .attn-words .w.sel`).evaluate((e) => getComputedStyle(e).outlineStyle);
  if (outline !== 'solid') throw new Error('selected word has no outline - widget styles are not applying');
  // Every cell above the diagonal is the future: n(n-1)/2 of them.
  const n = await page.locator(`${r} .attn-words .w`).count();
  const masked = await page.locator(`${r} .attn-matrix .c.masked`).count();
  if (masked !== (n * (n - 1)) / 2) throw new Error(`expected ${(n * (n - 1)) / 2} masked (future) cells for ${n} words, got ${masked}`);
});

await scenario('diagram-steps', '/learn/git/inside-git/', async (page) => {
  const r = '[data-diagram="git-objects-map"]';
  const visible = () => page.locator(`${r} .d-wide .d-node:not(.d-off)`).count();
  await page.locator(r).scrollIntoViewIfNeeded();
  if (await visible() !== 1) throw new Error(`step 1 should show only the commit, shows ${await visible()} boxes`);
  if (!(await page.locator(`${r} [data-prev]`).isDisabled())) throw new Error('Back is enabled on the first step');
  await expectText(page, `${r} .d-captions li:not([hidden])`, /Start at HEAD/);
  for (let i = 0; i < 3; i++) await page.click(`${r} [data-next]`);
  await expectText(page, `${r} [data-count]`, /^4 of 4$/);
  await expectText(page, `${r} .d-captions li:not([hidden])`, /parent commit/);
  if (await visible() !== 5) throw new Error(`last step should show all 5 boxes, shows ${await visible()}`);
  if (await page.locator(`${r} .d-captions li:not([hidden])`).count() !== 1) throw new Error('more than one caption visible while stepping');
  if (!(await page.locator(`${r} .d-wide .d-node.d-focus[data-el="parent"]`).count())) throw new Error('the focus box of the last step is not highlighted');
});

await scenario('diagram-phone', '/learn/git/inside-git/', async (page) => {
  // On a phone the 3-wide picture must turn to 2 across, not shrink its labels.
  const r = '[data-diagram="git-objects-map"]';
  await page.locator(r).scrollIntoViewIfNeeded();
  if (await page.locator(`${r} .d-wide`).isVisible()) throw new Error('the wide layout shows on a phone');
  const box = await page.locator(`${r} .d-narrow`).boundingBox();
  const vb = await page.locator(`${r} .d-narrow`).getAttribute('viewBox');
  const scale = box.width / Number(vb.split(' ')[2]);
  if (scale * 16 < 12) throw new Error(`box labels render at ${(scale * 16).toFixed(1)}px on a phone`);
}, { width: 375 });

await scenario('nn-challenge-prop', '/learn/ml/neural-networks/', async (page) => {
  // The xor lesson starts with no hidden layer and only x,y - the props must land.
  const first = page.locator('[data-nn]').first();
  const arch = await first.locator('[data-arch]').innerText();
  if (!/^Shape: 2 → 1 /.test(arch)) throw new Error(`expected a no-hidden-layer network, got "${arch}"`);
  await expectText(page, '[data-nn] [data-goal]', /checkerboard/);
});

// ---- security 4-6 (writer B)
// Each widget: play its mission the way a learner would, and check that the
// wrong-but-tempting move (cluster-admin, alg none, one control) shows as wrong.

await scenario('supply-chain', '/learn/security/supply-chain/', async (page) => {
  const r = '[data-supply]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.check(`${r} input[value="takeover"]`);
  await page.click(`${r} [data-install]`);
  await expectText(page, `${r} [data-verdict]`, /^Got in: toy-flatmap/);
  if (!(await page.locator(`${r} .sc-tree li.bad.missed`).count())) throw new Error('the installed bad package is not marked in the tree');
  await page.check(`${r} .sc-controls input[value="lockfile"]`);
  await page.click(`${r} [data-install]`);
  await expectText(page, `${r} [data-verdict]`, /^Delayed - not stopped/);
  await page.check(`${r} input[value="tarball"]`);
  await page.uncheck(`${r} .sc-controls input[value="lockfile"]`);
  await page.check(`${r} .sc-controls input[value="provenance"]`);
  await page.click(`${r} [data-install]`);
  await expectText(page, `${r} [data-verdict]`, /^Blocked: toy-compress/);
  await page.check(`${r} .sc-controls input[value="lockfile"]`);
  await page.check(`${r} .sc-controls input[value="review"]`);
  await page.click(`${r} [data-all]`);
  await expectText(page, `${r} [data-verdict]`, /All five blocked/);
  await page.uncheck(`${r} .sc-controls input[value="review"]`);
  await page.click(`${r} [data-all]`);
  await expectText(page, `${r} [data-verdict]`, /of 5 got in/);
  await expectText(page, `${r} .m-debrief`, /blind to something/);
  // Script-created rows must be styled (scoped CSS never reaches them).
  const bg = await page.locator(`${r} .sc-all tr.missed td`).last().evaluate((e) => getComputedStyle(e).color);
  const ink = await page.evaluate(() => getComputedStyle(document.body).color);
  if (bg === ink) throw new Error('results table is unstyled - widget styles are not applying');
});

await scenario('rbac-least', '/learn/security/cluster-access/', async (page) => {
  const r = '[data-rbac]';
  await page.locator(`${r} .term-in input`).scrollIntoViewIfNeeded();
  await type(page, r, 'kubectl auth can-i get configmaps/shop-settings -n shop --as=system:serviceaccount:shop:reporter');
  await expectText(page, `${r} .term-out`, /\bno\s*$/);
  // The tempting fix works and must read as wrong.
  await type(page, r, 'kubectl create clusterrolebinding reporter-admin --clusterrole=cluster-admin --serviceaccount=shop:reporter');
  await expectText(page, `${r} [data-audit]`, /OPEN/);
  if (await page.locator(`${r} [data-audit] li.bad`).count() !== 4) throw new Error('cluster-admin should fail exactly the four least-privilege checks');
  if (await doneSteps(page, r) !== 2) throw new Error(`cluster-admin should tick only the first two steps, ticked ${await doneSteps(page, r)}`);
  await type(page, r, 'kubectl delete clusterrolebinding reporter-admin');
  await type(page, r, 'kubectl create role settings-reader --verb=get --resource=configmaps --resource-name=shop-settings -n shop');
  await type(page, r, 'kubectl create rolebinding reporter-settings --role=settings-reader --serviceaccount=shop:reporter -n shop');
  if (await page.locator(`${r} [data-audit] li.bad`).count()) throw new Error('least-privilege grant still fails an audit check');
  await type(page, r, 'kubectl auth can-i get secrets -n shop --as=system:serviceaccount:shop:reporter');
  await expectText(page, `${r} .m-debrief`, /one verb, one resource, one name/);
});

await scenario('jwt-forge', '/learn/security/identity/', async (page) => {
  const r = '[data-jwtlab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await expectText(page, `${r} [data-token]`, /^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/);
  await page.click(`${r} [data-send]`);
  await expectText(page, `${r} [data-api="strict"] [data-res]`, /Accepted - you are "viewer"/);
  const box = page.locator(`${r} [data-payload]`);
  await box.fill((await box.inputValue()).replace('"viewer"', '"admin"'));
  await page.click(`${r} [data-send]`);
  await expectText(page, `${r} [data-api="naive"] [data-res]`, /Refused · signature does not match/);
  await page.click(`${r} [data-none]`);
  await expectText(page, `${r} [data-api="naive"] [data-res]`, /Accepted - you are "admin"/);
  await expectText(page, `${r} [data-api="strict"] [data-res]`, /alg "none" is not on this server's allow-list/);
  await page.click(`${r} [data-other]`);
  await expectText(page, `${r} [data-api="strict"] [data-res]`, /audience/);
  await expectText(page, `${r} .m-debrief`, /someone else's app/);
});

await browser.close();
server?.kill();

writeFileSync(join(OUT, 'report.json'), JSON.stringify({ base, failures, report }, null, 2));
for (const r of report) {
  if (r.path) console.log(`${r.errors.length || r.failed.length || r.overflow > 1 || !r.h1 ? '✗' : '✓'} ${r.path.padEnd(36)} h1=${JSON.stringify(r.h1)} text=${r.chars} errors=${r.errors.length} failed=${r.failed.length}`);
  else console.log(`✓ scenario ${r.scenario}`);
}
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nAll ${report.length} checks passed in ${ENGINE}. Screenshots in ${OUT}/ - look at them.`);
