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
  // Also text that spills out of a box that itself fits: an unbroken token in a
  // quiz question overflowed by 34px while every box measured inside 375px, and
  // this list came back empty.
  const wide = overflow > 1 ? await page.evaluate(() => [...document.querySelectorAll('main *')]
    .filter((e) => !e.closest('[style*="overflow"], pre, .graph, .term-out, table') && (e.getBoundingClientRect().right > window.innerWidth + 1
      || (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === 'visible' && e.getBoundingClientRect().left + e.scrollWidth > window.innerWidth + 1)))
    // Innermost only: every ancestor of the culprit overflows too, and filled the list.
    .filter((e, _, all) => !all.some((o) => o !== e && e.contains(o)))
    .slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} right=${Math.round(e.getBoundingClientRect().left + Math.max(e.scrollWidth, e.getBoundingClientRect().width))}`)) : [];
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
  // Videos (<Watch>): the poster must have loaded and the player must not be
  // there yet. The play button is deliberately not pressed: that is the one
  // request to Google the site makes, and only on the learner's say-so, so
  // the third-party check above would rightly fail the page.
  // The poster is lazy and the first one sits 5,200px down its page, so it has
  // not been asked for when the page loads. Asking "has it loaded" there
  // failed WebKit with "poster did not load" on a poster that loads fine, and
  // passed Chromium only by luck of what ran before. Bring it on screen as a
  // learner would, give it time, then put the page back for the checks below.
  const videos = await page.evaluate(async () => {
    const found = [];
    for (const w of document.querySelectorAll('[data-video]')) {
      const img = w.querySelector('img');
      if (img && !img.complete) {
        img.scrollIntoView();
        await new Promise((done) => {
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
          setTimeout(done, 10000);
        });
      }
      found.push({ id: w.getAttribute('data-video'), poster: Boolean(img?.complete && img.naturalWidth > 0),
        play: Boolean(w.querySelector('.w-play')), iframe: Boolean(w.querySelector('iframe')) });
    }
    scrollTo(0, 0);
    return found;
  });
  for (const v of videos) {
    if (!v.poster) fail(path, `video ${v.id}: poster did not load`);
    if (!v.play || v.iframe) fail(path, `video ${v.id}: player present before play was pressed`);
  }
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
    // A scenario that injects a fault expects the page to log it. Anything else still fails.
    const unexpected = errors.filter((e) => !opts?.expectErrors?.test(e));
    if (unexpected.length) fail(name, `console errors: ${unexpected.join(' | ')}`);
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
    // innerText still returns the words of a [hidden] element, so without this a
    // mission's debrief "appeared" before the mission was finished, and the
    // scenario passed with nothing done. Only what a learner can see counts.
    if (re.test(last) && await loc.isVisible()) return last;
    await page.waitForTimeout(150);
  }
  throw new Error(`${sel} never matched ${re} while visible (last: ${JSON.stringify(last.slice(-200))})`);
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
  // describe, not get: a real get nodes has no CPU column, and the step says so.
  await type(page, r, 'kubectl describe nodes');
  await expectText(page, `${r} .term-out`, /Allocated resources:/);
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

await scenario('code-lab', '/learn/algorithms/counting-steps/', async (page) => {
  const r = '[data-codelab]';
  await page.locator(r).first().scrollIntoViewIfNeeded();
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-status]`, /Finished in \d+ steps/);
  await expectText(page, `${r} [data-out]`, /True\s+False/);
  // The learner's edit must never sit beside output from the old code unmarked.
  await page.locator(`${r} [data-src]`).first().pressSequentially(' ');
  await expectText(page, `${r} [data-status]`, /since this ran/);
  await page.click(`${r} [data-reset]`);
  await page.click(`${r} [data-measure]`);
  await expectText(page, `${r} [data-shape]`, /quadratic/);
  await expectText(page, `${r} [data-growth-rows]`, /2x the input, [34]\.\dx the work/);
  // Stepping shows the line about to run and the call's own frame.
  await page.click(`${r} [data-step]`);
  await expectText(page, `${r} [data-status]`, /line about to run/);
  for (let i = 0; i < 6; i++) await page.click(`${r} [data-step]`);
  await expectText(page, `${r} [data-vars]`, /has_duplicate\(\)[\s\S]*items/);
  const at = await page.locator(`${r} [data-listing] li.at`).count();
  if (at !== 1) throw new Error(`stepper highlights ${at} lines`);
  await page.click(`${r} [data-edit-btn]`);
  const fixed = 'def has_duplicate(items):\n    seen = set()\n    for x in items:\n        if x in seen:\n            return True\n        seen.add(x)\n    return False\n';
  await page.locator(`${r} [data-src]`).first().fill(fixed);
  await page.click(`${r} [data-measure]`);
  await expectText(page, `${r} [data-shape]`, /linear/);
  await expectText(page, `${r} .m-debrief`, /quadruples the work/);
  // Loud limits: an endless loop is stopped and named, not reported as finished.
  await page.locator(`${r} [data-src]`).first().fill('while True:\n    pass\n');
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-status]`, /Stopped at [\d,]+ steps/, 30000);
  await page.locator(`${r} [data-src]`).first().fill('import math\n');
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-status]`, /Not your bug: real Python has 'import'/);
  await page.locator(`${r} [data-src]`).first().fill('print(1)\nprint(1 / 0)\n');
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-status]`, /ZeroDivisionError on line 2/);
  await expectText(page, `${r} [data-out]`, /^1\s*$/);
});

// ---- Algorithms trail: the first lessons -----------------------------------
// innerText of a hidden element still returns its text, so expectText on a hidden
// debrief can pass with the mission unfinished. These wait for it to be visible.
const debriefShows = (page, r) => page.locator(`${r} .m-debrief`).waitFor({ state: 'visible', timeout: 15000 });
const debriefHidden = async (page, r) => { if (await page.locator(`${r} .m-debrief`).isVisible()) throw new Error(`${r}: mission finished too early`); };
const mission = (id) => `[data-codelab][data-mission="${id}"]`;
const setCode = async (page, r, src) => {
  await page.locator(`${r} [data-edit-btn]`).isVisible().then((v) => (v ? page.click(`${r} [data-edit-btn]`) : null));
  await page.locator(`${r} [data-src]`).fill(src);
};

await scenario('alg-what-is-an-algorithm', '/learn/algorithms/what-is-an-algorithm/', async (page) => {
  // The first lab is what someone who has never seen code meets, so it has to work.
  const first = '[data-codelab] >> nth=0';
  await page.locator(first).scrollIntoViewIfNeeded();
  await page.locator(first).locator('[data-run]').click();
  await page.waitForFunction(() => /1 bottles of beer/.test(document.querySelector('[data-codelab] [data-out]').textContent));
  // The note sends someone who has never seen code to the track written for them.
  const note = await page.locator('main .callout').first().innerText();
  if (!/Programming from Zero/.test(note)) throw new Error(`note reads: ${note}`);
  const noteLink = await page.locator('main .callout').first().locator('a').getAttribute('href');
  if (!noteLink?.includes('/learn/programming/first-program/')) throw new Error(`the note links to ${noteLink}`);

  const r = mission('alg-what-last-day');
  const starter = await page.locator(`${r} [data-src]`).inputValue();
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-out]`, /^2007\s*$/);
  // Failure case one: an endless loop that isn't this bug doesn't tick the step.
  await setCode(page, r, 'while True:\n    pass\n');
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-status]`, /Stopped at [\d,]+ steps/, 30000);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 1) throw new Error('an unrelated hang ticked the step');
  // The real day: the page stops it, and the panel shows the state it is stuck in.
  await setCode(page, r, starter.replace('year_from_days(10000)', 'year_from_days(10593)'));
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-status]`, /Stopped at [\d,]+ steps/, 30000);
  await expectText(page, `${r} [data-vars]`, /days\s+366[\s\S]*year\s+2008/);
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .m-steps li.done`).length === 2, r);
  // Failure case two: the tempting fix stops the hang and gets the year wrong.
  await setCode(page, r, starter.replace('if days > 366:', 'if days >= 366:'));
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-status]`, /Finished/);
  await debriefHidden(page, r);
  await setCode(page, r, starter.replace('                year += 1\n        else:', '                year += 1\n            else:\n                break\n        else:'));
  await page.click(`${r} [data-run]`);
  await debriefShows(page, r);

  // Same interface, and only one of them keeps the promise.
  const book = page.locator('[data-codelab]').nth(3);
  await book.scrollIntoViewIfNeeded();
  await book.locator('[data-run]').click();
  const out = await book.locator('[data-out]');
  const deadline = Date.now() + 8000;
  while (!/111 111\s+111 222/.test(await out.innerText())) {
    if (Date.now() > deadline) throw new Error(`phone book printed: ${await out.innerText()}`);
    await page.waitForTimeout(100);
  }
});

await scenario('layout-lab', '/learn/algorithms/arrays-and-lists/', async (page) => {
  const r = '[data-layout]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const walk = async (id, size) => {
    await page.selectOption(`${r} [data-walk]`, id);
    await page.locator(`${r} [data-size]`).fill(String(size));
    await page.click(`${r} [data-walk-run]`);
  };
  const misses = async () => Number((await page.locator(`${r} [data-s="misses"]`).innerText()).replace(/,/g, ''));
  await expectText(page, `${r} [data-history]`, /Nothing walked yet/);
  await walk('array', 512);
  if (await misses() !== 64) throw new Error(`array at 512: ${await misses()} misses, the model says 64`);
  await walk('list-ordered', 512);
  if (await misses() !== 128) throw new Error(`in-order list at 512: ${await misses()} misses, the model says 128`);
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .m-steps li.done`).length === 1, r);
  // Failure case: where the list fits in the cache, scattering shows nothing and must not tick.
  await walk('list-shuffled', 32);
  await walk('list-ordered', 32);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 1) throw new Error('a size that fits in the cache ticked the scatter step');
  await walk('list-shuffled', 512);
  if (await misses() <= 128) throw new Error(`scattered at 512: ${await misses()} misses`);
  // The canvas really draws: a blank one would still pass every number above.
  await page.waitForTimeout(1600);
  const painted = await page.locator(`${r} [data-map]`).evaluate((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const colours = new Set(); for (let i = 0; i < d.length; i += 4 * 7) colours.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); return colours.size; });
  if (painted < 3) throw new Error(`the memory map shows ${painted} colours`);
  await debriefHidden(page, r);
  for (const n of [64, 72]) { await walk('list-shuffled', n); await walk('list-ordered', n); }
  await debriefShows(page, r);

  // Growth: the pattern from CPython's source, and not doubling.
  await page.click(`${r} [data-append="1"]`);
  await expectText(page, `${r} [data-grow-line]`, /Length 1, capacity 4/);
  await page.click(`${r} [data-append="100"]`);
  await expectText(page, `${r} [data-jumps]`, /0, 4, 8, 16, 24, 32, 40, 52, 64, 76/);
  await page.click(`${r} [data-grow-reset]`);
  await page.click(`${r} [data-append="2000000"]`);
  await expectText(page, `${r} [data-rule="cpython"]`, /2,141,028\s+92\s+8\.56/);
  await expectText(page, `${r} [data-rule="doubling"]`, /1\.05/);

  // Your machine: filled in with numbers, and judged by nothing. No ratio is checked.
  await expectText(page, `${r} [data-machine-status]`, /Not run yet/);
  await page.locator(`${r} [data-machine]`).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-machine-run]`);
  await expectText(page, `${r} [data-machine-status]`, /^Done\. One run, on this device/, 180000);
  const rows = await page.locator(`${r} [data-machine-rows] tr`).allInnerTexts();
  if (rows.length !== 5 || !rows.every((t) => /\d+\.\d+\s+\d+\.\d+\s+(\d+\.\dx|too fast)/.test(t))) throw new Error(`machine rows: ${JSON.stringify(rows)}`);

  const lab = mission('alg-lists-newest-first');
  await page.locator(lab).scrollIntoViewIfNeeded();
  await page.click(`${lab} [data-measure]`);
  await expectText(page, `${lab} [data-shape]`, /quadratic/);
  await setCode(page, lab, 'def newest_first(events):\n    out = []\n    for e in events:\n        out.append(e)\n    return out\n');
  await page.click(`${lab} [data-measure]`);
  await expectText(page, `${lab} [data-shape]`, /linear/);
  await debriefHidden(page, lab);
  await setCode(page, lab, 'def newest_first(events):\n    out = []\n    for e in events:\n        out.append(e)\n    out.reverse()\n    return out\n');
  await page.click(`${lab} [data-measure]`);
  await debriefShows(page, lab);
});

await scenario('alg-stacks-and-queues', '/learn/algorithms/stacks-and-queues/', async (page) => {
  const sim = page.locator('[data-codelab]').first();
  await sim.scrollIntoViewIfNeeded();
  await sim.locator('[data-run]').click();
  await page.waitForFunction(() => /oldest first: \(21, 39\)\s+newest first: \(60, 0\)/.test(document.querySelector('[data-codelab] [data-out]').textContent));

  const b = mission('alg-stack-brackets');
  await page.locator(b).scrollIntoViewIfNeeded();
  await page.click(`${b} [data-run]`);
  await expectText(page, `${b} [data-out]`, /True\s+True\s+True/);
  await setCode(page, b, 'def balanced(text):\n    return True\n');
  await page.click(`${b} [data-run]`);
  await expectText(page, `${b} [data-status]`, /Finished/);
  await debriefHidden(page, b);
  await setCode(page, b, 'def balanced(text):\n    pairs = {")": "(", "]": "[", "}": "{"}\n    stack = []\n    for ch in text:\n        if ch in "([{":\n            stack.append(ch)\n        if ch in ")]}":\n            if len(stack) == 0 or stack.pop() != pairs[ch]:\n                return False\n    return len(stack) == 0\n');
  await page.click(`${b} [data-run]`);
  await debriefShows(page, b);

  const rec = page.locator('[data-codelab]').nth(3);
  await rec.scrollIntoViewIfNeeded();
  await rec.locator('[data-run]').click();
  await rec.locator('[data-status]', { hasText: 'RecursionError' }).waitFor({ timeout: 15000 });

  const q = mission('alg-queue-parcel');
  await page.locator(q).scrollIntoViewIfNeeded();
  await page.click(`${q} [data-measure]`);
  await expectText(page, `${q} [data-shape]`, /quadratic/);
  await expectText(page, `${q} [data-growth-rows]`, /2x the input, [34]\.\dx the work/);
  // The tempting fix is fast because it's a stack: wrong order, and not a pass.
  const starter = await page.locator(`${q} [data-src]`).inputValue();
  await setCode(page, q, starter.replaceAll('queue.pop(0)', 'queue.pop()'));
  await page.click(`${q} [data-measure]`);
  await expectText(page, `${q} [data-shape]`, /linear/);
  await debriefHidden(page, q);
  await setCode(page, q, 'def pass_the_parcel(players):\n    queue = []\n    for p in players:\n        queue.append(p)\n    head = 0\n    out = []\n    while head < len(queue):\n        queue.append(queue[head])\n        head += 1\n        if head < len(queue):\n            out.append(queue[head])\n            head += 1\n    return out\n');
  await page.click(`${q} [data-measure]`);
  await expectText(page, `${q} [data-shape]`, /linear/);
  await debriefShows(page, q);
});

await scenario('midpoint-lab', '/learn/algorithms/searching/', async (page) => {
  const c = mission('alg-search-halving');
  await page.locator(c).scrollIntoViewIfNeeded();
  await page.click(`${c} [data-measure]`);
  await expectText(page, `${c} [data-shape]`, /linear/);
  await setCode(page, c, 'def find(items, target):\n    low = 0\n    high = len(items) - 1\n    while low <= high:\n        mid = (low + high) // 2\n        if items[mid] < target:\n            low = mid + 1\n        elif items[mid] > target:\n            high = mid - 1\n        else:\n            return mid\n    return -1\n\ndef worst(items):\n    return find(items, len(items))\n');
  await page.click(`${c} [data-measure]`);
  await expectText(page, `${c} [data-shape]`, /logarithmic/);
  await debriefShows(page, c);

  const r = '[data-midpoint]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await expectText(page, `${r} .widget-head`, /emulated/);
  const go = async (n) => { await page.locator(`${r} [data-length]`).fill(String(n)); await page.click(`${r} [data-search]`); };
  const done = () => page.locator(`${r} .m-steps li.done`).count();
  await go(1000000);
  await expectText(page, `${r} [data-result]`, /Found it at index 999,999/);
  // A length no int can hold is refused by name, not clamped to something else.
  await page.locator(`${r} [data-length]`).fill('3000000000');
  await page.click(`${r} [data-search]`);
  await expectText(page, `${r} [data-result]`, /Nothing was searched/);
  await go(2147483647);
  await expectText(page, `${r} [data-result]`, /Crashed: it tried to read index -/);
  await expectText(page, `${r} [data-probes]`, /wrapped/);
  // Bloch's number works. If the mission took it, it would teach the wrong answer.
  await go(2 ** 30);
  await expectText(page, `${r} [data-result]`, /Found it/);
  if (await done() !== 2) throw new Error(`2^30 alone left ${await done()} steps done`);
  await page.click(`${r} [data-adjust="1"]`);
  await page.click(`${r} [data-search]`);
  await expectText(page, `${r} [data-result]`, /Crashed: it tried to read index -1,073,741,824/);
  if (await done() !== 3) throw new Error(`the shortest length left ${await done()} steps done`);
  // Rarely hit, which is the point: no random target finds it.
  await page.click(`${r} [data-random]`);
  await expectText(page, `${r} [data-odds]`, /, 0 crashed/);
  await page.selectOption(`${r} [data-model]`, 'int64');
  await page.click(`${r} [data-search]`);
  if (await done() !== 3) throw new Error('moving to 64-bit ticked the formula fix');
  await page.selectOption(`${r} [data-model]`, 'int32');
  await page.selectOption(`${r} [data-formula]`, 'diff');
  await page.click(`${r} [data-search]`);
  await expectText(page, `${r} [data-result]`, /Found it at index 1,073,741,824/);
  await debriefHidden(page, r);
  // The silent failure: no error, and a wrong answer.
  await page.locator(`${r} [data-items]`).fill('3, x, 2');
  await page.click(`${r} [data-lookup]`);
  await expectText(page, `${r} [data-lookup-result]`, /"x" is not a whole number/);
  await page.locator(`${r} [data-items]`).fill('3, 1, 2');
  await page.click(`${r} [data-lookup]`);
  await expectText(page, `${r} [data-lookup-result]`, /returned 3, which means "not there", but a scan finds 3 at index 0/);
  await debriefShows(page, r);
  await page.click(`${r} [data-sort]`);
  await expectText(page, `${r} [data-lookup-result]`, /says it is at index 2/);
});

// ---- Algorithms: sorting, divide and conquer, hash tables, trees and heaps ----

await scenario('killer-lab', '/learn/algorithms/sorting/', async (page) => {
  const r = '[data-killer]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const set = (k, v) => page.selectOption(`${r} [data-k="${k}"]`, v);
  const run = () => page.click(`${r} [data-run]`);
  const count = (re) => expectText(page, `${r} [data-count]`, re);
  // The failure case: replaying nothing is refused, and not reported as a cheap sort.
  await set('input', 'replay'); await run();
  await expectText(page, `${r} [data-status]`, /Nothing to replay yet/);
  await set('input', 'sorted'); await run();
  await count(/^499,500$/);
  await expectText(page, `${r} [data-status]`, /times n lg n/);
  await set('pivot', 'random'); await run();
  await count(/^10,614$/);
  // The McIlroy finding, both halves: live, then the same input replayed.
  await set('input', 'adversary'); await run();
  await count(/^498,502$/);
  await set('input', 'replay');
  await page.click(`${r} [data-new-seed]`); await run();
  await count(/^10,345$/);
  await page.fill(`${r} [data-k="seed"]`, '11'); await run();
  await count(/^498,502$/);
  // Repeated numbers: no attacker, no secret, and quadratic at any seed. The same
  // file through a new seed has to stay bad, or the lesson's claim is wrong.
  await set('input', 'equal'); await run();
  await count(/^499,500$/);
  await expectText(page, `${r} [data-status]`, /about 100% of what comparing every pair would cost/);
  await page.click(`${r} [data-new-seed]`); await run();
  await count(/^499,500$/);
  await set('input', 'zeroOne'); await run();
  await expectText(page, `${r} [data-status]`, /about 5\d% of what comparing every pair would cost/);
  const zeroOneBars = await page.locator(`${r} [data-solid]`).getAttribute('d');
  if (!zeroOneBars || zeroOneBars.length < 100) throw new Error(`zeros and ones drew nothing: ${zeroOneBars}`);
  await page.fill(`${r} [data-k="seed"]`, '11');
  // Pivot and seed mean nothing to sorted, and must not look as if they do.
  await set('sort', 'python');
  if (await page.locator(`${r} [data-pivot-wrap]`).isVisible()) throw new Error('pivot control still showing for sorted');
  await set('input', 'adversary'); await run();
  await count(/^999$/);
  await expectText(page, `${r} .m-debrief`, /lightning/);
  await expectText(page, `${r} [data-runs]`, /Python's sorted[\s\S]*adversary/);
});

await scenario('sort-labs', '/learn/algorithms/sorting/', async (page) => {
  const select = '[data-codelab][data-grow="selection_sort"]', insert = '[data-codelab][data-grow="insertion_sort"]', nan = '[data-codelab][data-mission="cs-sort-nan"]';
  await page.locator(select).scrollIntoViewIfNeeded();
  await page.click(`${select} [data-measure]`);
  await expectText(page, `${select} [data-shape]`, /quadratic/);
  await page.locator(insert).scrollIntoViewIfNeeded();
  await page.click(`${insert} [data-measure]`);
  await expectText(page, `${insert} [data-shape]`, /linear/);
  // The silent failure, on screen: the list comes back unsorted, with no error.
  await page.locator(nan).scrollIntoViewIfNeeded();
  await page.click(`${nan} [data-run]`);
  await expectText(page, `${nan} [data-out]`, /\[3\.3, nan, 1\.1, 2\.2\]/);
  await expectText(page, `${nan} [data-status]`, /Finished/);
  await page.locator(`${nan} [data-src]`).fill('nan = float("nan")\ndef clean_sort(numbers):\n    return sorted([x for x in numbers if x == x])\nprint(clean_sort([3.3, nan, 1.1, 2.2]))\n');
  await page.click(`${nan} [data-run]`);
  await expectText(page, `${nan} [data-out]`, /\[1\.1, 2\.2, 3\.3\]/);
  await expectText(page, `${nan} .m-debrief`, /never checks its answer/);
});

await scenario('dc-labs', '/learn/algorithms/divide-and-conquer/', async (page) => {
  const m = '[data-codelab][data-mission="cs-dc-merge-sort"]', q = '[data-codelab][data-mission="cs-dc-quicksort"]';
  await page.locator(m).scrollIntoViewIfNeeded();
  await page.click(`${m} [data-run]`);
  await expectText(page, `${m} [data-out]`, /\[1, 2, 5, 5, 6, 9\]/);
  await page.click(`${m} [data-measure]`);
  await expectText(page, `${m} [data-shape]`, /quadratic/);
  // Sorted is not a merge sort: the step stays open.
  await page.locator(`${m} [data-src]`).fill('def merge_sort(items):\n    return sorted(items)\n');
  await page.click(`${m} [data-measure]`);
  await expectText(page, `${m} [data-shape]`, /linear/);
  if (await page.locator(`${m} .m-debrief`).isVisible()) throw new Error('sorted() finished the merge sort mission');
  await page.locator(`${m} [data-src]`).fill('def merge(left, right):\n    out = []\n    i = 0\n    j = 0\n    while i < len(left) and j < len(right):\n        if right[j] < left[i]:\n            out.append(right[j])\n            j += 1\n        else:\n            out.append(left[i])\n            i += 1\n    return out + left[i:] + right[j:]\n\ndef merge_sort(items):\n    if len(items) <= 1:\n        return items\n    mid = len(items) // 2\n    return merge(merge_sort(items[:mid]), merge_sort(items[mid:]))\n');
  await page.click(`${m} [data-measure]`);
  await expectText(page, `${m} [data-shape]`, /n log n/);
  await expectText(page, `${m} .m-debrief`, /T\(n\) = 2T\(n\/2\) \+ n/);

  await page.locator(q).scrollIntoViewIfNeeded();
  await page.click(`${q} [data-run]`);
  await page.click(`${q} [data-measure]`);
  await expectText(page, `${q} [data-shape]`, /quadratic/);
  await expectText(page, `${q} [data-growth-rows]`, /did not finish/);
  const src = await page.locator(`${q} [data-src]`).inputValue();
  await page.locator(`${q} [data-src]`).fill(src.replace('pivot = items[0]', 'pivot = items[len(items) // 2]'));
  await page.click(`${q} [data-measure]`);
  await expectText(page, `${q} [data-shape]`, /n log n/);
  await expectText(page, `${q} .m-debrief`, /splits into nothing and everything|sorted list splits/);
});

await scenario('flood-lab', '/learn/algorithms/hash-tables/', async (page) => {
  const r = '[data-flood]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const set = (k, v) => page.selectOption(`${r} [data-f="${k}"]`, v);
  const send = () => page.click(`${r} [data-send]`);
  const checks = (re) => expectText(page, `${r} [data-checks]`, re);
  await set('traffic', 'ordinary'); await send();
  await checks(/^0$/);
  await set('traffic', 'crafted'); await send();
  await checks(/^8,393,791$/);
  await expectText(page, `${r} [data-status]`, /flood reached the table/);
  // The tempting fix, which changes every hash and no collision.
  await set('defence', 'seeded'); await send();
  await expectText(page, `${r} [data-status]`, /flood reached the table/);
  await set('defence', 'keyed'); await send();
  await checks(/^0$/);
  await set('traffic', 'ints'); await send();
  await checks(/^8,386,560$/);
  await expectText(page, `${r} [data-status]`, /flood reached the table/);
  await page.check(`${r} [data-f="intsAsStr"]`); await send();
  await checks(/^0$/);
  await page.uncheck(`${r} [data-f="intsAsStr"]`);
  // The range check refuses those keys, and looks like the end of it.
  await page.check(`${r} [data-f="rangeCheck"]`); await send();
  await expectText(page, `${r} [data-accepted]`, /^0 of 4,096$/);
  await expectText(page, `${r} [data-status]`, /says nothing about keys that do fit/);
  // The failure this lab used to hide: zero checks, no shared hash, and a flood. It
  // read as calm when calm only looked at equality checks.
  await set('traffic', 'walk'); await send();
  await expectText(page, `${r} [data-accepted]`, /^4,096$/);
  await checks(/^0$/);
  await expectText(page, `${r} [data-probes]`, /^2,300,319$/);
  await expectText(page, `${r} [data-status]`, /This is a flood/);
  const walkClass = await page.locator(`${r} [data-status]`).getAttribute('class');
  if (!/\bbad\b/.test(walkClass)) throw new Error(`the walk attack rendered as "${walkClass}", not as a failure`);
  const walkLine = await page.locator(`${r} [data-line]`).getAttribute('d');
  if (!walkLine || walkLine.length < 100) throw new Error(`the walk drew no line: ${walkLine}`);
  await page.check(`${r} [data-f="intsAsStr"]`); await send();
  await checks(/^0$/);
  await expectText(page, `${r} [data-status]`, /cheap for this request/);
  await page.uncheck(`${r} [data-f="intsAsStr"]`); await page.uncheck(`${r} [data-f="rangeCheck"]`);
  // The sketch never looked, and must not read as a pass.
  await set('defence', 'trees'); await send();
  await expectText(page, `${r} [data-probes]`, /not modelled/);
  await expectText(page, `${r} [data-status]`, /^Not modelled/);
  await set('traffic', 'crafted'); await set('defence', 'none');
  await page.check(`${r} [data-f="cap"]`); await send();
  await expectText(page, `${r} [data-accepted]`, /1,000 of 4,096/);
  await expectText(page, `${r} [data-status]`, /Bounded, not fixed/);
  await page.click(`${r} [data-lh="one"]`);
  await expectText(page, `${r} [data-lh-text]`, /bucket 21/);
  await expectText(page, `${r} .m-debrief`, /Ez and FY collide/);
});

await scenario('hash-lab', '/learn/algorithms/hash-tables/', async (page) => {
  const r = '[data-codelab][data-mission="cs-hash-table"]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-out]`, /longest bucket: 100/);
  await page.click(`${r} [data-measure]`);
  await expectText(page, `${r} [data-shape]`, /quadratic/);
  const src = await page.locator(`${r} [data-src]`).inputValue();
  const hashed = src.replace('def h(key):\n    return len(key)\n', 'def h(key):\n    v = 5381\n    for c in key:\n        v = (v * 33 + ord(c)) % 2**32\n    return v\n');
  // A better hash, and still no growth: the last step has to stay open.
  await page.locator(`${r} [data-src]`).fill(hashed);
  await page.click(`${r} [data-measure]`);
  await expectText(page, `${r} [data-status]`, /Finished/);
  if (await page.locator(`${r} .m-debrief`).isVisible()) throw new Error('a fixed table finished the hash table mission');
  const grown = hashed
    .replace('    table["count"] += 1\n', '    table["count"] += 1\n    if table["count"] > len(buckets) * 2 // 3:\n        grow(table)\n')
    .replace('def put(table, key, value):', 'def grow(table):\n    old = table["buckets"]\n    table["buckets"] = [[] for _ in range(len(old) * 2)]\n    for bucket in old:\n        for pair in bucket:\n            table["buckets"][h(pair[0]) % len(table["buckets"])].append(pair)\n\ndef put(table, key, value):');
  await page.locator(`${r} [data-src]`).fill(grown);
  await page.click(`${r} [data-measure]`);
  await expectText(page, `${r} [data-shape]`, /linear/);
  await expectText(page, `${r} .m-debrief`, /Two separate things/);
  // Loud limit: the sandbox's hash() refuses strings by name.
  const ints = '[data-codelab]:not([data-mission])';
  await page.locator(ints).first().scrollIntoViewIfNeeded();
  await page.locator(ints).first().locator('[data-run]').click();
  await expectText(page, `${ints} [data-out]`, /0 0 0[\s\S]*1 1 1[\s\S]*-2/);
  await page.locator(ints).first().locator('[data-src]').fill('print(hash("abc"))\n');
  await page.locator(ints).first().locator('[data-run]').click();
  await expectText(page, `${ints} [data-status]`, /Not your bug: real Python has hash\(\)/);
});

await scenario('tree-shaper', '/learn/algorithms/trees-and-heaps/', async (page) => {
  const r = '[data-shaper]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const set = (k, v) => page.selectOption(`${r} [data-t="${k}"]`, v);
  const grow = () => page.click(`${r} [data-grow]`);
  const panel = (id) => `${r} [data-panel="${id}"] [data-num]`;
  await set('order', 'sorted'); await grow();
  await expectText(page, panel('bst'), /height 999, 499,500 comparisons/);
  await expectText(page, panel('rb'), /height 16\b/);
  await expectText(page, `${r} [data-status]`, /list wearing a tree/);
  // A straight line drawn really has to be on screen, not only claimed in text.
  const d = await page.locator(`${r} [data-panel="bst"] path`).getAttribute('d');
  if (!d || d.split('M').length < 900) throw new Error('the plain tree was not drawn');
  await set('order', 'shuffled'); await grow();
  await expectText(page, panel('bst'), /height 19, 10,672 comparisons/);
  await set('order', 'nearly'); await grow();
  await expectText(page, panel('bst'), /height 971/);
  await set('order', 'sorted'); await set('fanout', '100'); await grow();
  await expectText(page, panel('bt'), /height 1, 2 node reads/);
  // The outage, then the repair.
  await page.uncheck(`${r} [data-rebalance]`);
  await page.click(`${r} [data-replay]`);
  await expectText(page, `${r} [data-events]`, /After 247 updates: height 81[\s\S]*Recovery starts[\s\S]*After 247 updates/);
  await expectText(page, `${r} [data-outage-status]`, /fired 3 times/);
  await page.check(`${r} [data-rebalance]`);
  await page.click(`${r} [data-replay]`);
  await expectText(page, `${r} [data-outage-status]`, /never fired/);
  await expectText(page, `${r} .m-debrief`, /fictionalized/);
});

await scenario('heap-lab', '/learn/algorithms/trees-and-heaps/', async (page) => {
  const r = '[data-codelab][data-mission="cs-heap-queue"]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-run]`);
  await page.click(`${r} [data-measure]`);
  await expectText(page, `${r} [data-shape]`, /quadratic/);
  const src = await page.locator(`${r} [data-src]`).inputValue();
  await page.locator(`${r} [data-src]`).fill(src.replace('    q = []\n    for x in items:\n        push(q, x)\n    out = []\n    while q:\n        out.append(pop_smallest(q))\n    return out\n', '    return sorted(items)\n'));
  await page.click(`${r} [data-measure]`);
  if (await page.locator(`${r} .m-debrief`).isVisible()) throw new Error('sorted() finished the heap mission');
  await page.locator(`${r} [data-src]`).fill('def push(q, x):\n    q.append(x)\n    i = len(q) - 1\n    while i > 0:\n        parent = (i - 1) // 2\n        if q[i] < q[parent]:\n            q[i], q[parent] = q[parent], q[i]\n            i = parent\n        else:\n            break\n\ndef pop_smallest(q):\n    top = q[0]\n    last = q.pop()\n    if q:\n        q[0] = last\n        i = 0\n        while True:\n            left = 2 * i + 1\n            right = 2 * i + 2\n            smallest = i\n            if left < len(q) and q[left] < q[smallest]:\n                smallest = left\n            if right < len(q) and q[right] < q[smallest]:\n                smallest = right\n            if smallest == i:\n                break\n            q[i], q[smallest] = q[smallest], q[i]\n            i = smallest\n    return top\n\ndef drain(items):\n    q = []\n    for x in items:\n        push(q, x)\n    out = []\n    while q:\n        out.append(pop_smallest(q))\n    return out\n');
  await page.click(`${r} [data-measure]`);
  await expectText(page, `${r} [data-shape]`, /n log n/);
  await expectText(page, `${r} .m-debrief`, /every parent is no larger than its children/);
  // The recursion limit is real here too, and the lab names it.
  const chain = '[data-codelab]:not([data-mission])';
  await page.locator(chain).first().scrollIntoViewIfNeeded();
  await page.locator(chain).first().locator('[data-run]').click();
  await expectText(page, `${chain} [data-status]`, /RecursionError/);
  await expectText(page, `${chain} [data-out]`, /^499\s*$/);
});

// Algorithms trail: graphs to algorithms-and-people. Each drives the failure the
// lesson is about, then the fix, then checks the mission really finished.
const debriefShown = (page, r, re) => expectText(page, `${r} .m-debrief`, re);
const typeRun = async (page, r, src) => {
  await page.locator(`${r} [data-src]`).first().fill(src);
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-status]`, /Finished in|on line|Stopped|Not your bug/, 20000);
};

await scenario('network-lab-graphs', '/learn/algorithms/graphs/', async (page) => {
  const r = '[data-netlab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await expectText(page, `${r} [data-flood-status]`, /Nothing injected yet/);
  // Running a quiet network must not read as a tested one.
  await page.click(`${r} [data-tick="100"]`);
  await expectText(page, `${r} [data-flood-status]`, /Nothing injected yet/);
  await page.click(`${r} [data-inject]`);
  await page.click(`${r} [data-tick="100"]`);
  await expectText(page, `${r} [data-flood-status]`, /Still circulating after 100 ticks/);
  await expectText(page, `${r} [data-rule-check]`, /40 is LATER than 8, 44 is LATER than 40, 8 is LATER than 44/);
  // One restart is re-infected by its neighbours.
  await page.selectOption(`${r} [data-imp]`, '2');
  await page.click(`${r} [data-restart]`);
  await page.click(`${r} [data-tick="10"]`);
  await expectText(page, `${r} [data-flood-status]`, /Still circulating/);
  // Restart-all clears it, and the page says that proves nothing.
  await page.click(`${r} [data-restart-all]`);
  await expectText(page, `${r} [data-flood-status]`, /proves nothing about the rule/);
  // The same numbers in another order die out: the page must say so, not fail.
  await page.click(`${r} [data-flood-reset]`);
  await page.selectOption(`${r} [data-seqs]`, 'other');
  await page.click(`${r} [data-inject]`);
  await page.click(`${r} [data-tick="100"]`);
  await expectText(page, `${r} [data-flood-status]`, /Died out by itself/);
  // The fix ends it. Then the invented numbers break the fix.
  await page.click(`${r} [data-flood-reset]`);
  await page.selectOption(`${r} [data-seqs]`, 'real');
  await page.check(`${r} [data-strict]`);
  await page.click(`${r} [data-inject]`);
  await page.click(`${r} [data-tick="100"]`);
  await expectText(page, `${r} [data-flood-status]`, /Died out by itself/);
  await expectText(page, `${r} [data-rule-check]`, /40 is not LATER than 8/);
  await page.click(`${r} [data-flood-reset]`);
  await page.selectOption(`${r} [data-seqs]`, 'invented');
  await page.click(`${r} [data-inject]`);
  await page.click(`${r} [data-tick="100"]`);
  await expectText(page, `${r} [data-flood-status]`, /Still circulating after 100 ticks/);
  // Route: same places, different order.
  await page.click(`${r} [data-tab="route"]`);
  await page.selectOption(`${r} [data-algo]`, 'bfs');
  await page.click(`${r} [data-route-step]`);
  await expectText(page, `${r} [data-route-detail]`, /Queue \(next out is first\): B, C/);
  await page.click(`${r} [data-route-run]`);
  await expectText(page, `${r} [data-route-status]`, /reached 5 of 7\. Cannot reach F, G from A/);
  await page.selectOption(`${r} [data-algo]`, 'dfs');
  await page.click(`${r} [data-route-run]`);
  await expectText(page, `${r} [data-route-detail]`, /Visit order: A, C, E, D, B/);
  await expectText(page, `${r} [data-reps]`, /14 list entries against 49 matrix cells/);
  // Build: no cycle is fine, a cycle is refused, or carried on past.
  await page.click(`${r} [data-tab="build"]`);
  await page.click(`${r} [data-build]`);
  await expectText(page, `${r} [data-build-status]`, /Everything comes after what it needs/);
  await page.check(`${r} [data-cycle]`);
  await page.click(`${r} [data-build]`);
  await expectText(page, `${r} [data-build-status]`, /Refused\. These need each other/);
  await page.selectOption(`${r} [data-mode]`, 'drop');
  await page.click(`${r} [data-build]`);
  await expectText(page, `${r} [data-build-status]`, /dropped "core needs app"/);
  await debriefShown(page, r, /had a cycle in it/);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 6) throw new Error('expected all 6 steps done');
});

await scenario('network-lab-paths', '/learn/algorithms/shortest-paths/', async (page) => {
  const r = '[data-netlab]', c = '[data-codelab][data-mission="alg-paths-dijkstra"]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-route-run]`);
  await expectText(page, `${r} [data-route-status]`, /no error\. Distance from s: s = 0, a = 2, b = 3, t = 3/);
  await page.selectOption(`${r} [data-algo]`, 'bellman-ford');
  await page.click(`${r} [data-route-run]`);
  await expectText(page, `${r} [data-route-status]`, /a = 2, b = 3, t = 3/);
  await page.fill(`${r} [data-weight]`, '-2');
  await page.locator(`${r} [data-weight]`).dispatchEvent('change');
  await page.selectOption(`${r} [data-algo]`, 'dijkstra');
  await page.click(`${r} [data-route-run]`);
  // The wrong answer, with no error: the status must read the same as a right one.
  await expectText(page, `${r} [data-route-status]`, /Finished with no error\. Distance from s: s = 0, a = 2, b = 3, t = 3/);
  await page.selectOption(`${r} [data-algo]`, 'bellman-ford');
  await page.click(`${r} [data-route-run]`);
  await expectText(page, `${r} [data-route-status]`, /a = 1, b = 3, t = 2/);
  await debriefShown(page, r, /it is wrong: s to b to a to t is 2/);
  await page.locator(c).scrollIntoViewIfNeeded();
  await page.click(`${c} [data-run]`);
  await expectText(page, `${c} [data-out]`, /^3\s*$/);
  await typeRun(page, c, 'def shortest(edges, start, goal):\n    dist = {start: 0}\n    settled = set()\n    while True:\n        best = None\n        for node in dist:\n            if node not in settled and (best is None or dist[node] < dist[best]):\n                best = node\n        if best is None:\n            return dist.get(goal)\n        settled.add(best)\n        for a, b, length in edges:\n            if a == best:\n                if b not in dist or dist[a] + length < dist[b]:\n                    dist[b] = dist[a] + length\n                    settled.discard(b)\n\nprint(shortest([("s", "a", 2), ("s", "b", 3), ("b", "a", -2), ("a", "t", 1)], "s", "t"))\n');
  await expectText(page, `${c} [data-out]`, /^2\s*$/);
  await debriefShown(page, c, /One rule was the whole bug/);
});

await scenario('greedy-labs', '/learn/algorithms/greedy/', async (page) => {
  const a = '[data-codelab][data-mission="alg-greedy-coins"]', b = '[data-codelab][data-mission="alg-greedy-classes"]';
  await page.locator(a).scrollIntoViewIfNeeded();
  await page.click(`${a} [data-run]`);
  await expectText(page, `${a} [data-out]`, /2 2\s+3 2\s+None/);
  const coins = await page.locator(`${a} [data-src]`).first().inputValue();
  // A hard-coded answer for the one visible case must not finish the mission.
  await typeRun(page, a, coins.replace('    return None\n\nprint(greedy', '    return 6\n\nprint(greedy'));
  if (await page.locator(`${a} .m-debrief`).isVisible()) throw new Error('a hard-coded first_lie finished the mission');
  await typeRun(page, a, coins.replace('    return None\n\nprint(greedy', '    for amount in range(1, 101):\n        if greedy(amount, coins) != fewest(amount, coins):\n            return amount\n    return None\n\nprint(greedy'));
  await debriefShown(page, a, /right on every American amount/);
  await page.locator(b).scrollIntoViewIfNeeded();
  await page.click(`${b} [data-run]`);
  await expectText(page, `${b} [data-out]`, /^1\s*$/);
  const classes = await page.locator(`${b} [data-src]`).first().inputValue();
  await typeRun(page, b, classes.replace('key=lambda c: c[0]', 'key=lambda c: c[1] - c[0]'));
  if (await page.locator(`${b} .m-debrief`).isVisible()) throw new Error('shortest-first finished the mission');
  await typeRun(page, b, classes.replace('key=lambda c: c[0]', 'key=lambda c: c[1]'));
  await debriefShown(page, b, /only "ends earliest" is right/);
  const mst = '[data-codelab]:not([data-mission])';
  await page.locator(mst).first().scrollIntoViewIfNeeded();
  await page.click(`${mst} [data-run]`);
  await expectText(page, `${mst} [data-out]`, /^total 10/);
});

await scenario('dp-labs', '/learn/algorithms/dynamic-programming/', async (page) => {
  const r = '[data-codelab][data-mission="alg-dp-fib"]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-measure]`);
  await expectText(page, `${r} [data-shape]`, /exponential or worse/);
  await expectText(page, `${r} [data-growth-rows]`, /4 more input, [\d.]+x the work/);
  const memo = 'memo = {}\n\ndef fib(n):\n    if n in memo:\n        return memo[n]\n    if n < 2:\n        return n\n    memo[n] = fib(n - 1) + fib(n - 2)\n    return memo[n]\n';
  await page.locator(`${r} [data-src]`).first().fill(`${memo}\nprint(fib(0), fib(1), fib(2))\n`);
  await page.click(`${r} [data-measure]`);
  await expectText(page, `${r} [data-shape]`, /linear/);
  const loop = 'def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\nprint(len(str(fib(5000))))\n';
  // A RecursionError from something else is not the memo hitting the stack. This
  // used to finish the step, so the loop below would have finished the mission.
  await typeRun(page, r, 'def f():\n    f()\n\nf()\n');
  await expectText(page, `${r} [data-status]`, /RecursionError on line/);
  await typeRun(page, r, loop);
  await expectText(page, `${r} [data-out]`, /^1045\s*$/);
  if (await page.locator(`${r} .m-debrief`).isVisible()) throw new Error('an unrelated RecursionError finished the mission');
  // The stack: memoised, from cold, and it still fails, with the real error's name.
  await typeRun(page, r, `${memo}\nprint(fib(5000))\n`);
  await expectText(page, `${r} [data-status]`, /RecursionError on line/);
  await typeRun(page, r, loop);
  await expectText(page, `${r} [data-out]`, /^1045\s*$/);
  await debriefShown(page, r, /fixed the time and did nothing for the depth/);
  // Stepping shows the stack the lesson talks about.
  await page.click(`${r} [data-edit-btn]`).catch(() => {});
  await page.locator(`${r} [data-src]`).first().fill('def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\n\nprint(fib(3))\n');
  await page.click(`${r} [data-step]`);
  for (let i = 0; i < 8; i++) await page.click(`${r} [data-step]`);
  await expectText(page, `${r} [data-vars]`, /fib\(\)[\s\S]*fib\(\)/);
  const m = '[data-codelab]:not([data-mission])';
  await page.locator(m).first().scrollIntoViewIfNeeded();
  await page.click(`${m} [data-run]`);
  await expectText(page, `${m} [data-out]`, /k=160 plain 26243 remembering 643/, 30000);
});

await scenario('growth-labs', '/learn/algorithms/growth-classes/', async (page) => {
  const r = '[data-codelab][data-mission="alg-growth-quicksort"]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-run]`);
  await expectText(page, `${r} [data-out]`, /\[1, 1, 2, 3, 4, 5, 6, 9\]/);
  await page.click(`${r} [data-measure]`);
  await expectText(page, `${r} [data-shape]`, /quadratic/);
  // A sorted check is the tempting shortcut: it measures well and must not pass.
  await page.locator(`${r} [data-src]`).first().fill('def quicksort(items):\n    if items == sorted(items):\n        return items\n    pivot = items[0]\n    rest = items[1:]\n    return quicksort([x for x in rest if x < pivot]) + [pivot] + quicksort([x for x in rest if x >= pivot])\n');
  await page.click(`${r} [data-measure]`);
  await expectText(page, `${r} [data-shape]`, /Shape over these sizes/);
  if (await page.locator(`${r} .m-debrief`).isVisible()) throw new Error('a sorted check finished the mission');
  // The built-in sorts correctly and isn't quadratic, and has no pivot in it. This used to pass.
  await page.locator(`${r} [data-src]`).first().fill('def quicksort(items):\n    return sorted(items)\n');
  await page.click(`${r} [data-measure]`);
  await expectText(page, `${r} [data-shape]`, /linear/);
  if (await page.locator(`${r} .m-debrief`).isVisible()) throw new Error('return sorted(items) finished the mission');
  await page.locator(`${r} [data-src]`).first().fill('def quicksort(items):\n    if len(items) < 2:\n        return items\n    mid = len(items) // 2\n    pivot = items[mid]\n    rest = items[:mid] + items[mid + 1:]\n    smaller = [x for x in rest if x < pivot]\n    larger = [x for x in rest if x >= pivot]\n    return quicksort(smaller) + [pivot] + quicksort(larger)\n');
  await page.click(`${r} [data-measure]`);
  await expectText(page, `${r} [data-shape]`, /n log n/);
  await debriefShown(page, r, /moved the worst case rather than removing it/);
  const s = '[data-codelab][data-grow="subsets"]', o = '[data-codelab][data-grow="orderings"]';
  await page.locator(s).scrollIntoViewIfNeeded();
  await page.click(`${s} [data-measure]`);
  await expectText(page, `${s} [data-shape]`, /exponential or worse/, 20000);
  await page.click(`${o} [data-measure]`);
  await expectText(page, `${o} [data-shape]`, /exponential or worse/, 20000);
  const f = '[data-codelab]:not([data-mission]):not([data-grow])';
  await page.locator(f).first().scrollIntoViewIfNeeded();
  await page.click(`${f} [data-run]`);
  await expectText(page, `${f} [data-out]`, /best 1\s+worst 1000\s+average 500\.5\s+not there 1000/);
});

await scenario('people-labs', '/learn/algorithms/algorithms-and-people/', async (page) => {
  const c = '[data-codelab][data-mission="alg-people-averaging"]';
  await page.locator(c).scrollIntoViewIfNeeded();
  await page.click(`${c} [data-run]`);
  await expectText(page, `${c} [data-out]`, /^1615\.38/);
  const src = await page.locator(`${c} [data-src]`).first().inputValue();
  // "Nobody owes anything" clears the false debt and misses the real one.
  await typeRun(page, c, 'def debt(income, on_benefit):\n    return 0.0\n\nprint(debt([1], [True]))\n');
  if (await page.locator(`${c} .m-debrief`).isVisible()) throw new Error('returning zero finished the mission');
  await typeRun(page, c, src.replace('    average = sum(income) / len(income)\n', '').replace('average > FREE', 'income[fortnight] > FREE').replace('(average - FREE)', '(income[fortnight] - FREE)'));
  await expectText(page, `${c} [data-out]`, /^0\.0\s*$/);
  await debriefShown(page, c, /confident number/);
  const t = '[data-codelab]:not([data-mission])';
  await page.locator(t).first().scrollIntoViewIfNeeded();
  await page.click(`${t} [data-run]`);
  await expectText(page, `${t} [data-out]`, /false positives 44\.8% vs 23\.5%[\s\S]*flagged but did not reoffend 37\.0% vs 40\.9%/);
  const r = '[data-fairlab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const slide = async (sel, v) => { await page.locator(`${r} ${sel}`).fill(String(v)); };
  await slide('[data-ta]', 6); await slide('[data-tb]', 6);
  await expectText(page, `${r} [data-status]`, /71 innocent people flagged in Group A, 185 in Group B/);
  await expectText(page, `${r} [data-cell="fpr-gap"]`, /pts/);
  // Nobody flagged is undefined, never "equal".
  await slide('[data-ta]', 11); await slide('[data-tb]', 11);
  await expectText(page, `${r} [data-cell="ppv-gap"]`, /undefined/);
  await expectText(page, `${r} [data-cell="ppv-a"]`, /nobody flagged/);
  // 5.1% and 5.4%: the false positives even out, and the predictive values come apart.
  await slide('[data-ta]', 7); await slide('[data-tb]', 9);
  await expectText(page, `${r} [data-cell="fpr-gap"]`, /^0\.2 pts/);
  await expectText(page, `${r} [data-cell="ppv-gap"]`, /^15\.5 pts/);
  await page.click(`${r} [data-search]`);
  await expectText(page, `${r} [data-status]`, /Tried all 121 pairs\. None match on all three/);
  await page.selectOption(`${r} [data-set]`, 'same');
  // Everyone flagged makes the numbers match by making them useless. This used to finish the mission.
  await slide('[data-ta]', 1); await slide('[data-tb]', 1);
  await expectText(page, `${r} [data-status]`, /All three match/);
  if (await page.locator(`${r} .m-debrief`).isVisible()) throw new Error('flagging everyone finished the fairness mission');
  // Nobody flagged: the equation has no predictive value, so it must not claim to agree with the table.
  await slide('[data-ta]', 11); await slide('[data-tb]', 11);
  await expectText(page, `${r} [data-eq]`, /nothing to work from/);
  await slide('[data-ta]', 5); await slide('[data-tb]', 5);
  await expectText(page, `${r} [data-status]`, /All three match/);
  await debriefShown(page, r, /Equal base rates only make it possible/);
  await debriefShown(page, r, /a larger share of the innocent people/);
  await expectText(page, `${r} [data-eq]`, /Chouldechova's equation[\s\S]*the same as the table/);
});

// ---- Programming from Zero, first half --------------------------------------
// Each drives a lesson the way a beginner would: runs the starter, makes the mistake,
// reads what the page says, then fixes it. A beginner can't see the hidden inputs, so
// these also check the reason shown on an unticked step: a bare unticked box is the
// silent failure here.
const progRun = (page, r) => page.click(`${r} [data-run]`);
// Polls: a run finishes a moment after the click, and until then the reason on screen is
// the previous run's, which is correct for that run and wrong to judge this one by.
const progWhy = async (page, r, re) => {
  const why = page.locator(`${r} .m-steps li.current .m-why`);
  await why.waitFor({ state: 'visible', timeout: 15000 });
  const deadline = Date.now() + 15000;
  let text = await why.innerText();
  while (!re.test(text)) {
    if (Date.now() > deadline) throw new Error(`${r}: the reason shown is "${text}"`);
    await page.waitForTimeout(100);
    text = await why.innerText();
  }
};
const progTry = async (page, r, src) => { await setCode(page, r, src); await progRun(page, r); };

await scenario('prog-first-program', '/learn/programming/first-program/', async (page) => {
  const r = mission('prog-first-hello');
  await page.locator(r).scrollIntoViewIfNeeded();
  await progRun(page, r);
  await expectText(page, `${r} [data-out]`, /Hello, panda/);
  await debriefHidden(page, r);
  await progTry(page, r, 'print("I wrote this")\n');
  await expectText(page, `${r} [data-out]`, /I wrote this/);
  await progTry(page, r, 'prin("I wrote this")\n');
  await expectText(page, `${r} [data-status]`, /NameError on line 1: name 'prin' is not defined/);
  await debriefHidden(page, r);
  await progTry(page, r, 'print("I wrote this")\n');
  await debriefShows(page, r);

  // The lesson's claim: a runtime error has run the lines above it, a syntax error has run nothing.
  const labs = page.locator('[data-codelab]:not([data-mission])');
  const runtime = labs.nth(1), syntax = labs.nth(2);
  await runtime.scrollIntoViewIfNeeded();
  await runtime.locator('[data-run]').click();
  await runtime.locator('[data-status].bad').waitFor({ timeout: 15000 });
  if (!/^one\s*$/.test(await runtime.locator('[data-out]').innerText())) throw new Error('the runtime error should leave "one" printed');
  await syntax.locator('[data-run]').click();
  await syntax.locator('[data-status].bad').waitFor({ timeout: 15000 });
  if (!/SyntaxError on line 2: unterminated string literal/.test(await syntax.locator('[data-status]').innerText())) throw new Error(await syntax.locator('[data-status]').innerText());
  if ((await syntax.locator('[data-out]').innerText()).trim() !== '') throw new Error('a syntax error should print nothing');

  // Say what's sandbox: import is refused by name, and never reads as the learner's bug.
  await syntax.locator('[data-src]').fill('import math\n');
  await syntax.locator('[data-run]').click();
  await syntax.locator('[data-status].warn').waitFor({ timeout: 15000 });
  if (!/Not your bug: real Python has 'import'/.test(await syntax.locator('[data-status]').innerText())) throw new Error(await syntax.locator('[data-status]').innerText());

  const c = mission('prog-first-countdown');
  await page.locator(c).scrollIntoViewIfNeeded();
  await progRun(page, c);
  await expectText(page, `${c} [data-status]`, /NameError on line 3/);
  await expectText(page, `${c} [data-out]`, /Go!\s+3/);
  await progTry(page, c, 'print("Go!")\nprint(3)\nprint(2)\nprint(1)\n');
  await progWhy(page, c, /It printed/);
  await debriefHidden(page, c);
  await progTry(page, c, 'print(3)\nprint(2)\nprint(1)\nprint("Go!")\n');
  await debriefShows(page, c);
});

await scenario('prog-values', '/learn/programming/values-and-variables/', async (page) => {
  const r = mission('prog-vals-share');
  const starter = await page.locator(`${r} [data-src]`).inputValue();
  await page.locator(r).scrollIntoViewIfNeeded();
  await progRun(page, r);
  await expectText(page, `${r} [data-out]`, /^15\s*$/);
  await progTry(page, r, starter.replace('bill = 60', 'bill = 90'));
  await expectText(page, `${r} [data-out]`, /^22\s*$/);
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .m-steps li.done`).length === 2, r);
  // A hard-coded answer fails on a bill the learner never saw, and the page says which.
  await progTry(page, r, 'bill = 60\npeople = 4\nprint(15)\n');
  await progWhy(page, r, /With bill = 90 and people = 4, it printed "15"; expected 22\.5/);
  await debriefHidden(page, r);
  await progTry(page, r, starter.replace('//', '/'));
  await debriefShows(page, r);

  const a = mission('prog-vals-age');
  await page.locator(a).scrollIntoViewIfNeeded();
  await progRun(page, a);
  await expectText(page, `${a} [data-status]`, /TypeError on line 2: can only concatenate str \(not "int"\) to str/);
  await progTry(page, a, 'age_text = "41"\nprint(age_text + "1")\n');
  await expectText(page, `${a} [data-out]`, /411/);
  await progWhy(page, a, /expected/);
  await progTry(page, a, 'age_text = "41"\nprint(int(age_text) + 1)\n');
  await debriefShows(page, a);

  // input() is refused by name, with what to do instead.
  await progTry(page, a, 'name = input()\n');
  await expectText(page, `${a} [data-status]`, /Not your bug: this lab has no input box/);
});

// The review's worst freeze: "a1".strip(1) threw a raw JavaScript error and left the lab on
// "Running…" with Stop hanging. The engine no longer throws on that, so a fault is injected
// in two places: inside the engine, and in the page's own code after the run.
await scenario('prog-lab-fails-loudly', '/learn/programming/first-program/', async (page) => {
  const lab = page.locator('[data-codelab]:not([data-mission])').first();
  await lab.scrollIntoViewIfNeeded();
  const buttonsBack = async () => {
    await page.waitForFunction((el) => el.querySelector('[data-run]').textContent === 'Run' && !el.querySelector('[data-step]').disabled, await lab.elementHandle(), { timeout: 15000 });
    const said = await lab.locator('[data-status]').innerText();
    if (!/bug in this page's Python sandbox, not in your code/.test(said)) throw new Error(`status says: ${said}`);
    if (/Running/.test(said)) throw new Error('still reads as running');
    if (await lab.locator('[data-status].bad').count()) throw new Error('a sandbox bug is styled as the learner\'s error');
    if (await lab.locator('[data-tb-box]').isVisible()) throw new Error('a sandbox bug shows a Python traceback');
  };
  // The real failure first: it's a TypeError now, and it reads as one.
  await lab.locator('[data-src]').fill('print("a1".strip(1))\n');
  await lab.locator('[data-run]').click();
  await expectText(page, '[data-codelab]:not([data-mission]) >> nth=0 >> [data-status]', /TypeError on line 1: strip arg must be None or str/);
  // A fault inside the engine: Array.prototype.at is on the path of every instruction.
  await page.evaluate(() => { const real = Array.prototype.at; window.__realAt = real; Array.prototype.at = function () { throw new TypeError('injected engine fault'); }; });
  await lab.locator('[data-src]').fill('print("hello")\n');
  await lab.locator('[data-run]').click();
  await page.waitForFunction((el) => /injected engine fault/.test(el.querySelector('[data-status]').textContent), await lab.elementHandle(), { timeout: 15000 });
  await page.evaluate(() => { Array.prototype.at = window.__realAt; });
  await buttonsBack();
  await page.setViewportSize({ width: 1280, height: 900 });
  await lab.scrollIntoViewIfNeeded();
  if (process.env.CHECK_SHOTS) await lab.screenshot({ path: `${process.env.CHECK_SHOTS}/sandbox-bug-desktop.png` });
  await page.setViewportSize({ width: 375, height: 800 });
  await lab.scrollIntoViewIfNeeded();
  if (process.env.CHECK_SHOTS) await lab.screenshot({ path: `${process.env.CHECK_SHOTS}/sandbox-bug-375.png` });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (wide) throw new Error('the sandbox bug message overflows a phone');
  await page.setViewportSize({ width: 1280, height: 900 });
  // And it recovers: the next run works.
  await lab.locator('[data-run]').click();
  await expectText(page, '[data-codelab]:not([data-mission]) >> nth=0 >> [data-out]', /^hello\s*$/);
  // A fault in the page's own code, past the engine: the same message, the same buttons.
  await page.evaluate(() => { window.__realRC = Element.prototype.replaceChildren; Element.prototype.replaceChildren = function () { throw new TypeError('injected page fault'); }; });
  await lab.locator('[data-run]').click();
  await page.waitForFunction((el) => /injected page fault/.test(el.querySelector('[data-status]').textContent), await lab.elementHandle(), { timeout: 15000 });
  await page.evaluate(() => { Element.prototype.replaceChildren = window.__realRC; });
  await buttonsBack();
  await lab.locator('[data-run]').click();
  await expectText(page, '[data-codelab]:not([data-mission]) >> nth=0 >> [data-status]', /Finished in/);
  // The hint is code to read. It used to promise a terminal this page doesn't have.
  const title = await page.locator(`${mission('prog-first-hello')} .m-steps code`).first().getAttribute('title');
  if (title !== null) throw new Error(`a hint says: ${title}`);
}, { expectErrors: /injected (engine|page) fault/ });

await scenario('prog-fix-first', '/learn/programming/values-and-variables/', async (page) => {
  // Right first time, with a word after the number, before ever running the broken starter.
  const r = mission('prog-vals-share');
  await page.locator(r).scrollIntoViewIfNeeded();
  await debriefHidden(page, r);
  await progTry(page, r, 'bill = 60\npeople = 4\nshare = bill / people\nprint(share, "each")\n');
  await debriefShows(page, r);
  if (await page.locator(`${r} .m-steps li.done`).count() !== 3) throw new Error('a correct program should tick every step');
});

await scenario('prog-decisions', '/learn/programming/decisions/', async (page) => {
  const first = page.locator('[data-codelab]').first();
  await first.scrollIntoViewIfNeeded();
  await first.locator('[data-run]').click();
  await first.locator('[data-status].bad').waitFor({ timeout: 15000 });
  const said = await first.locator('[data-status]').innerText();
  if (!/SyntaxError on line 2: invalid syntax\. Maybe you meant '==' or ':=' instead of '='\?/.test(said)) throw new Error(said);

  const r = mission('prog-dec-ticket');
  const starter = await page.locator(`${r} [data-src]`).inputValue();
  await page.locator(r).scrollIntoViewIfNeeded();
  await progRun(page, r);
  await expectText(page, `${r} [data-out]`, /adult/);
  await progTry(page, r, starter.replace('age = 30', 'age = 8'));
  await expectText(page, `${r} [data-status]`, /Finished/);
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .m-steps li.done`).length === 2, r);
  // The edge: > where >= belongs passes on 30 and 8, and fails on 13.
  await progTry(page, r, 'age = 30\nif age > 18:\n    print("adult")\nelif age > 13:\n    print("teen")\nelse:\n    print("child")\n');
  await progWhy(page, r, /With age = 13, it printed "child"; expected "teen"/);
  await debriefHidden(page, r);
  await progTry(page, r, `${starter}else:\n    print("child")\n`);
  await debriefShows(page, r);

  const l = mission('prog-dec-leap');
  const leap = await page.locator(`${l} [data-src]`).inputValue();
  await page.locator(l).scrollIntoViewIfNeeded();
  await progRun(page, l);
  await expectText(page, `${l} [data-status]`, /Maybe you meant/);
  await progTry(page, l, leap.replace('% 4 = 0', '% 4 == 0'));
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .m-steps li.done`).length === 2, l);
  await progWhy(page, l, /With year = 1900, it printed "leap"; expected "not leap"/);
  await progTry(page, l, leap.replace('year % 4 = 0', 'year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)'));
  await debriefShows(page, l);
});

await scenario('prog-loops', '/learn/programming/loops/', async (page) => {
  const first = page.locator('[data-codelab]').first();
  await first.scrollIntoViewIfNeeded();
  // Step shows the value changing, which is what the lesson asks a beginner to watch.
  await first.locator('[data-step]').click();
  await first.locator('[data-step]').click();
  await first.locator('[data-step]').click();
  if (!/n\s+3/.test(await first.locator('[data-vars]').innerText())) throw new Error(await first.locator('[data-vars]').innerText());

  const r = mission('prog-loop-stuck');
  const starter = await page.locator(`${r} [data-src]`).inputValue();
  await page.locator(r).scrollIntoViewIfNeeded();
  await progRun(page, r);
  await expectText(page, `${r} [data-status]`, /Stopped/, 30000);
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .m-steps li.done`).length === 1, r);
  await debriefHidden(page, r);
  await progTry(page, r, 'n = 5\nprint(5)\nprint(4)\nprint(3)\nprint(2)\nprint(1)\nprint("Go!")\n');
  await progWhy(page, r, /With n = 3/);
  await progTry(page, r, starter.replace('n - 1', 'n = n - 1'));
  await debriefShows(page, r);

  const s = mission('prog-loop-sum');
  const sum = await page.locator(`${s} [data-src]`).inputValue();
  await page.locator(s).scrollIntoViewIfNeeded();
  await progRun(page, s);
  await expectText(page, `${s} [data-out]`, /^45\s*$/);
  await progTry(page, s, sum.replace('range(1, n)', 'range(n)'));
  await progWhy(page, s, /expected 55/);
  await progTry(page, s, sum.replace('range(1, n)', 'range(1, n + 1)'));
  await debriefShows(page, s);
});

await scenario('prog-stop-counts', '/learn/programming/loops/', async (page) => {
  // The step's own hint says to press Stop, and pressing it used to tick nothing.
  const r = mission('prog-loop-stuck');
  await page.locator(r).scrollIntoViewIfNeeded();
  // A quiet loop, not the lesson's starter. The starter prints on every pass, so it
  // fills the output limit in about 20 ms and in WebKit it stopped itself before this
  // click arrived. That's correct behaviour, but it isn't the Stop button.
  await page.locator(`${r} [data-src]`).fill('n = 5\nwhile n > 0:\n    n - 1\n');
  await progRun(page, r);
  await page.waitForFunction((sel) => /[1-9][\d,]* steps/.test(document.querySelector(`${sel} [data-steps]`).textContent) && document.querySelector(`${sel} [data-run]`).textContent === 'Stop', r, { timeout: 15000 });
  await progRun(page, r);
  await expectText(page, `${r} [data-status]`, /You stopped it at/);
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .m-steps li.done`).length === 1, r);
  if (await page.locator(`${r} [data-run]`).innerText() !== 'Run') throw new Error('Stop should hand the Run button back');
});

await scenario('prog-functions', '/learn/programming/functions/', async (page) => {
  const r = mission('prog-fn-fahrenheit');
  await page.locator(r).scrollIntoViewIfNeeded();
  await progRun(page, r);
  await expectText(page, `${r} [data-out]`, /212\.0/);
  // Looks right on screen, and fails: this is the point of the mission.
  await progWhy(page, r, /to_fahrenheit\(0\) returned None; expected 32\.0/);
  await debriefHidden(page, r);
  await progTry(page, r, 'def to_fahrenheit(c):\n    return c * 1.8 + 32\n');
  await debriefShows(page, r);

  const l = mission('prog-fn-leap');
  await page.locator(l).scrollIntoViewIfNeeded();
  await progRun(page, l);
  await progWhy(page, l, /is_leap\(2023\) returned None; expected False/);
  await progTry(page, l, 'def is_leap(year):\n    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)\n\ndef days_in_year(year):\n    return 366 if is_leap(year) else 365\n');
  await debriefShows(page, l);

  // The call stack: stepping into a call shows that call's own variables.
  const stack = page.locator('[data-codelab]:not([data-mission])').nth(1);
  await stack.scrollIntoViewIfNeeded();
  // Press 1 shows line 1, press 2 runs the def, press 3 enters the call. A fourth has returned.
  for (let i = 0; i < 3; i++) await stack.locator('[data-step]').click();
  const vars = await stack.locator('[data-vars]').innerText();
  if (!/with_tax\(\)[\s\S]*price\s+3/.test(vars)) throw new Error(`after stepping into the call, the panel reads: ${vars}`);
});

await scenario('prog-lists', '/learn/programming/lists/', async (page) => {
  const first = page.locator('[data-codelab]').first();
  await first.scrollIntoViewIfNeeded();
  await first.locator('[data-run]').click();
  await first.locator('[data-status].ok').waitFor({ timeout: 15000 });
  if (!/\[1, 2, 3\]\s+\[1, 2, 3\]/.test(await first.locator('[data-out]').innerText())) throw new Error('the opening aliasing program should show both names changed');

  const c = mission('prog-list-copy');
  await page.locator(c).scrollIntoViewIfNeeded();
  await progRun(page, c);
  await progWhy(page, c, /the list it was given is now \[2, 3, 4\]/);
  await debriefHidden(page, c);
  await progTry(page, c, 'def with_bonus(scores):\n    return [s + 1 for s in scores]\n');
  await debriefShows(page, c);

  const d = mission('prog-list-default');
  await page.locator(d).scrollIntoViewIfNeeded();
  await progRun(page, d);
  await expectText(page, `${d} [data-out]`, /\['tea', 'milk'\]/);
  // The starter's own two calls have already filled the shared list, and the reason shows it.
  await progWhy(page, d, /add_item\('a'\) returned \['tea', 'milk', 'a'\]; expected \['a'\]/);
  await progTry(page, d, 'def add_item(item, basket=None):\n    if basket is None:\n        basket = []\n    basket.append(item)\n    return basket\n');
  await debriefShows(page, d);

  const m = mission('prog-list-remove');
  const rm = await page.locator(`${m} [data-src]`).inputValue();
  await page.locator(m).scrollIntoViewIfNeeded();
  await progRun(page, m);
  await progTry(page, m, rm.replace('[5, 1, 7]', '[1, 1, 2]'));
  await expectText(page, `${m} [data-out]`, /\[1, 2\]/);
  await progWhy(page, m, /remove_all\(\[1, 1, 2\], 1\) returned \[1, 2\]; expected \[2\]/);
  await progTry(page, m, 'def remove_all(items, target):\n    return [x for x in items if x != target]\n');
  await debriefShows(page, m);
});

await scenario('prog-records', '/learn/programming/records-and-maps/', async (page) => {
  const first = page.locator('[data-codelab]').first();
  await first.scrollIntoViewIfNeeded();
  await first.locator('[data-run]').click();
  await first.locator('[data-status].ok').waitFor({ timeout: 15000 });
  if (!/Bo is 7\s+Bo is 19/.test(await first.locator('[data-out]').innerText())) throw new Error('the parallel lists should drift apart with no error');

  const r = mission('prog-map-count');
  await page.locator(r).scrollIntoViewIfNeeded();
  await progRun(page, r);
  await expectText(page, `${r} [data-status]`, /KeyError on line 4: 'tea'/);
  await debriefHidden(page, r);
  // Built in a different order, and still right.
  await progTry(page, r, 'def count_words(words):\n    counts = {}\n    for w in sorted(words):\n        counts[w] = counts.get(w, 0) + 1\n    return counts\n');
  await debriefShows(page, r);

  const o = mission('prog-map-orders');
  await page.locator(o).scrollIntoViewIfNeeded();
  await progRun(page, o);
  await expectText(page, `${o} [data-status]`, /Finished/);
  // Runs clean and prints a plausible {}: the check is what says it isn't done.
  await progWhy(page, o, /returned \{\}; expected/);
  await debriefHidden(page, o);
  await progTry(page, o, 'def totals(orders):\n    result = {}\n    for order in orders:\n        result[order["name"]] = result.get(order["name"], 0) + order["amount"]\n    return result\n');
  await debriefShows(page, o);

  const s = mission('prog-set-common');
  await page.locator(s).scrollIntoViewIfNeeded();
  await progRun(page, s);
  await expectText(page, `${s} [data-out]`, /\[1, 1, 1, 1\]/);
  await progTry(page, s, 'def in_both(a, b):\n    return list(set(a) & set(b))\n');
  await progWhy(page, s, /expected \[1, 3\]/);
  await debriefHidden(page, s);
  await progTry(page, s, 'def in_both(a, b):\n    return sorted(set(a) & set(b))\n');
  await debriefShows(page, s);
});

await scenario('prog-text', '/learn/programming/text/', async (page) => {
  const t = mission('prog-text-tidy');
  await page.locator(t).scrollIntoViewIfNeeded();
  await progRun(page, t);
  await expectText(page, `${t} [data-out]`, /\[ {2}Mei@Example\.COM \]/);
  await progWhy(page, t, /returned '  Mei@Example\.COM '; expected 'mei@example\.com'/);
  await debriefHidden(page, t);
  await progTry(page, t, 'def tidy_email(s):\n    return s.strip().lower()\n');
  await debriefShows(page, t);

  const w = mission('prog-text-count');
  await page.locator(w).scrollIntoViewIfNeeded();
  await progRun(page, w);
  await expectText(page, `${w} [data-out]`, /^2\s*$/);
  await progTry(page, w, 'def count_word(text, word):\n    return text.lower().count(word.lower())\n');
  await progWhy(page, w, /expected 1/);
  await progTry(page, w, 'def count_word(text, word):\n    return text.lower().split().count(word.lower())\n');
  await debriefShows(page, w);

  // Escapes and emoji have to survive the trip through MDX and the page: a sample that
  // arrives with \\n or a broken joiner would still run, and teach the wrong thing.
  const labs = page.locator('[data-codelab]:not([data-mission])');
  const count = await labs.count();
  let family = null, escapes = null;
  for (let i = 0; i < count; i++) {
    const src = await labs.nth(i).locator('[data-src]').inputValue();
    if (src.includes('👨‍👩‍👧')) family = labs.nth(i);
    if (src.includes('one\\ntwo')) escapes = labs.nth(i);
  }
  if (!family || !escapes) throw new Error(`samples not found intact: family ${!!family}, escapes ${!!escapes}`);
  await family.scrollIntoViewIfNeeded();
  await family.locator('[data-run]').click();
  await family.locator('[data-status].ok').waitFor({ timeout: 15000 });
  if (!/^1\s+2\s+2\s+5\b/.test(await family.locator('[data-out]').innerText())) throw new Error(await family.locator('[data-out]').innerText());
  await escapes.locator('[data-run]').click();
  await escapes.locator('[data-status].ok').waitFor({ timeout: 15000 });
  if (!/^one\s+two\s+a\s+b\s+back\\slash\s+1\s*$/.test(await escapes.locator('[data-out]').innerText())) throw new Error(await escapes.locator('[data-out]').innerText());
});
// ---- Programming from Zero, second half. Each plays its lab as a learner would,
// including the tempting wrong answer, and reads the verdict off the screen.
{
  const lab = (id) => `[data-codelab][data-mission="${id}"]`;
  const setCode = async (page, id, code) => {
    await page.locator(`${lab(id)} [data-src]`).scrollIntoViewIfNeeded();
    await page.locator(`${lab(id)} [data-src]`).fill(code);
  };
  const run = async (page, id) => page.locator(`${lab(id)} [data-run]`).click();
  const stepsDone = (page, id) => page.locator(`${lab(id)} .m-steps li.done`).count();
  const waitDone = async (page, id, n) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { if (await stepsDone(page, id) === n) return; await page.waitForTimeout(100); }
    throw new Error(`${id}: expected ${n} steps done, saw ${await stepsDone(page, id)}`);
  };

  await scenario('prog-input-stdin', '/learn/programming/input-and-errors/', async (page) => {
    // The input box really feeds input(), and bad input really reaches the program.
    const m = 'prog-errors-ask';
    await run(page, m);
    await expectText(page, `${lab(m)} [data-tb]`, /ValueError: invalid literal for int\(\) with base 10: 'forty'/);
    await expectText(page, `${lab(m)} [data-tb]`, /Traceback \(most recent call last\):/);
    await waitDone(page, m, 1);
    await setCode(page, m, `def ask_age():
    while True:
        try:
            age = int(input("How old are you? "))
        except ValueError:
            continue
        if 0 <= age <= 150:
            return age

print("You are", ask_age())
`);
    await run(page, m);
    await expectText(page, `${lab(m)} [data-out]`, /You are 41/);
    await waitDone(page, m, 3);
    await expectText(page, `${lab(m)} .m-debrief`, /makes up an age/);
    // Too little input says what happened, as a sandbox limit, not as the learner's bug.
    await page.locator(`${lab(m)} [data-stdin]`).fill('nope');
    await run(page, m);
    await expectText(page, `${lab(m)} [data-status]`, /Not your bug: the program asked for more input/);
  });

  await scenario('prog-swallowed-error', '/learn/programming/input-and-errors/', async (page) => {
    const m = 'prog-errors-swallow';
    await run(page, m);
    await expectText(page, `${lab(m)} [data-out]`, /^0\s*$/);
    await expectText(page, `${lab(m)} [data-status]`, /Finished/);
    await waitDone(page, m, 1);
    // The tempting fix: repair the typo and keep catching everything. Right answer, not done.
    const start = await page.locator(`${lab(m)} [data-src]`).inputValue();
    await setCode(page, m, start.replace('totl', 'total'));
    await run(page, m);
    await expectText(page, `${lab(m)} [data-out]`, /350/);
    await waitDone(page, m, 1);
    // Narrowing with the typo still there: the hidden bug comes out loud.
    await setCode(page, m, start.replace('except Exception', 'except ValueError'));
    await run(page, m);
    await expectText(page, `${lab(m)} [data-tb]`, /NameError: name 'totl' is not defined/);
    await waitDone(page, m, 2);
    await setCode(page, m, start.replace('except Exception', 'except ValueError').replace('totl', 'total'));
    await run(page, m);
    await expectText(page, `${lab(m)} .m-debrief`, /has to stay loud/);
  });

  await scenario('prog-debug-hidden-inputs', '/learn/programming/debugging/', async (page) => {
    const m = 'prog-debug-step';
    await run(page, m);
    await waitDone(page, m, 1);
    const start = await page.locator(`${lab(m)} [data-src]`).inputValue();
    // Special-casing the visible input prints the right thing and doesn't pass.
    await setCode(page, m, start.replace('    best = 0\n', '    if items == ["a", "a", "b", "b", "b"]:\n        return 3\n    best = 0\n'));
    await run(page, m);
    await expectText(page, `${lab(m)} [data-out]`, /2\s+3/);
    await waitDone(page, m, 1);
    await setCode(page, m, start.replace('    return best\n', '    return max(best, current)\n'));
    await run(page, m);
    await expectText(page, `${lab(m)} .m-debrief`, /longest run comes last/);
    // Step shows the call stack, with the function's own frame on top.
    const t = 'prog-debug-traceback';
    await page.locator(`${lab(t)} [data-step]`).click();
    for (let i = 0; i < 6; i++) await page.locator(`${lab(t)} [data-step]`).click();
    await expectText(page, `${lab(t)} [data-vars]`, /report\(\)/);
  });

  await scenario('prog-mutants', '/learn/programming/your-first-tests/', async (page) => {
    const m = 'prog-tests-mutants';
    await expectText(page, `${lab(m)} [data-given]`, /def ticket_price/);
    await run(page, m);
    await waitDone(page, m, 1);
    // A test that can't fail: it passes on the correct function and catches nothing.
    await setCode(page, m, 'assert ticket_price(5) == ticket_price(5)\nassert True\nprint("all tests passed")\n');
    await run(page, m);
    await expectText(page, `${lab(m)} [data-out]`, /all tests passed/);
    await waitDone(page, m, 1);
    // A test that's wrong about the function fails on the correct one, so it doesn't count.
    await setCode(page, m, 'assert ticket_price(5) == 0\n');
    await run(page, m);
    await expectText(page, `${lab(m)} [data-tb]`, /AssertionError/);
    await waitDone(page, m, 0);
    // Upper edges only: passed before, and misses the version that stops at 17.
    await setCode(page, m, 'assert ticket_price(30) == 10\nassert ticket_price(3) == 0\nassert ticket_price(10) == 5\nassert ticket_price(70) == 6\nassert ticket_price(5) == 5\nassert ticket_price(18) == 10\nassert ticket_price(65) == 6\nprint("all tests passed")\n');
    await run(page, m);
    await waitDone(page, m, 5);
    await setCode(page, m, 'assert ticket_price(30) == 10\nassert ticket_price(3) == 0\nassert ticket_price(10) == 5\nassert ticket_price(70) == 6\nassert ticket_price(4) == 0\nassert ticket_price(5) == 5\nassert ticket_price(17) == 5\nassert ticket_price(18) == 10\nassert ticket_price(64) == 10\nassert ticket_price(65) == 6\nprint("all tests passed")\n');
    await run(page, m);
    await expectText(page, `${lab(m)} .m-debrief`, /thirteen broken ones/);
  });

  // The mission that couldn't be finished: its last step changes a rate its first two
  // steps still demanded, so finishing it cleared all three ticks and hid the debrief.
  await scenario('prog-refactor-finishes', '/learn/programming/readable-code/', async (page) => {
    const m = 'prog-readable-refactor';
    const start = await page.locator(`${lab(m)} [data-src]`).inputValue();
    const renamed = start.replace('def f(d, r):', 'def late_fee(due_day, returned_day):').replace('x = r - d', 'x = returned_day - due_day').replace('print(f(10, 15))', 'print(late_fee(10, 15))').replace('print(f(10, 50))', 'print(late_fee(10, 50))');
    await setCode(page, m, renamed);
    await run(page, m);
    await waitDone(page, m, 1);
    const fee = (rate) => `def days_late(due_day, returned_day):\n    return max(0, returned_day - due_day)\n\ndef late_fee(due_day, returned_day):\n    days = days_late(due_day, returned_day)\n    if days > 30:\n        return 30 * ${rate} + (days - 30) * 50\n    return days * ${rate}\n\nprint(late_fee(10, 15))\n`;
    await setCode(page, m, fee(25));
    await run(page, m);
    await waitDone(page, m, 2);
    await setCode(page, m, fee(30));
    await run(page, m);
    await waitDone(page, m, 3);
    await expectText(page, `${lab(m)} .m-debrief`, /charged people the wrong amount/);
  });

  await scenario('prog-hypothesis-needs-a-print', '/learn/programming/debugging/', async (page) => {
    const m = 'prog-debug-hypothesis';
    const start = await page.locator(`${lab(m)} [data-src]`).inputValue();
    // The unchanged starter used to tick the step that asks for a new print.
    await run(page, m);
    await expectText(page, `${lab(m)} [data-out]`, /\[1, -3, 4\]/);
    await waitDone(page, m, 0);
    await expectText(page, `${lab(m)} .m-why`, /still broken/);
    await setCode(page, m, `${start}print(without_negatives([-1, -2, -3]))\n`);
    await run(page, m);
    await waitDone(page, m, 1);
    await setCode(page, m, 'def without_negatives(items):\n    return [x for x in items if x >= 0]\n');
    await run(page, m);
    await waitDone(page, m, 2);
  });

  await scenario('prog-recursion-limit', '/learn/programming/recursion/', async (page) => {
    const m = 'prog-rec-trees';
    await run(page, m);
    await expectText(page, `${lab(m)} [data-tb]`, /\[Previous line repeated \d+ more times\]/);
    await waitDone(page, m, 1);
    const probe = page.locator('[data-codelab]').nth(2);
    await probe.locator('[data-run]').click();
    await page.waitForFunction(() => /stopped after 999 calls/.test(document.querySelectorAll('[data-codelab]')[2].querySelector('[data-out]').textContent));
    // The call stack is visible while stepping: three frames of count_down, by name.
    const first = page.locator('[data-codelab]').first();
    for (let i = 0; i < 10; i++) await first.locator('[data-step]').click();
    await page.waitForFunction(() => document.querySelector('[data-codelab]').querySelectorAll('.cl-frame').length >= 3);
  });

  await scenario('prog-real-trip', '/learn/programming/real-program/', async (page) => {
    const m = 'prog-real-trip';
    await run(page, m);
    await expectText(page, `${lab(m)} [data-tb]`, /write parse_expense/);
    await waitDone(page, m, 1);
    const start = await page.locator(`${lab(m)} [data-src]`).inputValue();
    const solved = start.replace('def test_parse_expense():', `def parse_expense(line, people):
    words = line.split()
    if len(words) < 2 or words[0] not in people:
        raise ValueError(f"can't read: {line}")
    return (words[0], to_cents(words[1]))

def balances(people, expenses):
    total = sum([c for n, c in expenses])
    share, extra = total // len(people), total % len(people)
    b = {}
    for i, p in enumerate(people):
        b[p] = -share - (1 if i < extra else 0)
    for n, c in expenses:
        b[n] += c
    return b

def settle(balance):
    left = dict(balance)
    out = []
    while True:
        a = max(left, key=lambda p: left[p])
        z = min(left, key=lambda p: left[p])
        if left[a] == 0:
            return out
        amount = min(left[a], -left[z])
        out.append((z, a, amount))
        left[a] -= amount
        left[z] += amount

def test_parse_expense():`);
    await setCode(page, m, solved);
    await run(page, m);
    await expectText(page, `${lab(m)} [data-out]`, /Cai pays Ana 32\.16/);
    await expectText(page, `${lab(m)} [data-out]`, /Skipped line 4: not an amount: lots/);
    // Not done yet: the last step wants the learner's own numbers.
    await waitDone(page, m, 4);
    await page.locator(`${lab(m)} [data-stdin]`).fill('Mo, Jo\nMo 10 lunch\ndone');
    await run(page, m);
    await expectText(page, `${lab(m)} [data-out]`, /Jo pays Mo 5\.00/);
    await expectText(page, `${lab(m)} .m-debrief`, /still owes you money/);
  });

  await scenario('prog-shell-silent', '/learn/programming/shell-scripts/', async (page) => {
    const r = '[data-shell-pg][data-mission="prog-shell-silent"]';
    await type(page, r, './cleanup.sh');
    await expectText(page, `${r} .term-out`, /cache cleaned/);
    await type(page, r, 'echo $?');
    await expectText(page, `${r} .term-out`, /cache cleaned[\s\S]*\n0\s*$/);
    // * skips hidden files, here as in real bash, so .bashrc is the only survivor.
    await expectText(page, `${r} [data-files]`, /^(?![\s\S]*notes\.txt)[\s\S]*\.bashrc/);
    // Safe and useless does not pass: it never empties anything.
    await type(page, r, `echo 'echo "cache cleaned"' > cleanup.sh`);
    if (await page.locator(`${r} .m-steps li.done`).count() !== 1) throw new Error('a script that does nothing passed as a fix');
    await type(page, r, `echo 'cd cache && rm -r * && echo "cache cleaned"' > cleanup.sh`);
    await type(page, r, 'bash cleanup.sh');
    await type(page, r, 'echo $?');
    await expectText(page, `${r} .m-debrief`, /deleted nothing and exited non-zero/);
    // Things this sandbox lacks say so by name, and aren't "command not found".
    await type(page, r, 'set -e');
    await expectText(page, `${r} .term-out`, /real bash has it/);
  });

  // The typo the lesson teaches: wc on it printed nothing, threw in the page, and $? said 0.
  await scenario('prog-shell-missing-file', '/learn/programming/shell-scripts/', async (page) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const r = '[data-shell-pg]:not([data-mission="prog-shell-report"]):not([data-mission="prog-shell-silent"])';
    await type(page, r, 'wc -l acces.log; echo $?');
    await expectText(page, `${r} .term-out`, /wc: acces\.log: No such file or directory[\s\S]*\n1\s*$/);
    await type(page, r, 'grep -c zebra notes.txt; echo $?');
    await expectText(page, `${r} .term-out`, /\n0\s*\n1\s*$/);
    await type(page, r, 'rm -rf /; echo $?');
    await expectText(page, `${r} .term-out`, /dangerous to operate recursively[\s\S]*\n1\s*$/);
    if (errors.length) throw new Error(`the page threw: ${errors.join('; ')}`);
  });

  await scenario('prog-whose-catch', '/learn/programming/whose-code/', async (page) => {
    const m = 'prog-whose-catch';
    await run(page, m);
    await expectText(page, `${lab(m)} [data-out]`, /all tests passed/);
    await waitDone(page, m, 1);
    const start = await page.locator(`${lab(m)} [data-src]`).inputValue();
    // assert False fails on the correct version too, so it isn't catching anything.
    await setCode(page, m, `assert False\n${start}`);
    await run(page, m);
    await waitDone(page, m, 1);
    await setCode(page, m, `assert remove_duplicates([1, 2, 1]) == [1, 2]\na = [1, 1]\nremove_duplicates(a)\nassert a == [1, 1]\n`);
    await run(page, m);
    await expectText(page, `${lab(m)} [data-tb]`, /AssertionError/);
    await expectText(page, `${lab(m)} .m-debrief`, /Plausible isn't the same as correct/);
  });
}

// ---- How a Machine Computes: bits to adder -----------------------------------
// Each lab driven by its controls, with its refusals, and each mission to its debrief.
await scenario('comp-bit-lab', '/learn/computer/bits-and-bases/', async (page) => {
  const r = '[data-bitlab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await expectText(page, `${r} .widget-head`, /emulated/);
  const set = async (v) => { await page.locator(`${r} [data-set-value]`).fill(v); await page.click(`${r} [data-set]`); };
  // Switches, the way a person would: 8 + 4 + 1.
  for (const i of [3, 2, 0]) await page.click(`${r} [data-bit="${i}"]`);
  await expectText(page, `${r} [data-reading="unsigned"]`, /^13$/);
  await expectText(page, `${r} [data-reading="binary"]`, /0000 1101/);
  // A number that doesn't fit is refused by name, and nothing changes.
  await set('256');
  await expectText(page, `${r} [data-status]`, /does not fit in 8 bits/);
  await expectText(page, `${r} [data-reading="unsigned"]`, /^13$/);
  await set('pizza');
  await expectText(page, `${r} [data-status]`, /not a whole number/);
  await debriefHidden(page, r);
  await set('255');
  await page.click(`${r} [data-plus]`);
  await expectText(page, `${r} [data-status]`, /256, which needs 9 bits.*read 0/);
  await set('0xA5');
  await expectText(page, `${r} [data-reading="hex"]`, /0xa5/);
  await set('65');
  await expectText(page, `${r} [data-reading="char"]`, /"A", chr\(65\)/);
  // Minus on an unsigned row talks about subtracting, not "65 + 255 is 320".
  await page.click(`${r} [data-minus]`);
  await expectText(page, `${r} [data-status]`, /65 - 1 = 64/);
  await set('0');
  await page.click(`${r} [data-minus]`);
  await expectText(page, `${r} [data-status]`, /0 - 1 is -1.*wrapped round to 255/);
  await debriefHidden(page, r);
  await page.selectOption(`${r} [data-width]`, '16');
  await set('65535');
  await debriefShows(page, r);
  // 32 switches, none of them off the screen on a phone: the width check below covers that.
  await page.selectOption(`${r} [data-width]`, '32');
  await expectText(page, `${r} [data-status]`, /Now 32 bits/);
  const shown = await page.locator(`${r} .bl-bit:visible`).count();
  if (shown !== 32) throw new Error(`${shown} switches at 32 bits`);
  const c = mission('comp-bits-digits');
  await page.locator(c).scrollIntoViewIfNeeded();
  await page.click(`${c} [data-run]`);
  await expectText(page, `${c} [data-out]`, /0b1101 0xff 13/);
  await setCode(page, c, 'def to_digits(n, base):\n    if n == 0:\n        return [0]\n    d = []\n    while n > 0:\n        d.insert(0, n % base)\n        n = n // base\n    return d\n\ndef from_digits(digits, base):\n    v = 0\n    for x in digits:\n        v = v * base + x\n    return v\n');
  await page.click(`${c} [data-run]`);
  await debriefShows(page, c);
});

await scenario('comp-bit-lab-signed', '/learn/computer/negative-numbers/', async (page) => {
  const r = '[data-bitlab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const set = async (v) => { await page.locator(`${r} [data-set-value]`).fill(v); await page.click(`${r} [data-set]`); };
  const addIt = async (v) => { await page.locator(`${r} [data-add-value]`).fill(v); await page.click(`${r} [data-add]`); };
  await set('-1');
  await expectText(page, `${r} [data-reading="binary"]`, /1111 1111/);
  await expectText(page, `${r} [data-reading="twos"]`, /^-1$/);
  await expectText(page, `${r} [data-reading="sign"]`, /^-127$/);
  await expectText(page, `${r} [data-reading="ones"]`, /^-0$/);
  await set('-129');
  await expectText(page, `${r} [data-status]`, /-128 to 127/);
  await set('-3');
  await addIt('5');
  await expectText(page, `${r} [data-status]`, /-3 \+ 5 = 2\. A carry fell off the top/);
  await set('127');
  await page.click(`${r} [data-plus]`);
  await expectText(page, `${r} [data-status]`, /127 \+ 1 is 128.*read -128/);
  await set('-128');
  await page.click(`${r} [data-negate]`);
  await expectText(page, `${r} [data-status]`, /gave -128 back/);
  await debriefHidden(page, r);
  // -1 widened to 16 bits really reads 255 here, and this used to say only "Now 16 bits".
  await set('-1');
  await page.selectOption(`${r} [data-width]`, '16');
  await expectText(page, `${r} [data-reading="twos"]`, /^255$/);
  await expectText(page, `${r} [data-status]`, /Now 16 bits\. The new top bits are 0, so two's complement changed from -1 to 255/);
  await page.selectOption(`${r} [data-width]`, '8');
  await expectText(page, `${r} [data-status]`, /Now 8 bits\.$|Now 8 bits\. Only the low bits/);
  await expectText(page, `${r} [data-reading="twos"]`, /^-1$/);
  await page.selectOption(`${r} [data-width]`, '16');
  await set('32767');
  await page.click(`${r} [data-plus]`);
  await expectText(page, `${r} [data-reading="twos"]`, /^-32768$/);
  await debriefShows(page, r);
  const c = mission('comp-neg-emulate');
  await page.locator(c).scrollIntoViewIfNeeded();
  await page.click(`${c} [data-run]`);
  await expectText(page, `${c} [data-out]`, /^32768/);
  // Clamping is the tempting wrong answer, and the panel says which input it failed.
  await setCode(page, c, 'print(32768)\ndef wrap(n, bits):\n    top = 2 ** (bits - 1)\n    return max(-top, min(top - 1, n))\n\ndef fits(n, bits):\n    return True\n');
  await page.click(`${c} [data-run]`);
  await expectText(page, `${c} .m-steps li.current .m-why`, /wrap\(32768, 16\) returned 32767; expected -32768/);
  await setCode(page, c, 'print(32768)\ndef wrap(n, bits):\n    u = n % 2 ** bits\n    return u - 2 ** bits if u >= 2 ** (bits - 1) else u\n\ndef fits(n, bits):\n    return wrap(n, bits) == n\n');
  await page.click(`${c} [data-run]`);
  await debriefShows(page, c);
});

await scenario('comp-float-lab', '/learn/computer/floating-point/', async (page) => {
  const r = '[data-floatlab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await expectText(page, `${r} [data-exact]`, /0\.1000000000000000055511151231257827021181583404541015625/);
  const store = async (v) => { await page.locator(`${r} [data-value]`).fill(v); await page.click(`${r} [data-store]`); };
  await store('pizza');
  await expectText(page, `${r} [data-status]`, /not a number this lab reads/);
  await store('0.1');
  await expectText(page, `${r} [data-status]`, /Not exact/);
  await expectText(page, `${r} [data-hex]`, /0x1\.999999999999ap-4/);
  await store('0.75');
  await expectText(page, `${r} [data-status]`, /Stored exactly/);
  await store('9007199254740993');
  await expectText(page, `${r} [data-exact]`, /^9007199254740992$/);
  await page.click(`${r} [data-next="up"]`);
  await expectText(page, `${r} [data-exact]`, /^9007199254740994$/);
  await expectText(page, `${r} [data-status]`, /Moved by 2\.0/);
  await debriefHidden(page, r);
  // A flipped bit changes the number on screen: the sign bit of 1.0.
  await store('1');
  await page.click(`${r} [data-fbit="0"]`);
  await expectText(page, `${r} [data-repr]`, /^-1\.0$/);
  // Zero is exact however wild the exponent: "0e9999" once read "Not exact".
  await store('0e9999');
  await expectText(page, `${r} [data-status]`, /Stored exactly/);
  // The word inf shows infinity and doesn't count, and the lab says why.
  await store('inf');
  await expectText(page, `${r} [data-status]`, /asks for it by name/);
  await debriefHidden(page, r);
  // The route the lesson describes: all 1s in the exponent, then clear the fraction. From 0.1 it
  // passes through NaN, and the last flip goes from NaN to infinity, which once ticked nothing.
  await store('0.1');
  const flipTo = async (from, to, want) => {
    for (let i = from; i < to; i++) {
      if ((await page.locator(`${r} [data-fbit="${i}"]`).innerText()).trim() === want) await page.click(`${r} [data-fbit="${i}"]`);
    }
  };
  await flipTo(1, 12, '0');
  await expectText(page, `${r} [data-status]`, /It is NaN now/);
  // WebKit and Firefox would wipe a NaN's fraction if the page read its bits back from the number. 0.1's fraction starts 1001.
  const fractionStart = await page.locator(`${r} .fl-bit.frac`).evaluateAll((all) => all.slice(0, 4).map((b) => b.textContent).join(''));
  if (fractionStart !== '1001') throw new Error(`a NaN's fraction was changed: it starts ${fractionStart}, not 1001`);
  await flipTo(12, 64, '1');
  await expectText(page, `${r} [data-kind]`, /Infinity/);
  await expectText(page, `${r} [data-status]`, /It is infinity now/);
  await debriefShows(page, r);
  await store('1e309');
  await expectText(page, `${r} [data-kind]`, /Infinity/);
  await expectText(page, `${r} [data-status]`, /outside what 64 bits can hold/);
  // The edge of the edge: nothing beyond infinity, and back down to the largest number.
  await page.click(`${r} [data-next="up"]`);
  await expectText(page, `${r} [data-status]`, /end of the line/);
  await page.click(`${r} [data-next="down"]`);
  await expectText(page, `${r} [data-repr]`, /1\.7976931348623157e\+308/);
  const c = mission('comp-float-close');
  await page.locator(c).scrollIntoViewIfNeeded();
  await page.click(`${c} [data-run]`);
  await expectText(page, `${c} [data-out]`, /^False/);
  // A fixed tolerance looks right and isn't.
  await setCode(page, c, 'print(False)\ndef close(a, b):\n    return abs(a - b) < 1e-9\n\ndef split(cents, people):\n    return [cents // people] * people\n');
  await page.click(`${c} [data-run]`);
  await expectText(page, `${c} .m-steps li.current .m-why`, /returned False; expected True|returned True; expected False/);
  await setCode(page, c, 'print(False)\ndef close(a, b):\n    return abs(a - b) <= 1e-9 * max(abs(a), abs(b))\n\ndef split(cents, people):\n    return [cents // people] * people\n');
  await page.click(`${c} [data-run]`);
  await expectText(page, `${c} .m-steps li.current .m-why`, /went missing/);
  await setCode(page, c, 'print(False)\ndef close(a, b):\n    return abs(a - b) <= 1e-9 * max(abs(a), abs(b))\n\ndef split(cents, people):\n    each = cents // people\n    extra = cents % people\n    return [each + 1 if i < extra else each for i in range(people)]\n');
  await page.click(`${c} [data-run]`);
  await debriefShows(page, c);
});

await scenario('comp-text-lab', '/learn/computer/text-and-images-as-bytes/', async (page) => {
  const r = '[data-textbytes]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await expectText(page, `${r} [data-count]`, /4 code points, 5 bytes/);
  await expectText(page, `${r} [data-rows]`, /U\+00E9\s+233\s+C3 A9/);
  const type = async (t) => { await page.locator(`${r} [data-text]`).fill(t); };
  const read = async (enc) => { await page.selectOption(`${r} [data-encoding]`, enc); };
  await page.click(`${r} [data-repair]`);
  await expectText(page, `${r} [data-repaired]`, /Nothing here is garbled/);
  await type('€');
  await expectText(page, `${r} [data-count]`, /1 code point, 3 bytes/);
  // One flag on screen, and two code points: this once read "2 characters".
  await type('\u{1F1EC}\u{1F1E7}');
  await expectText(page, `${r} [data-count]`, /2 code points, 8 bytes/);
  await type('Café');
  await read('cp1252');
  await expectText(page, `${r} [data-result]`, /CafÃ©/);
  await type('Cafe');
  await expectText(page, `${r} [data-result]`, /same/);
  await type('Café');
  await page.click(`${r} [data-repair]`);
  await expectText(page, `${r} [data-repaired]`, /Café\. Identical to the original/);
  await debriefHidden(page, r);
  await type('Á');
  await expectText(page, `${r} [data-result]`, /replaced with the character/);
  await page.click(`${r} [data-repair]`);
  await expectText(page, `${r} [data-repaired]`, /Can't be repaired.*replacement character/);
  await debriefShows(page, r);

  const p = '[data-pixellab]';
  await page.locator(p).scrollIntoViewIfNeeded();
  await expectText(page, `${p} [data-status]`, /^192 bytes read as 64 pixels, 8 wide and 8 tall\.$/);
  await expectText(page, `${p} [data-at]`, /Row 0, column 0 starts at byte 0/);
  await page.locator(`${p} [data-width]`).fill('99');
  await expectText(page, `${p} [data-status]`, /whole number from 1 to 24/);
  await page.locator(`${p} [data-width]`).fill('7');
  await expectText(page, `${p} [data-status]`, /64 pixels, 7 wide and 10 tall: the last row is short, with 1 pixel\. That changed the reading, and not one byte/);
  await page.click(`${p} [data-paint]`);
  await expectText(page, `${p} [data-at]`, /Put the settings right/);
  await expectText(page, `${p} [data-status]`, /Nothing was painted, so not one byte changed/);
  await page.selectOption(`${p} [data-channels]`, '1');
  await expectText(page, `${p} [data-status]`, /192 pixels/);
  await page.selectOption(`${p} [data-channels]`, '3');
  await page.selectOption(`${p} [data-offset]`, '1');
  await expectText(page, `${p} [data-status]`, /2 bytes left over/);
  await debriefHidden(page, p);
  await page.selectOption(`${p} [data-offset]`, '0');
  await page.locator(`${p} [data-width]`).fill('8');
  await page.selectOption(`${p} [data-row]`, '1');
  await page.selectOption(`${p} [data-col]`, '2');
  await expectText(page, `${p} [data-at]`, /starts at byte 30/);
  await page.click(`${p} [data-paint]`);
  await expectText(page, `${p} [data-at]`, /FF 00 00/);
  // The status once said "The bytes have not changed" right here, above the three that just had.
  await expectText(page, `${p} [data-status]`, /Painting wrote bytes 30, 31 and 32: F5 F5 F5 became FF 00 00\. The other 189 bytes are as they were/);
  await debriefShows(page, p);
  await page.click(`${p} [data-paint]`);
  await expectText(page, `${p} [data-status]`, /already held FF 00 00, so no byte changed/);

  const c = mission('comp-text-utf8');
  await page.locator(c).scrollIntoViewIfNeeded();
  await page.click(`${c} [data-run]`);
  await expectText(page, `${c} [data-out]`, /233 8364 128512/);
  await setCode(page, c, 'print(128512)\ndef utf8_len(text):\n    return len(text)\n\ndef utf8_bytes(ch):\n    return [ord(ch)]\n');
  await page.click(`${c} [data-run]`);
  await expectText(page, `${c} .m-steps li.current .m-why`, /returned 1; expected 2/);
  await setCode(page, c, 'print(128512)\ndef utf8_bytes(ch):\n    n = ord(ch)\n    if n < 128:\n        return [n]\n    if n < 2048:\n        return [192 + n // 64, 128 + n % 64]\n    if n < 65536:\n        return [224 + n // 4096, 128 + (n // 64) % 64, 128 + n % 64]\n    return [240 + n // 262144, 128 + (n // 4096) % 64, 128 + (n // 64) % 64, 128 + n % 64]\n\ndef utf8_len(text):\n    total = 0\n    for c in text:\n        total = total + len(utf8_bytes(c))\n    return total\n');
  await page.click(`${c} [data-run]`);
  await debriefShows(page, c);
});

// Parts are added and wired the way a person does it, through the selects.
const addPart = async (page, r, part, ...wires) => {
  await page.click(`${r} [data-shelf] [data-add="${part}"]`);
  const row = page.locator(`${r} [data-gates] .ll-gate`).last();
  for (let i = 0; i < wires.length; i++) await row.locator(`select[data-pin="${i}"]`).selectOption(wires[i]);
};
const output = (page, r, name, from) => page.locator(`${r} [data-output-select="${name}"]`).selectOption(from);

await scenario('comp-logic-gates', '/learn/computer/gates/', async (page) => {
  const r = '[data-logiclab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await expectText(page, `${r} [data-verdict]`, /Right on all 4/);
  await expectText(page, `${r} [data-output-value="out"]`, /^1$/);
  // Wiring the output to "always 0" shows a 0, and shows nothing about the gate.
  await output(page, r, 'out', '0');
  await expectText(page, `${r} [data-verdict]`, /Wrong on 3 of 4/);
  if (await page.locator(`${r} .m-steps li.done`).count()) throw new Error('a constant 0 ticked the NAND step');
  await output(page, r, 'out', 'g1');
  await page.click(`${r} [data-switch="a"]`);
  await page.click(`${r} [data-switch="b"]`);
  await expectText(page, `${r} [data-output-value="out"]`, /^0$/);
  await page.click(`${r} [data-puzzle="not"]`);
  // Nothing wired is refused by name, not read as a wrong answer or as 0.
  await expectText(page, `${r} [data-verdict]`, /Not finished: Output out isn't connected/);
  await output(page, r, 'out', 'a');
  await expectText(page, `${r} [data-verdict]`, /Wrong on 2 of 2/);
  await addPart(page, r, 'NAND', 'a');
  await expectText(page, `${r} [data-verdict]`, /Input b of g1 isn't connected/);
  await page.locator(`${r} [data-gate="g1"] select[data-pin="1"]`).selectOption('a');
  await expectText(page, `${r} [data-verdict]`, /Wrong on 2 of 2/);
  await output(page, r, 'out', 'g1');
  await expectText(page, `${r} [data-verdict]`, /Right on all 2/);
  // A loop is refused here, with the reason.
  await page.locator(`${r} [data-gate="g1"] select[data-pin="1"]`).selectOption('g1');
  await expectText(page, `${r} [data-verdict]`, /loops back/);
  await page.locator(`${r} [data-gate="g1"] select[data-pin="1"]`).selectOption('1');
  await expectText(page, `${r} [data-verdict]`, /Right on all 2/);

  await page.click(`${r} [data-puzzle="and"]`);
  await addPart(page, r, 'NAND', 'a', 'b');
  await addPart(page, r, 'NOT', 'g1');
  await output(page, r, 'out', 'g2');
  await expectText(page, `${r} [data-verdict]`, /Right on all 4/);
  await page.click(`${r} [data-puzzle="or"]`);
  await addPart(page, r, 'NOT', 'a');
  await addPart(page, r, 'NOT', 'b');
  await addPart(page, r, 'NAND', 'g1', 'g2');
  await output(page, r, 'out', 'g3');
  await expectText(page, `${r} [data-verdict]`, /Right on all 4/);
  await expectText(page, `${r} [data-counts]`, /3 NANDs underneath/);
  // Removing a part unwires what read it, rather than leaving it wired to something else.
  await page.click(`${r} [data-remove="g2"]`);
  await expectText(page, `${r} [data-verdict]`, /Input b of g3 isn't connected/);
  await addPart(page, r, 'NOT', 'b');
  await page.locator(`${r} [data-gate="g3"] select[data-pin="1"]`).selectOption('g2');
  await expectText(page, `${r} [data-verdict]`, /Right on all 4/);
  await page.click(`${r} [data-puzzle="xor"]`);
  await addPart(page, r, 'OR', 'a', 'b');
  await addPart(page, r, 'NAND', 'a', 'b');
  await addPart(page, r, 'AND', 'g1', 'g2');
  await output(page, r, 'out', 'g1');
  await expectText(page, `${r} [data-verdict]`, /Wrong on 1 of 4/);
  await expectText(page, `${r} [data-table] tr.bad`, /wrong/);
  await output(page, r, 'out', 'g3');
  await expectText(page, `${r} [data-verdict]`, /Right on all 4/);
  await debriefHidden(page, r);
  await page.click(`${r} [data-puzzle="mux"]`);
  await addPart(page, r, 'NOT', 'sel');
  await addPart(page, r, 'AND', 'a', 'g1');
  await addPart(page, r, 'AND', 'b', 'sel');
  await addPart(page, r, 'OR', 'g2', 'g3');
  await output(page, r, 'out', 'g4');
  await expectText(page, `${r} [data-verdict]`, /Right on all 8/);
  await debriefShows(page, r);
  // Going back to break a solved puzzle doesn't untick it, and starting over works.
  await page.click(`${r} [data-puzzle="not"]`);
  await page.click(`${r} [data-reset]`);
  await expectText(page, `${r} [data-verdict]`, /Output out isn't connected/);
  await debriefShows(page, r);
});

await scenario('comp-logic-adder', '/learn/computer/adder/', async (page) => {
  const r = '[data-logiclab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await addPart(page, r, 'OR', 'a', 'b');
  await addPart(page, r, 'AND', 'a', 'b');
  await output(page, r, 'sum', 'g1');
  await output(page, r, 'carry', 'g2');
  await expectText(page, `${r} [data-verdict]`, /Wrong on 1 of 4/);
  await page.locator(`${r} [data-gate="g1"]`).locator('[data-remove]').click();
  await addPart(page, r, 'XOR', 'a', 'b');
  await output(page, r, 'sum', 'g1');
  await expectText(page, `${r} [data-verdict]`, /Right on all 4/);

  await page.click(`${r} [data-puzzle="full"]`);
  await addPart(page, r, 'HALF', 'a', 'b');
  await addPart(page, r, 'HALF', 'g1.sum', 'cin');
  await addPart(page, r, 'OR', 'g1.carry', 'g2.carry');
  await output(page, r, 'sum', 'g2.sum');
  await output(page, r, 'carry', 'g3');
  await expectText(page, `${r} [data-verdict]`, /Right on all 8/);

  await page.click(`${r} [data-puzzle="add4"]`);
  await expectText(page, `${r} [data-verdict]`, /Output s1 isn't connected/);
  await addPart(page, r, 'FULL', 'a1', 'b1', 'g1.carry');
  await addPart(page, r, 'FULL', 'a2', 'b2', 'g2.carry');
  await addPart(page, r, 'FULL', 'a3', 'b3', 'g3.carry');
  await output(page, r, 's1', 'g2.sum');
  await output(page, r, 's2', 'g3.sum');
  await output(page, r, 's3', 'g4.sum');
  await output(page, r, 'carry', '0');
  // Right on every sum that fits, wrong on the 120 that don't: a small test would miss it.
  await expectText(page, `${r} [data-verdict]`, /Wrong on 120 of 256/);
  await expectText(page, `${r} [data-table] li`, /a = 8, b = 8: wants s = 0, carry = 1, yours gives s = 0, carry = 0/);
  await output(page, r, 'carry', 'g4.carry');
  await expectText(page, `${r} [data-verdict]`, /Right on all 256/);
  await expectText(page, `${r} [data-counts]`, /60 NANDs underneath, a change settles within 16 gate delays/);

  // Watch it settle: a carry running up through all four columns.
  for (const s of ['a0', 'a1', 'a2', 'a3']) await page.click(`${r} [data-switch="${s}"]`);
  await page.check(`${r} [data-slow]`);
  await page.click(`${r} [data-switch="b0"]`);
  await expectText(page, `${r} [data-delay-note]`, /nothing else has yet/);
  await expectText(page, `${r} [data-output-value="carry"]`, /^0$/);
  let settled = false;
  for (let i = 0; i < 40 && !settled; i++) {
    await page.click(`${r} [data-delay]`);
    settled = /Settled after/.test(await page.locator(`${r} [data-delay-note]`).innerText());
  }
  if (!settled) throw new Error('never settled');
  // The panel above and this note must give one number: they once said 19 and 16.
  await expectText(page, `${r} [data-delay-note]`, /Settled after 16 gate delays/);
  await expectText(page, `${r} [data-output-value="carry"]`, /^1$/);
  await page.uncheck(`${r} [data-slow]`);
  await debriefHidden(page, r);

  await page.click(`${r} [data-puzzle="addsub"]`);
  for (let i = 0; i < 4; i++) await addPart(page, r, 'XOR', `b${i}`, 'sub');
  await addPart(page, r, 'FULL', 'a0', 'g1', 'sub');
  await addPart(page, r, 'FULL', 'a1', 'g2', 'g5.carry');
  await addPart(page, r, 'FULL', 'a2', 'g3', 'g6.carry');
  await addPart(page, r, 'FULL', 'a3', 'g4', 'g7.carry');
  for (let i = 0; i < 4; i++) await output(page, r, `s${i}`, `g${5 + i}.sum`);
  await expectText(page, `${r} [data-verdict]`, /Right on all 512/);
  await debriefShows(page, r);
});

// ---- How a Machine Computes: the machine, the clock, the pipeline, the cache ----
const machineLab = (id) => `[data-machine-lab][data-mission="${id}"]`;
const machineRun = async (page, r, src) => {
  if (await page.locator(`${r} [data-edit-btn]`).isVisible()) await page.click(`${r} [data-edit-btn]`);
  if (src !== undefined) await page.locator(`${r} [data-src]`).fill(src);
  await page.click(`${r} [data-run]`);
};
const ticked = (page, r) => page.locator(`${r} .m-steps li.done`).count();
const waitTicks = (page, r, n) => page.waitForFunction(([sel, want]) => document.querySelectorAll(`${sel} .m-steps li.done`).length === want, [r, n]);

await scenario('clock-lab', '/learn/computer/clocks-and-memory/', async (page) => {
  const r = '[data-clock-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  // The latch remembers with nothing pressed, and both-at-once is reported, not hidden.
  await page.click(`${r} [data-sr="set"]`);
  await expectText(page, `${r} [data-q]`, /^1$/);
  await page.click(`${r} [data-sr="release"]`);
  await expectText(page, `${r} [data-q]`, /^1$/);
  await expectText(page, `${r} [data-sr-note]`, /still 1/);
  await waitTicks(page, r, 1);
  await page.click(`${r} [data-sr="both"]`);
  await page.click(`${r} [data-sr="release"]`);
  await expectText(page, `${r} [data-sr-note]`, /never settles/);
  // The bench: raising the clock and changing D moves the latch and not the flip-flop.
  await page.click(`${r} [data-raise]`);
  await page.click(`${r} [data-flip-d]`);
  await expectText(page, `${r} [data-e="latchQ"]`, /^1$/);
  await expectText(page, `${r} [data-e="ffQ"]`, /^0$/);
  await waitTicks(page, r, 2);
  if (!(await page.locator(`${r} [data-edge-wave] svg path`).count())) throw new Error('the bench drew no waveform');
  const run = async (p) => { await page.locator(`${r} [data-period]`).fill(String(p)); await page.click(`${r} [data-run-counter]`); };
  await run(30);
  await expectText(page, `${r} [data-verdict]`, /Every read was right at 30/);
  await waitTicks(page, r, 3);
  // Failure case: one delay under the limit, with the exact wrong reading from the model.
  await debriefHidden(page, r);
  await run(12);
  await expectText(page, `${r} [data-verdict]`, /Wrong at 12.*After 6 it should read 7, and it read 15.*2 of these 17 reads are wrong.*nothing checks/);
  if (await page.locator(`${r} [data-reads] li.wrong`).count() < 1) throw new Error('no read is marked wrong at period 12');
  await debriefHidden(page, r);
  await run(13);
  await expectText(page, `${r} [data-verdict]`, /Every read was right at 13/);
  await debriefShows(page, r);
  if (!(await page.locator(`${r} [data-wave] svg path`).count())) throw new Error('the counter drew no waveform');
  const code = page.locator('[data-codelab]').first();
  await code.locator('[data-run]').click();
  await expectText(page, '[data-codelab] [data-out]', /4 green/);
});

await scenario('machine-lab-fetch', '/learn/computer/toy-cpu/', async (page) => {
  const r = machineLab('cpu-count-up');
  await page.locator(r).scrollIntoViewIfNeeded();
  // Step shows what it decoded, and the panel follows the real registers.
  await page.click(`${r} [data-step]`);
  await expectText(page, `${r} [data-status]`, /nothing has run yet/);
  await page.click(`${r} [data-step]`);
  await expectText(page, `${r} [data-decode]`, /addi t0, zero, 0/);
  await expectText(page, `${r} [data-fetch]`, /0x0000/);
  if ((await page.locator(`${r} [data-bits] .ml-field`).count()) !== 5) throw new Error('the decode panel does not show an I-format word');
  for (let i = 0; i < 40 && (await ticked(page, r)) < 1; i++) await page.click(`${r} [data-step]`);
  await waitTicks(page, r, 1);
  await expectText(page, `${r} [data-pc]`, /0x00/);
  // Back to editing, and a run from the top on the visible input: the starter's off-by-one, 10 and not 15.
  await machineRun(page, r);
  await expectText(page, `${r} [data-reg="10"]`, /a0\s*10/);
  // A shortcut for the visible answer must not pass, and it has to say why.
  await machineRun(page, r, 'li a0, 15\nebreak\n');
  await expectText(page, `${r} [data-reg="10"]`, /15/);
  await expectText(page, `${r} .m-why:not([hidden])`, /you can't see/);
  if ((await ticked(page, r)) !== 1) throw new Error('hard-coding 15 ticked a step');
  // Invalid program: refused with the line number, and no run.
  await machineRun(page, r, 'li a0, 1\nfrobnicate a0\n');
  await expectText(page, `${r} [data-errors]`, /Line 2:.*frobnicate/);
  await expectText(page, `${r} [data-status]`, /didn't assemble/);
  // Runaway: stops at the budget, with buttons restored.
  await machineRun(page, r, 'spin:\n  j spin\n');
  await expectText(page, `${r} [data-status]`, /Line 2: stopped after 200,000 steps/);
  // A wild jump and an empty box each say what really happened.
  await machineRun(page, r, 'li t0, 0x3000\njr t0\n');
  await expectText(page, `${r} [data-status]`, /Line 2: jumped to 0x3000, where nothing has been written/);
  await machineRun(page, r, '# nothing\n');
  await expectText(page, `${r} [data-status]`, /no instructions/);
  if (await page.locator(`${r} [data-run]`).isDisabled()) throw new Error('Run stays disabled after the budget');
  // Bad inputs are refused rather than ignored.
  await page.locator(`${r} [data-inputs]`).fill('q9=1');
  await machineRun(page, r);
  await expectText(page, `${r} [data-status]`, /"q9" isn't a register/);
  await page.locator(`${r} [data-inputs]`).fill('a0=5');
  // Play it to the end with a real solution.
  const fixed = (await page.locator(`${r} [data-reset]`).click(), await page.locator(`${r} [data-src]`).inputValue()).replace('bge t1, a0, done', 'bgt t1, a0, done');
  await machineRun(page, r, fixed);
  await expectText(page, `${r} [data-reg="10"]`, /15/);
  await waitTicks(page, r, 2);
  await debriefHidden(page, r);
  await machineRun(page, r, fixed.replace('    mv a0, t0\n', '    mv a0, t0\n    la t2, total\n    sw t0, 0(t2)\n'));
  await debriefShows(page, r);
  await expectText(page, `${r} [data-data]`, /15/);
  // The patch sample: a0 ends as 42, from a line that says nop.
  const first = '[data-machine-lab] >> nth=0';
  await page.locator(first).locator('[data-run]').click();
  await expect42(page);
});
async function expect42(page) {
  const text = await page.locator('[data-machine-lab]').first().locator('[data-reg="10"]').innerText();
  if (!/42/.test(text)) throw new Error(`the patched nop left a0 as ${text}`);
}

await scenario('machine-lab-calls', '/learn/computer/assembly/', async (page) => {
  const r = machineLab('asm-calls');
  await page.locator(r).scrollIntoViewIfNeeded();
  const start = await page.locator(`${r} [data-src]`).inputValue();
  await machineRun(page, r);
  await expectText(page, `${r} [data-status]`, /stopped after 200,000 steps/);
  await waitTicks(page, r, 1);
  // A fix that saves ra and not s0 still fails, and the reason names the input.
  const sumTo = `sum_to:
    beqz a0, base
    addi sp, sp, -16
    sw ra, 12(sp)
    sw s0, 8(sp)
    mv s0, a0
    addi a0, a0, -1
    call sum_to
    add a0, a0, s0
    lw s0, 8(sp)
    lw ra, 12(sp)
    addi sp, sp, 16
    ret
base:
    ret
`;
  const main = start.slice(0, start.indexOf('# sum_to(n)'));
  const noS0 = sumTo.replace('    sw s0, 8(sp)\n', '').replace('    lw s0, 8(sp)\n', '');
  await machineRun(page, r, `${main}${noS0}\nfib:\n    ret\n`);
  await expectText(page, `${r} .m-why:not([hidden])`, /sum_to\(\d+\)/);
  // An 8-byte frame gets the right answer and breaks the convention, and it's told which rule.
  await machineRun(page, r, `${main}${sumTo.replaceAll('-16', '-8').replaceAll('sp, sp, 16', 'sp, sp, 8').replaceAll('12(sp)', '4(sp)').replaceAll('8(sp)', '0(sp)')}\nfib:\n    ret\n`);
  await expectText(page, `${r} .m-why:not([hidden])`, /isn't a multiple of 16/);
  await machineRun(page, r, `${main}${sumTo}\nfib:\n    ret\n`);
  await expectText(page, `${r} [data-reg="10"]`, /10/);
  await waitTicks(page, r, 2);
  await debriefHidden(page, r);
  const fib = `fib:
    li t0, 2
    blt a0, t0, small
    addi sp, sp, -16
    sw ra, 12(sp)
    sw s0, 8(sp)
    sw s1, 4(sp)
    mv s0, a0
    addi a0, s0, -1
    call fib
    mv s1, a0
    addi a0, s0, -2
    call fib
    add a0, a0, s1
    lw s1, 4(sp)
    lw s0, 8(sp)
    lw ra, 12(sp)
    addi sp, sp, 16
small:
    ret
`;
  await machineRun(page, r, `${main}${sumTo}\n${fib}`);
  await debriefShows(page, r);
  // Stepping into a call shows the saved return address on the stack panel.
  await page.click(`${r} [data-edit-btn]`).catch(() => {});
  await page.click(`${r} [data-step]`);
  for (let i = 0; i < 8; i++) await page.click(`${r} [data-step]`);
  await expectText(page, `${r} [data-stack]`, /a return to line/);
  await expectText(page, `${r} [data-frames]`, /sum_to/);
  await page.click(`${r} [data-edit-btn]`);
  // The stack smash: three words comes back, and a fourth takes over the return.
  const smash = page.locator('[data-machine-lab]', { hasText: 'Machine lab' }).filter({ has: page.locator('[data-inputs][value="a1=3"]') });
  await smash.locator('[data-run]').click();
  if ((await smash.locator('[data-out]').innerText()).trim() !== 'K') throw new Error('copy with 3 words did not come back');
  await smash.locator('[data-inputs]').fill('a1=4');
  await smash.locator('[data-run]').click();
  if ((await smash.locator('[data-out]').innerText()).trim() !== 'X') throw new Error('a fourth word did not take over the return');
  // Reset puts the whole lab back: it used to leave a1=4 in the box, so the "as it is" run printed X.
  await smash.locator('[data-reset]').click();
  if ((await smash.locator('[data-inputs]').inputValue()) !== 'a1=3') throw new Error('Reset left the changed input in the box');
  if ((await smash.locator('[data-out]').innerText()).trim() !== '') throw new Error('Reset left the old output on screen');
  if (!/Nothing here yet/.test(await smash.locator('[data-data]').innerText())) throw new Error('Reset left the old data on screen');
  if (!/0xffff/.test(await smash.locator('[data-reg="1"]').innerText())) throw new Error('Reset left the old ra on screen');
  await smash.locator('[data-run]').click();
  if ((await smash.locator('[data-out]').innerText()).trim() !== 'K') throw new Error('after Reset, the run as it was did not print K');
  // The stack overflow reports its line and its depth.
  const runaway = page.locator('[data-machine-lab]').nth(3);
  await runaway.locator('[data-run]').click();
  const status = await runaway.locator('[data-status]').innerText();
  if (!/guard area/.test(status) || !/Line 4/.test(status)) throw new Error(`stack overflow reported: ${status}`);
  if (!/2,048 calls deep/.test(await runaway.locator('[data-frames]').innerText())) throw new Error('the depth of the overflow is not shown');
});

await scenario('pipeline-lab', '/learn/computer/pipelining/', async (page) => {
  const r = '[data-pipe-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const cycles = async () => Number((await page.locator(`${r} [data-s="cycles"]`).innerText()).replace(/,/g, ''));
  const run = () => page.click(`${r} [data-run]`);
  // The exact counts from the reference, through the real page.
  await page.selectOption(`${r} [data-forwarding]`, 'off');
  await run();
  if (await cycles() !== 15) throw new Error(`chain with no forwarding: ${await cycles()} cycles, the model says 15`);
  await debriefHidden(page, r);
  await page.selectOption(`${r} [data-forwarding]`, 'on');
  await run();
  if (await cycles() !== 9) throw new Error(`chain with forwarding: ${await cycles()} cycles, the model says 9`);
  await waitTicks(page, r, 1);
  // Failure case: with no hazard handling the same program gives a wrong answer and no error.
  await page.click(`${r} [data-unprotected]`);
  await expectText(page, `${r} [data-status]`, /a0 is 1, and should be 8/);
  // Registers that all match don't clear a stale store or a stale print. This used to say "happens to come out right".
  const chainSrc = await page.locator(`${r} [data-src]`).inputValue();
  await page.locator(`${r} [data-src]`).fill('li t0, 7\nli t1, 0x2000\nsw t0, 0(t1)\nebreak\n');
  await page.click(`${r} [data-unprotected]`);
  await expectText(page, `${r} [data-status]`, /the word at 0x2000 is 0x00000000, and should be 0x00000007.*registers all match/);
  await page.locator(`${r} [data-src]`).fill("li t1, 0x10000000\nnop\nnop\nli t0, 'A'\nsb t0, 0(t1)\nebreak\n");
  await page.click(`${r} [data-unprotected]`);
  await expectText(page, `${r} [data-status]`, /it printed "\\0", and should have printed "A"/);
  await page.locator(`${r} [data-src]`).fill('li t0, 5\nnop\nnop\nli t1, 1\nnop\nnop\nebreak\n');
  await page.click(`${r} [data-unprotected]`);
  await expectText(page, `${r} [data-status]`, /ended the same in everything compared here: registers, all of memory, what it printed, and where it stopped/);
  await page.locator(`${r} [data-src]`).fill(chainSrc);
  // The diagram really draws, stalls included.
  await page.selectOption(`${r} [data-forwarding]`, 'off');
  await run();
  if (await page.locator(`${r} td.stall`).count() !== 6) throw new Error('the diagram does not show the 6 stalls');
  await page.selectOption(`${r} [data-forwarding]`, 'on');
  // The reorder: a shortcut fails on hidden values, a nop doesn't save a cycle, a reorder passes.
  await page.selectOption(`${r} [data-program]`, 'reorder');
  await run();
  if (await cycles() !== 14) throw new Error(`reorder starter: ${await cycles()} cycles`);
  await expectText(page, `${r} .m-why:not([hidden])`, /14 cycles/);
  await page.locator(`${r} [data-src]`).fill('li t0, 30\nsw t0, 12(a0)\nli t0, 40\nsw t0, 16(a0)\nebreak\n');
  await run();
  await expectText(page, `${r} .m-why:not([hidden])`, /values you can't see/);
  if ((await ticked(page, r)) !== 1) throw new Error('hard-coding the visible answers ticked the reorder step');
  await page.locator(`${r} [data-src]`).fill('lw t1, 0(a0)\nlw t2, 4(a0)\nlw t4, 8(a0)\nadd t3, t1, t2\nsw t3, 12(a0)\nadd t5, t1, t4\nsw t5, 16(a0)\nebreak\n');
  await run();
  if (await cycles() !== 12) throw new Error(`reordered: ${await cycles()} cycles`);
  await waitTicks(page, r, 2);
  await debriefHidden(page, r);
  // Refused, with a line.
  await page.locator(`${r} [data-src]`).fill('frob\n');
  await run();
  await expectText(page, `${r} [data-status]`, /Line 1:.*frob/);
  await page.selectOption(`${r} [data-program]`, 'loop');
  await page.selectOption(`${r} [data-predictor]`, 'two-bit');
  await page.selectOption(`${r} [data-order]`, 'shuffled');
  await run();
  if (await cycles() !== 1938) throw new Error(`shuffled, two-bit: ${await cycles()} cycles`);
  await debriefHidden(page, r);
  await page.selectOption(`${r} [data-order]`, 'sorted');
  await run();
  if (await cycles() !== 1690) throw new Error(`sorted, two-bit: ${await cycles()} cycles`);
  await debriefShows(page, r);
  // Your machine: filled in with numbers, and judged by nothing.
  await page.locator(`${r} [data-machine]`).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-machine-run]`);
  await expectText(page, `${r} [data-machine-status]`, /One run, on this device/, 120000);
});

await scenario('cache-lab', '/learn/computer/caches/', async (page) => {
  const r = '[data-cache-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  const set = (k, v) => page.selectOption(`${r} [data-${k}]`, v);
  const run = async (pattern) => { await set('pattern', pattern); await page.click(`${r} [data-run]`); };
  const stat = async (k) => Number((await page.locator(`${r} [data-s="${k}"]`).innerText()).replace(/,/g, ''));
  await run('rows');
  if (await stat('misses') !== 8192) throw new Error(`rows: ${await stat('misses')} misses, the model says 8,192`);
  await run('cols');
  if (await stat('misses') !== 131072) throw new Error(`columns: ${await stat('misses')} misses, the model says 131,072`);
  if (await stat('conflict') !== 122880) throw new Error(`columns: ${await stat('conflict')} conflict misses`);
  await waitTicks(page, r, 1);
  await expectText(page, `${r} [data-s="amat"]`, /100\.50 ns/);
  // Failure case: a cache too small for the matrix doesn't tick the step about fitting.
  await set('size', '65536');
  await run('cols');
  if ((await ticked(page, r)) !== 1) throw new Error('a cache too small ticked the fitting step');
  await set('size', '262144');
  await run('cols');
  if (await stat('capacity') !== 0 || await stat('conflict') !== 0) throw new Error('a cache that fits still shows capacity or conflict misses');
  await waitTicks(page, r, 2);
  await set('size', '32768');
  await set('side', '64');
  await set('ways', '1');
  await run('two-arrays');
  if (await stat('conflict') !== 7936) throw new Error(`two arrays, direct-mapped: ${await stat('conflict')} conflict misses`);
  await set('ways', '2');
  await run('two-arrays');
  if (await stat('conflict') !== 0) throw new Error('two ways did not clear the conflict misses');
  await waitTicks(page, r, 3);
  await debriefHidden(page, r);
  await set('side', '256');
  await set('passes', '1');
  await set('ways', '8');
  await run('walk-order');
  await set('prefetch', 'on');
  await run('walk-order');
  if (await stat('misses') !== 2048) throw new Error(`prefetched walk: ${await stat('misses')} misses`);
  await run('walk-scattered');
  if (await stat('misses') !== 57517) throw new Error(`prefetched scattered walk: ${await stat('misses')} misses`);
  await set('prefetch', 'off');
  await run('walk-scattered');
  await debriefShows(page, r);
  // A nonsense address is refused, and a good one is cut into its parts.
  await page.locator(`${r} [data-addr]`).fill('nonsense');
  await expectText(page, `${r} [data-split]`, /isn't an address/);
  await page.locator(`${r} [data-addr]`).fill('0x12345');
  await expectText(page, `${r} [data-split]`, /byte 5 in the line.*set 13/);
  // A fully associative choice with a size the select offers still works.
  await set('ways', 'full');
  await set('prefetch', 'off');
  await set('passes', '2');
  await run('cols');
  if (await stat('conflict') !== 0) throw new Error('a fully associative cache has conflict misses');
  // The same with oldest-in, which used to show them, and the page says what it judged against.
  await set('policy', 'fifo');
  await set('side', '128');
  await run('walk-scattered');
  if (await stat('conflict') !== 0) throw new Error('a fully associative oldest-in cache has conflict misses');
  await expectText(page, `${r} [data-status]`, /also throws out the oldest in/);
  await set('policy', 'lru');
  await set('side', '256');
  // Two arrays at this size run into each other, and the page says so rather than call them two arrays.
  await set('ways', '8');
  await set('size', '32768');
  await run('two-arrays');
  await expectText(page, `${r} [data-status]`, /the two arrays overlap/);
  await set('ways', 'full');
  // The learner's own simulator, in the code lab: a shortcut fails, a real one passes.
  const lab = mission('computer-cache-sim');
  await page.locator(lab).scrollIntoViewIfNeeded();
  await setCode(page, lab, 'def count_misses(addresses, lines, line_size):\n    seen = set()\n    for a in addresses:\n        seen.add(a // line_size)\n    return len(seen)\n');
  await page.click(`${lab} [data-run]`);
  await expectText(page, `${lab} .m-why:not([hidden])`, /expected/);
  await setCode(page, lab, 'def count_misses(addresses, lines, line_size):\n    cache = [None] * lines\n    misses = 0\n    for address in addresses:\n        line = address // line_size\n        if cache[line % lines] != line:\n            misses += 1\n            cache[line % lines] = line\n    return misses\n\ndef count_misses_lru(addresses, lines, line_size):\n    cache = []\n    misses = 0\n    for address in addresses:\n        line = address // line_size\n        if line in cache:\n            cache.remove(line)\n        else:\n            misses += 1\n            if len(cache) == lines:\n                cache.pop(0)\n        cache.append(line)\n    return misses\n');
  await page.click(`${lab} [data-run]`);
  await debriefShows(page, lab);
  // Your machine: filled in with numbers, and judged by nothing. No ratio is checked.
  await page.locator(`${r} [data-machine]`).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-machine-run]`);
  await expectText(page, `${r} [data-machine-status]`, /(^Done\. One run|^Stopped: this browser refused)/, 240000);
  if (!(await page.locator(`${r} [data-machine-rows] tr`).count())) throw new Error('the machine panel shows no rows');
});

await scenario('latency-lab', '/learn/computer/latency-numbers/', async (page) => {
  const r = '[data-latency-lab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  // Every row has a source link and a date, on the page.
  const rows = page.locator(`${r} [data-row]`);
  if (await rows.count() !== 13) throw new Error(`${await rows.count()} rows`);
  if (await page.locator(`${r} [data-row] .lt-src a`).count() !== 13) throw new Error('a row has no source link');
  await expectText(page, `${r} [data-row="coast"]`, /69 ms[\s\S]*30 days to 2026-07-30/);
  await expectText(page, `${r} [data-row="mem"] [data-scaled]`, /3\.33 minutes/);
  await page.selectOption(`${r} [data-unit]`, '100');
  await expectText(page, `${r} [data-row="l1"] [data-scaled]`, /less than a second/);
  await expectText(page, `${r} [data-row="mem"] [data-scaled]`, /1 second/);
  const plan = async (writes, place, batch) => {
    await page.locator(`${r} [data-writes]`).fill(String(writes));
    await page.selectOption(`${r} [data-place]`, place);
    await page.selectOption(`${r} [data-batch]`, String(batch));
    await page.click(`${r} [data-plan]`);
  };
  await plan(40, 'dc', 1);
  await expectText(page, `${r} [data-verdict]`, /40 round trips.*20 ms/);
  await waitTicks(page, r, 1);
  await plan(40, 'coast', 1);
  await expectText(page, `${r} [data-verdict]`, /2,760 ms.*over 300/);
  await waitTicks(page, r, 2);
  // Failure cases: fewer writes isn't the fix, and nonsense is refused.
  await plan(4, 'coast', 1);
  await expectText(page, `${r} .m-why:not([hidden])`, /36 never happen/);
  await debriefHidden(page, r);
  await plan(-3, 'coast', 1);
  await expectText(page, `${r} [data-verdict]`, /whole number from 0 to 1,000/);
  await plan(40, 'coast', 10);
  await expectText(page, `${r} [data-verdict]`, /4 round trips.*276 ms/);
  await debriefShows(page, r);
});

// ---- computer: compiler to qubits (writer computer-c)
{
  const compile = async (page, r, text) => { await page.fill(`${r} [data-text]`, text); await page.click(`${r} [data-compile]`); };
  const codeMission = async (page, id, src) => {
    const lab = `[data-codelab][data-mission="${id}"]`;
    await page.locator(lab).scrollIntoViewIfNeeded();
    if (src !== undefined) await page.fill(`${lab} [data-src]`, src);
    await page.click(`${lab} [data-run]`);
    return lab;
  };

  const PARSER_FIXED = `def tokens(text):
    out = []
    i = 0
    while i < len(text):
        c = text[i]
        if c == " ":
            i += 1
        elif c.isdigit():
            j = i
            while j < len(text) and text[j].isdigit():
                j += 1
            out.append(int(text[i:j]))
            i = j
        else:
            out.append(c)
            i += 1
    return out

def atom(toks):
    if toks[0] == "(":
        toks.pop(0)
        inner = expr(toks)
        toks.pop(0)
        return inner
    return toks.pop(0)

def term(toks):
    left = atom(toks)
    while len(toks) > 0 and toks[0] in ("*", "/"):
        op = toks.pop(0)
        left = (op, left, atom(toks))
    return left

def expr(toks):
    left = term(toks)
    while len(toks) > 0 and toks[0] in ("+", "-"):
        op = toks.pop(0)
        left = (op, left, term(toks))
    return left

def calc(tree):
    if type(tree) == int:
        return tree
    op, a, b = tree
    a = calc(a)
    b = calc(b)
    return {"+": a + b, "-": a - b, "*": a * b}[op] if op != "/" else a / b

def value(text):
    return calc(expr(tokens(text)))

print(value("10 - 3 - 2"))
`;

  await scenario('compiler-parse-lab', '/learn/computer/tiny-compiler-parse/', async (page) => {
    const r = '[data-complab]';
    await page.locator(r).scrollIntoViewIfNeeded();
    await compile(page, r, '1 + 2 * 3');
    await expectText(page, `${r} [data-brackets]`, /\(1 \+ \(2 \* 3\)\)/);
    await expectText(page, `${r} [data-mine]`, /^7$/);
    await expectText(page, `${r} [data-py]`, /^7$/);
    if (await page.locator(`${r} [data-tree] svg circle`).count() !== 5) throw new Error('the tree did not draw five nodes');
    // The failure case: it says where.
    await compile(page, r, '1 + * 2');
    await expectText(page, `${r} [data-point]`, /1 \+ \* 2\n {4}\^/);
    await compile(page, r, '(1 + 2');
    await expectText(page, `${r} [data-point]`, /never closed/);
    await compile(page, r, '2 ^ 3');
    await expectText(page, `${r} [data-point]`, /\*\*/);
    await expectText(page, `${r} [data-verdict]`, /Refused by name/);
    const mode = (m) => page.selectOption(`${r} [data-mode]`, m);
    await mode('flat');
    await compile(page, r, '1 + 2 * 3');
    await expectText(page, `${r} [data-mine]`, /^9$/);
    await expectText(page, `${r} [data-py]`, /^7$/);
    await expectText(page, `${r} [data-verdict]`, /tree is wrong/);
    await mode('right');
    await compile(page, r, '10 - 3 - 2');
    await expectText(page, `${r} [data-mine]`, /^9$/);
    await expectText(page, `${r} [data-py]`, /^5$/);
    await compile(page, r, '1 + 2 + 3');
    await expectText(page, `${r} [data-verdict]`, /Same answer from the wrong tree/);
    await expectText(page, `${r} .m-debrief`, /The tree is the meaning/);
    await mode('excel');
    await compile(page, r, '-2 ** 2');
    await expectText(page, `${r} [data-mine]`, /^4$/);
    await expectText(page, `${r} [data-py]`, /^-4$/);
    await expectText(page, `${r} [data-verdict]`, /neither program is broken/);
    await expectText(page, `${r} [data-verdict]`, /didn't run in Excel/);
    await expectText(page, `${r} [data-brackets]`, /\(\(-2\) \*\* 2\)/);
    await expectText(page, `${r} [data-excel-note]`, /only the order from Microsoft's table/);
    // The failure this rule shipped with: the minus vanished, and the verdict called it a difference of opinion.
    await compile(page, r, '-5');
    await expectText(page, `${r} [data-mine]`, /^-5$/);
    await compile(page, r, '2 * -3');
    await expectText(page, `${r} [data-mine]`, /^-6$/);
    await expectText(page, `${r} [data-verdict]`, /same tree as Python/);
    await compile(page, r, '-3 ** 3');
    await expectText(page, `${r} [data-mine]`, /^-27$/);
    await compile(page, r, '-2 ^ 2');
    await expectText(page, `${r} [data-point]`, /type \*\* here/);
    await compile(page, r, '7 % 2');
    await expectText(page, `${r} [data-point]`, /percent mark/);
    // One side refused means no second answer to differ from.
    await compile(page, r, '-8 ** 0.5');
    await expectText(page, `${r} [data-verdict]`, /aren't two answers to compare/);
    await mode('correct');
    if (await page.locator(`${r} [data-excel-note]`).isVisible()) throw new Error('the Excel note stayed up on the correct parser');
    // Said only of numbers real Python really reads.
    await compile(page, r, '1_');
    await expectText(page, `${r} [data-point]`, /Real Python refuses 1_ too/);
    await compile(page, r, '1_000');
    await expectText(page, `${r} [data-point]`, /Real Python reads 1_000 as a number/);
    // The arithmetic worked and only the printing failed, and the page has to say which.
    await compile(page, r, '10 ** 4300');
    await expectText(page, `${r} [data-mine]`, /^ValueError$/);
    await expectText(page, `${r} [data-verdict]`, /What failed is printing/);
    // A power too large for the page is refused, never a number.
    await compile(page, r, '9 ** 9 ** 9');
    await expectText(page, `${r} [data-verdict]`, /Refused, and nothing was computed/);
  });

  await scenario('compiler-parse-mission', '/learn/computer/tiny-compiler-parse/', async (page) => {
    const lab = await codeMission(page, 'comp-parse-fix');
    await expectText(page, `${lab} [data-out]`, /\('-', 10, \('-', 3, 2\)\)\s+9/);
    await codeMission(page, 'comp-parse-fix', PARSER_FIXED);
    await expectText(page, `${lab} [data-out]`, /^5\s*$/);
    await expectText(page, `${lab} .m-debrief`, /recursive descent/);
  });

  await scenario('compiler-generate-lab', '/learn/computer/tiny-compiler-generate/', async (page) => {
    const r = '[data-complab]';
    await page.locator(r).scrollIntoViewIfNeeded();
    await compile(page, r, '1 + 2 * 3');
    for (let i = 0; i < 5; i++) await page.click(`${r} [data-step]`);
    await expectText(page, `${r} [data-stack]`, /\[ 7 \]/);
    await page.selectOption(`${r} [data-gen]`, 'swapped');
    await compile(page, r, '10 - 3');
    await expectText(page, `${r} [data-mine]`, /^-7$/);
    await expectText(page, `${r} [data-py]`, /^7$/);
    await expectText(page, `${r} [data-verdict]`, /wrong way round/);
    await page.selectOption(`${r} [data-gen]`, 'correct');
    await page.check(`${r} [data-fold]`);
    await compile(page, r, 'x + 2 * 3');
    await expectText(page, `${r} [data-stack-count]`, /3 instructions, 5 before folding/);
    await expectText(page, `${r} [data-mine]`, /^13$/);
    await compile(page, r, '1 / 0 + 2');
    await expectText(page, `${r} [data-mine]`, /ZeroDivisionError/);
    await expectText(page, `${r} [data-py]`, /ZeroDivisionError/);
    await page.selectOption(`${r} [data-regs]`, '2');
    // Folding is still on, as the mission's step before this asks: all-number sums fold away.
    await compile(page, r, '(1 + 2) * (3 + 4)');
    await expectText(page, `${r} [data-reg-count]`, /0 values saved to memory/);
    await compile(page, r, '(x + 1) * (y + 2)');
    await expectText(page, `${r} [data-reg-count]`, /[1-9]\d* values? saved to memory/);
    await expectText(page, `${r} .m-debrief`, /Operand order/);
    // The failure case: no tree, no code, and the buttons still work.
    await compile(page, r, '1 +');
    await expectText(page, `${r} [data-point]`, /ended here/);
    await compile(page, r, 'zebra');
    await expectText(page, `${r} [data-point]`, /Nothing called zebra/);
    await compile(page, r, '2 + 2');
    await expectText(page, `${r} [data-mine]`, /^4$/);
    // A value too long to print is walked to its end, and the page says what happened.
    await compile(page, r, '10 ** 4300');
    await expectText(page, `${r} [data-verdict]`, /What failed is printing/);
    for (let i = 0; i < 3; i++) await page.click(`${r} [data-step]`);
    await expectText(page, `${r} [data-stack]`, /too long for Python to print/);
  });

  await scenario('compiler-generate-mission', '/learn/computer/tiny-compiler-generate/', async (page) => {
    const lab = await codeMission(page, 'comp-gen-stack');
    await expectText(page, `${lab} [data-out]`, /-7\s*$/);
    const fixed = `def gen(tree):
    if type(tree) == int or type(tree) == float:
        return [("PUSH", tree)]
    if type(tree) == str:
        return [("LOAD", tree)]
    op, left, right = tree
    return gen(left) + gen(right) + [(op,)]

def fold(tree):
    if type(tree) != tuple:
        return tree
    op, left, right = tree
    left = fold(left)
    right = fold(right)
    if type(left) not in (str, tuple) and type(right) not in (str, tuple):
        try:
            return run(gen((op, left, right)))
        except ZeroDivisionError:
            pass
    return (op, left, right)

print(answer("10 - 3"))
`;
    await codeMission(page, 'comp-gen-stack', fixed);
    await expectText(page, `${lab} [data-out]`, /^7\s*$/);
    await expectText(page, `${lab} .m-debrief`, /Real Python's own compiler/);
  });

  await scenario('speculation-lab', '/learn/computer/speculation-leak/', async (page) => {
    const r = '[data-speclab]';
    await page.locator(r).scrollIntoViewIfNeeded();
    const setX = (x) => page.fill(`${r} [data-x]`, String(x));
    // An empty box must refuse, not quietly call victim(0).
    await page.fill(`${r} [data-x]`, '');
    await page.click(`${r} [data-call]`);
    await expectText(page, `${r} [data-arch]`, /Nothing was called/);
    await setX(16);
    await page.click(`${r} [data-call]`);
    await expectText(page, `${r} [data-arch]`, /returned 0/);
    // Forgetting the flush is the failure case: training's own lines muddy the reading.
    await page.click(`${r} [data-train]`);
    await page.click(`${r} [data-call]`);
    await page.click(`${r} [data-probe]`);
    await expectText(page, `${r} [data-read-out]`, /lines are fast/);
    let digits = '';
    for (const x of [16, 17, 18, 19]) {
      await setX(x);
      await page.click(`${r} [data-round]`);
      const t = await expectText(page, `${r} [data-read-out]`, /One line stands out: [0-9a-f]/);
      digits += /stands out: ([0-9a-f])/.exec(t)[1];
    }
    await page.fill(`${r} [data-guess]`, 'zzzz');
    await page.click(`${r} [data-check]`);
    await expectText(page, `${r} [data-guess-out]`, /^No\./);
    await page.fill(`${r} [data-guess]`, [...digits].join(', '));
    await page.click(`${r} [data-check]`);
    await expectText(page, `${r} [data-guess-out]`, /^Yes/);
    // Straight after a flush, "wasn't flushed" was simply false.
    await page.click(`${r} [data-flush]`);
    await page.click(`${r} [data-probe]`);
    await expectText(page, `${r} [data-truth]`, /Nothing out of range has run/);
    await page.selectOption(`${r} [data-defence]`, 'mask');
    await setX(16);
    await page.click(`${r} [data-round]`);
    await expectText(page, `${r} [data-truth]`, /No secret reached the cache/);
    await page.selectOption(`${r} [data-defence]`, 'barrier');
    await page.click(`${r} [data-round]`);
    await expectText(page, `${r} [data-read-out]`, /all slow/);
    await page.selectOption(`${r} [data-defence]`, 'none');
    await page.check(`${r} [data-coarse]`);
    await page.click(`${r} [data-round]`);
    await expectText(page, `${r} [data-read-out]`, /can't tell a hit from a miss/);
    // The verdict can't say safe: the mark is still in the cache.
    await expectText(page, `${r} [data-truth]`, /A secret did mark the cache[\s\S]*still there/);
    await page.uncheck(`${r} [data-coarse]`);
    await page.selectOption(`${r} [data-attack]`, 'meltdown');
    await page.click(`${r} [data-round2]`);
    await expectText(page, `${r} [data-read-out]`, /One line stands out/);
    await expectText(page, `${r} [data-arch]`, /faulted/);
    await page.check(`${r} [data-iso]`);
    await page.click(`${r} [data-round2]`);
    await expectText(page, `${r} [data-read-out]`, /all slow/);
    await expectText(page, `${r} .m-debrief`, /The program never saw the secret/);
  });

  await scenario('amdahl-lab', '/learn/computer/many-small-brains/', async (page) => {
    const r = '[data-amlab]';
    await page.locator(r).scrollIntoViewIfNeeded();
    const set = async (p, power) => { await page.locator(`${r} [data-p]`).fill(String(p)); await page.locator(`${r} [data-c]`).fill(String(power)); };
    await set(900, 3);
    await expectText(page, `${r} [data-speedup]`, /^4\.71$/);
    await expectText(page, `${r} [data-limit]`, /^10\.00$/);
    await page.click(`${r} [data-run]`);
    await expectText(page, `${r} [data-ticks]`, /^4\.69$/);
    await expectText(page, `${r} [data-sched]`, /213 ticks/);
    await set(900, 10);
    await expectText(page, `${r} [data-speedup]`, /^9\.91$/);
    await set(900, 12);
    await expectText(page, `${r} [data-speedup]`, /^9\.98$/);
    await set(970, 6);
    await expectText(page, `${r} [data-speedup]`, /^22\.15$/);
    await expectText(page, `${r} .m-debrief`, /nothing buys you more than 10 times/);
    // The far end: the note used to call a run at a quarter of the formula "a little under".
    await set(1000, 12);
    await expectText(page, `${r} [data-speedup]`, /^4096\.00$/);
    await page.click(`${r} [data-run]`);
    await expectText(page, `${r} [data-ticks]`, /^1000\.00$/);
    await expectText(page, `${r} [data-sched]`, /^1 tick instead of[\s\S]*76% under the formula[\s\S]*no use for more than 1,000 cores/);
    await set(1000, 3);
    await page.click(`${r} [data-run]`);
    await expectText(page, `${r} [data-ticks]`, /^8\.00$/);
    if ((await page.locator(`${r} [data-sched]`).textContent()).includes('under the formula')) throw new Error('the note spoke where the two agree exactly');
    await expectText(page, `${r} [data-limit]`, /no limit/);
    await page.selectOption(`${r} [data-pattern]`, 'alternating');
    await expectText(page, `${r} [data-lane-speed]`, /^4\.00x$/);
    await expectText(page, `${r} [data-both]`, /^128 of 128$/);
    await page.selectOption(`${r} [data-pattern]`, 'uniform');
    await expectText(page, `${r} [data-lane-speed]`, /^8\.00x$/);
    await page.selectOption(`${r} [data-lanes]`, '1');
    await expectText(page, `${r} [data-lane-note]`, /ordinary machine/);
  });

  await scenario('joule-lab', '/learn/computer/energy/', async (page) => {
    const r = '[data-jlab]';
    await page.locator(r).scrollIntoViewIfNeeded();
    const set = async (v, g) => { await page.selectOption(`${r} [data-volts]`, String(v)); await page.selectOption(`${r} [data-ghz]`, String(g)); };
    await expectText(page, `${r} [data-total]`, /^4\.26 J$/);
    await page.selectOption(`${r} [data-ghz]`, '2');
    await expectText(page, `${r} [data-total]`, /^5\.48 J$/);
    await expectText(page, `${r} [data-verdict]`, /more energy than full speed/);
    // Asking for a clock the voltage can't reach gets no number at all.
    await set(0.6, 4.5);
    await expectText(page, `${r} [data-verdict]`, /can't run/);
    await expectText(page, `${r} [data-total]`, /no result/);
    await set(0.8, 2.5);
    await expectText(page, `${r} [data-total]`, /^2\.80 J$/);
    await set(0.5, 0.5);
    await expectText(page, `${r} [data-verdict]`, /misses the deadline/);
    await set(0.6, 1.5);
    await expectText(page, `${r} [data-total]`, /^2\.45 J$/);
    await expectText(page, `${r} .m-debrief`, /It's the voltage that matters/);
    await expectText(page, `${r} [data-gap]`, /2\.87 × 10\^-21/);
    await page.selectOption(`${r} [data-op]`, 'dram');
    await expectText(page, `${r} [data-gap]`, /sets no minimum for the copy itself/);
    await expectText(page, `${r} [data-gap]`, /those 64 bits is 1\.84 × 10\^-19 J, about 7\.08 × 10\^9 times less/);
    await page.selectOption(`${r} [data-temp]`, '4');
    await expectText(page, `${r} [data-gap]`, /at 4 K/);
  });

  await scenario('qubit-lab', '/learn/computer/qubits/', async (page) => {
    const r = '[data-qlab]';
    await page.locator(r).scrollIntoViewIfNeeded();
    const gate = (g) => page.click(`${r} [data-gate="${g}"]`);
    const chance = (label, re) => expectText(page, `${r} [data-row="${label}"]`, re);
    await chance('00', /100\.0%/);
    await gate('H:0');
    await chance('00', /50\.0%/);
    await chance('10', /50\.0%/);
    await gate('H:0');
    await chance('00', /100\.0%/);
    await page.click(`${r} [data-reset]`);
    await gate('H:0'); await gate('Z:0');
    await chance('10', /-0\.707[\s\S]*50\.0%/);
    await gate('H:0');
    await chance('10', /100\.0%/);
    await page.click(`${r} [data-reset]`);
    await gate('H:0');
    await page.click(`${r} [data-cnot="0:1"]`);
    await chance('11', /50\.0%/);
    await chance('01', /0\.0%/);
    await expectText(page, `${r} [data-note]`, /Entangled/);
    await page.click(`${r} [data-shoot]`);
    const first = await expectText(page, `${r} [data-shots]`, /\|01> 0\s+\|10> 0/);
    await page.click(`${r} [data-shoot]`);
    const second = await expectText(page, `${r} [data-shots]`, /\|01> 0\s+\|10> 0/);
    if (first !== second) throw new Error('the same seed gave different shots');
    await page.fill(`${r} [data-seed]`, '2');
    await page.click(`${r} [data-shoot]`);
    const third = await expectText(page, `${r} [data-shots]`, /seed 2:/);
    if (third === second) throw new Error('a different seed gave identical text');
    // A real measurement collapses the state, and both qubits now agree.
    await page.click(`${r} [data-measure="0"]`);
    await expectText(page, `${r} [data-note]`, /Certain/);
    await expectText(page, `${r} [data-circuit]`, /Measure\(q0\) read [01]/);
    // Fresh runs of that circuit: the shots message said so and showed 100% one outcome.
    await page.click(`${r} [data-reset]`);
    await gate('H:0');
    await page.click(`${r} [data-measure="0"]`);
    await page.selectOption(`${r} [data-count]`, '1000');
    await page.click(`${r} [data-shoot]`);
    const fresh = await expectText(page, `${r} [data-shots]`, /fresh run of the circuit above, its measurement included/);
    const seenCount = (label) => Number(new RegExp(`\\|${label}> (\\d+)`).exec(fresh)[1]);
    if (seenCount('00') < 300 || seenCount('10') < 300) throw new Error(`H then Measure should be near 50/50 in fresh runs: ${fresh}`);
    // Reading again changes nothing, and a later gate can make new outcomes.
    await gate('H:0');
    await expectText(page, `${r} [data-note]`, /2 outcomes possible/);
    await page.click(`${r} [data-reset]`);
    await expectText(page, `${r} [data-shots]`, /No shots yet/);
    // An entangled state whose chances look independent gets called what it is.
    await gate('H:0'); await gate('H:1');
    await page.click(`${r} [data-cz]`);
    await expectText(page, `${r} [data-note]`, /Entangled: these amplitudes/);
    await page.click(`${r} [data-reset]`);
    await gate('H:0'); await gate('H:1');
    await page.click(`${r} [data-oracle]`);
    // The table can't hand over the oracle's secret before Diffusion has done anything.
    await expectText(page, `${r} [data-note]`, /hiding which/);
    for (const label of ['00', '01', '10', '11']) await chance(label, /±0\.500[\s\S]*25\.0%/);
    if (await page.locator(`${r} .ql-bar i.neg`).count()) throw new Error('a red bar gave away the marked item before Diffusion');
    await page.click(`${r} [data-diffusion]`);
    await expectText(page, `${r} [data-note]`, /Certain/);
    await expectText(page, `${r} .m-debrief`, /Nothing here tried every answer/);
  });
}

// ---- kubernetes workloads (cs/k8s-a) -------------------------------------
// Each mission played by typing, with its failure seen first: the empty
// namespace, the stale config, the Job stuck at 0/1, the refusal, the silent
// suspend, the missing node, the Pending pod.

const kube = (id) => `[data-kube-sim][data-mission="${id}"]`;
const fast = (page, r) => page.selectOption(`${r} [data-speed]`, '150');

await scenario('kube-namespaces', '/learn/kubernetes/objects-and-namespaces/', async (page) => {
  const r = kube('kube-namespaces');
  await type(page, r, 'kubectl get pods');
  await expectText(page, `${r} .term-out`, /No resources found in default namespace\./);
  await type(page, r, 'kubectl get pods -A');
  await expectText(page, `${r} .term-out`, /NAMESPACE\s+NAME[\s\S]*shop\s+hello-/);
  await type(page, r, 'kubectl -n shop get deployment hello -o yaml');
  await expectText(page, `${r} .term-out`, /progressDeadlineSeconds: 600/);
  await type(page, r, 'kubectl config set-context --current --namespace=shop');
  await type(page, r, 'kubectl get pods -l app=hello');
  await expectText(page, `${r} .m-debrief`, /never "none anywhere"/);
});

await scenario('kube-config', '/learn/kubernetes/config-and-secrets/', async (page) => {
  const r = kube('kube-config');
  await fast(page, r);
  await type(page, r, 'kubectl logs deployment/web');
  await type(page, r, `kubectl patch configmap greeting -p '{"data":{"GREETING":"hello from v2"}}'`);
  await page.waitForTimeout(2500);
  await type(page, r, 'kubectl logs deployment/web --tail=1');
  await expectText(page, `${r} .term-out`, /GREETING=hello from v1\s*$/);
  if (await doneSteps(page, r) < 3) throw new Error('reading, changing and re-reading did not tick three steps');
  // The tempting shortcut: the password in plain text. api runs, the step must not tick.
  await type(page, r, 'kubectl set env deployment/api DATABASE_URL=postgres://db:5432/shop');
  await type(page, r, 'kubectl rollout restart deployment/web');
  await expectText(page, `${r} .m-why:not([hidden])`, /plain text/, 20000);
});

await scenario('kube-config-volume', '/learn/kubernetes/config-and-secrets/', async (page) => {
  const r = kube('kube-config-volume');
  await fast(page, r);
  await type(page, r, 'kubectl logs deployment/files');
  await type(page, r, `kubectl patch configmap greeting -p '{"data":{"GREETING":"v2"}}'`);
  await type(page, r, 'kubectl exec deployment/files -- cat /etc/greeting/GREETING /etc/sub/GREETING');
  await expectText(page, `${r} .term-out`, /^v1\nv1$/m);
  const deadline = Date.now() + 25000;
  for (;;) {
    await page.waitForTimeout(1000);
    await type(page, r, 'kubectl exec deployment/files -- cat /etc/greeting/GREETING /etc/sub/GREETING');
    if (/v2\nv1\s*$/.test(await page.locator(`${r} .term-out`).innerText())) break;
    if (Date.now() > deadline) throw new Error('the mounted folder never picked up v2');
  }
  await type(page, r, 'kubectl rollout restart deployment/files');
  await expectText(page, `${r} .m-debrief`, /will not receive ConfigMap updates/, 30000);
});

await scenario('kube-sidecars', '/learn/kubernetes/init-and-sidecars/', async (page) => {
  const r = kube('kube-sidecars');
  await fast(page, r);
  await type(page, r, 'kubectl get jobs');
  await expectText(page, `${r} .term-out`, /nightly-report\s+Running\s+0\/1/);
  await type(page, r, 'kubectl get pods');
  await expectText(page, `${r} .term-out`, /nightly-report-\S+\s+1\/2\s+NotReady/);
  await type(page, r, 'kubectl logs job/nightly-report -c report');
  await type(page, r, 'kubectl apply -f report-native.yaml');
  await expectText(page, `${r} .term-out`, /field is immutable/);
  await type(page, r, 'kubectl delete job nightly-report');
  await type(page, r, 'kubectl apply -f report-native.yaml');
  await type(page, r, 'kubectl logs deployment/shop -c wait-for-db');
  await expectText(page, `${r} .term-out`, /waiting for db/);
  await type(page, r, 'kubectl create deployment db --image=panda/db:1.0');
  await expectText(page, `${r} .m-debrief`, /restartPolicy: Always/, 40000);
});

await scenario('kube-nonroot', '/learn/kubernetes/security-context/', async (page) => {
  const r = kube('kube-nonroot');
  await fast(page, r);
  await type(page, r, 'kubectl describe pod -l app=web');
  await expectText(page, `${r} .term-out`, /container has runAsNonRoot and image will run as root/);
  await type(page, r, `kubectl patch deployment web -p '{"spec":{"template":{"spec":{"securityContext":{"runAsUser":1000}}}}}'`);
  // Let web settle first: label the namespace before its new pod exists and
  // that pod is refused too. Real, but not what this step is about.
  for (let i = 0; i < 80 && await doneSteps(page, r) < 2; i++) await page.waitForTimeout(250);
  await type(page, r, 'kubectl label namespace default pod-security.kubernetes.io/enforce=restricted');
  await expectText(page, `${r} .term-out`, /violate the new PodSecurity enforce level "restricted:latest"/);
  await type(page, r, 'kubectl create deployment api --image=panda/hello-nonroot:1.0');
  await expectText(page, `${r} .term-out`, /Warning: would violate PodSecurity/);
  await page.waitForTimeout(1500);
  await type(page, r, 'kubectl get events');
  await expectText(page, `${r} .term-out`, /FailedCreate\s+replicaset\/api-\S+\s+Error creating: pods "api-\S+" is forbidden: violates PodSecurity/);
  if (await doneSteps(page, r) < 4) throw new Error('the first four steps did not tick');
});

await scenario('kube-cron', '/learn/kubernetes/jobs-and-cronjobs/', async (page) => {
  const r = kube('kube-cron');
  await fast(page, r);
  await type(page, r, 'kubectl get cronjobs,jobs');
  await expectText(page, `${r} .term-out`, /cronjob\.batch\/nightly\s+\*\/1 \* \* \* \*\s+<none>\s+True/);
  await type(page, r, 'kubectl describe cronjob nightly');
  await expectText(page, `${r} .term-out`, /Suspend:\s+True/);
  await type(page, r, `kubectl patch cronjob nightly -p '{"spec":{"suspend":false}}'`);
  await type(page, r, 'kubectl create job nightly-now --from=cronjob/nightly');
  await type(page, r, 'kubectl describe job backfill');
  await expectText(page, `${r} .term-out`, /Job has reached the specified backoff limit/);
  await type(page, r, 'kubectl logs job/backfill');
  await expectText(page, `${r} .m-debrief`, /simply makes no Jobs/, 30000);
});

await scenario('kube-daemonset', '/learn/kubernetes/daemonsets-and-taints/', async (page) => {
  const r = kube('kube-daemonset');
  await fast(page, r);
  await type(page, r, 'kubectl get daemonsets');
  await expectText(page, `${r} .term-out`, /log-collector\s+2\s+2\s+2/);
  await type(page, r, 'kubectl get nodes');
  await type(page, r, 'kubectl describe node control-plane');
  await expectText(page, `${r} .term-out`, /Taints:\s+node-role\.kubernetes\.io\/control-plane:NoSchedule/);
  if (!/control-plane:NoSchedule/.test(await page.locator(`${r} .taints`).first().innerText())) throw new Error('the taint is not drawn on the node');
  // The blanket toleration fills the node and must not tick the step.
  await type(page, r, `kubectl patch daemonset log-collector -p '{"spec":{"template":{"spec":{"tolerations":[{"operator":"Exists"}]}}}}'`);
  await expectText(page, `${r} .m-why:not([hidden])`, /tolerates every taint/, 15000);
  await type(page, r, `kubectl patch daemonset log-collector -p '{"spec":{"template":{"spec":{"tolerations":[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"}]}}}}'`);
  await type(page, r, 'kubectl taint node worker-2 dedicated=gpu:NoSchedule');
  await type(page, r, 'kubectl scale deployment web --replicas=4');
  await expectText(page, `${r} .m-debrief`, /NoExecute is the effect that evicts/, 40000);
});

await scenario('kube-placement', '/learn/kubernetes/placement/', async (page) => {
  const r = kube('kube-placement');
  await fast(page, r);
  await type(page, r, 'kubectl describe pod -l app=fast');
  await expectText(page, `${r} .term-out`, /didn't match Pod's node affinity\/selector/);
  await type(page, r, 'kubectl label node worker-3 disktype=ssd');
  await type(page, r, 'kubectl scale deployment web --replicas=4');
  await page.waitForTimeout(1500);
  await type(page, r, 'kubectl get events');
  await expectText(page, `${r} .term-out`, /didn't match pod anti-affinity rules/);
  if (await page.locator(`${r} [data-pending] .pod`).count() < 1) throw new Error('the fourth web pod is not drawn as waiting');
  await type(page, r, 'kubectl delete deployment web');
  await type(page, r, 'kubectl apply -f web-preferred.yaml');
  await page.waitForTimeout(2000);
  await type(page, r, 'kubectl get pods -o wide');
  await expectText(page, `${r} .m-debrief`, /closer together than you think/, 30000);
});

// ---- Kubernetes networking and packaging (NetSim, RenderLab, ApiLab) ----------

await scenario('kube-net-services', '/learn/kubernetes/pods-and-services/', async (page) => {
  const r = '[data-netsim]';
  await page.locator(r).scrollIntoViewIfNeeded();
  // The cluster view is built by the script; scoped styles once styled nothing.
  const pill = await page.locator(`${r} .ns-pods li`).first().evaluate((e) => getComputedStyle(e).borderTopStyle);
  if (pill !== 'solid') throw new Error(`pod chips are unstyled (${pill}) - widget styles are not applying`);
  await type(page, r, 'kubectl get svc');
  await expectText(page, `${r} .term-out`, /LoadBalancer\s+10\.96\.98\.211\s+<pending>\s+80:30292\/TCP/);
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://web');
  await expectText(page, `${r} .term-out`, /curl: \(7\) Failed to connect to web port 80 after 3 ms: Could not connect to server/);
  await type(page, r, 'kubectl get endpointslices');
  if (await doneSteps(page, r) !== 3) throw new Error(`expected 3 steps after the refusal, got ${await doneSteps(page, r)}`);
  // Kinds Kubernetes has are a sandbox limit, never the server's "doesn't have".
  await type(page, r, 'kubectl get all');
  await expectText(page, `${r} .term-out`, /This sandbox doesn't model all\. A real cluster has it/);
  // Curling a pod directly is the shortcut that must not pass step 4.
  const ip = (await page.locator(`${r} .ns-pods li code`).first().innerText()).trim();
  await type(page, r, `kubectl exec client -- curl -sS -m 5 http://${ip}:8080`);
  if (await doneSteps(page, r) !== 3) throw new Error('curling a pod IP passed the Service fix');
  await type(page, r, `kubectl patch svc web -p '{"spec":{"ports":[{"port":80,"targetPort":8080}]}}'`);
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://web');
  await expectText(page, `${r} .term-out`, /hello from web-.*\(v1\.0\)/);
  await type(page, r, 'curl http://172.18.0.3:30292');
  await type(page, r, 'kubectl create deployment web-green --image=panda/web:2.0 --replicas=2');
  await type(page, r, 'kubectl set selector svc web app=web-green');
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://web');
  await expectText(page, `${r} .m-debrief`, /all blue\/green is/);
  if (await doneSteps(page, r) !== 6) throw new Error('mission did not tick all 6 steps');
});

await scenario('kube-net-dns', '/learn/kubernetes/cluster-dns/', async (page) => {
  const r = '[data-netsim]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://web');
  await expectText(page, `${r} .term-out`, /curl: \(6\) Could not resolve host: web/);
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://web.shop');
  await type(page, r, 'kubectl exec client -- nslookup web.shop');
  await expectText(page, `${r} .term-out`, /server can't find web\.shop: NXDOMAIN/);
  await type(page, r, 'kubectl exec client -- nslookup web.shop.svc.cluster.local');
  await type(page, r, 'kubectl exec client -- nslookup web-pods.shop.svc.cluster.local');
  await type(page, r, 'kubectl -n kube-system scale deployment coredns --replicas=0');
  await expectText(page, `${r} [data-view]`, /CoreDNS: 0 pods/);
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://web.shop');
  // Bringing DNS back without trying the IP must not finish the mission.
  await type(page, r, 'kubectl -n kube-system scale deployment coredns --replicas=2');
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://web.shop');
  if (await doneSteps(page, r) !== 5) throw new Error(`skipping the IP step ticked ${await doneSteps(page, r)}`);
  await type(page, r, 'kubectl -n kube-system scale deployment coredns --replicas=0');
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://10.96.98.211');
  await type(page, r, 'kubectl -n kube-system scale deployment coredns --replicas=2');
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://web.shop');
  await expectText(page, `${r} .m-debrief`, /only the name did/);
});

await scenario('kube-net-policy', '/learn/kubernetes/network-policies/', async (page) => {
  const r = '[data-netsim]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://api');
  await page.click(`${r} .ns-tab[data-file="deny-all.yaml"]`);
  await page.click(`${r} [data-apply]`);
  await expectText(page, `${r} .term-out`, /networkpolicy\.networking\.k8s\.io\/default-deny created/);
  await expectText(page, `${r} [data-mbody]`, /blocked \(egress\)/);
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://api');
  await expectText(page, `${r} .term-out`, /curl: \(28\) Resolving timed out after 5003 milliseconds/);
  await page.click(`${r} .ns-tab[data-file="allow-dns.yaml"]`);
  await page.click(`${r} [data-apply]`);
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://api');
  await expectText(page, `${r} .term-out`, /Connection timed out after 5032 milliseconds/);
  // A syntax error in the editor is refused by name, not half-applied.
  await page.click(`${r} .ns-tab[data-file="web-to-api.yaml"]`);
  const box = page.locator(`${r} [data-text]`);
  const tmpl = await box.inputValue();
  await box.fill(tmpl.replace('policyTypes:\n  - Ingress', 'policyTypes:\n  - Ingres'));
  await page.click(`${r} [data-apply]`);
  await expectText(page, `${r} .term-out`, /spec\.policyTypes\[0\]: Unsupported value: "Ingres"/);
  await box.fill(tmpl.replace('app: CHANGE-ME', 'app: web').replace('app: CHANGE-ME', 'app: api'));
  await page.click(`${r} [data-apply]`);
  await type(page, r, 'kubectl exec deploy/web -- curl -sS -m 5 http://api');
  await expectText(page, `${r} .term-out`, /served_by/);
  if (await doneSteps(page, r) !== 4) throw new Error(`expected 4 steps with the policies right, got ${await doneSteps(page, r)}`);
  await page.locator(`${r} [data-cni-box]`).uncheck();
  await expectText(page, `${r} [data-mbody]`, /"blocked", but connects/);
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://api');
  await expectText(page, `${r} .m-debrief`, /The only test is the connection that should fail/);
  // In the ambient mesh, a default deny no longer takes Service names with it
  // (measured on tilt): the sandbox once printed "Resolving timed out" here.
  await page.click(`${r} [data-reset]`);
  await type(page, r, 'kubectl label ns shop istio.io/dataplane-mode=ambient');
  await page.click(`${r} .ns-tab[data-file="deny-all.yaml"]`);
  await page.click(`${r} [data-apply]`);
  await type(page, r, 'kubectl exec client -- curl -sS -m 5 http://api');
  await expectText(page, `${r} .term-out`, /curl: \(28\) Operation timed out after 5032 milliseconds with 0 bytes received/);
  await expectText(page, `${r} [data-mnote]`, /port 15008/);
});

await scenario('kube-net-ingress', '/learn/kubernetes/ingress/', async (page) => {
  const r = '[data-netsim]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await type(page, r, `kubectl create ingress shop --rule='shop.localhost/*=web:80'`);
  await type(page, r, 'kubectl get ingress');
  await type(page, r, 'curl http://shop.localhost');
  await expectText(page, `${r} .term-out`, /Failed to connect to shop\.localhost port 80/);
  await expectText(page, `${r} [data-view]`, /no address/);
  await page.click(`${r} [data-install]`);
  await type(page, r, 'kubectl get ingressclass');
  await expectText(page, `${r} .term-out`, /panda\s+example\.com\/panda-ingress/);
  // Installing a controller is not enough: the class-less Ingress stays unclaimed.
  await expectText(page, `${r} [data-view]`, /no address/);
  if (await doneSteps(page, r) !== 3) throw new Error(`expected 3 steps before claiming, got ${await doneSteps(page, r)}`);
  await type(page, r, `kubectl patch ingress shop -p '{"spec":{"ingressClassName":"panda"}}'`);
  await type(page, r, 'curl http://shop.localhost');
  await expectText(page, `${r} .term-out`, /hello from web-/);
  await expectText(page, `${r} .m-debrief`, /Gateway API fixed exactly this/);
});

await scenario('kube-pkg-render', '/learn/kubernetes/helm-and-kustomize/', async (page) => {
  const r = '[data-rlab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.fill(`${r} [data-set]`, 'replicaCont=3');
  await page.click(`${r} [data-helm]`);
  await expectText(page, `${r} [data-out]`, /^ {2}replicas: 1$/m);
  if (await page.locator(`${r} [data-out] .chg`).count()) throw new Error('the typo render highlighted a change, but nothing changed');
  await page.fill(`${r} [data-set]`, 'replicaCount=3');
  await page.click(`${r} [data-helm]`);
  await expectText(page, `${r} [data-out] .chg`, /replicas: 3/);
  await page.locator(`${r} [data-schema]`).check();
  await page.fill(`${r} [data-set]`, 'replicaCont=3');
  await page.click(`${r} [data-helm]`);
  await expectText(page, `${r} [data-out]`, /additional properties 'replicaCont' not allowed/);
  await page.fill(`${r} [data-overlay]`, 'resources:\n- ../base\nnamePrefix: prod-\nreplicas:\n- name: web\n  count: 3\nimages:\n- name: panda/webb\n  newTag: "2.0"\n');
  await page.click(`${r} [data-kust]`);
  await expectText(page, `${r} [data-out]`, /image: panda\/web:1\.0/);
  if (await doneSteps(page, r) !== 5) throw new Error(`expected 5 steps, got ${await doneSteps(page, r)}`);
  await page.fill(`${r} [data-overlay]`, 'resources:\n- ../base\nnamePrefix: prod-\nreplicas:\n- name: web\n  count: 3\nimages:\n- name: panda/web\n  newTag: "2.0"\n');
  await page.click(`${r} [data-kust]`);
  await expectText(page, `${r} .m-debrief`, /Read the rendered output, not the inputs/);
  // Field names fold case and digest applies, as Kustomize v5.8.1 did; the
  // sandbox once dropped both without a word.
  await page.fill(`${r} [data-overlay]`, 'resources:\n- ../base\nimages:\n- name: panda/web\n  newtag: "2.0"\n  digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n');
  await page.click(`${r} [data-kust]`);
  await expectText(page, `${r} [data-out]`, /image: panda\/web:2\.0@sha256:0123/);
  await page.fill(`${r} [data-overlay]`, 'resources:\n- ../base\nimages:\n- name: panda/web\n  bogus: 1\n');
  await page.click(`${r} [data-kust]`);
  await expectText(page, `${r} [data-out]`, /json: unknown field "bogus"/);
});

await scenario('kube-api-removed', '/learn/kubernetes/extending-kubernetes/', async (page) => {
  const r = '[data-alab]';
  await page.locator(r).scrollIntoViewIfNeeded();
  await page.click(`${r} [data-apply]`);
  await expectText(page, `${r} [data-out]`, /no matches for kind "Ingress" in version "networking\.k8s\.io\/v1beta1"/);
  await page.selectOption(`${r} [data-version]`, '21');
  await page.click(`${r} [data-apply]`);
  await expectText(page, `${r} [data-out]`, /Warning: networking\.k8s\.io\/v1beta1 Ingress is deprecated in v1\.19\+, unavailable in v1\.22\+; use networking\.k8s\.io\/v1 Ingress/);
  await page.selectOption(`${r} [data-version]`, '36');
  // The shortcut the review found: new apiVersion, spec deleted. Refused as 1.36.1 refuses it.
  await page.fill(`${r} [data-manifest]`, 'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: shop\n');
  await page.click(`${r} [data-apply]`);
  await expectText(page, `${r} [data-out]`, /either `defaultBackend` or `rules` must be specified/);
  if (await doneSteps(page, r) !== 2) throw new Error(`deleting the spec ticked the migration (${await doneSteps(page, r)} steps)`);
  await page.fill(`${r} [data-manifest]`, 'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: shop\nspec:\n  defaultBackend:\n    service:\n      name: web\n      port:\n        number: 80\n');
  await page.click(`${r} [data-apply]`);
  await expectText(page, `${r} [data-out]`, /ingress\.networking\.k8s\.io\/shop created/);
  await page.click(`${r} [data-preset="bamboo"]`);
  await page.click(`${r} [data-apply]`);
  await page.locator(`${r} [data-crd]`).check();
  await page.click(`${r} [data-apply]`);
  await expectText(page, `${r} [data-out]`, /bamboo\.panda\.example\.com\/snack created/);
  await page.click(`${r} [data-preset="endpoints"]`);
  await page.click(`${r} [data-apply]`);
  await expectText(page, `${r} .m-debrief`, /they arrive while everything still works/);
});

// ---- kubernetes batch C: storage and cluster operations (cs/k8s-c) ----------
// Both sandboxes tick on a timer, so each scenario turns the speed to fast and
// waits on what appears, the way a person waits for a pod. Each one also
// drives the tempting wrong move first and checks it is not ticked.
{
  const fast = async (page, r) => { await page.locator(r).scrollIntoViewIfNeeded(); await page.selectOption(`${r} [data-speed]`, '150'); };
  const ticked = (page, r) => page.locator(`${r} .m-steps li.done`).count();
  const flags = '--endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key';

  await scenario('storage-pending', '/learn/kubernetes/volumes/', async (page) => {
    const r = '[data-storage-sim]';
    await fast(page, r);
    await type(page, r, 'kubectl get pods,pvc');
    await type(page, r, 'kubectl describe pvc indexer-data');
    await expectText(page, `${r} .term-out`, /storageclass\.storage\.k8s\.io "hostpath" not found/);
    await type(page, r, 'kubectl get sc');
    // The in-place fix is refused with the API's own words, and ticks nothing.
    await type(page, r, `kubectl patch pvc indexer-data -p '{"spec":{"storageClassName":"standard"}}'`);
    await expectText(page, `${r} .term-out`, /spec is immutable after creation/);
    if (await ticked(page, r) !== 3) throw new Error('the patch attempt changed the checklist');
    // Edit the file the way a person would: in the editor panel.
    const ed = page.locator(`${r} [data-editor]`);
    await ed.fill((await ed.inputValue()).replace('  storageClassName: hostpath\n', ''));
    // Applying the edit over the claim is refused too; it once said "unchanged".
    await type(page, r, 'kubectl apply -f indexer.yaml');
    await expectText(page, `${r} .term-out`, /"StorageClassName": null/);
    if (/indexer-data unchanged/.test(await page.locator(`${r} .term-out`).innerText())) throw new Error('apply over the claim said unchanged');
    await expectText(page, `${r} .m-steps li.current .m-why`, /Delete the claim first/);
    await type(page, r, 'kubectl delete pvc indexer-data');
    await page.waitForTimeout(600);
    await type(page, r, 'kubectl apply -f indexer.yaml');
    await expectText(page, `${r} [data-pods]`, /indexer\s*Running/, 20000);
    await type(page, r, 'kubectl describe pvc scratch');
    await expectText(page, `${r} .term-out`, /waiting for first consumer/);
    await type(page, r, 'kubectl exec indexer -- sh -c "echo panda-data > /data/note.txt"');
    await type(page, r, 'kubectl get pv');
    const pv = (await page.locator(`${r} .term-out`).innerText()).match(/pvc-[0-9a-f-]{36}/g).pop();
    await type(page, r, `kubectl patch pv ${pv} -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'`);
    await type(page, r, 'kubectl delete pod indexer');
    await type(page, r, 'kubectl delete pvc indexer-data');
    await expectText(page, `${r} [data-volumes]`, /Released · Retain · 1 file/, 15000);
    await expectText(page, `${r} .m-debrief`, /Delete, the reclaim policy a StorageClass gets/);
  });

  await scenario('storage-sts', '/learn/kubernetes/statefulsets/', async (page) => {
    const r = '[data-storage-sim]';
    await fast(page, r);
    await type(page, r, 'kubectl get pods,pvc');
    await expectText(page, `${r} [data-pods]`, /web-2\s*Running/, 20000);
    await type(page, r, 'kubectl get pods');
    await type(page, r, 'kubectl exec web-2 -- sh -c "echo written-before-scale-down > /data/note.txt"');
    await type(page, r, 'kubectl scale sts web --replicas=1');
    await page.waitForFunction(() => !/web-1/.test(document.querySelector('[data-storage-sim] [data-pods]').textContent), null, { timeout: 20000 });
    await type(page, r, 'kubectl get pvc');
    await type(page, r, 'kubectl scale sts web --replicas=3');
    await expectText(page, `${r} [data-pods]`, /web-2\s*Running/, 20000);
    await type(page, r, 'kubectl exec web-2 -- cat /data/note.txt');
    await expectText(page, `${r} .term-out`, /^written-before-scale-down$/m);
    await type(page, r, 'kubectl set image sts/web app=panda/web:2.O');
    await expectText(page, `${r} [data-pods]`, /ImagePullBackOff/, 20000);
    // Reverting alone must not finish the mission: the stuck pod stays stuck.
    await type(page, r, 'kubectl set image sts/web app=panda/web:2.0');
    await page.waitForTimeout(3000);
    await expectText(page, `${r} .m-steps li.current .m-why`, /still runs the broken image/);
    await type(page, r, 'kubectl delete pod web-2');
    await expectText(page, `${r} .m-debrief`, /Deleting it let the fixed template through/, 30000);
  });

  await scenario('ops-control-plane', '/learn/kubernetes/control-plane/', async (page) => {
    const r = '[data-ops-sim]';
    await fast(page, r);
    await type(page, r, 'kubectl describe pod p');
    await expectText(page, `${r} .term-out`, /Events: +<none>/);
    await type(page, r, 'kubectl -n kube-system get pods');
    await type(page, r, 'docker exec ops-control-plane ls /etc/kubernetes/manifests');
    await type(page, r, 'docker exec ops-control-plane mv /tmp/kube-scheduler.yaml /etc/kubernetes/manifests/');
    await expectText(page, `${r} .m-steps`, /Now stop the controller-manager/, 15000);
    await page.waitForFunction(() => document.querySelectorAll('[data-ops-sim] .m-steps li.done').length >= 4, null, { timeout: 15000 });
    await type(page, r, 'docker exec ops-control-plane mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/');
    await page.waitForTimeout(800);
    await type(page, r, 'kubectl get pods');
    const name = (await page.locator(`${r} .term-out`).innerText()).match(/hello-\w+-\w+/)[0];
    await type(page, r, `kubectl delete pod ${name}`);
    await page.waitForTimeout(1500);
    await type(page, r, 'kubectl get deploy');
    await expectText(page, `${r} .term-out`, /hello +2\/2/);
    await type(page, r, 'docker exec ops-control-plane mv /tmp/kube-controller-manager.yaml /etc/kubernetes/manifests/');
    await expectText(page, `${r} .m-debrief`, /Silence was the clue/, 20000);
  });

  await scenario('ops-node', '/learn/kubernetes/node-troubleshooting/', async (page) => {
    const r = '[data-ops-sim]';
    await fast(page, r);
    await type(page, r, 'docker exec ops-worker systemctl stop kubelet');
    await expectText(page, `${r} [data-nodes]`, /ops-worker\s*NotReady/, 20000);
    await type(page, r, 'kubectl get nodes');
    await type(page, r, 'kubectl describe node ops-worker');
    await expectText(page, `${r} .term-out`, /Kubelet stopped posting node status\./);
    await type(page, r, 'kubectl get pods -o wide');
    await page.waitForFunction(() => /Terminating/.test(document.querySelector('[data-ops-sim] [data-nodes]').innerHTML), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(500);
    await type(page, r, 'kubectl get pods -o wide');
    await expectText(page, `${r} .term-out`, /Terminating/);
    await type(page, r, 'docker exec ops-worker journalctl -u kubelet');
    await type(page, r, 'docker exec ops-worker systemctl start kubelet');
    await expectText(page, `${r} .m-debrief`, /Nobody had told them/, 20000);
  });

  await scenario('ops-drain', '/learn/kubernetes/drain-and-disruption/', async (page) => {
    const r = '[data-ops-sim]';
    await fast(page, r);
    await type(page, r, 'kubectl get pdb');
    await type(page, r, 'kubectl drain ops-worker --ignore-daemonsets --timeout=60s');
    await expectText(page, `${r} .term-out`, /Cannot evict pod as it would violate the pod's disruption budget/);
    await expectText(page, `${r} .term-out`, /global timeout reached: 1m0s/, 20000);
    await type(page, r, 'kubectl get nodes');
    await expectText(page, `${r} .term-out`, /ops-worker +Ready,SchedulingDisabled/);
    // Deleting the budget is the shortcut that must not pass.
    await type(page, r, 'kubectl delete pdb web');
    await page.waitForTimeout(600);
    await expectText(page, `${r} .m-steps li.current .m-why`, /budget is gone/);
    await type(page, r, 'kubectl create pdb web --selector=app=web --min-available=1');
    await page.waitForTimeout(800);
    await type(page, r, 'kubectl drain ops-worker --ignore-daemonsets --timeout=120s');
    await expectText(page, `${r} .term-out`, /node\/ops-worker drained/, 20000);
    await type(page, r, 'kubectl uncordon ops-worker');
    await expectText(page, `${r} .m-debrief`, /left web unprotected/, 8000);
  });

  await scenario('ops-upgrade', '/learn/kubernetes/upgrades/', async (page) => {
    const r = '[data-ops-sim]';
    await fast(page, r);
    if (!(await page.locator(`${r} [data-skew-panel]`).isVisible())) throw new Error('the skew panel is hidden');
    await type(page, r, 'kubectl version');
    await type(page, r, 'kubectl get nodes');
    await type(page, r, 'docker cp v1.37.2/kubeadm ops-control-plane:/usr/bin/kubeadm');
    await type(page, r, 'docker exec ops-control-plane kubeadm upgrade apply v1.37.2 -y');
    await expectText(page, `${r} .term-out`, /only supports deploying clusters with the control plane version >= 1\.36\.0/);
    await type(page, r, 'docker cp v1.36.1/kubeadm ops-control-plane:/usr/bin/kubeadm');
    await type(page, r, 'docker exec ops-control-plane kubeadm upgrade apply v1.36.1 -y');
    await expectText(page, `${r} .term-out`, /SUCCESS! A control plane node/);
    await type(page, r, 'kubectl get nodes');
    // The kubelet first without draining: not accepted.
    await type(page, r, 'docker cp v1.36.1/kubelet ops-control-plane:/usr/bin/kubelet');
    await type(page, r, 'docker exec ops-control-plane systemctl restart kubelet');
    await page.waitForTimeout(800);
    await expectText(page, `${r} .m-steps li.current .m-why`, /drain first/);
    await type(page, r, 'kubectl drain ops-control-plane --ignore-daemonsets');
    await page.waitForTimeout(2500);
    await type(page, r, 'docker cp v1.36.1/kubelet ops-control-plane:/usr/bin/kubelet');
    await type(page, r, 'docker exec ops-control-plane systemctl restart kubelet');
    await type(page, r, 'kubectl uncordon ops-control-plane');
    await page.waitForTimeout(800);
    await type(page, r, 'kubectl drain ops-worker --ignore-daemonsets');
    await expectText(page, `${r} .term-out`, /node\/ops-worker drained/, 20000);
    for (const c of ['docker cp v1.36.1/kubeadm ops-worker:/usr/bin/kubeadm', 'docker exec ops-worker kubeadm upgrade node', 'docker cp v1.36.1/kubelet ops-worker:/usr/bin/kubelet', 'docker exec ops-worker systemctl restart kubelet', 'kubectl uncordon ops-worker']) await type(page, r, c);
    await expectText(page, `${r} .m-debrief`, /one minor version at a time is a rule it enforces/, 15000);
    if (await page.locator(`${r} [data-skew-list] li.bad`).count()) throw new Error('a skew rule is still broken after the upgrade');
  });

  await scenario('ops-quorum', '/learn/kubernetes/etcd-and-quorum/', async (page) => {
    const r = '[data-ops-sim][data-mission="ops-quorum"]';
    await fast(page, r);
    await type(page, r, `kubectl -n kube-system exec etcd-ops-control-plane -- etcdctl ${flags} member list -w table`);
    await expectText(page, `${r} .term-out`, /ops-control-plane3/);
    await type(page, r, 'docker exec ops-control-plane3 mv /etc/kubernetes/manifests/etcd.yaml /tmp/');
    await expectText(page, `${r} [data-etcd]`, /2 of 3 members up/, 8000);
    await type(page, r, 'kubectl get nodes');
    await type(page, r, 'docker exec ops-control-plane2 mv /etc/kubernetes/manifests/etcd.yaml /tmp/');
    await expectText(page, `${r} [data-etcd]`, /1 of 3 members up · quorum needs 2 · API cannot commit/, 8000);
    await type(page, r, 'kubectl get nodes');
    await expectText(page, `${r} .term-out`, /^sandbox: etcd has fewer members up than its quorum/m);
    await type(page, r, 'docker exec ops-control-plane2 mv /tmp/etcd.yaml /etc/kubernetes/manifests/');
    await type(page, r, 'docker exec ops-control-plane3 mv /tmp/etcd.yaml /etc/kubernetes/manifests/');
    await expectText(page, `${r} [data-etcd]`, /3 of 3 members up/, 8000);
    await type(page, r, 'kubectl get nodes');
    await expectText(page, `${r} .m-debrief`, /case for odd numbers/, 8000);
  });

  await scenario('ops-restore', '/learn/kubernetes/etcd-and-quorum/', async (page) => {
    const r = '[data-ops-sim][data-mission="ops-restore"]';
    await fast(page, r);
    await type(page, r, `kubectl -n kube-system exec etcd-ops-control-plane -- etcdctl ${flags} snapshot save /var/lib/etcd/snap.db`);
    await expectText(page, `${r} .term-out`, /Snapshot saved at \/var\/lib\/etcd\/snap\.db/);
    await type(page, r, 'kubectl create namespace after-snap');
    await type(page, r, `kubectl -n kube-system exec etcd-ops-control-plane -- etcdctl ${flags} snapshot restore /var/lib/etcd/snap.db --data-dir /var/lib/etcd/restored`);
    await expectText(page, `${r} .term-out`, /Error: unknown flag: --data-dir/);
    await type(page, r, 'kubectl -n kube-system exec etcd-ops-control-plane -- etcdutl --data-dir /var/lib/etcd/restored snapshot restore /var/lib/etcd/snap.db');
    await type(page, r, "docker exec ops-control-plane sed -i 's#path: /var/lib/etcd$#path: /var/lib/etcd/restored#' /etc/kubernetes/manifests/etcd.yaml");
    await page.waitForTimeout(1200);
    await type(page, r, 'kubectl get ns');
    await expectText(page, `${r} .term-out`, /after-snap +Active/);
    await type(page, r, 'docker exec ops-control-plane mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/');
    await page.waitForTimeout(800);
    await type(page, r, 'docker exec ops-control-plane mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/');
    await page.waitForTimeout(1500);
    await type(page, r, 'kubectl get ns after-snap');
    await expectText(page, `${r} .term-out`, /namespaces "after-snap" not found/);
    await expectText(page, `${r} .m-debrief`, /answered from what it had cached/, 8000);
  });

  // The docs' order must finish too: it used to strand the learner at r5.
  await scenario('ops-restore-docs-order', '/learn/kubernetes/etcd-and-quorum/', async (page) => {
    const r = '[data-ops-sim][data-mission="ops-restore"]';
    await fast(page, r);
    await type(page, r, `kubectl -n kube-system exec etcd-ops-control-plane -- etcdctl ${flags} snapshot save /var/lib/etcd/snap.db`);
    await type(page, r, 'kubectl create namespace after-snap');
    await type(page, r, 'kubectl -n kube-system exec etcd-ops-control-plane -- etcdutl --data-dir /var/lib/etcd/restored snapshot restore /var/lib/etcd/snap.db');
    await type(page, r, 'docker exec ops-control-plane mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/');
    await page.waitForTimeout(800);
    await type(page, r, "docker exec ops-control-plane sed -i 's#path: /var/lib/etcd$#path: /var/lib/etcd/restored#' /etc/kubernetes/manifests/etcd.yaml");
    await page.waitForTimeout(800);
    await type(page, r, 'docker exec ops-control-plane mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/');
    await page.waitForTimeout(1500);
    await type(page, r, 'kubectl get ns');
    const out = await page.locator(`${r} .term-out`).innerText();
    if (/after-snap/.test(out.slice(out.lastIndexOf('kubectl get ns') + 14))) throw new Error('after-snap listed after a docs-order restore');
    await expectText(page, `${r} .m-debrief`, /as the docs say, after-snap was gone at the first look/, 8000);
  });
}

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
    await expectText(page, `${r} [data-card="${card}"] [data-why]`, /^Supported\.(?! Supported)/);
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
      await expectText(page, `${r} [data-card="${card}"] [data-why]`, /^Supported\.(?! Supported)/);
    }
    await expectText(page, `${r} .m-debrief`, /./);
    if (await page.locator(`${r} .m-steps li.done`).count() !== Object.keys(picks).length) throw new Error(`${deck}: not every step ticked`);
  });
}

// ---- tool lessons
// One scenario per tool deck, played from the deck's own data, so a tool
// lesson added later is tested without anyone writing a scenario for it. Node
// runs the TypeScript registry directly; a deck missing from it is caught by
// CardSort refusing to build.
const { DECKS } = await import('../src/lib/decks.ts');
for (const deck of Object.values(DECKS).filter((d) => d.id.startsWith('tool-'))) {
  await scenario(`deck-${deck.id}`, `/learn/tools/${deck.id.slice('tool-'.length)}/`, async (page) => {
    const r = `[data-cards="${deck.id}"]`;
    await page.locator(r).scrollIntoViewIfNeeded();
    const first = deck.cards[0];
    const wrong = first.options.find((o) => o.id !== first.answer);
    await page.check(`${r} [data-card="${first.id}"] input[value="${wrong.id}"]`);
    await expectText(page, `${r} [data-card="${first.id}"] [data-why]`, /^Not quite\./);
    for (const c of deck.cards) {
      await page.check(`${r} [data-card="${c.id}"] input[value="${c.answer}"]`);
      await expectText(page, `${r} [data-card="${c.id}"] [data-why]`, /^Supported\.(?! Supported)/);
    }
    if (await page.locator(`${r} .m-steps li.done`).count() !== deck.cards.length) throw new Error(`${deck.id}: not every step ticked`);
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
