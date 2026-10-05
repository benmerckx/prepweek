// Bun dev/prod server. Bun bundles the HTML entry (TSX, CSS) on the fly, with
// HMR in development. In production the same app is deployed as static assets
// (e.g. Cloudflare Workers static assets / Pages) next to /worker.
import index from './src/index.html';

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    // Static files (fonts) are copied as-is next to the bundle.
    '/fonts/*': (req) => {
      const file = Bun.file(`public${new URL(req.url).pathname}`);
      return new Response(file, { headers: { 'cache-control': 'public, max-age=31536000, immutable' } });
    },
    // App manifest, icons and service worker (not registered in dev).
    '/manifest.webmanifest': () => new Response(Bun.file('public/manifest.webmanifest'), { headers: { 'content-type': 'application/manifest+json' } }),
    '/sw.js': () => new Response(Bun.file('public/sw.js')),
    '/icons/*': (req) => new Response(Bun.file(`public${new URL(req.url).pathname}`)),
    '/*': index,
  },
  development: process.env.NODE_ENV !== 'production' && { hmr: true, console: true },
});

console.log(`prepweek → ${server.url}`);
