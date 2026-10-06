import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  acceptInvite,
  addSheet,
  authConfig,
  createWorkspace,
  deleteSheet,
  forgetLastSheet,
  forgetMySheet,
  getMe,
  getPeople,
  googleUrl,
  inviteInfo,
  inviteToWorkspace,
  mySheets,
  newSheetId,
  onMe,
  rememberMySheet,
  removeMember,
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
import { useBackToClose, useEscape } from '../lib/useBackToClose.ts';
import { Check, ChevronDown, Close, LinkIcon, Logo, People as PeopleIcon, Plus, Trash } from '../ui/icons.tsx';

export const useAccount = () => useSyncExternalStore(onMe, getMe);
const useAccess = () => useSyncExternalStore(onAccess, getAccess);

const go = (sheetId: string) => {
  location.href = `/s/${encodeURIComponent(sheetId)}`;
};

/** The sheet we're on is gone: open another one of yours (or start fresh). */
const leaveSheet = () => {
  const next = getMe()?.workspaces.flatMap((w) => w.sheets)[0];
  forgetLastSheet();
  if (next) go(next.id);
  else location.href = '/';
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

export function useAutoSave() {
  const me = useAccount();
  const access = useAccess();
  useEffect(() => {
    const id = getSheetId();
    const ws = me?.workspaces[0];
    if (!me?.user || !ws || !access || access.workspace !== null || access.role !== 'edit') return;
    if (!mySheets().includes(id) || saving.has(id)) return;
    saving.add(id);
    void addSheet(ws.id, `Plan ${ws.sheets.length + 1}`, id)
      .then(() => {
        forgetMySheet(id);
        return reloadAccess();
      })
      .catch((e) => console.warn('Could not save this plan to your workspace', e))
      .finally(() => saving.delete(id));
  }, [me, access]);
}

// --- Sheet switcher (left of the toolbar) -----------------------------------------

export function SheetSwitcher({ onSignIn, onWorkspace }: { onSignIn(): void; onWorkspace(id: string): void }) {
  const me = useAccount();
  const access = useAccess();
  const ref = useRef<HTMLDetailsElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState('');
  const current = getSheetId();

  // No accounts here (dev server, offline): just the brand.
  if (!me) {
    return (
      <div className="brand">
        <Logo />
        <span className="brand-name">prepweek</span>
      </div>
    );
  }

  // Your own sheets are known from the account right away (and stay fresh
  // after a rename); other sheets wait for the access check.
  const home = me.workspaces.find((w) => w.sheets.some((s) => s.id === current));
  const ws = home ? { id: home.id, name: home.name } : (access?.workspace ?? null);
  const name = home?.sheets.find((s) => s.id === current)?.name || access?.name || (ws ? 'Untitled sheet' : 'Untitled plan');
  const member = !!home || (!!ws && me.workspaces.some((w) => w.id === ws.id));
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
      <Logo />
      <details className="tb-dd sheet-dd" ref={ref} onToggle={(e) => !e.currentTarget.open && (setRenaming(false), setError(''))}>
        <summary className="sheet-btn" title="Sheets and workspaces">
          <span className="sheet-name">{name}</span>
          <span className="sheet-ws">{ws ? ws.name : me.user ? 'Not in a workspace' : 'Not saved to an account'}</span>
          <ChevronDown size={14} />
        </summary>
        <div className="tb-menu sheet-menu">
          {renaming && member ? (
            <form
              className="view-save"
              onSubmit={async (e) => {
                e.preventDefault();
                const v = new FormData(e.currentTarget).get('name') as string;
                try {
                  await renameSheet(current, v);
                  await reloadAccess();
                  setRenaming(false);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              <input name="name" autoFocus defaultValue={name} aria-label="Sheet name" />
              <button className="btn primary small">Save</button>
            </form>
          ) : (
            member && (
              <button className="menu-item" onClick={() => setRenaming(true)}>
                Rename “{name}”
              </button>
            )
          )}
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
          {me.workspaces.map((w) => (
            <div key={w.id} className="sheet-group">
              <div className="sheet-group-head">
                <span>{w.name}</span>
                <button
                  className="link-btn"
                  onClick={() => {
                    closeMenu(ref.current);
                    onWorkspace(w.id);
                  }}
                >
                  <PeopleIcon />
                  People
                </button>
              </div>
              {w.sheets.map((s) => (
                <a key={s.id} className={'tb-person' + (s.id === current ? ' on' : '')} href={`/s/${encodeURIComponent(s.id)}`}>
                  <span className="fl-label">{s.name}</span>
                  {s.id === current && (
                    <span className="tb-check">
                      <Check size={14} />
                    </span>
                  )}
                </a>
              ))}
              <button className="menu-item" onClick={() => void newSheet(w)}>
                <Plus />
                New sheet
              </button>
            </div>
          ))}
          {!me.user && (
            <button className="menu-item" onClick={() => void newSheet()}>
              <Plus />
              New plan
            </button>
          )}
          {me.user && (
            <button
              className="menu-item"
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
      <button className="btn tb-signup" onClick={onSignIn}>
        Sign up
      </button>
    );
  const u = me.user;
  const ws = access?.workspace ?? me.workspaces[0];
  return (
    <details className="tb-dd tb-account" ref={ref}>
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
            {ws.name}: people
          </button>
        )}
        <div className="menu-sep" />
        <button className="menu-item" onClick={() => void signOut().then(() => location.reload())}>
          Sign out
        </button>
      </div>
    </details>
  );
}

// --- Sign in / sign up --------------------------------------------------------------------

function SignInForm({ next, compact, email: initialEmail = '' }: { next: string; compact?: boolean; email?: string }) {
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [email, setEmail] = useState(initialEmail);
  const [state, setState] = useState<{ sent?: boolean; devLink?: string; error?: string; busy?: boolean }>({});
  useEffect(() => {
    authConfig()
      .then(setCfg)
      .catch(() => setCfg({ email: false, google: false, devLinks: false }));
  }, []);

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

  return (
    <div className={'signin' + (compact ? ' compact' : '')}>
      {cfg?.google && (
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
          <div className="signin-or">or</div>
        </>
      )}
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
      {state.error && <p className="editor-error">{state.error}</p>}
      {cfg && !cfg.email && !cfg.google && <p className="editor-error">Sign-in isn’t configured on this server yet (see the README).</p>}
      <p className="signin-foot">New here? The same link creates your account. No password needed.</p>
    </div>
  );
}

export function SignInDialog({ onClose }: { onClose(): void }) {
  useBackToClose(true, onClose);
  useEscape(onClose);
  const next = location.pathname + location.search;
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
  const [people, setPeople] = useState<People | null>(null);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [link, setLink] = useState<{ link: string; sent: boolean; email: string } | null>(null);
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
              <select value={role} onChange={(e) => setRole(e.currentTarget.value as 'member' | 'admin')} aria-label="Role">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
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
                  <select value={m.role} onChange={(e) => void run(() => setMemberRole(workspaceId, m.id, e.currentTarget.value as 'admin' | 'member'))} aria-label={`Role of ${m.name}`}>
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
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
          <Logo size={26} />
        </span>
        {error ? (
          <>
            <h1>Invite unavailable</h1>
            <p>{error}</p>
            <a className="btn" href="/">
              Open prepweek
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
