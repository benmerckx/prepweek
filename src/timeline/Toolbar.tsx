import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { canRedo, canUndo, onHistoryChange, redo, store, undo } from '../data/store.ts';
import { getSyncStatus, onSyncStatus } from '../data/sync.ts';
import { seed } from '../data/seed.ts';
import { ZOOM_MAX, ZOOM_MIN } from './viewport.ts';
import type { TimelineModel } from './model.ts';
import { Check, ChevronLeft, ChevronRight, Close, Logo, Minus, More, People, Plus, Redo, Search as SearchIc, Undo, Upload } from '../ui/icons.tsx';

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
  onImport(): void;
}



const SYNC_HELP = {
  local: 'Saved in this browser; edits sync live across tabs',
  connecting: 'Connecting to the server…',
  online: 'Live: changes sync to everyone on this sheet',
  offline: 'Offline: changes are kept and sync when the connection is back',
} as const;

const historySnapshot = () => (canUndo() ? 1 : 0) | (canRedo() ? 2 : 0);

export const Toolbar = memo(function Toolbar(props: Props) {
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
  // Re-render on edits only when what we show changes (counts, focus), not
  // on every recolor or drag.
  const counts = useCallback(() => `${model.rows.length}|${store.getRowCount('tasks')}|${model.getFocus()?.size ?? 0}`, [model]);
  useSyncExternalStore(model.subscribe, counts);
  const taskCount = store.getRowCount('tasks');

  return (
    <header className="toolbar">
      <div className="brand">
        <Logo />
        <span className="brand-name">prepweek</span>
      </div>
      <div className="seg">
        <button className="btn icon" onClick={() => onPage(-1)} aria-label="Earlier" title="Earlier">
          <ChevronLeft />
        </button>
        <button className="btn" onClick={onToday} title="Today (T)">
          Today
        </button>
        <button className="btn icon" onClick={() => onPage(1)} aria-label="Later" title="Later">
          <ChevronRight />
        </button>
      </div>
      <div className="seg zoom">
        <button className="btn icon" onClick={() => onZoom(colW / 1.25)} aria-label="Zoom out" title="Zoom out (⌘−, pinch)">
          <Minus />
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
        <button className="btn icon" onClick={() => onZoom(colW * 1.25)} aria-label="Zoom in" title="Zoom in (⌘+, pinch)">
          <Plus />
        </button>
      </div>
      <div className="seg">
        <button className="btn icon" disabled={!(hist & 1)} onClick={undo} aria-label="Undo" title="Undo (⌘Z)">
          <Undo />
        </button>
        <button className="btn icon redo" disabled={!(hist & 2)} onClick={redo} aria-label="Redo" title="Redo (⇧⌘Z)">
          <Redo />
        </button>
      </div>
      <div className="tb-spacer" />
      <Search {...props} open={searchOpen} setOpen={setSearchOpen} />
      <PeopleMenu {...props} />
      <div className={`sync sync-${sync}`} title={SYNC_HELP[sync]}>
        <span className="dot" />
        <span className="sync-label">{sync === 'local' ? 'Local' : sync}</span>
      </div>
      <button className="btn tb-import" onClick={props.onImport} title="Import from Teamweek / Toggl Plan">
        <Upload />
        Import
      </button>
      <details className="tb-more">
        <summary className="btn icon" aria-label="More" title="More">
          <More />
        </summary>
        <div className="tb-menu" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute('open')}>
          <div className="tb-menu-stats">
            {model.rows.length === 1 ? '1 person' : `${model.rows.length} people`} · {taskCount.toLocaleString()} tasks
            <div className={`sync sync-${sync}`}>
              <span className="dot" />
              {SYNC_HELP[sync]}
            </div>
          </div>
          <button className="menu-item" onClick={props.onImport}>
            <Upload />
            Import from Teamweek…
          </button>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => confirm('Replace everything with fresh demo data?') && seed()}>
            Reset demo data
          </button>
          <button
            className="menu-item"
            title="Load 120 people × 2 years (~25k tasks)"
            onClick={() => confirm('Replace everything with a large stress-test dataset?') && seed(120, 1.6, 11)}
          >
            Stress test (120 people)
          </button>
        </div>
      </details>
    </header>
  );
});

function Search({ query, onQuery, matchCount, onNextMatch, open, setOpen }: Props & { open: boolean; setOpen(o: boolean): void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        className={'btn icon tb-search-toggle' + (query ? ' active' : '')}
        aria-label="Search tasks"
        onClick={() => {
          // Open and focus in the same tap: iOS only raises the keyboard for
          // a focus() made synchronously inside the user gesture.
          flushSync(() => setOpen(true));
          input.current?.focus();
        }}
      >
        <SearchIc />
      </button>
      <div className={'tb-search' + (open ? ' open' : '') + (query ? ' has-query' : '')}>
        <SearchIc />
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
              <ChevronLeft />
            </button>
            <button className="tb-search-btn" aria-label="Next match" disabled={!matchCount} onClick={() => onNextMatch(1)}>
              <ChevronRight />
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
          <Close />
        </button>
      </div>
    </>
  );
}

/** Pick who to focus on; works the same on touch, where avatars are small. */
function PeopleMenu({ model, onFocusPerson, onClearFocus }: Props) {
  const focus = model.getFocus();
  const ref = useRef<HTMLDetailsElement>(null);
  // The list is only built while the menu is open.
  const [open, setOpen] = useState(false);
  return (
    <details className="tb-people" ref={ref} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className={'btn icon' + (focus ? ' active' : '')} aria-label="Focus on people" title="Focus on people">
        <People />
        {focus && <span className="tb-badge">{focus.size}</span>}
      </summary>
      <div className="tb-menu tb-people-menu">
        <div className="tb-menu-stats">Focus on</div>
        <button className={'tb-person' + (!focus ? ' on' : '')} onClick={() => { onClearFocus(); ref.current?.removeAttribute('open'); }}>
          Everyone
        </button>
        <div className="tb-people-list">
          {open && model.allUsers().map((u) => (
            <button
              key={u.id}
              className={'tb-person' + (focus?.has(u.id) ? ' on' : '')}
              // A checklist: tap to add/remove, the menu stays open.
              onClick={() => onFocusPerson(u.id, true)}
            >
              <span className="tb-person-dot" style={{ background: u.color }} />
              {u.name}
              {focus?.has(u.id) && (
                <span className="tb-check">
                  <Check size={14} />
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}
