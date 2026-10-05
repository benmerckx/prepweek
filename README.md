# prepweek

A fast resource planner in the spirit of Teamweek: people are rows, days are
columns, work is blocks you drag around.

```sh
bun install
bun run dev          # http://localhost:3000 (HMR)
bun test             # lane-packing tests
bun run typecheck    # TypeScript 7 (tsgo), app + worker
bun run build        # production bundle → dist/
bun run worker:dev   # app + realtime backend on http://localhost:8787 (wrangler)
```

Open `/s/<anything>` for a separate sheet. The default sheet seeds demo data;
**Stress** loads 120 people and ~29k tasks.

## Using it

| Action | How |
| --- | --- |
| Move (also to another person) | drag a block |
| Change dates | drag a block's left/right edge |
| Create | drag across empty space in a row, or double-click |
| Duplicate | hold <kbd>Alt</kbd> while dragging, or <kbd>⌘D</kbd> |
| Edit | double-click a block, or <kbd>Enter</kbd> when selected |
| Nudge | <kbd>←</kbd>/<kbd>→</kbd> moves a day, <kbd>⇧</kbd> resizes, <kbd>↑</kbd>/<kbd>↓</kbd> changes person |
| Cancel a drag | <kbd>Esc</kbd> |
| Undo / redo | <kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd> |
| Zoom | pinch, <kbd>⌘</kbd>+wheel, <kbd>⌘±</kbd> or the slider (keeps the day under the cursor fixed) |
| Scrub through the year(s) | drag or click the strip at the bottom, or wheel over it |
| Jump to today | <kbd>T</kbd> |

Drags autoscroll at the edges. Edits sync live to other tabs.

## How it's built

```
src/
  lib/dates.ts          integer day numbers (days since 1970-01-01), no TZ drift
  lib/layout.ts         lane packing (+ tests)
  data/store.ts         TinyBase MergeableStore, schema, commands, undo/redo
  data/sync.ts          IndexedDB + BroadcastChannel + optional WebSocket sync
  timeline/model.ts     derived, incrementally updated row layouts
  timeline/viewport.ts  scroll/zoom geometry shared by everything
  timeline/drag.ts      pointer-event drag controller
  timeline/Timeline.tsx windowing, zoom, keyboard
  timeline/Rows.tsx     rows → 4-week tiles → task blocks
  timeline/Minimap.tsx  the scrubber (canvas)
  timeline/pin.ts       keeps titles readable when blocks are cut off
worker/                 Cloudflare Worker + Durable Object per sheet
```

**Scrolling.** The sheet scrolls natively, which keeps trackpad momentum and
lets the compositor do the work, inside a CSS grid with a sticky header and
sidebar. React only re-renders when the visible range nears the edge of the
rendered window. That window is made of 4-week tiles memoized per row, so
moving it mounts only the new tiles. The grid and weekends are CSS gradients
over the window, with no DOM node per cell. Rows are virtualized vertically
as well. Block titles stay readable through a small imperative pass over the
mounted blocks: CSS `position: sticky` on hundreds of labels cost more than
10 ms per scroll frame.

**Lane packing** (`lib/layout.ts`). Each person's tasks are packed into lanes
by sweeping them in start order. Each cluster of overlapping tasks uses the
minimum possible number of lanes, which equals the peak number of tasks on
any one day. Lane choice is also stable: when a task is placed, at least one
of those k lanes is always free, so the packer can keep a task in its
previous lane, or in the lane it was dropped into, without ever using more
lanes. Blocks therefore don't shuffle while you drag nearby or when a remote
edit arrives. Rows are sized for the lanes needed in the rendered window,
not for the busiest week in history.

**Drag & drop** (`timeline/drag.ts`) is written directly on Pointer Events,
with no library:
- a 4 px slop separates a click from a drag;
- listeners live on `window`, so virtualization can't break a gesture;
- dates snap to the nearest column boundary;
- autoscroll speeds up near the edges;
- <kbd>Esc</kbd> cancels and <kbd>Alt</kbd> duplicates.

While a drag is in progress it is only a preview in the layout model, and the
other blocks reflow live. The store is written once, on drop, as one undoable
command, which is also exactly one sync message.

**Undo** records the cells each local command changed and restores only those
cells. TinyBase checkpoints would also roll back collaborators' edits.

## Storage, sync, realtime

Each sheet is one TinyBase **MergeableStore**, a CRDT with hybrid logical
clocks per cell, so all replicas merge deterministically:

1. **IndexedDB**: local-first. The sheet opens instantly and works offline.
2. **BroadcastChannel**: other tabs see edits in realtime.
3. **Cloudflare** (`worker/`): one **Durable Object per sheet**, persisted to
   that object's own SQLite database (`createDurableObjectSqlStoragePersister`).
   The same object is the WebSocket room that relays changes between clients.

On "one D1 database per sheet": a SQLite-backed Durable Object already *is*
a private SQLite database per sheet. It is also colocated with the realtime
sockets, so writes involve no network hop, and TinyBase supports it out of
the box. D1 remains a good place for cross-sheet data: accounts, the sheet
index, permissions, and reporting exports.

Sync is enabled automatically when the app is served by the worker. Locally,
run `bun run build && bun run worker:dev` and open
`http://localhost:8787/s/team?sync=ws://localhost:8787/sync` in two browsers.
`?sync=off` turns it off again. The worker has no authentication yet; there
is a TODO at the upgrade point in `worker/index.ts`.

Deploy with `bun run build && bun run worker:deploy`.
