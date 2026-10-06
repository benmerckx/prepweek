// Loading code split into chunks, robust to deploys.
//
// Every build renames its chunks (content hashes) and a deploy replaces them
// all, so a page opened before a deploy asks for files that no longer exist
// once it lazily loads one (the server answers with the HTML page, and the
// browser reports "Failed to fetch dynamically imported module"). Reloading
// picks up the new build; it's done once per minute at most, so a real
// outage doesn't turn into a reload loop.

const KEY = 'prepweek:chunkReload';

export const loadChunk = <T>(load: () => Promise<T>, reloadTo?: string): Promise<T> =>
  load().catch((error) => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY)) || 0;
    } catch {}
    if (Date.now() - last < 60_000) throw error;
    try {
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {}
    if (reloadTo) location.assign(reloadTo);
    else location.reload();
    // Never settles: the page is going away.
    return new Promise<T>(() => {});
  });
