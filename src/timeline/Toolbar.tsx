import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { canRedo, canUndo, isHistoryBusy, onHistoryChange, redo, store, undo } from '../data/store.ts';
import { getSyncStatus, onSyncStatus } from '../data/sync.ts';
import type { TimelineModel } from './model.ts';
import { FilterMenu, ViewsMenu, type FilterState } from './Filters.tsx';
import { NotificationsMenu } from './Discussion.tsx';
import { PresenceAvatars } from './Presence.tsx';
import { AccountButton, SheetSwitcher, useAccount } from './Account.tsx';
import { canInstall, install, onInstallChange } from '../lib/install.ts';
import { getTheme, onThemeChange, toggleTheme } from '../lib/theme.ts';
import type { Peer } from '../data/presence.ts';
import type { ViewConfig } from '../data/store.ts';
import { navigate, useRoute, type Section } from '../lib/route.ts';
import { isPopoverOpen } from '../ui/Select.tsx';
import { Briefcase, Calendar, Check, People, ChevronLeft, ChevronRight, Close, Download, Eye, Folder, History, LinkIcon, Moon, More, Redo, Search as SearchIc, Sun, Undo, Upload } from '../ui/icons.tsx';

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
  onExport(): void;
  onCalendar(): void;
  hideWeekends: boolean;
  onToggleWeekends(): void;
  dense: boolean;
  onToggleDense(): void;
  filter: FilterState;
  onFilter(f: FilterState): void;
  onManageProjects(): void;
  view: ViewConfig;
  onApplyView(c: ViewConfig): void;
  onOpenTask(id: string): void;
  onOpenActivity(): void;
  /** Jump to where another person on the sheet is. */
  onFollow(p: Peer): void;
  readOnly: boolean;
  onShare(): void;
  onPalette(): void;
  onSignIn(): void;
  onWorkspace(id: string): void;
}



const SYNC_HELP = {
  local: 'Saved in this browser; edits sync live across tabs',
  connecting: 'Connecting to the server…',
  online: 'Live: changes sync to everyone on this sheet',
  offline: 'Offline: changes are kept and sync when the connection is back',
} as const;

const historySnapshot = () => (canUndo() ? 1 : 0) | (canRedo() ? 2 : 0) | (isHistoryBusy() ? 4 : 0);

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'projects', label: 'Projects' },
  { id: 'clients', label: 'Clients' },
];

/** Plan · Projects · Clients. */
export function SectionTabs({ current }: { current: Section }) {
  return (
    <nav className="sections" aria-label="Sections">
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={s.id}
          className={'section-tab' + (s.id === current ? ' on' : '')}
          aria-current={s.id === current ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate({ section: s.id });
          }}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}

export const Toolbar = memo(function Toolbar(props: Props) {
  const { model, onToday, onPage } = props;
  const [searchOpen, setSearchOpen] = useState(false);
  /** The "…" menu: its main list, or the focus-on-people list in its place. */
  const [moreView, setMoreView] = useState<'main' | 'focus'>('main');

  // Close dropdown menus on any press outside them.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      // A ⋯ menu inside a toolbar menu lives at the end of <body>.
      if (isPopoverOpen()) return;
      for (const d of document.querySelectorAll<HTMLDetailsElement>('.toolbar details[open]'))
        if (!d.contains(e.target as Node)) d.removeAttribute('open');
    };
    document.addEventListener('pointerdown', away, true);
    // Menus open under their own button: left edges aligned, or right
    // edges when that would run off the screen.
    const place = (e: Event) => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement) || !d.closest('.toolbar')) return;
      const menu = d.querySelector<HTMLElement>(':scope > .tb-menu');
      if (!menu) return;
      // Hidden (CSS) until placed, so it never shows at a default spot first.
      if (!d.open) return void delete menu.dataset.placed;
      const btn = d.querySelector(':scope > summary')?.getBoundingClientRect();
      if (!btn) return;
      const fit = () => {
        const w = menu.offsetWidth;
        const left = btn.left + w > innerWidth - 8 ? Math.max(8, btn.right - w) : btn.left;
        const top = Math.round(btn.bottom + 6);
        menu.style.top = `${top}px`;
        menu.style.left = `${Math.round(left)}px`;
        menu.style.right = 'auto';
        // Taller than the screen: it scrolls.
        menu.style.maxHeight = `${innerHeight - top - 10}px`;
        menu.dataset.placed = '';
      };
      fit();
      // Content that renders once open can change the width.
      requestAnimationFrame(fit);
    };
    document.addEventListener('toggle', place, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('toggle', place, true);
    };
  }, []);
  const hist = useSyncExternalStore(onHistoryChange, historySnapshot);
  const installable = useSyncExternalStore(onInstallChange, canInstall);
  const theme = useSyncExternalStore(onThemeChange, getTheme);
  const sync = useSyncExternalStore(onSyncStatus, getSyncStatus);
  // Re-render on edits only when what we show changes (counts, focus), not
  // on every recolor or drag.
  const counts = useCallback(() => `${model.personCount}|${store.getRowCount('tasks')}|${model.getFocus()?.size ?? 0}`, [model]);
  useSyncExternalStore(model.subscribe, counts);
  const taskCount = store.getRowCount('tasks');
  const route = useRoute();
  const plan = route.section === 'plan';
  const account = useAccount();

  return (
    <header className={'toolbar' + (plan ? '' : ' on-page')}>
      <SheetSwitcher onSignIn={props.onSignIn} onWorkspace={props.onWorkspace} />
      <SectionTabs current={route.section} />
      {plan && (
      <>
      <ViewsMenu current={props.view} onApply={props.onApplyView} />
      <div className="seg">
        <button className="btn icon tb-page" onClick={() => onPage(-1)} aria-label="Earlier" title="Earlier">
          <ChevronLeft />
        </button>
        <button className="btn" onClick={onToday} title="Today (T)">
          Today
        </button>
        <button className="btn icon tb-page" onClick={() => onPage(1)} aria-label="Later" title="Later">
          <ChevronRight />
        </button>
      </div>
      </>
      )}
      <div className="tb-spacer" />
      {plan && (
        <>
          <Search {...props} open={searchOpen} setOpen={setSearchOpen} />
          <FilterMenu model={model} filter={props.filter} onFilter={props.onFilter} onManageProjects={props.onManageProjects} />
        </>
      )}
      <PresenceAvatars onFollow={props.onFollow} />
      {props.readOnly && (
        <span className="ro-chip" title="You have a view-only link">
          <Eye size={14} />
          View only
        </span>
      )}
      {/* Notifications are for accounts: signed out, Log in takes the spot. */}
      {!(account && !account.user) && <NotificationsMenu onOpenTask={props.onOpenTask} />}
      {/* Connection state lives in the menu; only losing it is worth a chip. */}
      {sync === 'offline' && (
        <div className="sync sync-offline" title={SYNC_HELP.offline}>
          <span className="dot" />
          <span className="sync-label">Offline</span>
        </div>
      )}
      <button
        className="btn icon tb-theme"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
      >
        {theme === 'dark' ? <Sun /> : <Moon />}
      </button>
      <AccountButton onSignIn={props.onSignIn} onWorkspace={props.onWorkspace} />
      <details className="tb-more" onToggle={(e) => !e.currentTarget.open && setMoreView('main')}>
        <summary className={'btn icon' + (model.getFocus() ? ' active' : '')} aria-label="More" title="More">
          <More />
          {model.getFocus() && <span className="tb-badge">{model.getFocus()!.size}</span>}
        </summary>
        <div className="tb-menu tb-more-menu" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute('open')}>
          {moreView === 'focus' ? (
            <FocusSection {...props} onBack={() => setMoreView('main')} />
          ) : (
          <>
          <div className="tb-menu-stats">
            {model.personCount === 1 ? '1 person' : `${model.personCount} people`} · {taskCount.toLocaleString()} tasks
            <div className={`sync sync-${sync}`}>
              <span className="dot" />
              {SYNC_HELP[sync]}
            </div>
          </div>
          <button className="menu-item" onClick={props.onShare}>
            <LinkIcon />
            Share…
          </button>
          {!props.readOnly && (
            <button className="menu-item" onClick={props.onImport}>
              <Upload />
              Import from Teamweek…
            </button>
          )}
          <button className="menu-item" onClick={props.onExport}>
            <Download />
            Export as CSV
          </button>
          <button className="menu-item" onClick={props.onCalendar}>
            <Calendar />
            Add to your calendar…
          </button>
          {!props.readOnly && (
            <>
              <button className="menu-item" disabled={!(hist & 1) || !!(hist & 4)} onClick={() => void undo()}>
                {hist & 4 ? <span className="spinner" aria-label="Undoing" /> : <Undo />}
                Undo
                <kbd className="menu-kbd">⌘Z</kbd>
              </button>
              <button className="menu-item" disabled={!(hist & 2)} onClick={() => void redo()}>
                <Redo />
                Redo
                <kbd className="menu-kbd">⇧⌘Z</kbd>
              </button>
            </>
          )}
          {plan && model.allUsers().length > 0 && (
            <button
              className="menu-item"
              onClick={(e) => {
                // Opens the people list in place; the menu stays open.
                e.stopPropagation();
                setMoreView('focus');
              }}
            >
              <People />
              Focus on people
              <span className="menu-next">
                {model.getFocus() ? model.getFocus()!.size : ''}
                <ChevronRight />
              </span>
            </button>
          )}
          <button className="menu-item" onClick={props.onPalette}>
            <SearchIc />
            Command palette
            <kbd className="menu-kbd">⌘K</kbd>
          </button>
          {installable && (
            <button className="menu-item" onClick={() => void install()}>
              <Download />
              Install app
            </button>
          )}
          <button className="menu-item" onClick={props.onOpenActivity}>
            <History />
            Activity
          </button>
          <button className="menu-item" onClick={() => navigate({ section: 'projects' })}>
            <Folder />
            Projects
          </button>
          <button className="menu-item" onClick={() => navigate({ section: 'clients' })}>
            <Briefcase />
            Clients
          </button>
          <div className="menu-sep" />
          <div className="menu-label">View</div>
          <Toggle label="Hide weekends" on={props.hideWeekends} onToggle={props.onToggleWeekends} />
          <Toggle label="Compact rows" on={props.dense} onToggle={props.onToggleDense} />
          <Toggle label="Dark mode" on={theme === 'dark'} onToggle={toggleTheme} />
          </>
          )}
        </div>
      </details>
    </header>
  );
});

/** A switch-style menu row; the menu stays open so the change is visible. */
function Toggle({ label, on, onToggle }: { label: string; on: boolean; onToggle(): void }) {
  return (
    <button
      className="menu-item menu-toggle"
      role="menuitemcheckbox"
      aria-checked={on}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {label}
      <span className={'switch' + (on ? ' on' : '')} aria-hidden />
    </button>
  );
}

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
/** Focus on people: a checklist inside the "…" menu (clicks keep it open). */
function FocusSection({ model, onFocusPerson, onClearFocus, onBack }: Props & { onBack(): void }) {
  const focus = model.getFocus();
  const people = model.allUsers();
  return (
    <div className="focus-section" onClick={(e) => e.stopPropagation()}>
      <div className="focus-head">
        <button className="focus-back" onClick={onBack} aria-label="Back">
          <ChevronLeft />
          Focus on
        </button>
        {focus && (
          <button className="link-btn" onClick={onClearFocus}>
            Show everyone
          </button>
        )}
      </div>
      <div className="tb-people-list">
        {people.map((u) => (
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
  );
}
