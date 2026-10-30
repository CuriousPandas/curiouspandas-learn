import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

export default defineConfig({
  site: 'https://learn.curiouspandas.dev',
  integrations: [mdx()],
  // Static output only. There is no server to scale, secure or pay for - the
  // learner's browser does all the work. See src/pages/about/index.astro.
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory' },
  // Astro's dev toolbar injects its own UI; the site check reads the page's
  // visible text, and the toolbar's text would be counted as ours.
  devToolbar: { enabled: false },
  // Astro's default github-dark draws comments at 3:1, below WCAG AA, and the
  // comments are where the lessons put "leave this running in another terminal".
  markdown: { shikiConfig: { theme: 'github-dark-default' } },
  // Removed lessons keep their URL alive, so a bookmark or a link someone shared
  // lands on the lesson that absorbed it instead of the 404 panda. Progress
  // follows separately, through src/lib/progress-renames.ts.
  redirects: {
    '/learn/frontiers/agents': '/learn/agents/what-is-an-agent/',
  },
});
