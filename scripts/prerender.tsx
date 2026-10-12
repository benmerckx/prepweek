// After the build: the public pages as real HTML. The app renders in the
// browser, so without this every address answers with an empty page that
// says "Opening your sheet…" until the script runs: search engines, link
// previews and checks that don't run scripts (Paddle's domain review) saw
// nothing. Each page is rendered here into a copy of index.html (as
// <page>.html, which Cloudflare serves at /<page>; the home page into
// index.html itself). It only shows without scripts (index.html's
// noscript); with them, the browser renders the page as usual.

import { renderToString } from 'react-dom/server';
import type { ComponentType } from 'react';

// What the pages read while rendering, outside a browser.
const g = globalThis as Record<string, unknown>;
const memory = new Map<string, string>();
g.localStorage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
g.sessionStorage = g.localStorage;
g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { Landing } = await import('../src/landing/Landing.tsx');
const pages = await import('../src/landing/Pages.tsx');

const DESCRIPTION = 'Prepweek puts everyone’s work on one timeline: drag a block onto someone, stretch it over the days it takes, and the whole team sees it live.';
const routes: [path: string, file: string, page: ComponentType, title: string, description: string][] = [
  ['/', 'index.html', Landing, 'Prepweek: who’s doing what, week by week', DESCRIPTION],
  ['/terms', 'terms.html', pages.TermsPage, 'Terms · Prepweek', 'The terms for using Prepweek, made and run by Codeurs bv.'],
  ['/privacy', 'privacy.html', pages.PrivacyPage, 'Privacy · Prepweek', 'What Prepweek stores, where, and how to take it out.'],
  ['/refunds', 'refunds.html', pages.RefundsPage, 'Refund policy · Prepweek', 'A full refund within 14 days of any Prepweek subscription payment.'],
  ['/help', 'help.html', pages.HelpPage, 'Help · Prepweek', 'Answers to common questions about Prepweek.'],
  ['/roadmap', 'roadmap.html', pages.RoadmapPage, 'Roadmap · Prepweek', 'What’s new in Prepweek and what’s coming.'],
  ['/daily', 'daily.html', pages.DailyPage, 'The daily week · Prepweek', 'A planning puzzle, new every day: fit a small team’s week together so every rule holds.'],
];

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const shell = await Bun.file('dist/index.html').text();
if (!shell.includes('<div id="root">')) throw new Error('dist/index.html: no root to render into');

for (const [path, file, Page, title, description] of routes) {
  g.location = new URL(`https://prepweek.com${path}`);
  const body = renderToString(<Page />);
  const html = shell
    .replace(/<title>[^<]*<\/title>/, `<title>${attr(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${attr(description)}"`)
    .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${attr(title)}"`)
    .replace('<div id="root">', `<div id="root"><div class="prerendered">${body}</div>`);
  await Bun.write(`dist/${file}`, html);
  console.log(`prerendered ${path} → dist/${file} (${Math.round(body.length / 1024)} KB)`);
}
