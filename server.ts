// Bun dev/prod server. Bun bundles the HTML entry (TSX, CSS) on the fly, with
// HMR in development. In production the same app is deployed as static assets
// (e.g. Cloudflare Workers static assets / Pages) next to /worker.
import index from './src/index.html';

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    '/*': index,
  },
  development: process.env.NODE_ENV !== 'production' && { hmr: true, console: true },
});

console.log(`prepweek → ${server.url}`);
