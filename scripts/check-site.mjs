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
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
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
  // If something already answers on this port - another worktree's preview, a
  // dev server - every check below would pass or fail against that build, not
  // this one. Refuse instead of testing the wrong site.
  const busy = await fetch(base).then(() => true, () => false);
  if (busy) { console.error(`Port ${port} is already serving something. Stop it or set CHECK_PORT.`); process.exit(2); }
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
  // The site promises no third-party requests. A font, script or beacon from
  // another host would load fine and pass every other check here.
  page.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.origin !== new URL(base).origin) failed.push(`third-party request: ${r.url()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/404.html') && !(path === '/404.html')) failed.push(`${r.status()} ${r.url()}`); });
  await page.goto(base + path, { waitUntil: 'networkidle' });
  return { ctx, page, errors, failed };
}

// A page's requests all succeeding says nothing about where its links go. Every
// internal link must name a built page (or a file in public/).
const known = new Set([...pages('dist'), '/favicon.svg']);
for (const path of pages('dist')) {
  // A redirect page has no content of its own to check; what matters is that
  // it lands on a real page rather than forwarding a bookmark into a 404.
  const html = readFileSync(join('dist', path === '/404.html' ? path : path + 'index.html'), 'utf8');
  const refresh = html.match(/http-equiv="refresh" content="\d+;url=([^"]+)"/);
  if (refresh) {
    const to = new URL(refresh[1], base + path).pathname;
    if (!known.has(to)) fail(path, `redirects to ${to}, which is not a page`);
    report.push({ path, redirect: to });
    continue;
  }
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
  // Look at the terminal first, as a person would. Simulations pause off screen
  // (battery), and fill() does not scroll in WebKit: when a diagram pushed the
  // cluster below the fold, kube-self-heal timed out in WebKit only.
  await input.scrollIntoViewIfNeeded();
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
  // A Ready pod, not just the first one: right after the delete, the first pod
  // can be the one being removed, and a click on an element that vanishes at
  // the next tick does nothing. That failed once in CI's WebKit (2026-10-30).
  await page.locator(`${r} .pod.ok`).first().click();
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
  // Both precisions once printed "0.1 MiB per token"; halving the bytes must show.
  await expectText(page, '[data-kvcalc] [data-out]', /128 KiB/);
  await page.selectOption('[data-kvcalc] [data-bytes]', '1');
  await expectText(page, '[data-kvcalc] [data-out]', /64 KiB/);
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
  // The slider used to run to 400 although the story yields about 340 merges,
  // and ids shifted as the learner typed: a real vocabulary is fixed.
  const max = Number(await page.locator(`${r} [data-merges]`).getAttribute('max'));
  if (!(max > 300 && max < 400)) throw new Error(`merge slider ends at ${max}, not where the story runs out of merges`);
  await page.locator(`${r} [data-merges]`).fill('120');
  await page.locator(`${r} [data-text]`).fill('the panda eats');
  const idOf = () => page.locator(`${r} [data-chips] .chip`).evaluateAll((cs) => cs.map((c) => c.getAttribute('title')).find((t) => /" panda"/.test(t ?? '')));
  const before = await idOf();
  await page.locator(`${r} [data-text]`).fill('the panda eats 12345 #');
  const after = await idOf();
  if (!before || before !== after) throw new Error(`" panda" id changed after typing new characters: ${before} -> ${after}`);
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

// ---- security 1-3 (writer A)
await scenario('sec-secret-history', '/learn/security/secrets-in-git/', async (page) => {
  const r = '[data-git-playground]';
  await page.locator(`${r} .term-in input`).scrollIntoViewIfNeeded();
  for (const c of ['echo "PAYMENT_KEY=panda_live_7Qx2EXAMPLE" >> config.env', 'git commit -am "add payment key"', 'echo "PORT=8080" > config.env', 'git commit -am "remove key"', 'cat config.env']) await type(page, r, c);
  // The current file is clean; reading it must not finish the mission.
  if (await page.locator(`${r} .m-debrief`).isVisible()) throw new Error('mission finished before the key was read back from history');
  await type(page, r, 'git show HEAD~1:config.env');
  await expectText(page, `${r} .term-out`, /PAYMENT_KEY=panda_live_7Qx2EXAMPLE/);
  await expectText(page, `${r} .m-debrief`, /revoke the key/);
  await expectText(page, 'header [data-xp]', /^[1-9]/);
});

await scenario('sec-hash-lab', '/learn/security/passwords-and-hashing/', async (page) => {
  const r = '[data-hash-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const ready = () => page.waitForFunction((sel) => !document.querySelector(`${sel} [data-attack]`).disabled && /^[0-9a-f]{64}$/.test(document.querySelector(`${sel} [data-hash]`).textContent), r);
  await page.selectOption(`${r} [data-pw]`, 'pandabear2024');
  await page.selectOption(`${r} [data-scheme]`, 'plain');
  await ready();
  await page.click(`${r} [data-attack]`);
  await expectText(page, `${r} [data-out]`, /Cracked after \d+ guesses.*"pandabear2024"/, 15000);
  await page.click(`${r} [data-table]`);
  await expectText(page, `${r} [data-out]`, /Found in one lookup/);
  await page.selectOption(`${r} [data-scheme]`, 'salted');
  await ready();
  await page.click(`${r} [data-table]`);
  await expectText(page, `${r} [data-out]`, /No match\. The table holds hashes of bare words/);
  // The listed password at 600,000 rounds must outlast the 4s budget.
  await page.selectOption(`${r} [data-scheme]`, 'pbkdf2');
  await page.selectOption(`${r} [data-iter]`, '600000');
  await ready();
  await page.click(`${r} [data-attack]`);
  await expectText(page, `${r} [data-out]`, /Gave up after 4s/, 20000);
  if (await page.locator(`${r} [data-goal].done`).count() !== 3) throw new Error('hash lab goals did not all tick');
  await expectText(page, 'header [data-xp]', /^[1-9]/);
});

await scenario('sec-xss-lab', '/learn/security/web-flaws/', async (page) => {
  const r = '[data-xss-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-preset^="<img"]`);
  await expectText(page, `${r} [data-verdict]`, /<img onerror>.*event handler/);
  if (!(await page.locator(`${r} .xl-preview .xl-chip.bad`).count())) throw new Error('the dangerous image is not drawn as a warning chip');
  // The page must never have created a real <img> from the comment.
  if (await page.locator(`${r} .xl-preview img`).count()) throw new Error('the preview created a live <img> from the comment');
  await page.selectOption(`${r} [data-mode]`, 'text');
  await expectText(page, `${r} [data-verdict]`, /Defused/);
  await expectText(page, `${r} [data-preview]`, /<img src="x" onerror=/);
  if (await page.locator(`${r} [data-goal].done`).count() !== 2) throw new Error('xss goals did not both tick');
  const bg = await page.locator(`${r} .xl-tree`).evaluate((e) => getComputedStyle(e).backgroundColor);
  if (bg === 'rgba(0, 0, 0, 0)') throw new Error('script-built tree is unstyled - widget styles are not applying');
});

await scenario('sec-sql-lab', '/learn/security/web-flaws/', async (page) => {
  const r = '[data-sql-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await expectText(page, `${r} [data-result]`, /1 row[\s\S]*Mei/);
  await page.click(`${r} [data-preset="' OR '1'='1"]`);
  await expectText(page, `${r} [data-query]`, /WHERE name = '' OR '1'='1'/);
  await expectText(page, `${r} [data-result]`, /4 rows/);
  await page.click(`${r} [data-preset="O'Neil"]`);
  await expectText(page, `${r} [data-result]`, /Error: .*quote ended the string early/);
  await page.click(`${r} [data-preset="' OR '1'='1"]`);
  await page.selectOption(`${r} [data-mode]`, 'param');
  await expectText(page, `${r} [data-query]`, /WHERE name = \?\nparameter 1:/);
  await expectText(page, `${r} [data-result]`, /0 rows/);
  if (await page.locator(`${r} [data-goal].done`).count() !== 2) throw new Error('sql goals did not both tick');
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
  await expectText(page, `${r} .m-debrief`, /only the verbs the app uses, on one resource, one name/);
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

// ---- linux (writer L)
// Each Linux mission played the way a learner would, with the tempting wrong
// fix tried first where there is one, and the side panels checked as well as
// the terminal: a listing or process table that never redraws would pass a
// terminal-only check.

await scenario('linux-paths', '/learn/linux/files-and-paths/', async (page) => {
  const r = '[data-shell-pg]';
  await type(page, r, 'pwd');
  await expectText(page, `${r} .term-out`, /\/home\/panda/);
  await type(page, r, 'ls -a');
  await expectText(page, `${r} .term-out`, /\.bashrc/);
  await type(page, r, 'cat /etc/hostname');
  await type(page, r, 'cd projects/bamboo');
  await expectText(page, `${r} [data-where]`, /panda@bamboo:~\/projects\/bamboo\$/);
  await type(page, r, 'cp README.md README.bak');
  await expectText(page, `${r} [data-files]`, /README\.bak/);
  await type(page, r, 'echo "gone" > /dev/null');
  await type(page, r, 'cat /dev/null');
  await expectText(page, `${r} .m-debrief`, /\/dev\/null took your text/);
  // Script-created rows must be styled: a directory name is drawn in its own colour.
  await type(page, r, 'cd ~');
  const dirColor = await page.locator(`${r} [data-files] li.dir .name`).first().evaluate((e) => getComputedStyle(e).color);
  const ink = await page.evaluate(() => getComputedStyle(document.body).color);
  if (dirColor === ink) throw new Error('folder names are unstyled - widget styles are not applying');
});

await scenario('linux-signals', '/learn/linux/processes-and-signals/', async (page) => {
  const r = '[data-shell-pg]';
  await type(page, r, 'ps -e');
  await expectText(page, `${r} .term-out`, /orders --listen :8080/);
  await type(page, r, 'kill 311');
  await expectText(page, `${r} .term-out`, /saved 3 orders/);
  await expectText(page, `${r} [data-proc-list]`, /orders --listen :8080\s*exited 0/);
  await type(page, r, 'kill 312');
  await type(page, r, 'ps -e');
  await expectText(page, `${r} [data-proc-list]`, /stuck --ignore-term\s*running/);
  await type(page, r, 'kill -9 312');
  await expectText(page, `${r} [data-proc-list]`, /stuck --ignore-term\s*ended 137 \(KILL\)/);
  await type(page, r, 'sleep 300 &');
  await type(page, r, 'kill %1');
  await expectText(page, `${r} .term-out`, /\[1\]\+\s+Terminated\s+sleep 300/);
  await type(page, r, 'wait %1');
  await type(page, r, 'echo $?');
  await expectText(page, `${r} .term-out`, /143\s*$/);
  await expectText(page, `${r} .m-debrief`, /128 \+ 15/);
});

await scenario('linux-perms', '/learn/linux/permissions/', async (page) => {
  const r = '[data-shell-pg]';
  await type(page, r, './deploy.sh');
  await expectText(page, `${r} .term-out`, /bash: \.\/deploy\.sh: Permission denied/);
  await type(page, r, 'ls -l deploy.sh');
  await expectText(page, `${r} .term-out`, /-rw-r--r-- 1 panda panda/);
  // The wrong fix: it runs, but anyone could now rewrite it. It must not pass.
  await type(page, r, 'chmod 777 deploy.sh');
  await type(page, r, './deploy.sh');
  await expectText(page, `${r} .term-out`, /deploying bamboo v2/);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 2) throw new Error('chmod 777 ticked the least-privilege step');
  await type(page, r, 'chmod 755 deploy.sh');
  await type(page, r, './deploy.sh');
  await expectText(page, `${r} [data-files]`, /-rwxr-xr-x\s*panda\s*deploy\.sh/);
  await type(page, r, 'cat /etc/shadow');
  await type(page, r, 'chmod 644 /etc/shadow');
  await expectText(page, `${r} .term-out`, /Operation not permitted/);
  await expectText(page, `${r} .m-debrief`, /chmod 777 would also have made it run/);
});

await scenario('linux-pipes', '/learn/linux/pipes/', async (page) => {
  const r = '[data-shell-pg]';
  await type(page, r, 'wc -l access.log');
  await expectText(page, `${r} .term-out`, /28 access\.log/);
  await type(page, r, "grep ' 500$' access.log");
  // The tempting answer counts every request and names the wrong client.
  await type(page, r, "cut -d ' ' -f 1 access.log | sort | uniq -c | sort -rn | head -1");
  await expectText(page, `${r} .term-out`, /12 10\.0\.0\.8\s*$/);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 2) throw new Error('counting every request ticked the failures step');
  await type(page, r, "grep ' 500$' access.log | cut -d ' ' -f 1 | sort | uniq -c | sort -rn | head -1 > noisy.txt");
  await type(page, r, "grep ' 500$' access.log | cut -d ' ' -f 1 | sort | uniq -c | sort -rn");
  await expectText(page, `${r} [data-files]`, /noisy\.txt/);
  await expectText(page, `${r} .m-debrief`, /never failed once/);
});

// ---- delivery (writer D)
// Each widget: play its mission as a learner would, including the tempting
// wrong move (retry until green, promote the failing canary), and check that
// the wrong move is shown as wrong rather than counted.

await scenario('pipeline-race', '/learn/delivery/pipelines/', async (page) => {
  const r = '[data-pipeline]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-push]`);
  await expectText(page, `${r} [data-verdict]`, /^In production after/);
  await page.check(`${r} [data-cache]`);
  await page.click(`${r} [data-push]`);
  await page.click(`${r} [data-push]`);
  await expectText(page, `${r} [data-stage="install"]`, /cache hit/);
  // Retrying the flaky test ships the race - and the widget says so.
  await page.check(`${r} input[value="race"]`);
  await page.selectOption(`${r} [data-flaky]`, 'retry');
  await page.click(`${r} [data-push]`);
  await expectText(page, `${r} [data-verdict]`, /race condition is now in production/);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 2) throw new Error('shipping the race by retrying ticked a mission step');
  // Script-set stage states must be styled (scoped CSS never reaches them).
  const passBg = await page.locator(`${r} [data-stage="lint"]`).evaluate((e) => getComputedStyle(e, '::before').backgroundColor);
  if (passBg === 'rgba(0, 0, 0, 0)') throw new Error('passed stages are unstyled - widget styles are not applying');
  await page.selectOption(`${r} [data-flaky]`, 'deterministic');
  await page.click(`${r} [data-push]`);
  await expectText(page, `${r} [data-verdict]`, /Stopped at test\. The race condition never left/);
  await page.check(`${r} input[value="code"]`);
  await page.check(`${r} [data-promote]`);
  await page.click(`${r} [data-push]`);
  await expectText(page, `${r} [data-verdict]`, /Production runs the artifact staging tested/);
  await expectText(page, `${r} .m-debrief`, /bytes you tested/);
});

await scenario('iac-plan', '/learn/delivery/infrastructure-as-code/', async (page) => {
  const r = '[data-iac]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-apply]`);
  await expectText(page, `${r} [data-msg]`, /Run a plan first/);
  await page.click(`${r} [data-plan]`);
  await expectText(page, `${r} [data-planout]`, /Plan: 3 to add, 0 to change, 0 to destroy\./);
  await page.click(`${r} [data-apply]`);
  await expectText(page, `${r} [data-msg]`, /Apply complete\. 3 added/);
  await page.selectOption(`${r} [data-size]`, 'large');
  await page.click(`${r} [data-plan]`);
  await expectText(page, `${r} [data-planout]`, /server\.web will be updated in-place/);
  await page.click(`${r} [data-apply]`);
  await page.click(`${r} [data-console="server"]`);
  await page.click(`${r} [data-plan]`);
  await expectText(page, `${r} [data-planout]`, /Changed outside the tool since the last apply: server\.web/);
  await page.click(`${r} [data-apply]`);
  await page.selectOption(`${r} [data-image]`, 'ubuntu-26.04');
  await page.click(`${r} [data-plan]`);
  await expectText(page, `${r} [data-planout]`, /server\.web must be replaced[\s\S]*forces replacement[\s\S]*dns_record\.www will be updated in-place/);
  await page.click(`${r} [data-apply]`);
  await page.uncheck(`${r} [data-bucket]`);
  await page.click(`${r} [data-plan]`);
  await expectText(page, `${r} [data-planout]`, /bucket\.assets will be destroyed/);
  await page.check(`${r} [data-bucket]`);
  await page.click(`${r} [data-plan]`);
  await expectText(page, `${r} [data-planout]`, /No changes/);
  await expectText(page, `${r} .m-debrief`, /reading the plan is the job/);
});

await scenario('release-canary', '/learn/delivery/release-strategies/', async (page) => {
  const r = '[data-release]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const release = async (version, strategy) => {
    await expectText(page, `${r} [data-status]`, /^(Pick|Promoted|Rolled back|Switched back|Finished)/, 15000);
    await page.selectOption(`${r} [data-version]`, version);
    await page.selectOption(`${r} [data-strategy]`, strategy);
    await page.click(`${r} [data-go]`);
  };
  await release('good', 'canary');
  await expectText(page, `${r} [data-status]`, /^Promoted/, 10000);
  await release('bad', 'rolling');
  await expectText(page, `${r} [data-status]`, /^Finished.*6% of requests v3 fails/, 10000);
  // Finishing a bad rollout is red, not green - and styled at all.
  if (!(await page.locator(`${r} [data-status].bad`).count())) throw new Error('a finished v3 rollout is not marked bad');
  const bg = await page.locator(`${r} [data-status]`).evaluate((e) => getComputedStyle(e).backgroundColor);
  await release('bad', 'bluegreen');
  await page.click(`${r} [data-back]`);
  await expectText(page, `${r} [data-status]`, /^Switched back to blue/);
  // The tempting button: promoting a failing canary by hand must not count.
  await release('bad', 'canary');
  await page.click(`${r} [data-promote]`);
  await expectText(page, `${r} [data-status]`, /^Promoted.*6% of requests v3 fails/);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 3) throw new Error('promoting the bad canary by hand ticked the last step');
  await release('bad', 'canary');
  await expectText(page, `${r} [data-status]`, /^Rolled back/, 10000);
  if (await page.locator(`${r} [data-ticks] li`).count() !== 3) throw new Error('bad canary should roll back after exactly 3 failed checks');
  await expectText(page, `${r} .m-debrief`, /no person awake required/);
  if (bg === 'rgba(0, 0, 0, 0)') throw new Error('release status is unstyled - widget styles are not applying');
});

// ---- network (writer N)
// Each widget: play its mission the way a learner would, and check that the
// tempting wrong move (a /16 rule, opening the firewall, least connections,
// switching the old server off early) does not pass.

const goalDone = (page, r, g) => page.locator(`${r} [data-goal="${g}"].done`).count();

await scenario('net-subnet', '/learn/network/ip-and-subnets/', async (page) => {
  const r = '[data-subnet-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  if (await page.locator(`${r} [data-bits] i`).count() !== 32) throw new Error('the calculator does not draw 32 bits');
  if (await goalDone(page, r, 'find')) throw new Error('the first goal was ticked before anyone typed');
  await page.fill(`${r} [data-cidr]`, '172.32.0.1/12');
  await expectText(page, `${r} [data-facts]`, /public: routable/);
  await page.fill(`${r} [data-cidr]`, '10.244.1.37/24');
  await expectText(page, `${r} [data-facts]`, /10\.244\.1\.0\/24[\s\S]*255\.255\.255\.0[\s\S]*254/);
  if (await page.locator(`${r} [data-bits] i.net`).count() !== 24) throw new Error('a /24 should mark 24 network bits');
  await page.fill(`${r} [data-rule]`, '10.244.0.0/16');
  await expectText(page, `${r} [data-verdict]`, /lets in more than it should/);
  if (await goalDone(page, r, 'exact')) throw new Error('a /16 rule passed the least-privilege goal');
  await page.fill(`${r} [data-rule]`, '10.244.1.0/24');
  await expectText(page, `${r} [data-verdict]`, /Exactly worker's pods/);
  if (await page.locator(`${r} [data-goal].done`).count() !== 3) throw new Error('subnet mission did not tick all three goals');
  await expectText(page, 'header [data-xp]', /^[1-9]/);
});

await scenario('net-tcp', '/learn/network/ports-and-tcp/', async (page) => {
  const r = '[data-tcp-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  // Starts broken: bound to loopback, a teammate on another machine is refused.
  await expectText(page, `${r} [data-curl]`, /curl: \(7\) Failed to connect to 10\.0\.0\.5 port 8080 after \d+ ms: Could not connect to server/);
  await expectText(page, `${r} [data-ss]`, /LISTEN .*127\.0\.0\.1:8080/);
  await page.selectOption(`${r} [data-from]`, 'same');
  await page.click(`${r} [data-go]`);
  await expectText(page, `${r} [data-packets]`, /SYN, ACK/);
  await page.selectOption(`${r} [data-from]`, 'other');
  await page.selectOption(`${r} [data-firewall]`, 'drop');
  await page.click(`${r} [data-go]`);
  await expectText(page, `${r} [data-curl]`, /\(28\) Connection timed out after 5002 milliseconds/);
  // The wrong fix: the firewall was never the problem.
  await page.selectOption(`${r} [data-firewall]`, 'allow');
  await page.click(`${r} [data-go]`);
  await expectText(page, `${r} [data-curl]`, /\(7\)/);
  if (await goalDone(page, r, 'fixed')) throw new Error('allowing the firewall passed the fix goal');
  await page.selectOption(`${r} [data-bind]`, '0.0.0.0');
  await page.click(`${r} [data-go]`);
  await expectText(page, `${r} [data-curl]`, /Connected to 10\.0\.0\.5/);
  if (await page.locator(`${r} [data-goal].done`).count() !== 3) throw new Error('tcp mission did not tick all three goals');
});

await scenario('net-dns', '/learn/network/dns-deep/', async (page) => {
  const r = '[data-dns-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-lookup]`);
  await expectText(page, `${r} [data-trace]`, /Asked 3 servers: a root server/);
  await page.click(`${r} [data-wait="60"]`);
  await page.click(`${r} [data-lookup]`);
  await expectText(page, `${r} [data-trace] li:first-child`, /From cache, nobody asked/);
  await page.click(`${r} [data-move]`);
  await page.click(`${r} [data-lookup]`);
  await expectText(page, `${r} [data-trace] li:first-child`, /the OLD address/);
  // Switching off right after the move strands an hour of caches.
  await page.click(`${r} [data-off]`);
  await expectText(page, `${r} [data-trace] li:first-child`, /cached answers still pointing at it/);
  if (await goalDone(page, r, 'safe')) throw new Error('an early switch-off passed');
  await page.click(`${r} [data-reset]`);
  await page.click(`${r} [data-ttl]`);
  await page.click(`${r} [data-wait="3600"]`);
  await page.click(`${r} [data-move]`);
  await expectText(page, `${r} [data-old]`, /still needed: caches may send people here for 1 min/);
  await page.click(`${r} [data-wait="60"]`);
  await page.click(`${r} [data-off]`);
  await expectText(page, `${r} [data-trace] li:first-child`, /Nobody noticed/);
  if (await page.locator(`${r} [data-goal].done`).count() !== 3) throw new Error('dns mission did not tick all three goals');
});

await scenario('net-lb', '/learn/network/load-balancers/', async (page) => {
  const r = '[data-lb-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-send]`);
  await expectText(page, `${r} [data-summary]`, /^10 of 30 requests failed \(33%\)/);
  await page.selectOption(`${r} [data-algo]`, 'least-conn');
  await page.click(`${r} [data-send]`);
  const worse = await expectText(page, `${r} [data-summary]`, /web-2 was sent \d+%/);
  if (Number(worse.match(/web-2 was sent (\d+)%/)[1]) <= 50) throw new Error(`least connections should favour the crashed backend: ${worse}`);
  if (await goalDone(page, r, 'healed')) throw new Error('least connections alone passed the heal goal');
  await page.check(`${r} [data-health]`);
  await page.click(`${r} [data-send]`);
  await page.click(`${r} [data-send]`);
  await expectText(page, `${r} [data-summary]`, /^0 of 30 requests failed/);
  await expectText(page, `${r} [data-backends]`, /pulled from the pool/);
  await page.click(`${r} [data-scenario="routes"]`);
  await page.click(`${r} [data-send]`);
  await expectText(page, `${r} [data-summary]`, /^[1-9]\d* of 30 requests failed/);
  await page.check(`${r} [data-rule]`);
  await expectText(page, `${r} [data-note]`, /This rule does nothing here/);
  await page.selectOption(`${r} [data-layer]`, 'L7');
  await page.click(`${r} [data-send]`);
  await expectText(page, `${r} [data-summary]`, /^0 of 30 requests failed/);
  if (await page.locator(`${r} [data-goal].done`).count() !== 4) throw new Error('lb mission did not tick all four goals');
  await expectText(page, 'header [data-xp]', /^[1-9]/);
});

// ---- release automation (writer RP)
// The release PR reads only the message. The tempting "fix:" on the API rename
// must ship a patch that breaks ^ users and leave the last step open; "!" fixes it.

await scenario('release-please', '/learn/delivery/release-automation/', async (page) => {
  const r = '[data-relauto]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const commit = async (change, message) => {
    await page.selectOption(`${r} [data-change]`, change);
    if (message !== undefined) await page.fill(`${r} [data-msg]`, message);
    await page.click(`${r} [data-commit]`);
  };
  const merge = () => page.click(`${r} [data-merge]`);
  await commit('typo');
  await expectText(page, `${r} [data-pr]`, /chore\(main\): release 1\.4\.3/);
  await merge();
  await expectText(page, `${r} [data-releases]`, /v1\.4\.3 patch/);
  await commit('readme', 'Fixed stuff');
  await expectText(page, `${r} [data-since]`, /ignored[\s\S]*release-please will not count it/);
  await expectText(page, `${r} [data-pr]`, /No release PR/);
  await commit('csv');
  await expectText(page, `${r} [data-pr]`, /release 1\.5\.0[\s\S]*Features/);
  await merge();
  // The tempting message: a patch that every ^1.5.0 user installs automatically.
  await commit('rename');
  await expectText(page, `${r} [data-pr]`, /release 1\.5\.1/);
  await merge();
  await expectText(page, `${r} [data-releases]`, /v1\.5\.1 patch[\s\S]*broke their code/);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 3) throw new Error('shipping the breaking rename as a patch must not complete the mission');
  await commit('rename', 'feat(api)!: rename the user field to account');
  await expectText(page, `${r} [data-pr]`, /release 2\.0\.0[\s\S]*BREAKING CHANGES/);
  await merge();
  await expectText(page, `${r} .m-debrief`, /commit message is the release note/);
  await expectText(page, 'header [data-xp]', /^[1-9]/);
});

// ---- resilience (writer R) ----------------------------------------------
// Each mission is played as a learner would, and the tempting move is tried
// first: buying everything, adding more connected copies, active/active for
// payments, a workaround that needs the broken system, blaming a person.

await scenario('res-rpo', '/learn/resilience/rpo-rto/', async (page) => {
  const r = '[data-rpo]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const run = async (system, backup, recovery) => {
    await page.selectOption(`${r} [data-system]`, system);
    await page.selectOption(`${r} [data-backup]`, backup);
    await page.selectOption(`${r} [data-recovery]`, recovery);
    await page.click(`${r} [data-go]`);
  };
  await run('orders', 'nightly', 'restore');
  await expectText(page, `${r} [data-verdict]`, /12 h 50 min of orders lost[\s\S]*Missed RPO 1 h/);
  await run('orders', 'quarter', 'standby');
  await expectText(page, `${r} [data-verdict]`, /can cost as little as \$250/);
  if (await doneSteps(page, r) !== 2) throw new Error('buying every option should meet the targets but not "least money"');
  await run('orders', 'hourly', 'restore');
  await expectText(page, `${r} [data-verdict]`, /The least that meets both targets/);
  await run('payroll', 'quarter', 'standby');
  if (await doneSteps(page, r) !== 3) throw new Error('orders-grade protection for payroll passed "least money"');
  await run('payroll', 'nightly', 'rebuild');
  await expectText(page, `${r} .m-debrief`, /Over-protecting payroll/);
});

await scenario('res-backups', '/learn/resilience/backups-that-restore/', async (page) => {
  const r = '[data-backups]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const tick = (c) => page.check(`${r} [data-copy="${c}"]`);
  const hit = (e) => page.click(`${r} [data-event="${e}"]`);
  await tick('usb'); await hit('disk');
  await expectText(page, `${r} [data-log] li:first-child`, /recovered/);
  await tick('sync'); await tick('cloud');
  await expectText(page, `${r} [data-321]`, /met on paper/);
  await hit('ransomware');
  await expectText(page, `${r} [data-log] li:first-child`, /data lost/);
  if (await doneSteps(page, r) !== 1) throw new Error('more connected copies survived ransomware');
  await tick('offline'); await hit('ransomware');
  await expectText(page, `${r} [data-log] li:first-child`, /Restored from: Offline drive/);
  await hit('late-delete');
  await expectText(page, `${r} [data-log] li:first-child`, /data lost/);
  if (!(await page.locator(`${r} [data-fix]`).isHidden())) throw new Error('fix offered before any drill found the problem');
  await page.click(`${r} [data-drill]`);
  await expectText(page, `${r} [data-log]`, /14 March/);
  await page.click(`${r} [data-fix]`);
  await hit('late-delete');
  await expectText(page, `${r} [data-log] li:first-child`, /Restored from: Cloud backup/);
  await expectText(page, `${r} .m-debrief`, /since March/);
});

await scenario('res-dr', '/learn/resilience/dr-strategies/', async (page) => {
  const r = '[data-dr]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const run = async (scenario, pattern, pitr, event) => {
    await page.selectOption(`${r} [data-scenario]`, scenario);
    await page.selectOption(`${r} [data-pattern]`, pattern);
    await page.setChecked(`${r} [data-pitr]`, pitr);
    await page.click(`${r} [data-event="${event}"]`);
  };
  await run('wiki', 'backup', false, 'region');
  await run('shop', 'pilot', false, 'region');
  await run('payments', 'active', false, 'region');
  await expectText(page, `${r} [data-log] li:first-child`, /targets met[\s\S]*A cheaper pattern would also have met/);
  if (await doneSteps(page, r) !== 2) throw new Error('active/active passed "without overpaying"');
  await run('payments', 'warm', false, 'region');
  await run('shop', 'warm', false, 'corruption');
  await expectText(page, `${r} [data-log] li:first-child`, /targets missed[\s\S]*Both copies are corrupt/);
  await run('shop', 'pilot', true, 'corruption');
  await expectText(page, `${r} .m-debrief`, /faithfully copied the corruption/);
});

await scenario('res-bia', '/learn/resilience/business-continuity/', async (page) => {
  const r = '[data-bia]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const ids = ['orders', 'shipping', 'payroll', 'suppliers', 'support', 'newsletter'];
  for (const p of ids) await page.selectOption(`${r} [data-mtd="${p}"]`, 'longer');
  if (await doneSteps(page, r) !== 0) throw new Error('"longer" for everything passed the impact step');
  if (await page.locator(`${r} select.wrong`).count() !== 5) throw new Error('wrong estimates are not marked');
  const right = { orders: '4h', shipping: '1d', payroll: '1d', suppliers: '3d', support: '3d', newsletter: 'longer' };
  for (const p of ids) await page.selectOption(`${r} [data-mtd="${p}"]`, right[p]);
  await expectText(page, `${r} [data-order]`, /^Recovery order, least tolerance first: Take orders/);
  await page.selectOption(`${r} [data-work="orders"]`, 'email-in');
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-log]`, /order system is the thing that is down/);
  if (await doneSteps(page, r) !== 2) throw new Error('a workaround that needs the broken system passed');
  await page.selectOption(`${r} [data-work="orders"]`, 'phone');
  await page.selectOption(`${r} [data-work="shipping"]`, 'paper');
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-log]`, /the plan holds for two days/);
  await expectText(page, `${r} .m-debrief`, /paper forms and a phone/);
});

await scenario('res-incident', '/learn/resilience/incidents/', async (page) => {
  const r = '[data-incident]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.check(`${r} [data-sev][value="3"]`);
  await expectText(page, `${r} [data-fb="sev"]`, /Too low/);
  await page.check(`${r} [data-sev][value="2"]`);
  const staff = async (ic, resolver, comms, scribe) => {
    for (const [role, who] of Object.entries({ ic, resolver, comms, scribe })) await page.selectOption(`${r} [data-role="${role}"]`, String(who));
  };
  await staff(0, 3, 1, 2);
  await expectText(page, `${r} [data-fb="staff"]`, /takes your best fixer off the fix/);
  await staff(2, 0, 1, 3);
  await page.check(`${r} [data-upd][value="2"]`);
  await expectText(page, `${r} [data-fb="upd"]`, /Blames a person/);
  if (await doneSteps(page, r) !== 2) throw new Error('a blaming status update passed');
  await page.check(`${r} [data-upd][value="1"]`);
  for (const i of [0, 1, 2, 3]) await page.check(`${r} [data-factor][value="${i}"]`);
  await page.click(`${r} [data-pm]`);
  await expectText(page, `${r} [data-fb="pm"]`, /blame, not analysis/);
  await page.uncheck(`${r} [data-factor][value="1"]`);
  await page.click(`${r} [data-pm]`);
  await expectText(page, `${r} .m-debrief`, /instead of one person to blame/);
  await expectText(page, 'header [data-xp]', /^[1-9]/);
});

// ---- sre (writer S)
// Each mission is played the way a learner would, wrong answer first: the
// threshold alert and the 3-day average must fail, blaming the service with
// the worst p99 must be refused, and peak capacity all day must not pass.

await scenario('sre-slo', '/learn/sre/slos/', async (page) => {
  const r = '[data-slo-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const runWith = async (scenarioKey, policy) => {
    await page.selectOption(`${r} [data-scenario]`, scenarioKey);
    await page.selectOption(`${r} [data-policy]`, policy);
    await page.click(`${r} [data-run]`);
  };
  await runWith('blip', 'threshold');
  await expectText(page, `${r} [data-verdict]`, /^Wrong call: it paged someone for a blip/);
  await runWith('fast', 'average');
  await expectText(page, `${r} [data-verdict]`, /^Wrong call: it never paged/);
  // Script-drawn chart lines must be styled (scoped CSS never reaches them).
  const stroke = await page.locator(`${r} .sl-line`).evaluate((e) => getComputedStyle(e).stroke);
  if (!stroke || stroke === 'none') throw new Error('budget line is unstyled - widget styles are not applying');
  for (const sc of ['blip', 'fast', 'slow']) await runWith(sc, 'burn');
  await expectText(page, `${r} [data-cell="burn:fast"]`, /^✓ paged \d+ minutes in/);
  await expectText(page, `${r} [data-cell="burn:slow"]`, /^✓ opened a ticket/);
  await expectText(page, `${r} .m-debrief`, /burn rate asks a different question/i);
});

await scenario('sre-trace', '/learn/sre/three-signals/', async (page) => {
  const r = '[data-trace-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  if (await page.locator(`${r} [data-dash] tr.over`).count() !== 0) throw new Error('averages should all be under target');
  await page.click(`${r} [data-stat="p99"]`);
  const over = await page.locator(`${r} [data-dash] tr.over`).count();
  if (over !== 4) throw new Error(`p99 should flag 4 services, flagged ${over}`);
  await page.locator(`${r} [data-list] .btn.slow`).first().click();
  await expectText(page, `${r} [data-fall]`, /tax/);
  await page.selectOption(`${r} [data-blame]`, 'checkout');
  await page.click(`${r} [data-blame-go]`);
  await expectText(page, `${r} [data-verdict]`, /checkout is slow only while it waits/);
  await page.selectOption(`${r} [data-blame]`, 'tax');
  await page.click(`${r} [data-blame-go]`);
  await expectText(page, `${r} [data-verdict]`, /^Yes - tax spent \d+ ms on its own/);
  await page.click(`${r} [data-logs]`);
  await expectText(page, `${r} [data-loglines]`, /timed out after 1000ms/);
  await expectText(page, `${r} .m-debrief`, /traces tell you where/);
});

await scenario('sre-scale', '/learn/sre/autoscaling/', async (page) => {
  const r = '[data-scale-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-verdict]`, /% of requests failed while new pods were still starting/);
  await page.selectOption(`${r} [data-min]`, '10');
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-verdict]`, /^Nothing dropped - but you paid for/);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 1) throw new Error('peak capacity all day must not pass the second step');
  await page.selectOption(`${r} [data-min]`, '2');
  await page.selectOption(`${r} [data-startup]`, '15');
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-verdict]`, /^Under 1% dropped on/);
  await page.selectOption(`${r} [data-workload]`, 'queue');
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-verdict]`, /Their CPU never moved/);
  await page.selectOption(`${r} [data-metric]`, 'queue');
  // The target list must follow the metric: CPU percentages make no sense for a queue.
  // A <select>'s innerText is its options' text in Chromium and WebKit but ""
  // in Firefox, so this check failed there while the widget was fine. Read the
  // options' textContent instead, which every engine agrees on.
  await page.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((o) => /messages waiting per pod/.test(o.textContent)), `${r} [data-target] option`, { timeout: 8000 });
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-verdict]`, /and drained\.$/);
  await expectText(page, `${r} .m-debrief`, /scale on what the work actually is/);
});


// ---- agents (writer AG)
// Each widget: play its mission the way a learner would, and check the
// tempting shortcuts stay open - the prompt rule alone, going back to v1,
// letting the agent do everything on its own.

await scenario('agents-loop', '/learn/agents/what-is-an-agent/', async (page) => {
  const r = '[data-agent-loop]';
  await page.locator(r).scrollIntoViewIfNeeded();
  for (let i = 0; i < 3; i++) await page.click(`${r} [data-step]`);
  await expectText(page, `${r} [data-trace]`, /18 days overdue/);
  // Every call re-reads everything so far: the context bars must grow.
  const ctx = (await page.locator(`${r} [data-bars] li > span:last-child`).allInnerTexts()).map((t) => Number(t.replace(/\D/g, '')));
  if (ctx.length !== 3 || !(ctx[0] < ctx[1] && ctx[1] < ctx[2])) throw new Error(`context did not grow call by call: ${ctx}`);
  await page.selectOption(`${r} [data-limit]`, '2');
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-trace]`, /the step limit, not the model/);
  await page.selectOption(`${r} [data-limit]`, '8');
  await page.uncheck(`${r} [data-tool="days_between"]`);
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-trace]`, /better than guessing/);
  await expectText(page, `${r} .m-debrief`, /the step limit was the loop/);
});

await scenario('agents-tools', '/learn/agents/tools/', async (page) => {
  const r = '[data-tool-bench]';
  await page.locator(r).scrollIntoViewIfNeeded();
  // A vague description sends the lookup to the refund tool.
  await page.selectOption(`${r} [data-desc]`, 'vague');
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-refunded]`, /^1$/);
  await page.selectOption(`${r} [data-desc]`, 'precise');
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-trace]`, /track\.example/);
  await page.selectOption(`${r} [data-email]`, 'disguised');
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-refunded]`, /^37$/);
  // Asking nicely does not hold against the disguised email.
  await page.check(`${r} [data-rule]`);
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-refunded]`, /^37$/);
  if (await page.locator(`${r} .m-debrief`).isVisible()) throw new Error('the prompt rule alone completed the mission');
  await page.check(`${r} [data-gate]`);
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-approval-text]`, /refunds 37 orders/);
  await page.click(`${r} [data-deny]`);
  await expectText(page, `${r} [data-approval-text]`, /send_reply/);
  await page.click(`${r} [data-approve]`);
  await expectText(page, `${r} [data-refunded]`, /^0$/);
  await expectText(page, `${r} .m-debrief`, /a person who saw/);
});

await scenario('agents-flows', '/learn/agents/workflows-vs-agents/', async (page) => {
  const r = '[data-workflow-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-design="workflow"]`);
  await expectText(page, `${r} [data-rows]`, /17 \/ 20/);
  await page.click(`${r} [data-design="agent"]`);
  await page.click(`${r} [data-design="hybrid"]`);
  await expectText(page, `${r} [data-rows]`, /Workflow \+ agent\s+20 \/ 20/);
  await expectText(page, `${r} .m-debrief`, /workflow prices/);
});

await scenario('agents-evals', '/learn/agents/guardrails-and-evals/', async (page) => {
  const r = '[data-eval-bench]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-which="all"]`);
  await expectText(page, `${r} [data-score]`, /prompt v1: 6 of 8/);
  await page.selectOption(`${r} [data-prompt]`, 'v2');
  await page.click(`${r} [data-which="demo"]`);
  await expectText(page, `${r} [data-score]`, /Demo on prompt v2: 1 of 1/);
  await page.click(`${r} [data-which="all"]`);
  await expectText(page, `${r} [data-score]`, /prompt v2: 6 of 8/);
  // Going back to v1, even with the guardrail, is not a way out.
  await page.selectOption(`${r} [data-prompt]`, 'v1');
  await page.check(`${r} [data-guard]`);
  await page.click(`${r} [data-which="all"]`);
  await expectText(page, `${r} [data-score]`, /v1 \+ guardrail: 6 of 8/);
  if (await page.locator(`${r} .m-debrief`).isVisible()) throw new Error('v1 + guardrail completed the mission');
  await page.selectOption(`${r} [data-prompt]`, 'v2');
  await page.click(`${r} [data-which="all"]`);
  await expectText(page, `${r} [data-score]`, /v2 \+ guardrail: 8 of 8/);
  await expectText(page, `${r} .m-debrief`, /case by case/);
});

await scenario('agents-business', '/learn/agents/business-agents/', async (page) => {
  const r = '[data-agent-designer]';
  await page.locator(r).scrollIntoViewIfNeeded();
  // Every action starts on "Alone": the tempting design.
  await page.click(`${r} [data-check]`);
  await expectText(page, `${r} [data-verdict]`, /Fail: risk/);
  for (const [id, v] of [['send', 'approve'], ['fee', 'approve'], ['pause', 'never']]) await page.selectOption(`${r} [data-action="${id}"]`, v);
  await page.click(`${r} [data-check]`);
  await expectText(page, `${r} [data-verdict]`, /Pass: risk[\s\S]*Pass: useful/);
  await expectText(page, `${r} [data-verdict]`, /\$8\.00/);
  await page.selectOption(`${r} [data-model]`, 'haiku');
  await page.click(`${r} [data-check]`);
  await expectText(page, `${r} .m-debrief`, /minutes of review/);
});

// ---- launch (writer M)
// Each widget plays its mission the way a learner would, trying the tempting
// answer first and checking it does not pass: counting the polite yeses,
// cutting payment to hit a date, the launch with the most sign-ups.

await scenario('launch-interview', '/learn/launch/validate/', async (page) => {
  const r = '[data-interview]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-summary]`, /^5 of 5 said yes/);
  // Counting the compliments is the trap.
  await page.selectOption(`${r} [data-answer]`, '5');
  await page.click(`${r} [data-decide]`);
  await expectText(page, `${r} [data-verdict]`, /Decide from evidence/);
  for (const id of ['would-use', 'good-idea', 'would-pay', 'wouldnt-it']) await page.uncheck(`${r} .il-qs input[value="${id}"]`);
  for (const id of ['last-time', 'today', 'spent']) await page.check(`${r} .il-qs input[value="${id}"]`);
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-summary]`, /No compliments to count.*2 of 5 show the problem/);
  await page.selectOption(`${r} [data-answer]`, '5');
  await page.click(`${r} [data-decide]`);
  await expectText(page, `${r} [data-verdict]`, /counts people who liked the idea/);
  if (await doneSteps(page, r) !== 3) throw new Error('answering 5 after a clean run ticked the decision step');
  await page.selectOption(`${r} [data-answer]`, '2');
  await page.click(`${r} [data-decide]`);
  await expectText(page, `${r} .m-debrief`, /kindness is not demand/);
});

await scenario('launch-scope', '/learn/launch/mvp/', async (page) => {
  const r = '[data-scope]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-check]`);
  await expectText(page, `${r} [data-total]`, /^48 working days/);
  // Fast, but cannot answer "will they pay": the trap.
  await page.click(`${r} [data-clear]`);
  for (const id of ['checker', 'email']) await page.check(`${r} .sc-list input[value="${id}"]`);
  await page.click(`${r} [data-check]`);
  await expectText(page, `${r} [data-total]`, /cannot tell you whether owners will pay/);
  if (await doneSteps(page, r) !== 1) throw new Error('a plan with no way to take money ticked the two-week step');
  await page.click(`${r} [data-clear]`);
  for (const id of ['manual', 'text', 'paylink']) await page.check(`${r} .sc-list input[value="${id}"]`);
  await page.click(`${r} [data-check]`);
  await expectText(page, `${r} [data-total]`, /^1 working day \(about one day\).*tests the riskiest assumption/);
  await expectText(page, `${r} .m-debrief`, /saved ten weeks/);
});

await scenario('launch-pricing', '/learn/launch/pricing/', async (page) => {
  const r = '[data-price-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  // Nothing is recorded until the learner changes something.
  if (await doneSteps(page, r) !== 0) throw new Error('a pricing step ticked on load');
  await page.click(`${r} [data-cheap]`);
  await expectText(page, `${r} [data-verdict]`, /^Never pays back/);
  await expectText(page, `${r} [data-maths]`, /\$60 \/ \$1\.50 = 40\.0 months/);
  const setPrice = async (v) => { await page.fill(`${r} [data-price]`, String(v)); await page.locator(`${r} [data-price]`).dispatchEvent('change'); };
  // Any price that pays back is not the lowest one.
  await setPrice(20);
  if (await doneSteps(page, r) !== 1) throw new Error('$20 ticked the lowest-price step');
  await setPrice(7);
  await expectText(page, `${r} [data-verdict]`, /Pays back in 10\.9 months/);
  await page.selectOption(`${r} [data-billing]`, 'annual');
  await setPrice(6);
  await expectText(page, `${r} [data-verdict]`, /covers acquisition on day one/);
  await expectText(page, `${r} .m-debrief`, /measure your own/);
});

await scenario('launch-traction', '/learn/launch/first-users/', async (page) => {
  const r = '[data-traction]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.selectOption(`${r} [data-channel]`, 'big-launch');
  await page.click(`${r} [data-launch]`);
  await expectText(page, `${r} [data-rows]`, /Big launch\s*400\s*40\s*8/);
  await page.selectOption(`${r} [data-channel]`, 'forum');
  await page.click(`${r} [data-launch]`);
  await page.check(`${r} [data-byhand]`);
  await page.click(`${r} [data-launch]`);
  await expectText(page, `${r} [data-rows]`, /Their forum \+ by hand\s*45\s*36\s*22\s*22\.5/);
  // The most sign-ups is the trap.
  await page.selectOption(`${r} [data-choose]`, 'big-launch');
  await page.click(`${r} [data-pick]`);
  await expectText(page, `${r} [data-verdict]`, /More sign-ups, fewer people/);
  if (await doneSteps(page, r) !== 3) throw new Error('choosing the big launch ticked the last step');
  await page.selectOption(`${r} [data-choose]`, 'forum');
  await page.click(`${r} [data-pick]`);
  await expectText(page, `${r} .m-debrief`, /do not scale while you still can/);
});

// ---- databases (writer DB) -------------------------------------------------
// The SQL consoles run real SQLite (WebAssembly, served from this origin) in a
// worker. Each scenario tries the tempting wrong query first and checks the
// mission does not tick, then plays it right.

const dbReady = (page, r, timeout = 30000) => page.waitForFunction((sel) => document.querySelector(sel)?.dataset.ready === '1', r, { timeout });

await scenario('db-zoo', '/learn/databases/sql-basics/', async (page) => {
  const r = '[data-db-console]';
  await page.locator(`${r} .term-in input`).scrollIntoViewIfNeeded();
  await dbReady(page, r);
  await type(page, r, 'SELECT * FROM pandas;');
  await expectText(page, `${r} .term-out`, /8 rows in/);
  await expectText(page, `${r} [data-result] caption`, /^8 rows$/);
  // COUNT(*) after a LEFT JOIN gives Ravi a panda he does not have.
  await type(page, r, 'SELECT k.name, COUNT(*) FROM keepers k LEFT JOIN pandas p ON p.keeper_id = k.id GROUP BY k.id;');
  await expectText(page, `${r} [data-result]`, /Ravi\s*1/);
  await type(page, r, 'SELECT p.name, k.name FROM pandas p JOIN keepers k ON k.id = p.keeper_id;');
  await expectText(page, `${r} .term-out`, /7 rows in/);
  if (await doneSteps(page, r) !== 1) throw new Error(`tempting queries ticked ${await doneSteps(page, r)} steps, expected only step 1`);
  for (const sql of [
    'SELECT name, age FROM pandas WHERE age > 10 ORDER BY age DESC;',
    'SELECT p.name, k.name FROM pandas p LEFT JOIN keepers k ON k.id = p.keeper_id;',
    "SELECT p.name, SUM(f.kg) FROM pandas p JOIN feedings f ON f.panda_id = p.id WHERE f.food = 'bamboo' GROUP BY p.name;",
    'SELECT k.name, COUNT(p.id) FROM keepers k LEFT JOIN pandas p ON p.keeper_id = k.id GROUP BY k.name;',
  ]) await type(page, r, sql);
  await expectText(page, `${r} .m-debrief`, /COUNT\(p\.id\) skips the NULL/);
  // Script-created result cells must be styled (scoped CSS never reaches them).
  await type(page, r, 'SELECT p.name, k.name FROM pandas p LEFT JOIN keepers k ON k.id = p.keeper_id;');
  await expectText(page, `${r} [data-result] td.null`, /NULL/);
  const style = await page.locator(`${r} [data-result] td.null`).first().evaluate((e) => getComputedStyle(e).fontStyle);
  if (style !== 'italic') throw new Error('NULL cells are unstyled - widget styles are not applying');
});

await scenario('db-runaway', '/learn/databases/sql-basics/', async (page) => {
  // A query that never ends must be stopped and reported, not freeze the tab
  // or come back looking like an empty result.
  const r = '[data-db-console]';
  await page.locator(`${r} .term-in input`).scrollIntoViewIfNeeded();
  await dbReady(page, r);
  await type(page, r, 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n;');
  await expectText(page, `${r} .term-out`, /Stopped after 4 s/, 15000);
  await type(page, r, 'SELECT count(*) FROM pandas;');
  await expectText(page, `${r} .term-out`, /1 row in/, 15000);
  await expectText(page, `${r} [data-result]`, /8/);
});

await scenario('db-index', '/learn/databases/indexes/', async (page) => {
  const r = '[data-db-console]';
  await page.locator(`${r} .term-in input`).scrollIntoViewIfNeeded();
  await dbReady(page, r, 45000);
  await type(page, r, 'SELECT * FROM orders WHERE customer_id = 4242;');
  await expectText(page, `${r} [data-plan]`, /SCAN orders[\s\S]*Read every row of orders: 200,000 rows, to return 10/, 15000);
  await type(page, r, 'CREATE INDEX idx_orders_customer ON orders(customer_id);');
  await expectText(page, `${r} [data-schema]`, /CREATE INDEX idx_orders_customer/, 15000);
  await type(page, r, 'SELECT * FROM orders WHERE customer_id = 4242;');
  await expectText(page, `${r} [data-plan]`, /SEARCH orders USING INDEX idx_orders_customer \(customer_id=\?\)/, 15000);
  // The tempting fix: an index on email does not help lower(email).
  await type(page, r, 'CREATE INDEX idx_email ON customers(email);');
  await expectText(page, `${r} [data-schema]`, /idx_email ON/, 15000);
  await type(page, r, "SELECT * FROM customers WHERE lower(email) = lower('Panda4242@Example.com');");
  await expectText(page, `${r} [data-plan]`, /Read every row of customers/, 15000);
  if (await doneSteps(page, r) !== 2) throw new Error(`an index on email ticked the lower(email) step (${await doneSteps(page, r)} done)`);
  await type(page, r, 'CREATE INDEX idx_email_lower ON customers(lower(email));');
  await expectText(page, `${r} [data-schema]`, /lower\(email\)/, 15000);
  await type(page, r, "SELECT * FROM customers WHERE lower(email) = lower('Panda4242@Example.com');");
  await expectText(page, `${r} [data-plan]`, /SEARCH customers USING INDEX idx_email_lower/, 15000);
  await expectText(page, `${r} .m-debrief`, /Index the expression/);
});

await scenario('db-lost-update', '/learn/databases/transactions/', async (page) => {
  const r = '[data-txn-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const sale = async (strategy, retry = false) => {
    await page.selectOption(`${r} [data-strategy]`, strategy);
    if (retry) await page.check(`${r} [data-retry]`); else if (strategy === 'repeatable') await page.uncheck(`${r} [data-retry]`);
    await page.click(`${r} [data-run]`);
    await page.waitForFunction((sel) => !document.querySelector(`${sel} [data-run]`).disabled, r, { timeout: 15000 });
    return page.locator(`${r} [data-result]`).innerText();
  };
  if (!/^Stock 9 .*1 sale lost/.test(await sale('none'))) throw new Error('read-then-write did not lose a sale');
  const txn = await sale('txn');
  if (!/^Stock 9/.test(txn)) throw new Error(`BEGIN ... COMMIT should still lose a sale: ${txn}`);
  if (!(await page.locator(`${r} [data-events] li.wait`).count())) throw new Error('clerk B never waited for the row lock');
  const rr = await sale('repeatable');
  if (!/1 refused/.test(rr)) throw new Error(`REPEATABLE READ should refuse one sale: ${rr}`);
  await expectText(page, `${r} [data-events] li.err`, /could not serialize access due to concurrent update/);
  if (await doneSteps(page, r) !== 2) throw new Error(`a transaction alone or a refused sale ticked step 3 (${await doneSteps(page, r)} done)`);
  if (!/^Stock 8/.test(await sale('atomic'))) throw new Error('stock = stock - 1 did not end at 8');
  if (!/^Stock 8/.test(await sale('repeatable', true))) throw new Error('retrying the refused sale did not end at 8');
  await expectText(page, `${r} .m-debrief`, /real PostgreSQL 17\.6/);
});

await scenario('db-replica', '/learn/databases/replication/', async (page) => {
  const r = '[data-replica-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const read = async (route) => { await page.selectOption(`${r} [data-route]`, route); await page.click(`${r} [data-save]`); return page.locator(`${r} [data-read]`).innerText(); };
  const restore = async (method, target) => {
    await page.selectOption(`${r} [data-method]`, method);
    if (target) await page.selectOption(`${r} [data-target]`, target);
    await page.click(`${r} [data-recover]`);
    return page.locator(`${r} [data-recovered]`).innerText();
  };
  if (!/You see: Bao\b/.test(await read('replica'))) throw new Error('a lagging replica showed the new name');
  if (!/You see: Bao\b/.test(await read('two-replicas'))) throw new Error('a second replica should lag just the same');
  if (!/other users read\s*the primary/.test(await read('primary'))) throw new Error('all-reads-to-primary should leave the replicas idle');
  if (!/orders does not exist/.test(await restore('promote'))) throw new Error('the promoted replica still had the table');
  if (!/4,800 of 5,112/.test(await restore('nightly'))) throw new Error("last night's backup should miss today's orders");
  if (!/orders does not exist/.test(await restore('pitr', '14:05:30'))) throw new Error('replaying past the DROP should replay it');
  if (await doneSteps(page, r) !== 1) throw new Error(`tempting fixes ticked ${await doneSteps(page, r)} steps, expected 1`);
  if (!/You see: Bamboo Bao/.test(await read('sticky'))) throw new Error('reading your own writes from the primary did not show the new name');
  if (!/5,112 of 5,112/.test(await restore('pitr', '14:04:59'))) throw new Error('PITR to 14:04:59 did not bring every order back');
  await expectText(page, `${r} .m-debrief`, /copies your mistakes/);
});

// ---- git strategies (writer GS) --------------------------------------------
// Each mission tries the tempting move first: the two-week branch, daily merges
// without a flag, rebasing and squashing the branch Sam built on, a vague title.

await scenario('git-cadence', '/learn/git/branching-strategies/', async (page) => {
  const r = '[data-branchlab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const run = async (every, flag) => {
    await page.selectOption(`${r} [data-cadence]`, String(every));
    await page.setChecked(`${r} [data-flag]`, flag);
    await page.click(`${r} [data-run]`);
  };
  await run(10, true);
  await expectText(page, `${r} [data-largest]`, /^8 files$/);
  await expectText(page, `${r} [data-exposed]`, /^0$/);
  await run(1, false);
  await expectText(page, `${r} [data-largest]`, /^1 file$/);
  await expectText(page, `${r} [data-exposed]`, /^9$/);
  if (await doneSteps(page, r) !== 2) throw new Error('daily merges without a flag finished the mission');
  await run(3, true);
  if (await doneSteps(page, r) !== 2) throw new Error('three-day merges passed the one-file step');
  await run(1, true);
  await expectText(page, `${r} .m-debrief`, /switched off until it was done/);
});

await scenario('git-integrate', '/learn/git/merge-rebase-squash/', async (page) => {
  const r = '[data-historylab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const go = async (scenario, method, title) => {
    await page.selectOption(`${r} [data-scenario]`, scenario);
    await page.selectOption(`${r} [data-method]`, method);
    if (title) await page.selectOption(`${r} [data-title]`, title);
    await page.click(`${r} [data-go]`);
  };
  await go('solo', 'rebase');
  await expectText(page, `${r} [data-main]`, /F2'[\s\S]*F1'[\s\S]*C/);
  await go('shared', 'rebase');
  await expectText(page, `${r} [data-notes]`, /Sam sees twice/);
  await go('shared', 'squash');
  await expectText(page, `${r} [data-notes]`, /re-offers/);
  if (await doneSteps(page, r) !== 1) throw new Error('rebasing or squashing the shared branch passed');
  await go('shared', 'merge');
  if (await page.locator(`${r} [data-notes] li.bad`).count()) throw new Error('a merge commit still reported harm to Sam');
  await go('solo', 'squash', 'Update search');
  await expectText(page, `${r} [data-release]`, /nothing releasable/);
  if (await doneSteps(page, r) !== 2) throw new Error('a vague squash title passed the release-please step');
  await go('solo', 'squash', 'feat(search): filter results by price');
  await expectText(page, `${r} [data-release]`, /counts: feat/);
  await expectText(page, `${r} .m-debrief`, /title is the commit release-please reads/);
  // The graph is drawn with real nodes, not left empty.
  if (await page.locator(`${r} .hl-node`).count() < 5) throw new Error('commit graph did not draw');
});

// ---- expeditions ------------------------------------------------------------
// Progress is seeded straight into localStorage, the way a returning learner's
// browser holds it, so these also prove a store saved before expeditions
// existed is read and completed rather than ignored.
const seed = (lessons, extra = {}) => JSON.stringify({ v: 1, xp: 100, lessons: Object.fromEntries(lessons.map((id) => [id, '2026-10-01T10:00:00.000Z'])), quizzes: {}, missions: {}, real: {}, days: ['2026-10-01'], ...extra });
const stepsOf = async (page) => JSON.parse(await page.locator('[data-steps]').getAttribute('data-steps'));
const xpNow = async (page) => Number(JSON.parse(await page.evaluate(() => localStorage.getItem('curiouspandas.progress.v1'))).xp);

await scenario('expeditions-index', '/expeditions/', async (page) => {
  const ready = await page.locator('a.xcard').count(), planned = await page.locator('.xcard.soon').count();
  if (ready !== 5 || planned !== 4) throw new Error(`expected 5 open and 4 planned expeditions, saw ${ready} and ${planned}`);
  await expectText(page, 'a.xcard[data-xcard="teamwork"] .facts', /^11 lessons · about [\d.]+ h · Trail Crew badge/);
  // A planned card must not be a way onto an unfinished route.
  if (await page.locator('.xcard.soon a, a.xcard.soon').count()) throw new Error('a planned expedition card is a link');
  await expectText(page, '[data-xcard="first-steps"] [data-xcount]', /Not started/);
});

await scenario('expedition-walk', '/expeditions/first-steps/', async (page) => {
  const steps = await stepsOf(page);
  const last = steps[steps.length - 1];
  await page.evaluate((v) => localStorage.setItem('curiouspandas.progress.v1', v), seed(steps.slice(0, -1).map((s) => s.id)));
  await page.reload({ waitUntil: 'networkidle' });
  await expectText(page, '[data-xstate]', new RegExp(`not earned yet\. ${steps.length - 1} of ${steps.length}`));
  const cont = await page.locator('[data-continue]').getAttribute('href');
  if (cont !== last.href) throw new Error(`Continue points at ${cont}, not the one unfinished lesson ${last.href}`);
  await page.locator('[data-follow]').click();
  if (await page.locator('[data-follow]').getAttribute('aria-pressed') !== 'true') throw new Error('Follow did not stick');
  // Walk the route by its own "next" links: a dead end or a wrong turn is
  // what a learner following it would hit.
  await page.goto(base + steps[0].href, { waitUntil: 'networkidle' });
  for (let i = 0; i < steps.length - 1; i++) {
    const go = page.locator('[data-xnext] [data-xgo]');
    if (!(await page.locator('[data-xnext]').isVisible())) throw new Error(`no expedition box on step ${i + 1} (${steps[i].href})`);
    const href = await go.getAttribute('href');
    if (href !== steps[i + 1].href) throw new Error(`step ${i + 1} sends you to ${href}, expected ${steps[i + 1].href}`);
    await go.click();
    await page.waitForURL(base + steps[i + 1].href);
    await page.waitForLoadState('networkidle');
  }
  const before = await xpNow(page);
  await expectText(page, '[data-xnext] [data-xgo]', /Last step/);
  await page.locator('[data-finish] [data-done]').click();
  await expectText(page, '[data-xnext] [data-xgo]', /Trailhead badge earned/);
  const lessonXp = Number(await page.locator('[data-finish]').getAttribute('data-xp'));
  const gained = (await xpNow(page)) - before;
  if (gained !== lessonXp + 10 * steps.length) throw new Error(`finishing the last lesson gave ${gained} XP, expected ${lessonXp} + ${10 * steps.length} badge`);
  await page.goto(base + '/expeditions/first-steps/', { waitUntil: 'networkidle' });
  await expectText(page, '[data-xstate]', /Trailhead - earned/);
  if (!(await page.locator('[data-xbadge].got').count())) throw new Error('earned badge still drawn locked');
  await page.reload({ waitUntil: 'networkidle' });
  if ((await xpNow(page)) !== before + gained) throw new Error('reloading awarded the badge XP again');
  // A lesson that is not on the followed expedition stays quiet.
  await page.goto(base + '/learn/kubernetes/scheduling/', { waitUntil: 'networkidle' });
  if (await page.locator('[data-xnext]').isVisible()) throw new Error('expedition box shown on a lesson outside the followed expedition');
});

await scenario('expedition-retroactive', '/expeditions/founder/', async (page) => {
  // Someone who finished every Founder lesson before expeditions shipped gets
  // the badge on their next visit, without redoing anything.
  const steps = await stepsOf(page);
  await page.evaluate((v) => localStorage.setItem('curiouspandas.progress.v1', v), seed(steps.map((s) => s.id)));
  await page.goto(base + '/progress/', { waitUntil: 'networkidle' });
  await expectText(page, '[data-badges]', /Trailblazer\s*Earned/);
  if ((await xpNow(page)) !== 100 + 10 * steps.length) throw new Error(`XP after the retroactive badge is ${await xpNow(page)}`);
});

await scenario('merged-lesson-progress', '/learn/agents/what-is-an-agent/', async (page) => {
  // frontiers/agents was merged into this lesson on 2026-10-30. A learner who
  // had finished it must see this one ticked, keep their XP, and not be able
  // to earn the same lesson's XP twice.
  await page.evaluate((v) => localStorage.setItem('curiouspandas.progress.v1', v), seed(['frontiers/agents']));
  await page.reload({ waitUntil: 'networkidle' });
  await expectText(page, '[data-finish] [data-done]', /Lesson complete ✓/);
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('curiouspandas.progress.v1')));
  if (stored.lessons['frontiers/agents'] || !stored.lessons['agents/what-is-an-agent']) throw new Error(`record not moved: ${Object.keys(stored.lessons)}`);
  if (stored.xp !== 100) throw new Error(`XP changed on migration: ${stored.xp}`);
  await page.goto(base + '/learn/frontiers/agents/', { waitUntil: 'networkidle' });
  if (!page.url().endsWith('/learn/agents/what-is-an-agent/')) throw new Error(`old URL ended at ${page.url()}`);
});

// ---- changing running software
// Each trap must show as "not checked" or as a measured gap, never as a pass:
// zero differences from zero comparisons is the failure these widgets teach.

await scenario('shadow-bench', '/learn/change/prove-it-in-production/', async (page) => {
  const r = '[data-shadow]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const send = async () => { await page.click(`${r} [data-send]`); await page.waitForTimeout(100); };
  await page.check(`${r} [data-mirror]`);
  await expectText(page, `${r} [data-yaml]`, /request_mirror_policies:[\s\S]*cluster: shop-v2[\s\S]*numerator: 10/);
  await send();
  await expectText(page, `${r} [data-status]`, /No search was compared/);
  await expectText(page, `${r} [data-table]`, /compared 0 · matched 0 · differed 0[\s\S]*no comparator[\s\S]*not checked/);
  await page.check(`${r} [data-comparator]`);
  await page.selectOption(`${r} [data-target]`, 'header');
  await send();
  await expectText(page, `${r} [data-table]`, /2500 requests · 0 mirrored/);
  await page.selectOption(`${r} [data-target]`, 'cluster');
  await page.selectOption(`${r} [data-fraction]`, 'absent');
  await expectText(page, `${r} [data-yaml]`, /^(?![\s\S]*runtime_fraction)/);
  await send();
  await expectText(page, `${r} [data-table]`, /shadow timed out/);
  if (!(await page.locator(`${r} .stat.bad [data-load]`).count())) throw new Error('an overloaded shadow is not marked bad');
  await page.selectOption(`${r} [data-fraction]`, '10');
  await page.selectOption(`${r} [data-sample]`, 'beta');
  await send();
  await expectText(page, `${r} [data-table]`, /outside sample/);
  await page.selectOption(`${r} [data-sample]`, 'all');
  await send();
  await expectText(page, `${r} [data-status]`, /^5 of 250 compared searches differed/);
  await expectText(page, `${r} [data-example]`, /out of stock/);
  // The tempting option: mirroring writes compares them and charges customers again.
  await page.selectOption(`${r} [data-writes]`, 'mirror');
  await send();
  await expectText(page, `${r} [data-charges]`, /^[1-9]/);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 5) throw new Error('mirroring real writes ticked the last step');
  await page.selectOption(`${r} [data-writes]`, 'stub');
  await send();
  await expectText(page, `${r} [data-charges]`, /^0$/);
  await expectText(page, `${r} .m-debrief`, /compared with its side effects stubbed/);
});

await scenario('strangler-lab', '/learn/change/strangler-fig/', async (page) => {
  const r = '[data-strangler]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const run = async (n) => { await page.click(`${r} [data-run="${n}"]`); await page.waitForTimeout(80); };
  const mode = (id, m) => page.selectOption(`${r} [data-mode="${id}"]`, m);
  const rule = (id) => `${r} [data-rule="${id}"]`;
  await expectText(page, rule('product'), /not checked[\s\S]*compared 0\/500/);
  await mode('product', 'shadow'); await run(1);
  await expectText(page, rule('product'), /differences[\s\S]*compared 350\/500 · matched 0 · differed 350/);
  await page.selectOption(`${r} [data-normaliser]`, 'scrub'); await run(1);
  await expectText(page, `${r} [data-diffs]`, /sale price differs/);
  await page.click(`${r} [data-verdict="price:fix-new"]`);
  await mode('search', 'shadow'); await run(1);
  await expectText(page, `${r} [data-diffs]`, /legacy lists one product twice/);
  await page.click(`${r} [data-verdict="dupes:legacy-wrong"]`);
  // Configured is not served: the planted rule never matches.
  await mode('cart', 'new'); await run(1);
  await expectText(page, rule('cart'), /configured new, but served today: 0 new · 150 legacy/);
  await mode('cart', 'shadow');
  await page.fill(`${r} [data-match="cart"]`, '/cart');
  await page.locator(`${r} [data-match="cart"]`).dispatchEvent('change');
  await run(1);
  await expectText(page, `${r} [data-diffs]`, /new store doesn't have this cart/);
  await page.selectOption(`${r} [data-sync]`, 'cdc');
  await page.selectOption(`${r} [data-writes]`, 'stub');
  for (const id of ['add', 'checkout', 'orders']) await mode(id, 'shadow');
  await run(7); await run(1); await run(1); await run(1);
  await expectText(page, `${r} [data-diffs]`, /large orders cut off at 50 lines/);
  await page.click(`${r} [data-verdict="bigorder:fix-new"]`);
  for (const id of ['cart', 'add']) await mode(id, 'new');
  await run(1);
  await page.click(`${r} [data-reconcile]`);
  await expectText(page, `${r} [data-recon]`, /0 diverged/);
  for (const id of ['product', 'search', 'checkout', 'orders']) await mode(id, 'new');
  await run(1);
  await expectText(page, `${r} .m-steps`, /./);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 6) throw new Error(`expected 6 steps done before the export, got ${await page.locator(`${r} .m-steps li.done`).count()}`);
  // The caller nobody listed shows up only in legacy's log, after a month end.
  await run('month');
  await expectText(page, `${r} [data-log]`, /\/export[\s\S]*no façade rule/);
  await page.click(`${r} [data-add-rule="export"]`);
  await mode('export', 'shadow'); await run('month');
  await mode('export', 'new');
  await page.click(`${r} [data-legacy]`);
  await run('month');
  await expectText(page, `${r} [data-watch]`, /Watch window: 30 clean days/);
  await page.click(`${r} [data-archive]`);
  await page.click(`${r} [data-delete]`);
  await run(1);
  await expectText(page, `${r} .m-debrief`, /compared, not compared, served by/);
  // A finished migration must not read as broken: the history stays in the
  // counts, but no route's pill may still say "differences".
  if (await page.locator(`${r} .st-rule.differences`).count()) throw new Error('a finished migration still shows open differences');
  await expectText(page, `${r} [data-harm]`, /wrong answers served\s*0[\s\S]*charged twice\s*0[\s\S]*items lost\s*0[\s\S]*failed requests\s*0/);
});

// ---- agile
// The Little's Law panel must say "not measured" before anything has run, and
// the forecast question must not pass on "velocity".

await scenario('flow-lab', '/learn/agile/flow/', async (page) => {
  const r = '[data-flow]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const sprint = async (n = 1) => { for (let i = 0; i < n; i++) { await page.click(`${r} [data-run="10"]`); await page.waitForTimeout(60); } };
  await page.click(`${r} [data-little]`);
  await expectText(page, `${r} [data-little-out]`, /^Not measured/);
  await page.selectOption(`${r} [data-load]`, 'overload');
  await sprint(3);
  const wip = Number(await page.locator(`${r} [data-wip]`).innerText());
  if (wip < 15) throw new Error(`no WIP limit under overload should pile up work on the board, got WIP ${wip}`);
  await page.click(`${r} [data-little]`);
  const out = await expectText(page, `${r} [data-little-out]`, /^Holds exactly: area under the WIP line \d+ item-days = time items spent inside the window \d+ item-days/);
  const [, area, res] = out.match(/line (\d+) item-days = .* window (\d+) item-days/);
  if (area !== res) throw new Error(`"holds" shown for unequal totals ${area} vs ${res}`);
  await page.selectOption(`${r} [data-limit]`, '4');
  await sprint(4);
  await expectText(page, `${r} .m-steps li:nth-child(3)`, /./);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 3) throw new Error(`expected 3 flow steps done after the limit drained the board, got ${await page.locator(`${r} .m-steps li.done`).count()}`);
  await page.selectOption(`${r} [data-limit]`, '1');
  await sprint(2);
  await expectText(page, `${r} .m-debrief`, /an identity about what you measured/);
});

await scenario('flow-forecast', '/learn/agile/forecasts/', async (page) => {
  const r = '[data-flow]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const sprint = async (n = 1) => { for (let i = 0; i < n; i++) { await page.click(`${r} [data-run="10"]`); await page.waitForTimeout(60); } };
  await sprint(3);
  await page.check(`${r} [data-target]`);
  await sprint(3);
  await expectText(page, `${r} [data-sprints] tbody`, /6 \(target\)/);
  // The tempting answer: velocity went up, so delivery went up.
  await page.check(`${r} [name="fl-answer"][value="velocity"]`);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 2) throw new Error('answering "velocity" ticked the last step');
  await page.check(`${r} [name="fl-answer"][value="throughput"]`);
  await expectText(page, `${r} .m-debrief`, /no study has measured one/);
});

await scenario('flow-dod', '/learn/agile/xp/', async (page) => {
  const r = '[data-flow]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const sprint = async (n = 1) => { for (let i = 0; i < n; i++) { await page.click(`${r} [data-run="10"]`); await page.waitForTimeout(60); } };
  await sprint(2);
  const finished = Number(await page.locator(`${r} [data-tp]`).innerText()), stayed = Number(await page.locator(`${r} [data-stayed]`).innerText());
  if (!(finished > stayed)) throw new Error(`a weak Definition of Done should count more finished than stayed done, got ${finished} vs ${stayed}`);
  await page.selectOption(`${r} [data-dod]`, 'strong');
  await sprint(2);
  // The tempting answer: the bigger number.
  await page.check(`${r} [name="fl-answer"][value="finished"]`);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 2) throw new Error('answering "finished" ticked the last step');
  await page.check(`${r} [name="fl-answer"][value="stayed"]`);
  await expectText(page, `${r} .m-debrief`, /counted the same work twice/);
});

await scenario('in-name-only-cards', '/learn/agile/in-name-only/', async (page) => {
  const r = '[data-cards="in-name-only"]';
  await page.locator(r).scrollIntoViewIfNeeded();
  // Calling the healthy team broken must be refused, with a reason.
  await page.check(`${r} [data-card="healthy"] input[value="broken"]`);
  await expectText(page, `${r} [data-card="healthy"] [data-why]`, /^Not quite\./);
  for (const [card, answer] of [['standup', 'status'], ['hardening', 'notdone'], ['velocity', 'target'], ['healthy', 'fine']]) {
    await page.check(`${r} [data-card="${card}"] input[value="${answer}"]`);
    await expectText(page, `${r} [data-card="${card}"] [data-why]`, /^Supported\./);
  }
  await expectText(page, `${r} .m-debrief`, /always says "fine"/);
});

await scenario('scrum-events-cards', '/learn/agile/scrum-guide/', async (page) => {
  const r = '[data-cards="scrum-events"]';
  await page.locator(r).scrollIntoViewIfNeeded();
  // "We always do it" is never a purpose.
  await page.check(`${r} [data-card="retro"] input[value="habit"]`);
  await expectText(page, `${r} [data-card="retro"] [data-why]`, /^Not quite\./);
  for (const card of ['planning', 'daily', 'review', 'retro', 'sprint']) {
    await page.check(`${r} [data-card="${card}"] input[value="purpose"]`);
    await expectText(page, `${r} [data-card="${card}"] [data-why]`, /^Supported\. The guide/);
  }
  await expectText(page, `${r} .m-debrief`, /doing Scrum rather than performing it/);
});

await scenario('manifesto-verbatim', '/learn/agile/manifesto/', async (page) => {
  // The typography pass turns "--" into an en dash. The lesson says the
  // principle keeps its double hyphens, and once rendered "Simplicity–the".
  await expectText(page, 'main', /Simplicity--the art of maximizing the amount of work not done--is essential/);
  await expectText(page, 'blockquote', /That is, while there is value in the items on the right, we value the items on the left more\.[\s\S]*this declaration may be freely copied in any form, but only in its entirety through this notice/i);
});

// ---- changing running software, the rest of the trail

await scenario('lock-queue', '/learn/change/expand-contract-schemas/', async (page) => {
  const r = '[data-lockq]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const run = () => page.click(`${r} [data-run]`);
  await run();
  await expectText(page, `${r} [data-status]`, /^Migration applied after waiting 10\.0 s, holding the lock 0\.3 s\. \d+ app requests gave up/);
  await page.selectOption(`${r} [data-timeout]`, '2000');
  await run();
  await expectText(page, `${r} [data-status]`, /^Migration aborted after waiting 2\.0 s\. The site kept serving/);
  await expectText(page, `${r} [data-failed]`, /^0$/);
  await page.uncheck(`${r} [data-report]`);
  await run();
  await expectText(page, `${r} [data-status]`, /^Migration applied after waiting 0\.0 s.*No app request was held up/);
  // The tempting belief: lock_timeout protects every migration.
  await page.selectOption(`${r} [data-ddl]`, 'add-column-volatile-default');
  await run();
  await expectText(page, `${r} [data-status]`, /holding the lock 15\.0 s\. \d+ app requests gave up/);
  await page.selectOption(`${r} [data-ddl]`, 'add-column-constant-default');
  await page.selectOption(`${r} [data-version]`, '10');
  await run();
  await page.selectOption(`${r} [data-version]`, '11');
  await run();
  await expectText(page, `${r} .m-debrief`, /better to abort a deploy than take your application down/);
});

await scenario('decommission', '/learn/change/decommissioning/', async (page) => {
  const r = '[data-strangler][data-mission="decommission"]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const run = async (n) => { await page.click(`${r} [data-run="${n}"]`); await page.waitForTimeout(80); };
  // A planned brownout: switch off, let the month end find the caller, switch back on.
  await page.click(`${r} [data-legacy]`);
  await run('month');
  await expectText(page, `${r} [data-h="failedRequests"]`, /^1$/);
  await expectText(page, `${r} [data-watch]`, /Watch window: 0 clean days/);
  await page.click(`${r} [data-legacy]`);
  await page.click(`${r} [data-add-rule="export"]`);
  await page.selectOption(`${r} [data-mode="export"]`, 'shadow');
  await run('month');
  await page.selectOption(`${r} [data-mode="export"]`, 'new');
  await run('month');
  await page.click(`${r} [data-legacy]`);
  await run('month');
  await page.click(`${r} [data-archive]`);
  await page.click(`${r} [data-delete]`);
  await run('1');
  await expectText(page, `${r} .m-debrief`, /invisible for 29 days out of 30/);
});

for (const [deck, path, picks, wrong] of [
  ['one-way-doors', '/learn/change/rewrite-or-evolve/', { cutover: 'oneway', descoped: 'removed', shadow: 'reversible', drop: 'oneway' }, ['shadow', 'oneway']],
  ['golden-master', '/learn/change/characterization-tests/', { regenerated: 'assertsbug', scrubber: 'blind', pinned: 'good' }, ['pinned', 'wrong']],
  ['flag-debt', '/learn/change/branch-by-abstraction/', { reused: 'bomb', forever: 'inventory', expiring: 'healthy' }, ['expiring', 'risky']],
  ['api-changes', '/learn/change/evolving-apis/', { optional: 'expand', order: 'hyrum', heartbeat: 'twophase' }, ['order', 'safe']],
]) {
  await scenario(`deck-${deck}`, path, async (page) => {
    const r = `[data-cards="${deck}"]`;
    await page.locator(r).scrollIntoViewIfNeeded();
    await page.check(`${r} [data-card="${wrong[0]}"] input[value="${wrong[1]}"]`);
    await expectText(page, `${r} [data-card="${wrong[0]}"] [data-why]`, /^Not quite\./);
    for (const [card, answer] of Object.entries(picks)) {
      await page.check(`${r} [data-card="${card}"] input[value="${answer}"]`);
      await expectText(page, `${r} [data-card="${card}"] [data-why]`, /^Supported\./);
    }
    await expectText(page, `${r} .m-debrief`, /./);
    if (await page.locator(`${r} .m-steps li.done`).count() !== Object.keys(picks).length) throw new Error(`${deck}: not every step ticked`);
  });
}

await browser.close();
server?.kill();

writeFileSync(join(OUT, 'report.json'), JSON.stringify({ base, failures, report }, null, 2));
for (const r of report) {
  if (r.redirect) console.log(`↪ ${r.path.padEnd(36)} redirects to ${r.redirect}`);
  else if (r.path) console.log(`${r.errors.length || r.failed.length || r.overflow > 1 || !r.h1 ? '✗' : '✓'} ${r.path.padEnd(36)} h1=${JSON.stringify(r.h1)} text=${r.chars} errors=${r.errors.length} failed=${r.failed.length}`);
  else console.log(`✓ scenario ${r.scenario}`);
}
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nAll ${report.length} checks passed in ${ENGINE}. Screenshots in ${OUT}/ - look at them.`);
