import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { addComment, deleteComment, isReadOnly, store, type CommentRow } from '../data/store.ts';
import { getMe, identityMode, isMe, onMeChange } from '../data/identity.ts';
import { getMe as getAccount, requestSignIn } from '../data/account.ts';
import { getSeen, markSeen, notifications, type Note } from '../data/notify.ts';
import { ago, useTables } from '../lib/useTable.ts';
import { useBackToClose, useEscape } from '../lib/useBackToClose.ts';
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

const avatarOf = (byId: string) => (byId && store.hasRow('users', byId) ? (store.getCell('users', byId, 'avatar') as string) : '');

function Face({ name, byId, size = 24 }: { name: string; byId: string; size?: number }) {
  const src = avatarOf(byId);
  return (
    <span className="face" style={{ ['--c' as string]: colorOf(byId), width: size, height: size, fontSize: size * 0.4 }}>
      {src ? <img src={src} alt="" referrerPolicy="no-referrer" /> : initials(name)}
    </span>
  );
}

/** "@Ava Peeters" in comment text, highlighted when it names a person. */
/**
 * Comment text with light markdown: @mentions, links (bare or [text](url)),
 * **bold**, *italic*, `code`, and "- " / "1. " lists.
 */
function RichText({ text }: { text: string }) {
  const names = useMemo(() => people().map((p) => p.name).filter(Boolean).sort((a, b) => b.length - a.length), []);
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const mention = esc.length ? `@(?:${esc.join('|')})` : '(?!)';
  const token = new RegExp(`(${mention})|\\[([^\\]]+)\\]\\((https?://[^)\\s]+)\\)|(https?://[^\\s<]+[^\\s<.,;:!?)\\]])|\\*\\*([^*]+)\\*\\*|\\*([^*\\s][^*]*)\\*|\`([^\`]+)\``, 'gi');
  const inline = (line: string, key: string) => {
    const out: ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    token.lastIndex = 0;
    while ((m = token.exec(line))) {
      if (m.index > last) out.push(line.slice(last, m.index));
      const k = `${key}-${m.index}`;
      if (m[1]) out.push(<span key={k} className="mention">{m[1]}</span>);
      else if (m[2]) out.push(<a key={k} href={m[3]} target="_blank" rel="noreferrer">{m[2]}</a>);
      else if (m[4]) out.push(<a key={k} href={m[4]} target="_blank" rel="noreferrer">{m[4].replace(/^https?:\/\/(www\.)?/, '')}</a>);
      else if (m[5]) out.push(<b key={k}>{m[5]}</b>);
      else if (m[6]) out.push(<i key={k}>{m[6]}</i>);
      else if (m[7]) out.push(<code key={k}>{m[7]}</code>);
      last = m.index + m[0].length;
    }
    if (last < line.length) out.push(line.slice(last));
    return out;
  };
  // Group consecutive list lines into lists; other lines stay as lines.
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; ) {
    const bullet = /^\s*[-*]\s+/;
    const num = /^\s*\d+[.)]\s+/;
    const kind = bullet.test(lines[i]!) ? 'ul' : num.test(lines[i]!) ? 'ol' : null;
    if (kind) {
      const items: ReactNode[] = [];
      const re = kind === 'ul' ? bullet : num;
      while (i < lines.length && re.test(lines[i]!)) {
        items.push(<li key={i}>{inline(lines[i]!.replace(re, ''), `l${i}`)}</li>);
        i++;
      }
      blocks.push(kind === 'ul' ? <ul key={`b${i}`}>{items}</ul> : <ol key={`b${i}`}>{items}</ol>);
    } else {
      blocks.push(
        <Fragment key={`t${i}`}>
          {inline(lines[i]!, `t${i}`)}
          {i < lines.length - 1 && !bullet.test(lines[i + 1]!) && !num.test(lines[i + 1]!) && <br />}
        </Fragment>,
      );
      i++;
    }
  }
  return <>{blocks}</>;
}

// --- Not tied to a row ------------------------------------------------------------

/**
 * Notifications are for someone's own row. A guest is urged to sign up; signed
 * in without a row, they're told how to claim one.
 */
function NotLinked() {
  const mode = identityMode();
  if (mode === 'account')
    return (
      <p className="fl-empty notes-empty">
        None of the rows on this sheet is yours yet. Give your row your login email ({getAccount()?.user?.email}), or open it from the
        sidebar and choose “This is me”.
      </p>
    );
  return (
    <div className="notes-signup">
      <span className="notes-signup-icon">
        <Bell size={18} />
      </span>
      <p className="notes-signup-title">Know when it’s about you</p>
      <p className="notes-signup-text">
        Create a free account to get @mentions, comments on your work and changes others make to it, here and by email. It also keeps this
        sheet safe in your workspace.
      </p>
      {mode === 'signedOut' && (
        <button className="btn primary" onClick={requestSignIn}>
          Sign up or log in
        </button>
      )}
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
  const [showHistory, setShowHistory] = useState(false);
  const [collapsed, setCollapsed] = useState(startCollapsed);
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
  // New comments scroll into view, with the box to write the next one; opening
  // a task with comments doesn't scroll the panel away from its details.
  const seen = useRef(-1);
  useEffect(() => {
    const first = seen.current < 0;
    seen.current = items.length;
    const list = end.current?.parentElement;
    if (first) {
      if (list) list.scrollTop = list.scrollHeight;
      return;
    }
    end.current?.scrollIntoView({ block: 'nearest' });
    end.current?.closest('.discussion')?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [items.length]);

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
                    <b>{it.by || 'Guest'}</b>
                    <span>{ago(it.at)}</span>
                    {isMe(it.byId, it.by) && !isReadOnly() && (
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
      {!isReadOnly() && <Composer taskId={taskId} />}
    </div>
  );
}

// --- Sheet activity (changelog) ----------------------------------------------------------

export function ActivityPanel({ onOpenTask, onClose }: { onOpenTask(id: string): void; onClose(): void }) {
  useBackToClose(true, onClose);
  useEscape(onClose);
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
      <aside className="drawer" role="dialog" aria-label="Activity">
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
              <NotLinked />
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
      </div>
    </details>
  );
}
