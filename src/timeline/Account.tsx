import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  acceptInvite,
  addSheet,
  authConfig,
  createWorkspace,
  deleteSheet,
  deleteWorkspace,
  forgetLastSheet,
  forgetMySheet,
  getMe,
  cachedPeople,
  getPeople,
  prefetchPeople,
  googleUrl,
  inviteInfo,
  inviteToWorkspace,
  mySheets,
  newSheetId,
  onMe,
  rememberMySheet,
  removeMember,
  setDigest,
  deleteAccount,
  renameSheet,
  renameWorkspace,
  revokeInvite,
  sendMagicLink,
  setMemberRole,
  signOut,
  type AuthConfig,
  type People,
  type Workspace,
} from '../data/account.ts';
import { getAccess, getSheetId, onAccess, reloadAccess } from '../data/access.ts';
import { store } from '../data/store.ts';
import { useBackToClose, useEscape } from '../lib/useBackToClose.ts';
import { Select, type Option } from '../ui/Select.tsx';
import { ActionMenu } from '../ui/Menu.tsx';
import { Check, ChevronDown, Close, LinkIcon, Pencil, People as PeopleIcon, Plus, Trash } from '../ui/icons.tsx';
import { Logo, Wordmark } from '../ui/brand.tsx';
import { PlansDialog } from './PlansDialog.tsx';

export const useAccount = () => useSyncExternalStore(onMe, getMe);
const useAccess = () => useSyncExternalStore(onAccess, getAccess);

const ROLES: Option<'member' | 'admin'>[] = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
];

const go = (sheetId: string) => {
  location.href = `/s/${encodeURIComponent(sheetId)}`;
};

/** The sheet we're on is gone: open another one of yours (or start fresh). */
const leaveSheet = () => {
  const next = getMe()?.workspaces.flatMap((w) => w.sheets)[0];
  forgetLastSheet();
  if (next) go(next.id);
  else location.href = '/app';
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';

function Avatar({ name, src, size = 26 }: { name: string; src?: string; size?: number }) {
  return src ? (
    <img className="acct-avatar" src={src} alt="" width={size} height={size} referrerPolicy="no-referrer" />
  ) : (
    <span className="acct-avatar" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {initials(name)}
    </span>
  );
}

/** Close a toolbar <details> menu. */
const closeMenu = (el: HTMLElement | null) => el?.closest('details')?.removeAttribute('open');

// --- Saving a sheet started without an account -------------------------------------

/**
 * Once signed in, a sheet started on this device without an account is
 * saved into your first workspace automatically.
 */
const saving = new Set<string>();

/** Nothing on this sheet yet (no people, no work). */
const isEmptySheet = () => !store.hasTable('users') && !store.hasTable('tasks');
const useEmptySheet = () =>
  useSyncExternalStore((cb) => {
    const id = store.addTableIdsListener(cb);
    return () => void store.delListener(id);
  }, isEmptySheet);

export function useAutoSave() {
  const me = useAccount();
  const access = useAccess();
  // An empty plan isn't worth keeping: it would only clutter the workspace
  // (and be where you land next time). It's saved once it has something.
  const empty = useEmptySheet();
  useEffect(() => {
    const id = getSheetId();
    const ws = me?.workspaces[0];
    if (empty || !me?.user || !ws || !access || access.workspace !== null || access.role !== 'edit') return;
    if (!mySheets().includes(id) || saving.has(id)) return;
    saving.add(id);
    void addSheet(ws.id, `Plan ${ws.sheets.length + 1}`, id)
      .then(() => {
        forgetMySheet(id);
        return reloadAccess();
      })
      .catch((e) => console.warn('Could not save this plan to your workspace', e))
      .finally(() => saving.delete(id));
  }, [me, access, empty]);
}

// --- Sheet switcher (left of the toolbar) -----------------------------------------

/** A name edited in place: Enter or leaving saves, Escape cancels. */
function RenameInput({ value, label, onDone }: { value: string; label: string; onDone(v: string | null): void }) {
  return (
    <input
      className="tree-rename"
      autoFocus
      defaultValue={value}
      aria-label={label}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => onDone(e.currentTarget.value.trim() || null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = '';
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function SheetSwitcher({ onSignIn, onWorkspace }: { onSignIn(): void; onWorkspace(id: string): void }) {
  const me = useAccount();
  const access = useAccess();
  const ref = useRef<HTMLDetailsElement>(null);
  /** The workspace or sheet whose name is being edited. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState('');
  const current = getSheetId();
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Window title: the sheet's name. An installed app's window already shows
  // "Prepweek - …" in front of it; a browser tab gets it appended.
  const titleName = me ? me.workspaces.flatMap((w) => w.sheets).find((x) => x.id === current)?.name || access?.name || '' : '';
  useEffect(() => {
    const standalone = matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches;
    document.title = !titleName ? 'Prepweek' : standalone ? titleName : `${titleName} – Prepweek`;
  }, [titleName]);

  // No accounts here (dev server, offline): just the brand.
  if (!me) {
    return (
      <a className="brand" href="/" title="Prepweek home" aria-label="Prepweek home">
        <Logo />
        <Wordmark className="brand-name" />
      </a>
    );
  }

  // Your own sheets are known from the account right away (and stay fresh
  // after a rename); other sheets wait for the access check.
  const home = me.workspaces.find((w) => w.sheets.some((s) => s.id === current));
  const ws = home ? { id: home.id, name: home.name } : (access?.workspace ?? null);
  const name = home?.sheets.find((s) => s.id === current)?.name || access?.name || (ws ? 'Untitled sheet' : 'Untitled plan');
  const newSheet = async (workspace?: Workspace) => {
    setError('');
    try {
      if (workspace) go(await addSheet(workspace.id, `Plan ${workspace.sheets.length + 1}`));
      else {
        const id = newSheetId();
        rememberMySheet(id);
        go(id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="brand switcher">
      <a className="brand-home" href="/" title="Prepweek home" aria-label="Prepweek home">
        <Logo />
      </a>
      <details className="tb-dd sheet-dd" ref={ref} onToggle={(e) => {
          if (e.currentTarget.open) me.workspaces.forEach((w) => prefetchPeople(w.id));
          else {
            setRenaming(null);
            setError('');
          }
        }}>
        <summary className="sheet-btn" title="Sheets and workspaces">
          <span className="sheet-name">{name}</span>
          <span className="sheet-ws">{ws ? ws.name : me.user ? 'Not in a workspace' : 'Not saved to an account'}</span>
          <ChevronDown size={14} />
        </summary>
        <div className="tb-menu sheet-menu">
          {!me.user && (
            <div className="sheet-save">
              <b>Keep this plan</b>
              <span>It lives at this address and in this browser. Sign up to save it to an account and invite your team.</span>
              <button
                className="btn primary"
                onClick={() => {
                  closeMenu(ref.current);
                  onSignIn();
                }}
              >
                Sign up or log in
              </button>
            </div>
          )}
          <div className="tree">
            {me.workspaces.map((w) => {
              const admin = w.role === 'admin';
              return (
                <div key={w.id} className="tree-ws">
                  <div className="tree-head">
                    {renaming === w.id ? (
                      <RenameInput
                        value={w.name}
                        label="Workspace name"
                        onDone={(v) => {
                          setRenaming(null);
                          if (v && v !== w.name) void act(() => renameWorkspace(w.id, v));
                        }}
                      />
                    ) : (
                      <span className="tree-ws-name">{w.name}</span>
                    )}
                    <ActionMenu
                      label={`${w.name} options`}
                      className="tree-more"
                      actions={[
                        {
                          id: 'people',
                          label: admin ? 'People and invites' : 'People',
                          icon: <PeopleIcon />,
                          onAction: () => {
                            closeMenu(ref.current);
                            onWorkspace(w.id);
                          },
                        },
                        ...(admin
                          ? [
                              { id: 'rename', label: 'Rename', icon: <Pencil size={14} />, onAction: () => setRenaming(w.id) },
                              {
                                id: 'delete',
                                label: 'Delete workspace',
                                icon: <Trash size={14} />,
                                danger: true,
                                onAction: () => {
                                  const n = w.sheets.length;
                                  if (!confirm(`Delete “${w.name}”${n ? ` and its ${n === 1 ? 'sheet' : `${n} sheets`}` : ''} for everyone? This can’t be undone.`)) return;
                                  const here = w.sheets.some((x) => x.id === current);
                                  void act(async () => {
                                    await deleteWorkspace(w.id);
                                    if (here) leaveSheet();
                                  });
                                },
                              },
                            ]
                          : []),
                      ]}
                    />
                    <button className="tree-add" title="New sheet" aria-label={`New sheet in ${w.name}`} onClick={() => void newSheet(w)}>
                      <Plus />
                    </button>
                  </div>
                  {w.sheets.map((sh) => (
                    <div key={sh.id} className={'tree-sheet' + (sh.id === current ? ' on' : '')}>
                      {renaming === sh.id ? (
                        <RenameInput
                          value={sh.name}
                          label="Sheet name"
                          onDone={(v) => {
                            setRenaming(null);
                            if (v && v !== sh.name)
                              void act(async () => {
                                await renameSheet(sh.id, v);
                                if (sh.id === current) await reloadAccess();
                              });
                          }}
                        />
                      ) : (
                        <a className="tree-link" href={`/s/${encodeURIComponent(sh.id)}`}>
                          {sh.name}
                        </a>
                      )}
                      <ActionMenu
                        label={`${sh.name} options`}
                        className="tree-more"
                        actions={[
                          { id: 'rename', label: 'Rename', icon: <Pencil size={14} />, onAction: () => setRenaming(sh.id) },
                          ...(admin
                            ? [
                                {
                                  id: 'delete',
                                  label: 'Delete sheet',
                                  icon: <Trash size={14} />,
                                  danger: true,
                                  onAction: () => {
                                    if (!confirm(`Delete “${sh.name}” for everyone? It can’t be opened afterwards.`)) return;
                                    void act(async () => {
                                      await deleteSheet(sh.id);
                                      if (sh.id === current) leaveSheet();
                                    });
                                  },
                                },
                              ]
                            : []),
                        ]}
                      />
                    </div>
                  ))}
                  {w.sheets.length === 0 && (
                    <button className="tree-empty" onClick={() => void newSheet(w)}>
                      No sheets yet · add one
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {!me.user && (
            <button className="menu-item" onClick={() => void newSheet()}>
              <Plus />
              New plan
            </button>
          )}
          {me.user && (
            <>
              {me.workspaces.length > 0 && <div className="menu-sep" />}
              <button
                className="menu-item tree-new-ws"
                onClick={async () => {
                  const n = prompt('Name the new workspace');
                  if (n?.trim()) {
                    const id = await createWorkspace(n);
                    closeMenu(ref.current);
                    onWorkspace(id);
                  }
                }}
              >
                <Plus />
                New workspace
              </button>
            </>
          )}
          {error && <p className="editor-error">{error}</p>}
        </div>
      </details>
    </div>
  );
}

// --- Account button (right of the toolbar) ---------------------------------------------

export function AccountButton({ onSignIn, onWorkspace }: { onSignIn(): void; onWorkspace(id: string): void }) {
  const me = useAccount();
  const access = useAccess();
  const ref = useRef<HTMLDetailsElement>(null);
  if (!me) return null;
  if (!me.user)
    return (
      <button className="btn tb-signup" onClick={onSignIn} title="Log in or sign up">
        Log in
      </button>
    );
  const u = me.user;
  const ws = access?.workspace ?? me.workspaces[0];
  return (
    <details className="tb-dd tb-account" ref={ref} onToggle={(e) => e.currentTarget.open && me?.workspaces.forEach((w) => prefetchPeople(w.id))}>
      <summary className="acct-btn" aria-label="Account" title={u.email}>
        <Avatar name={u.name} src={u.avatar} />
      </summary>
      <div className="tb-menu acct-menu">
        <div className="acct-head">
          <Avatar name={u.name} src={u.avatar} size={34} />
          <div>
            <b>{u.name}</b>
            <span>{u.email}</span>
          </div>
        </div>
        {ws && (
          <button
            className="menu-item"
            onClick={() => {
              closeMenu(ref.current);
              onWorkspace(ws.id);
            }}
          >
            <PeopleIcon />
            <span className="menu-item-text">People in {ws.name}</span>
          </button>
        )}
        <a className="menu-item" href="/">
          Prepweek home
        </a>
        {me.digest && (
          <button
            className="menu-item menu-toggle"
            role="menuitemcheckbox"
            aria-checked={me.digest.on}
            title="An email on workday mornings: what’s on your plate today and what changed on your work"
            onClick={() => void setDigest(!me.digest!.on).catch(() => {})}
          >
            Daily email digest
            <span className={'switch' + (me.digest.on ? ' on' : '')} aria-hidden />
          </button>
        )}
        <div className="menu-sep" />
        <a className="menu-item" href="/api/me/export" download>
          Export my data
        </a>
        <button className="menu-item" onClick={() => void signOut().then(() => location.assign('/'))}>
          Log out
        </button>
        <button
          className="menu-item danger-item"
          onClick={() => {
            // Workspaces only this person is in go with the account.
            const alone = me.workspaces.filter((w) => w.role === 'admin');
            const msg = [
              `Delete the account ${u.email}?`,
              '',
              'Workspaces where you are the only member are deleted with all their sheets. In shared workspaces you are removed; the plan stays for the others.',
              alone.length ? `\nWorkspaces you admin: ${alone.map((w) => w.name).join(', ')}.` : '',
              '\nExport your data first if you want to keep a copy. This cannot be undone.',
            ].join('\n');
            if (confirm(msg)) void deleteAccount().then(() => location.assign('/'), (e) => alert(e instanceof Error ? e.message : String(e)));
          }}
        >
          Delete account…
        </button>
      </div>
    </details>
  );
}

// --- Sign in / sign up --------------------------------------------------------------------

function SignInForm({ next, compact, email: initialEmail = '' }: { next: string; compact?: boolean; email?: string }) {
  /** null while loading, 'error' when the server couldn't be asked. */
  const [cfg, setCfg] = useState<AuthConfig | 'error' | null>(null);
  const [email, setEmail] = useState(initialEmail);
  const [state, setState] = useState<{ sent?: boolean; devLink?: string; error?: string; busy?: boolean }>({});
  const load = () => {
    setCfg(null);
    authConfig()
      .then((c) => setCfg(typeof c?.google === 'boolean' && typeof c?.email === 'boolean' ? c : 'error'))
      .catch(() => setCfg('error'));
  };
  useEffect(load, []);

  if (state.sent || state.devLink)
    return (
      <div className="signin-sent">
        <span className="share-icon">
          <Check />
        </span>
        <b>Check your email</b>
        <p>
          We sent a sign-in link to <b>{email}</b>. It works once, for 20 minutes.
        </p>
        {state.devLink && (
          <p className="signin-dev">
            No mail provider is set up (local dev), so here is the link: <a href={state.devLink}>Sign in as {email}</a>
          </p>
        )}
        <button className="link-btn" onClick={() => setState({})}>
          Use another email
        </button>
      </div>
    );

  if (cfg === null)
    return (
      <div className={'signin loading' + (compact ? ' compact' : '')}>
        <span className="spinner" aria-label="Loading" />
      </div>
    );
  if (cfg === 'error')
    return (
      <div className={'signin' + (compact ? ' compact' : '')}>
        <p className="editor-error">Couldn’t reach the sign-in server. Check your connection and try again.</p>
        <button className="btn" onClick={load}>
          Try again
        </button>
      </div>
    );

  return (
    <div className={'signin' + (compact ? ' compact' : '')}>
      {cfg.google && (
        <>
          <a className="btn big google" href={googleUrl(next)}>
            <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
              <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
            </svg>
            Continue with Google
          </a>
          {cfg.email && <div className="signin-or">or</div>}
        </>
      )}
      {cfg.email && (
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setState({ busy: true });
          try {
            setState(await sendMagicLink(email, next));
          } catch (err) {
            setState({ error: err instanceof Error ? err.message : String(err) });
          }
        }}
      >
        <input type="email" required autoFocus placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
        <button className="btn primary big" disabled={state.busy || !email}>
          {state.busy ? 'Sending…' : 'Email me a sign-in link'}
        </button>
      </form>
      )}
      {state.error && <p className="editor-error">{state.error}</p>}
      {!cfg.email && !cfg.google && (
        <p className="editor-error">This server has no sign-in set up yet: add Google or email (Mandrill) keys to the worker, see the README.</p>
      )}
      {(cfg.email || cfg.google) && (
        <p className="signin-foot">
          New here? {cfg.email ? 'The same link creates your account.' : 'Signing in creates your account.'} No password needed. By continuing you
          agree to the{' '}
          <a href="/terms" target="_blank">
            terms
          </a>{' '}
          and{' '}
          <a href="/privacy" target="_blank">
            privacy policy
          </a>
          .
        </p>
      )}
    </div>
  );
}

/** `next`: where signing in leads (default: back to this page). */
/**
 * Where to land after logging in: back here, unless this is an empty plan
 * started without an account; then your own sheets (/app) are the point.
 */
const afterSignIn = () => (getAccess()?.workspace == null && isEmptySheet() ? '/app' : location.pathname + location.search);

export function SignInDialog({ onClose, next = afterSignIn() }: { onClose(): void; next?: string }) {
  useBackToClose(true, onClose);
  useEscape(onClose);
  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal signin-modal" role="dialog" aria-label="Sign up or log in">
        <header className="modal-head">
          <h2>Sign up or log in</h2>
          <button className="tb-search-btn" aria-label="Close" onClick={onClose}>
            <Close />
          </button>
        </header>
        <div className="share-body">
          <p className="share-note">Save this plan to your account, invite your team and open it from anywhere.</p>
          <SignInForm next={next} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

// --- Workspace people & invites -----------------------------------------------------------

export function WorkspaceDialog({ workspaceId, onClose }: { workspaceId: string; onClose(): void }) {
  useBackToClose(true, onClose);
  useEscape(onClose);
  const me = useAccount();
  const ws = me?.workspaces.find((w) => w.id === workspaceId);
  const [people, setPeople] = useState<People | null>(() => cachedPeople(workspaceId));
  const [error, setError] = useState('');
  // Not fetched yet: wait a moment before showing, so the list doesn't jump in.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 700);
    return () => clearTimeout(t);
  }, []);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [link, setLink] = useState<{ link: string; sent: boolean; email: string } | null>(null);
  const [plans, setPlans] = useState(false);
  const reload = () =>
    getPeople(workspaceId)
      .then(setPeople)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => void reload(), [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  const admin = people?.role === 'admin';
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!people && !error && !waited) return null;

  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal ws-modal" role="dialog" aria-label="Workspace">
        <header className="modal-head">
          {admin && ws ? (
            <input
              className="ws-name"
              defaultValue={ws.name}
              aria-label="Workspace name"
              onBlur={(e) => e.currentTarget.value.trim() !== ws.name && void run(() => renameWorkspace(workspaceId, e.currentTarget.value))}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          ) : (
            <h2>{ws?.name ?? 'Workspace'}</h2>
          )}
          <button className="tb-search-btn" aria-label="Close" onClick={onClose}>
            <Close />
          </button>
        </header>
        <div className="share-body">
          {ws?.plan && (
            <div className="ws-plan">
              <div>
                <b>{ws.plan.name}</b>
                <span>
                  {ws.plan.used} of {ws.plan.limit} people planned · everyone can sign in
                </span>
              </div>
              <span className="load" aria-hidden>
                <span className="load-fill" style={{ width: `${Math.min(100, (ws.plan.used / ws.plan.limit) * 100)}%` }} />
              </span>
              {admin && (
                <button className="btn" onClick={() => setPlans(true)}>
                  {ws.plan.paid && ['active', 'trialing', 'past_due'].includes(ws.plan.paid.status) ? 'Plan and billing' : 'Upgrade'}
                </button>
              )}
            </div>
          )}
          {plans && <PlansDialog workspaceId={workspaceId} onClose={() => setPlans(false)} />}
          {admin && (
            <form
              className="ws-invite"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const r = await inviteToWorkspace(workspaceId, email, role);
                  setLink({ ...r, email });
                  setEmail('');
                });
              }}
            >
              <input type="email" required placeholder="Invite by email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
              <Select label="Role" value={role} options={ROLES} onChange={(r) => setRole(r)} />
              <button className="btn primary">Invite</button>
            </form>
          )}
          {link && (
            <div className="ws-link">
              <span>
                {link.sent ? `Invite sent to ${link.email}. You can also share the link:` : `Send ${link.email} this link to join:`}
              </span>
              <div className="share-row single">
                <input className="share-url" readOnly value={link.link} onFocus={(e) => e.currentTarget.select()} />
                <button className="btn" onClick={() => void navigator.clipboard?.writeText(link.link)}>
                  <LinkIcon size={14} />
                  Copy
                </button>
              </div>
            </div>
          )}
          <h3 className="ws-h">Members</h3>
          <div className="ws-list">
            {people?.members.map((m) => (
              <div key={m.id} className="ws-row">
                <Avatar name={m.name} src={m.avatar} size={30} />
                <div className="ws-who">
                  <b>
                    {m.name}
                    {m.id === me?.user?.id && <span className="dim"> (you)</span>}
                  </b>
                  <span>{m.email}</span>
                </div>
                {admin ? (
                  <Select label={`Role of ${m.name}`} value={m.role} options={ROLES} onChange={(r) => void run(() => setMemberRole(workspaceId, m.id, r))} />
                ) : (
                  <span className="ws-role">{m.role === 'admin' ? 'Admin' : 'Member'}</span>
                )}
                {(admin || m.id === me?.user?.id) && (
                  <button
                    className="tb-search-btn"
                    title={m.id === me?.user?.id ? 'Leave workspace' : 'Remove from workspace'}
                    aria-label={m.id === me?.user?.id ? 'Leave workspace' : `Remove ${m.name}`}
                    onClick={() =>
                      confirm(m.id === me?.user?.id ? 'Leave this workspace?' : `Remove ${m.name} from the workspace?`) &&
                      void run(() => removeMember(workspaceId, m.id))
                    }
                  >
                    <Trash />
                  </button>
                )}
              </div>
            ))}
          </div>
          {admin && !!people?.invites.length && (
            <>
              <h3 className="ws-h">Pending invites</h3>
              <div className="ws-list">
                {people.invites.map((i) => (
                  <div key={i.token} className="ws-row">
                    <Avatar name={i.email} size={30} />
                    <div className="ws-who">
                      <b>{i.email}</b>
                      <span>Invited as {i.role}</span>
                    </div>
                    <button className="link-btn" onClick={() => void navigator.clipboard?.writeText(`${location.origin}/invite/${i.token}`)}>
                      Copy link
                    </button>
                    <button className="tb-search-btn" aria-label={`Revoke invite for ${i.email}`} onClick={() => void run(() => revokeInvite(i.token))}>
                      <Close />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          {ws && (
            <>
              <h3 className="ws-h">Sheets</h3>
              <div className="ws-list">
                {ws.sheets.map((s) => (
                  <div key={s.id} className="ws-row">
                    <a className="ws-sheet" href={`/s/${encodeURIComponent(s.id)}`}>
                      {s.name}
                    </a>
                    {admin && (
                      <button
                        className="tb-search-btn"
                        aria-label={`Delete ${s.name}`}
                        title="Delete sheet"
                        onClick={() =>
                          confirm(`Delete “${s.name}” for everyone? It can’t be opened afterwards.`) &&
                          void run(async () => {
                            await deleteSheet(s.id);
                            if (s.id === getSheetId()) leaveSheet();
                          })
                        }
                      >
                        <Trash />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          {error && <p className="editor-error">{error}</p>}
          <p className="share-foot">Admins invite and remove people and manage sheets. Members plan on every sheet in the workspace.</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// --- /invite/<token> --------------------------------------------------------------------------

export function InviteScreen({ token }: { token: string }) {
  const me = useAccount();
  const [info, setInfo] = useState<{ workspace: string; inviter: string; email: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    inviteInfo(token)
      .then(setInfo)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [token]);
  const join = async () => {
    try {
      const wsId = await acceptInvite(token);
      const ws = getMe()?.workspaces.find((w) => w.id === wsId);
      location.href = ws?.sheets[0] ? `/s/${encodeURIComponent(ws.sheets[0].id)}` : '/';
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="lock invite">
      <div className="lock-card">
        <span className="lock-icon">
          <Logo size={24} />
        </span>
        {error ? (
          <>
            <h1>Invite unavailable</h1>
            <p>{error}</p>
            <a className="btn" href="/app">
              Open Prepweek
            </a>
          </>
        ) : !info ? (
          <p>Loading…</p>
        ) : (
          <>
            <h1>Join {info.workspace}</h1>
            <p>
              {info.inviter} invited {info.email} to plan together on prepweek.
            </p>
            {me?.user ? (
              <>
                <button className="btn primary big" onClick={() => void join()}>
                  Join as {me.user.name}
                </button>
                {me.user.email !== info.email && <p className="signin-foot">You’re signed in as {me.user.email}.</p>}
              </>
            ) : (
              <SignInForm next={location.pathname} compact email={info.email} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
