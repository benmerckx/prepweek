import { useSyncExternalStore } from 'react';
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
}

const historySnapshot = () => (canUndo() ? 1 : 0) | (canRedo() ? 2 : 0);

export function Toolbar({ colW, model, onZoom, onToday, onPage }: Props) {
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
        prepweek
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
      <div className="tb-stats">
        {model.rows.length} people · {taskCount.toLocaleString()} tasks
      </div>
      <div className={`sync sync-${sync}`} title="Edits sync live across tabs; add ?sync=wss://… for the Cloudflare backend">
        <span className="dot" />
        {sync === 'local' ? 'Local' : sync}
      </div>
      <div className="tb-group">
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
