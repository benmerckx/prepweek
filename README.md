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
bun run deploy       # build + deploy to Cloudflare
```

Open `/s/<anything>` for a separate sheet. The default sheet seeds demo data;
**Stress** loads 120 people and ~29k tasks.

## Using it

| Action | How |
| --- | --- |
| Move (also to another person) | drag a block |
| Change dates | drag a block's left/right edge |
| Create | click empty space in a row (desktop), drag across it, or long-press and drag (touch) |
| Duplicate | hold <kbd>Alt</kbd> while dragging, or <kbd>⌘D</kbd> |
| Open details | click a block (desktop; tap twice on touch), or <kbd>Enter</kbd> when selected. Details open in a panel on the right (a bottom sheet on phones) |
| Pan | hold <kbd>Space</kbd> and drag |
| Nudge | <kbd>←</kbd>/<kbd>→</kbd> moves a day, <kbd>⇧</kbd> resizes, <kbd>↑</kbd>/<kbd>↓</kbd> changes person |
| Cancel a drag | <kbd>Esc</kbd> |
| Undo / redo | <kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd> |
| Zoom | pinch, <kbd>⌘</kbd>+wheel, <kbd>⌘±</kbd> or the slider (keeps the day under the cursor fixed) |
| Scrub through the year(s) | drag or click the strip at the bottom, or wheel over it |
| Jump to today | <kbd>T</kbd> |
| Focus on a person | click their avatar (<kbd>⌘</kbd>/<kbd>Shift</kbd>-click adds more), the people menu in the toolbar, or <kbd>F</kbd> on a selected task; <kbd>Esc</kbd> or the chip in the corner shows everyone again |
| Find tasks | <kbd>/</kbd>, type; non-matching blocks fade, <kbd>Enter</kbd> / <kbd>⇧Enter</kbd> jump to the next/previous match |
| Projects, clients, tags | in a task's editor; **⋯ → Projects…** manages them (rename, client, color for all its tasks, archive) |
| Filter | the funnel in the toolbar: by project (grouped by client) and tag; combines with search |
| Saved views | the **Views** menu left in the toolbar saves focus, search, filters, weekends, density and zoom for everyone on the sheet |
| Repeat a task | **Repeat** in its editor (every workday/week/2 weeks/month, optional end date). Dragging the first one moves the series; dragging another detaches it |
| Teams | click a name → **Team**. Team headers collapse; double-click one to rename the team |
| Reorder people | drag a name up or down (long-press on touch); drop it under another team to move it there |
| Hide weekends / compact rows / dark mode | **⋯ → View**; the moon/sun button in the toolbar toggles dark mode |
| Patterns | in a task's panel, under the colors: dots, stripes, zigzag, waves, grid or checks, drawn in the block's color |
| Comments | in a task's editor; type **@** to mention someone |
| Activity | **⋯ → Activity**: every change, by whom; each task's editor has its own **History** |
| Notifications | the bell: mentions, comments on your tasks and changes others make to your work |
| See who's here | faces in the toolbar (click one to jump to them), their pointers and selections in their color, their view on the minimap |
| Share | **Share**: private edit and view-only links |
| Command palette | <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd>: run any command, focus a person, filter a project, apply a view or jump to a task |
| Install | **⋯ → Install app** (or the browser's install button); the app then opens offline too |
| Milestones | click the milestone lane under the dates (or **+** in the corner); drag a flag to move it, click to rename, recolor or delete |
| Attachments | in a task's editor: **File** / **Link**, drop files on the editor, or paste an image |
| Import from Teamweek / Toggl Plan | **Import** in the toolbar (or ⋯ menu), or drop the CSV anywhere on the app |

The browser/Android back button closes the open editor or dialog instead of
leaving the app.

### Importing from Teamweek / Toggl Plan

In Toggl Plan (formerly Teamweek) use **⋯ → Export tasks** in the Team or
Plan view. This needs an Owner or Admin. Drop the CSV on prepweek. Columns
are recognised by name (task, assignee name and email, start and end date,
project, status, tags, notes, estimate, color), and you can fix the mapping
before importing. Day/month order is detected from the dates; when it can't
be told, the dialog asks.

- People are matched to the sheet by email, then by name; anyone else is
  added.
- A task with several assignees gets one block per person.
- Completed and unassigned tasks are skipped by default, and undated tasks
  are always skipped.
- Project, tags and estimate go into the task notes. Blocks are colored per
  project.
- Choose **Add to sheet**, which keeps everything and merges, or **Replace
  sheet**, which removes the current people, tasks and attachments first.
  Milestones stay either way.
- The whole import is one undo step. Task ids are derived from the row, so
  importing a newer export of the same data updates those tasks instead of
  duplicating them.

The code is in `src/import/`. The CSV parser and column mapping are pure
functions with unit tests.

Each person also shows how booked they are over the next four weeks; the
darker part of the bar is parallel work.

Drags autoscroll at the edges. Edits sync live to other tabs.

**On phones and tablets:**

| Action | How |
| --- | --- |
| Scroll | swipe anywhere, including over blocks |
| Select / edit | tap a block, then tap it again to open the editor sheet |
| Move | long-press a block and drag (a selected block drags right away) |
| Change dates | drag the round knobs on a selected block |
| Create | long-press empty space, then drag to set the length |
| Zoom | pinch on the timeline |

Below 640px wide, the people column shrinks to avatars and first names, the
editor opens as a bottom sheet, and the less-used actions move into the
**⋯** menu.

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

## Milestones and attachments

**Milestones** are sheet-wide dates such as launches, freezes and offsites.
Each shows as a flag in its own lane under the dates and as a hatched column
through every row. The minimap marks them too. Click an empty spot in the lane
to add one, drag a flag to move it (one undo step), and click a flag to edit
it.

**Attachments** are files or links on a task. The task's block shows a
paperclip with the count, and a notes mark when it has notes. Only the
metadata (name, size, type) is stored in the synced sheet. File bytes stay out
of the CRDT:
- they are always kept in the browser's IndexedDB, so they work offline;
- if the sheet syncs to the worker and an R2 bucket is bound as `FILES`, they
  are also uploaded to `/files/<sheet>/<id>`, so collaborators can open them.

The R2 binding is commented out in `wrangler.toml` for now. To turn it on,
create the bucket with `wrangler r2 bucket create prepweek-files` and
uncomment the `[[r2_buckets]]` lines. Files are limited to 25 MB.

## Storage, sync, realtime

Each sheet is one TinyBase **MergeableStore**, a CRDT with hybrid logical
clocks per cell, so all replicas merge deterministically:

1. **IndexedDB**: local-first, and the sheet works offline. Persistence is
   incremental (`src/data/localdb.ts`). Each edit appends only its own
   changes, with their sync stamps, to a log, and the log is folded into a
   snapshot when the browser is idle. TinyBase's stock persister rewrote the
   whole sheet, about 1.5 MB, on every edit, which cost 200+ ms per change on
   a phone. Sheets saved by the old persister migrate automatically.
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
run `bun run worker:dev` and open
`http://localhost:8787/s/team?sync=ws://localhost:8787/sync` in two browsers.
`?sync=off` turns it off again.

Presence (faces, pointers, selections) is ephemeral and stays out of the
CRDT: tabs use a BroadcastChannel, other machines a relay-only
`PresenceDurableObject` per sheet at `/presence/<sheet>`.

The app is installable (web manifest, icons in `public/icons`) and works
offline: `public/sw.js` serves the cached app shell when the network is
gone, and the sheet itself already lives in IndexedDB. Sync, presence,
files and sharing requests always go to the network.

### Accounts, workspaces and sheets

- **No account needed to start.** Opening the app without one creates a new
  plan with its own unguessable address (`/s/<id>`), remembered on this
  device, so you can come back to it and share it.
- **Sign up / log in** (same thing): a magic link by email, or Google. Signing
  in saves the plan you started into your workspace automatically.
- **Workspaces** hold one or more sheets. People are **admins** (invite and
  remove people, change roles, delete sheets) or **members** (plan on every
  sheet in the workspace). Invite by email from the sheet menu → *People*; the
  invite link can also be copied and sent yourself.
- A sheet in a workspace opens only for its members, or for someone holding
  one of its private share links.

Everything account-related lives in one SQLite Durable Object
(`worker/directory.ts`), so there's no database to create. Configure sign-in
with Worker secrets (`wrangler secret put …`):

| Secret | For |
| --- | --- |
| `RESEND_API_KEY`, `EMAIL_FROM` | sending magic links and invites via [Resend](https://resend.com) (EMAIL_FROM like `prepweek <login@yourdomain.com>`, from a verified domain) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | "Continue with Google". Create an OAuth client (web) in Google Cloud and add `https://<your host>/auth/google/callback` as a redirect URI |

Without a mail provider, `wrangler dev` on localhost shows the magic link on
screen instead of emailing it.

### Sharing

A sheet starts open: anyone with its address can edit, which suits a demo.
**Share → Turn on private links** mints two secret keys, stored in the
sheet's Durable Object: an edit link and a view-only link (`/s/<sheet>?k=…`).
From then on the worker checks the key on every sync, presence and file
request, and the sheet shows a lock screen without one. The key is
remembered per sheet and removed from the address bar.

View-only is enforced by the server, not just the UI: the sheet's object
only forwards read requests from a view-only socket (TinyBase's
`GetContentHashes` / `Get…Diff` messages) and drops anything that carries
content. **Reset links** replaces both keys and disconnects everyone, so old
links stop working at once.

Links are keys, not accounts. For sign-in with company accounts, put the
worker behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/);
people pick who they are on the sheet (for comments and notifications) from
the bell or the comment box.

### Deploying

`wrangler.toml` lives at the repo root and builds the app before every
deploy (`[build] command = "bun run build"`), so either of these works:

- **From your machine:** `bun run deploy` (runs `wrangler login` the first time).
- **Cloudflare Git integration** (Workers & Pages → Create → Import a
  repository): pick this repo and branch `main`. Leave the build command empty
  and keep the deploy command `npx wrangler deploy`; Wrangler runs the Bun
  build itself. Durable Objects need the Workers Paid plan.
