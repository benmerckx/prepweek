import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { addComment, deleteComment, store, type CommentRow } from '../data/store.ts';
import { displayName, getMe, isMe, onMeChange, setMe } from '../data/identity.ts';
import { getSeen, markSeen, notifications, type Note } from '../data/notify.ts';
import { ago, useTables } from '../lib/useTable.ts';
import { useBackToClose } from '../lib/useBackToClose.ts';
import { Bell, Close, Comment, History, Send, Trash } from '../ui/icons.tsx';

const PAST: Record<string, string> = {
  move: 'moved', resize: 'resized', create: 'created', delete: 'deleted', edit: 'edited', rename: 'renamed',
  recolor: 'recolored', comment: 'commented on', add: 'added', attach: 'attached', remove: 'removed', set: 'set',
  tag: 'tagged', untag: 'untagged', repeat: 'made repeating', stop: 'stopped', import: 'imported', replace: 'replaced',
  reorder: 'reordered', save: 'saved', archive: 'archived', restore: 'restored', undo: 'undid', redo: 'redid',
};
/** "Move task" → "moved task", "Undo: Move task" → "undid: move task". */
export const phrase = (label: string) => {
  const [first = '', ...rest] = label.split(' ');
  const w = first.replace(/:$/, '').toLowerCase();
  const past = PAST[w] ?? w;
  const tail = rest.join(' ').toLowerCase();
  if (w === 'comment') return 'commented';
  if (w === 'repeat') return 'made it repeat';
  return `${past}${first.endsWith(':') ? ':' : ''}${tail ? ` ${tail}` : ''}`;
};

const useMe = () => useSyncExternalStore(onMeChange, getMe);

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';

const people = () =>
  store
    .getRowIds('users')
    .map((id) => ({ id, name: store.getCell('users', id, 'name') as string, color: store.getCell('users', id, 'color') as string }))
    .sort((a, b) => a.name.localeCompare(b.name));

const colorOf = (byId: string) => (byId && store.hasRow('users', byId) ? (store.getCell('users', byId, 'color') as string) : '#8b93a3');

function Face({ name, byId, size = 24 }: { name: string; byId: string; size?: number }) {
  return (
    <span className="face" style={{ ['--c' as string]: colorOf(byId), width: size, height: size, fontSize: size * 0.4 }}>
      {initials(name)}
    </span>
  );
}

/** "@Ava Peeters" in comment text, highlighted when it names a person. */
function RichText({ text }: { text: string }) {
  const names = useMemo(() => people().map((p) => p.name).filter(Boolean).sort((a, b) => b.length - a.length), []);
  if (!names.length) return <>{text}</>;
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(@(?:${esc.join('|')}))`, 'gi'));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <span key={i} className="mention">
            {p}
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

// --- Who are you? ----------------------------------------------------------------

/** Pick (or name) yourself; needed to sign comments and get notifications. */
export function WhoAreYou({ compact, onDone }: { compact?: boolean; onDone?(): void }) {
  const me = useMe();
  const [name, setName] = useState(me.name);
  const list = people();
  return (
    <div className={'who' + (compact ? ' compact' : '')}>
      <p className="who-title">Who are you on this sheet?</p>
      <p className="who-sub">Pick your row so @mentions and changes to your work reach you.</p>
      <div className="who-list">
        {list.map((p) => (
          <button
            key={p.id}
            className={'who-person' + (me.personId === p.id ? ' on' : '')}
            onClick={() => {
              setMe({ personId: p.id, name: p.name });
              onDone?.();
            }}
          >
            <Face name={p.name} byId={p.id} size={22} />
            {p.name}
          </button>
        ))}
      </div>
      <form
        className="who-other"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setMe({ personId: '', name: name.trim() });
          onDone?.();
        }}
      >
        <input placeholder="Not listed? Your name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <button className="btn small" disabled={!name.trim()}>
          Save
        </button>
      </form>
    </div>
  );
}

// --- Comment composer with @mentions ---------------------------------------------------

function Composer({ taskId }: { taskId: string }) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  /** Where to put the caret after we rewrite the text (mention insert). */
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const c = pendingCaret.current;
    if (c === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(c, c);
  }, [text]);
  // An "@query" right before the caret opens the people list.
  const m = /(^|\s)@([^@\n]{0,30})$/.exec(text.slice(0, caret));
  const q = m ? m[2]!.toLowerCase() : null;
  const options =
    q === null
      ? []
      : people()
          .filter((p) => p.name.toLowerCase().includes(q) || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)))
          .slice(0, 6);
  const open = options.length > 0;

  const insert = (name: string) => {
    const before = text.slice(0, caret).replace(/@([^@\n]{0,30})$/, `@${name} `);
    const next = before + text.slice(caret);
    pendingCaret.current = before.length;
    setText(next);
    setCaret(before.length);
  };
  const send = () => {
    const v = text.trim();
    if (!v) return;
    addComment(taskId, v);
    setText('');
    setCaret(0);
  };

  return (
    <div className="composer">
      {open && (
        <div className="mention-list" role="listbox">
          {options.map((p, i) => (
            <button
              key={p.id}
              className={'combo-item' + (i === hi % options.length ? ' hi' : '')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(p.name)}
            >
              <Face name={p.name} byId={p.id} size={20} />
              {p.name}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        placeholder="Comment… use @ to mention"
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value);
          setCaret(e.currentTarget.selectionStart);
          setHi(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setHi((h) => h + (e.key === 'ArrowDown' ? 1 : options.length - 1));
          } else if (open && (e.key === 'Enter' || e.key === 'Tab')) {
            e.preventDefault();
            insert(options[hi % options.length]!.name);
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button className="composer-send" aria-label="Send comment" disabled={!text.trim()} onMouseDown={(e) => e.preventDefault()} onClick={send}>
        <Send size={15} />
      </button>
    </div>
  );
}

// --- Per-task discussion: comments + history -------------------------------------------

type Item =
  | { kind: 'comment'; id: string; at: number; by: string; byId: string; text: string }
  | { kind: 'change'; id: string; at: number; by: string; byId: string; label: string };

export function Discussion({ taskId, collapsed: startCollapsed = false }: { taskId: string; collapsed?: boolean }) {
  const v = useTables('comments', 'activity');
  const me = useMe();
  const [showHistory, setShowHistory] = useState(false);
  const [collapsed, setCollapsed] = useState(startCollapsed);
  /** Asked who you are (only once you go to write something). */
  const [asking, setAsking] = useState(false);
  const count = useMemo(
    () => store.getRowIds('comments').filter((id) => store.getCell('comments', id, 'taskId') === taskId).length,
    [v, taskId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const items = useMemo(() => {
    const out: Item[] = [];
    for (const id of store.getRowIds('comments')) {
      const c = store.getRow('comments', id) as CommentRow;
      if (c.taskId === taskId) out.push({ kind: 'comment', id, at: c.at, by: c.by, byId: c.byId, text: c.text });
    }
    if (showHistory)
      for (const id of store.getRowIds('activity')) {
        const a = store.getRow('activity', id) as { taskId: string; at: number; by: string; byId: string; label: string };
        if (a.taskId === taskId && !a.label.endsWith('omment')) out.push({ kind: 'change', id, at: a.at, by: a.by, byId: a.byId, label: a.label });
      }
    return out.sort((a, b) => a.at - b.at);
  }, [v, taskId, showHistory]); // eslint-disable-line react-hooks/exhaustive-deps
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [items.length]);
  const signedIn = !!displayName();

  if (collapsed)
    return (
      <div className="discussion">
        <button className="disc-head disc-open" onClick={() => setCollapsed(false)}>
          <span className="disc-title">
            <Comment size={14} />
            Comments{count ? ` · ${count}` : ''}
          </span>
          <span className="disc-more">Show</span>
        </button>
      </div>
    );

  return (
    <div className="discussion">
      <div className="disc-head">
        <span className="disc-title">
          <Comment size={14} />
          Comments{count ? ` · ${count}` : ''}
        </span>
        <button className={'link-btn' + (showHistory ? ' on' : '')} onClick={() => setShowHistory((h) => !h)}>
          <History size={13} />
          {showHistory ? 'Hide history' : 'History'}
        </button>
      </div>
      {items.length > 0 && (
        <div className="disc-list">
          {items.map((it) =>
            it.kind === 'comment' ? (
              <div key={it.id} className="disc-comment">
                <Face name={it.by || '?'} byId={it.byId} />
                <div className="disc-body">
                  <div className="disc-meta">
                    <b>{it.by || 'Someone'}</b>
                    <span>{ago(it.at)}</span>
                    {isMe(it.byId, it.by) && (
                      <button className="disc-del" aria-label="Delete comment" onClick={() => deleteComment(it.id)}>
                        <Trash size={12} />
                      </button>
                    )}
                  </div>
                  <div className="disc-text">
                    <RichText text={it.text} />
                  </div>
                </div>
              </div>
            ) : (
              <div key={it.id} className="disc-change">
                <span className="disc-dot" />
                <span>
                  <b>{it.by || 'Someone'}</b> {phrase(it.label)}
                </span>
                <span className="disc-when">{ago(it.at)}</span>
              </div>
            ),
          )}
          <div ref={end} />
        </div>
      )}
      {signedIn ? (
        <Composer taskId={taskId} />
      ) : asking ? (
        <WhoAreYou compact key={me.name} />
      ) : (
        <button className="composer composer-ghost" onClick={() => setAsking(true)}>
          Comment… use @ to mention
        </button>
      )}
    </div>
  );
}

// --- Sheet activity (changelog) ----------------------------------------------------------

export function ActivityPanel({ onOpenTask, onClose }: { onOpenTask(id: string): void; onClose(): void }) {
  useBackToClose(true, onClose);
  const v = useTables('activity', 'comments');
  const [limit, setLimit] = useState(150);
  const rows = useMemo(() => {
    const ids = store.getSortedRowIds('activity', 'at', true);
    return ids.slice(0, limit).map((id) => ({ id, ...(store.getRow('activity', id) as { at: number; by: string; byId: string; label: string; taskId: string; title: string }) }));
  }, [v, limit]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = store.getRowCount('activity');
  let lastDay = '';

  return createPortal(
    <div className="drawer-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label="Activity" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="modal-head">
          <h2>Activity</h2>
          <button className="tb-search-btn" aria-label="Close" onClick={onClose}>
            <Close />
          </button>
        </header>
        <div className="act-list">
          {rows.length === 0 && <p className="proj-empty">Nothing yet. Every change on this sheet shows up here, with who made it.</p>}
          {rows.map((a) => {
            const day = new Date(a.at).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
            const head = day !== lastDay ? (lastDay = day) : null;
            const live = a.taskId && store.hasRow('tasks', a.taskId);
            return (
              <Fragment key={a.id}>
                {head && <h3 className="act-day">{head}</h3>}
                <button className="act-row" disabled={!live} onClick={() => live && onOpenTask(a.taskId)}>
                  <Face name={a.by || '?'} byId={a.byId} size={26} />
                  <span className="act-text">
                    <span>
                      <b>{a.by || 'Someone'}</b> {phrase(a.label)}
                    </span>
                    {a.title && <span className="act-task">{a.title}</span>}
                  </span>
                  <span className="act-when">{new Date(a.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                </button>
              </Fragment>
            );
          })}
          {total > limit && (
            <button className="btn act-more" onClick={() => setLimit((l) => l + 300)}>
              Show older
            </button>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

// --- Notifications ----------------------------------------------------------------------

export function NotificationsMenu({ onOpenTask }: { onOpenTask(id: string): void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const v = useTables('comments', 'activity', 'tasks', 'users');
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(getSeen);
  const [perm, setPerm] = useState(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission));
  // Recomputed lazily: the badge needs only a count, cheap enough per change.
  const notes = useMemo(() => notifications(), [v, me]); // eslint-disable-line react-hooks/exhaustive-deps
  const unread = notes.filter((n) => n.at > seen).length;
  const close = () => ref.current?.removeAttribute('open');
  const label = (n: Note) =>
    n.kind === 'mention' ? 'mentioned you on' : n.kind === 'comment' ? 'commented on' : phrase(n.text);

  return (
    <details
      className="tb-bell tb-dd"
      ref={ref}
      onToggle={(e) => {
        const o = e.currentTarget.open;
        setOpen(o);
        // Closing the panel marks everything shown as read.
        if (!o && notes.length) {
          markSeen(notes[0]!.at);
          setSeen(notes[0]!.at);
        }
      }}
    >
      <summary className={'btn icon' + (unread ? ' active' : '')} aria-label={unread ? `${unread} new notifications` : 'Notifications'} title="Notifications">
        <Bell />
        {unread > 0 && <span className="bell-dot">{unread > 9 ? '9+' : unread}</span>}
      </summary>
      <div className="tb-menu notes-menu">
        <div className="fl-head">
          <span>Notifications</span>
          {unread > 0 && (
            <button
              className="link-btn"
              onClick={() => {
                markSeen(notes[0]!.at);
                setSeen(notes[0]!.at);
              }}
            >
              Mark all read
            </button>
          )}
        </div>
        {open && (
          <div className="fl-scroll">
            {!me.personId ? (
              <WhoAreYou compact />
            ) : notes.length === 0 ? (
              <p className="fl-empty notes-empty">
                You’re all caught up. Mentions, comments on your tasks and changes others make to your work show up here.
              </p>
            ) : (
              notes.map((n) => (
                <button
                  key={n.id}
                  className={'note' + (n.at > seen ? ' unread' : '')}
                  onClick={() => {
                    close();
                    if (store.hasRow('tasks', n.taskId)) onOpenTask(n.taskId);
                  }}
                >
                  <Face name={n.by} byId={n.byId} size={26} />
                  <span className="note-text">
                    <span>
                      <b>{n.by}</b> {label(n)} {n.title && <b className="note-task">{n.title}</b>}
                    </span>
                    {n.kind !== 'change' && (
                      <span className="note-quote">
                        <RichText text={n.text} />
                      </span>
                    )}
                    <span className="note-when">{ago(n.at)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        )}
        {me.personId && perm === 'default' && (
          <button
            className="menu-item notes-enable"
            onClick={() => void Notification.requestPermission().then((p) => setPerm(p))}
          >
            <Bell />
            Enable desktop notifications
          </button>
        )}
        {me.personId && (
          <div className="notes-foot">
            Signed as <b>{displayName()}</b> ·{' '}
            <button className="link-btn" onClick={() => setMe({ personId: '', name: '' })}>
              change
            </button>
          </div>
        )}
      </div>
    </details>
  );
}
