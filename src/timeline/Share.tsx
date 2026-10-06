import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { calendarLink, changeSharing, getAccess, hasServer, onAccess, shareLink } from '../data/access.ts';
import { getMe } from '../data/identity.ts';
import { store, type UserRow } from '../data/store.ts';
import { Select } from '../ui/Select.tsx';
import { useBackToClose, useEscape } from '../lib/useBackToClose.ts';
import { Check, Close, LinkIcon, Lock, Trash } from '../ui/icons.tsx';

export const useAccess = () => useSyncExternalStore(onAccess, getAccess);

function CopyRow({ label, hint, url }: { label: string; hint: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="share-row">
      <div className="share-row-text">
        <b>{label}</b>
        <span>{hint}</span>
      </div>
      <input className="share-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label={`${label} link`} />
      <button
        className={'btn' + (copied ? ' copied' : '')}
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        {copied ? <Check size={14} /> : <LinkIcon size={14} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function ShareDialog({ onClose }: { onClose(): void }) {
  useBackToClose(true, onClose);
  useEscape(onClose);
  const access = useAccess();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (action: 'enable' | 'rotate' | 'disable', confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setError('');
    try {
      await changeSharing(action);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const server = hasServer();
  const isPrivate = !!access?.private;
  const editor = access?.role === 'edit';

  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share" role="dialog" aria-label="Share">
        <header className="modal-head">
          <h2>Share this sheet</h2>
          <button className="tb-search-btn" aria-label="Close" onClick={onClose}>
            <Close />
          </button>
        </header>
        <div className="share-body">
          {!server ? (
            <p className="share-note">
              This sheet lives only in this browser. Deploy prepweek to Cloudflare (see the README) to share it: everyone with a
              link then sees changes live.
            </p>
          ) : !isPrivate ? (
            <>
              <div className="share-state open">
                <span className="share-icon">
                  <LinkIcon />
                </span>
                <div>
                  <b>Anyone with the address can edit</b>
                  <span>Fine for a demo. Turn on private links to choose who can edit and who can only look.</span>
                </div>
              </div>
              <CopyRow label="Sheet address" hint="Opens and edits this sheet" url={shareLink()} />
              {editor && (
                <button className="btn primary big" disabled={busy} onClick={() => act('enable')}>
                  <Lock />
                  Turn on private links
                </button>
              )}
            </>
          ) : editor ? (
            <>
              <div className="share-state private">
                <span className="share-icon">
                  <Lock />
                </span>
                <div>
                  <b>Private: only people with a link</b>
                  <span>The address alone no longer opens this sheet.</span>
                </div>
              </div>
              <CopyRow label="Can edit" hint="Plan, move and comment" url={shareLink(access?.edit)} />
              <CopyRow label="Can view" hint="Sees everything live, changes nothing" url={shareLink(access?.view)} />
              <div className="share-actions">
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => act('rotate', 'Reset both links? Everyone using the current links is disconnected until they get a new one.')}
                >
                  Reset links
                </button>
                <button
                  className="btn danger ghost"
                  disabled={busy}
                  onClick={() => act('disable', 'Make the sheet open to anyone with its address again?')}
                >
                  Turn off private links
                </button>
              </div>
            </>
          ) : (
            <p className="share-note">You have a view-only link. Ask someone who can edit for an edit link.</p>
          )}
          {error && <p className="editor-error">{error}</p>}
          <p className="share-foot">
            Links are keys: anyone holding one gets that access. For sign-in with company accounts, put the app behind Cloudflare
            Access.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Shown instead of the sheet when we may not open it. */
export function LockScreen({ signedIn, deleted, onSignIn }: { signedIn: boolean; deleted?: boolean; onSignIn(): void }) {
  if (deleted)
    return (
      <div className="lock">
        <div className="lock-card">
          <span className="lock-icon">
            <Trash size={22} />
          </span>
          <h1>This sheet was deleted</h1>
          <p>Someone removed it from its workspace, so it can’t be opened any more.</p>
          <button
            className="btn primary big"
            onClick={() => {
              try {
                localStorage.removeItem('prepweek:lastSheet');
              } catch {}
              location.href = '/app';
            }}
          >
            Go to your sheets
          </button>
        </div>
      </div>
    );
  return (
    <div className="lock">
      <div className="lock-card">
        <span className="lock-icon">
          <Lock size={22} />
        </span>
        <h1>This sheet is private</h1>
        <p>
          {signedIn
            ? 'Your account isn’t in the workspace this sheet belongs to. Ask an admin to invite you, or ask for a share link.'
            : 'Log in if it belongs to your workspace, or ask someone on the team for a share link.'}
        </p>
        {!signedIn && (
          <button className="btn primary big" onClick={onSignIn}>
            Log in
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Subscribe to the plan in Google Calendar, Apple Calendar or Outlook: your
 * own tasks, someone else's, or everyone's. The calendar app refreshes it.
 */
export function CalendarDialog({ onClose }: { onClose(): void }) {
  useBackToClose(true, onClose);
  useEscape(onClose);
  const people = store
    .getRowIds('users')
    .map((id) => ({ id, ...(store.getRow('users', id) as UserRow) }))
    .sort((a, b) => a.order - b.order);
  const me = getMe().personId;
  const [who, setWho] = useState(me && people.some((p) => p.id === me) ? me : 'all');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!hasServer()) return;
    let live = true;
    setUrl('');
    calendarLink(who)
      .then((u) => live && setUrl(u))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [who]);
  const options = [{ value: 'all', label: 'Everyone (the whole plan)' }, ...people.map((p) => ({ value: p.id, label: p.id === me ? `${p.name} (you)` : p.name || 'Unnamed' }))];
  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share" role="dialog" aria-label="Add to your calendar">
        <header className="modal-head">
          <h2>Add to your calendar</h2>
          <button className="tb-search-btn" aria-label="Close" onClick={onClose}>
            <Close />
          </button>
        </header>
        <div className="share-body">
          {!hasServer() ? (
            <p className="share-note">This sheet lives only in this browser. Calendar links need the hosted version.</p>
          ) : (
            <>
              <label className="cal-who">
                <span>Whose plan</span>
                <Select label="Whose plan" value={who} options={options} onChange={setWho} />
              </label>
              {url ? <CopyRow label="Calendar address" hint="Updates by itself, about every hour" url={url} /> : !error && <p className="share-note">Making a link…</p>}
              {url && (
                <a className="btn primary big cal-open" href={url.replace(/^https?:/, 'webcal:')}>
                  Open in my calendar app
                </a>
              )}
              <ul className="cal-how">
                <li>
                  <b>Google Calendar:</b> Other calendars, <i>+</i>, From URL, then paste the address.
                </li>
                <li>
                  <b>Apple Calendar:</b> File, New Calendar Subscription.
                </li>
                <li>
                  <b>Outlook:</b> Add calendar, Subscribe from web.
                </li>
              </ul>
            </>
          )}
          {error && <p className="editor-error">{error}</p>}
          <p className="share-foot">Anyone with this address can see these tasks. Resetting the sheet’s share links turns old calendar addresses off.</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
