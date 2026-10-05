import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { canRedo, canUndo, onHistoryChange, redo, store, undo } from '../data/store.ts';
import { getSyncStatus, onSyncStatus } from '../data/sync.ts';
import { seed } from '../data/seed.ts';
import { ZOOM_MAX, ZOOM_MIN } from './viewport.ts';
import type { TimelineModel } from './model.ts';

interface Props {
  colW: number;
  model: TimelineModel;
  onZoom(w: number): void;
  onToday(): void;
  onPage(dir: -1 | 1): void;
  query: string;
  onQuery(q: string): void;
  matchCount: number;
  onNextMatch(dir?: 1 | -1): void;
  onFocusPerson(id: string, additive?: boolean): void;
  onClearFocus(): void;
}

const SearchIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
    <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const PeopleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <circle cx="6" cy="5.5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M1.5 13.5c.6-2.4 2.3-3.6 4.5-3.6s3.9 1.2 4.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M11 3.2a2.4 2.4 0 0 1 0 4.6M12.3 9.9c1.1.5 1.9 1.6 2.2 3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const historySnapshot = () => (canUndo() ? 1 : 0) | (canRedo() ? 2 : 0);

export function Toolbar(props: Props) {
  const { colW, model, onZoom, onToday, onPage } = props;
  const [searchOpen, setSearchOpen] = useState(false);

  // Close dropdown menus on any press outside them.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      for (const d of document.querySelectorAll<HTMLDetailsElement>('.toolbar details[open]'))
        if (!d.contains(e.target as Node)) d.removeAttribute('open');
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, []);
  const hist = useSyncExternalStore(onHistoryChange, historySnapshot);
  const sync = useSyncExternalStore(onSyncStatus, getSyncStatus);
  useSyncExternalStore(model.subscribe, model.getVersion);
  const taskCount = store.getRowCount('tasks');

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="logo" aria-hidden>
          ▦
        </span>
        <span className="brand-name">prepweek</span>
      </div>
      <div className="tb-group">
        <button className="btn" onClick={() => onPage(-1)} aria-label="Earlier">
          ‹
        </button>
        <button className="btn" onClick={onToday} title="Today (T)">
          Today
        </button>
        <button className="btn" onClick={() => onPage(1)} aria-label="Later">
          ›
        </button>
      </div>
      <div className="tb-group zoom">
        <button className="btn" onClick={() => onZoom(colW / 1.25)} title="Zoom out (⌘−, pinch)">
          −
        </button>
        <input
          type="range"
          min={Math.log(ZOOM_MIN)}
          max={Math.log(ZOOM_MAX)}
          step={0.01}
          value={Math.log(colW)}
          onChange={(e) => onZoom(Math.exp(Number(e.currentTarget.value)))}
          aria-label="Zoom"
        />
        <button className="btn" onClick={() => onZoom(colW * 1.25)} title="Zoom in (⌘+, pinch)">
          +
        </button>
      </div>
      <div className="tb-group">
        <button className="btn" disabled={!(hist & 1)} onClick={undo} title="Undo (⌘Z)">
          ↶
        </button>
        <button className="btn" disabled={!(hist & 2)} onClick={redo} title="Redo (⇧⌘Z)">
          ↷
        </button>
      </div>
      <div className="tb-spacer" />
      <Search {...props} open={searchOpen} setOpen={setSearchOpen} />
      <PeopleMenu {...props} />
      <div className="tb-stats">
        {model.rows.length === 1 ? '1 person' : `${model.rows.length} people`} · {taskCount.toLocaleString()} tasks
      </div>
      <div className={`sync sync-${sync}`} title="Edits sync live across tabs; add ?sync=wss://… for the Cloudflare backend">
        <span className="dot" />
        <span className="sync-label">{sync === 'local' ? 'Local' : sync}</span>
      </div>
      <details className="tb-more">
        <summary className="btn" aria-label="More">
          ⋯
        </summary>
        <div className="tb-menu" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute('open')}>
          <div className="tb-menu-stats">
            {model.rows.length === 1 ? '1 person' : `${model.rows.length} people`} · {taskCount.toLocaleString()} tasks
          </div>
          <button className="btn" onClick={() => confirm('Replace everything with fresh demo data?') && seed()}>
            Reset demo
          </button>
          <button className="btn" onClick={() => confirm('Replace everything with a large stress-test dataset?') && seed(120, 1.6, 11)}>
            Stress test
          </button>
        </div>
      </details>
      <div className="tb-group tb-actions">
        <button className="btn" onClick={() => confirm('Replace everything with fresh demo data?') && seed()}>
          Reset demo
        </button>
        <button
          className="btn"
          title="Load 120 people × 2 years (~25k tasks)"
          onClick={() => confirm('Replace everything with a large stress-test dataset?') && seed(120, 1.6, 11)}
        >
          Stress
        </button>
      </div>
    </header>
  );
}

function Search({ query, onQuery, matchCount, onNextMatch, open, setOpen }: Props & { open: boolean; setOpen(o: boolean): void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        className={'btn tb-search-toggle' + (query ? ' active' : '')}
        aria-label="Search tasks"
        onClick={() => {
          // Open and focus in the same tap: iOS only raises the keyboard for
          // a focus() made synchronously inside the user gesture.
          flushSync(() => setOpen(true));
          input.current?.focus();
        }}
      >
        <SearchIcon />
      </button>
      <div className={'tb-search' + (open ? ' open' : '')}>
        <SearchIcon />
        <input
          ref={input}
          type="search"
          placeholder="Find tasks…  /"
          value={query}
          enterKeyHint="search"
          onChange={(e) => onQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onNextMatch(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
              onQuery('');
              setOpen(false);
              e.currentTarget.blur();
            }
          }}
        />
        {query && (
          <>
            <span className="tb-search-count">{matchCount}</span>
            <button className="tb-search-btn" aria-label="Previous match" disabled={!matchCount} onClick={() => onNextMatch(-1)}>
              ‹
            </button>
            <button className="tb-search-btn" aria-label="Next match" disabled={!matchCount} onClick={() => onNextMatch(1)}>
              ›
            </button>
          </>
        )}
        <button
          className="tb-search-btn tb-search-close"
          aria-label="Clear search"
          onClick={() => {
            onQuery('');
            setOpen(false);
          }}
        >
          ×
        </button>
      </div>
    </>
  );
}

/** Pick who to focus on; works the same on touch, where avatars are small. */
function PeopleMenu({ model, onFocusPerson, onClearFocus }: Props) {
  const focus = model.getFocus();
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <details className="tb-people" ref={ref}>
      <summary className={'btn' + (focus ? ' active' : '')} aria-label="Focus on people">
        <PeopleIcon />
        {focus && <span className="tb-badge">{focus.size}</span>}
      </summary>
      <div className="tb-menu tb-people-menu">
        <div className="tb-menu-stats">Focus on</div>
        <button className={'tb-person' + (!focus ? ' on' : '')} onClick={() => { onClearFocus(); ref.current?.removeAttribute('open'); }}>
          Everyone
        </button>
        <div className="tb-people-list">
          {model.allUsers().map((u) => (
            <button
              key={u.id}
              className={'tb-person' + (focus?.has(u.id) ? ' on' : '')}
              // A checklist: tap to add/remove, the menu stays open.
              onClick={() => onFocusPerson(u.id, true)}
            >
              <span className="tb-person-dot" style={{ background: u.color }} />
              {u.name}
              {focus?.has(u.id) && <span className="tb-check">✓</span>}
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}
