# The site's local loop: `tilt up`, then open http://localhost:10350.
#
# Everything here is a local_resource. The site is static and runs entirely in
# the browser, so there is no cluster to deploy to: the point is one dashboard
# that keeps the dev server up and re-runs the checks a change can break, with
# each one's log a click away. CI runs the same commands (.github/workflows/ci.yml).

# The dev server. Astro reloads the page itself on save, so Tilt only has to
# keep it running and say when it is actually answering.
local_resource(
    'site',
    serve_cmd='npm run dev -- --host 127.0.0.1 --port 4321',
    readiness_probe=probe(period_secs=2, http_get=http_get_action(port=4321, path='/')),
    links=[link('http://127.0.0.1:4321/', 'site')],
    labels=['site'],
)

# Unit tests: the simulators, the missions and the progress-id guard. Seconds,
# so they run on every save to the code they cover.
local_resource(
    'unit-tests',
    cmd='npm test',
    deps=['src/lib', 'src/data', 'tests', 'scripts/progress-ids.ts', 'src/content/lessons'],
    allow_parallel=True,
    labels=['checks'],
)

# Types across every .astro and .ts file: about 40 seconds, and it catches
# what the tests cannot, such as a component prop a lesson spells wrongly.
local_resource(
    'typecheck',
    cmd='npm run check',
    deps=['src', 'astro.config.mjs', 'tsconfig.json'],
    allow_parallel=True,
    labels=['checks'],
)

# The real evidence: build, then render every page in a browser and drive every
# widget. Minutes, so it runs when you press its trigger button, not on save.
# Uses its own port so it never checks the dev server's build by mistake.
local_resource(
    'site-check',
    cmd='npm run build && npm run check:site',
    env={'CHECK_PORT': '4329'},
    trigger_mode=TRIGGER_MODE_MANUAL,
    auto_init=False,
    allow_parallel=True,
    labels=['checks'],
)
