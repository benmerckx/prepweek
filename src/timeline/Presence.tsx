import { memo, useSyncExternalStore } from 'react';
import { getPeers, onPeers, type Peer } from '../data/presence.ts';
import type { TimelineModel } from './model.ts';
import type { Scale } from './scale.ts';

export const usePeers = () => useSyncExternalStore(onPeers, getPeers);

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';

/** Faces of everyone else here; click one to jump to what they're looking at. */
export function PresenceAvatars({ onFollow }: { onFollow(p: Peer): void }) {
  const peers = usePeers();
  if (!peers.length) return null;
  // One face per person, even with several tabs open.
  const seen = new Map<string, Peer>();
  for (const p of peers) {
    const k = p.personId || p.name;
    const prev = seen.get(k);
    if (!prev || p.at > prev.at) seen.set(k, p);
  }
  const people = [...seen.values()];
  const shown = people.slice(0, 4);
  return (
    <div className="presence" aria-label={`${people.length} others here`}>
      {shown.map((p) => (
        <button
          key={p.id}
          className="presence-face"
          style={{ ['--c' as string]: p.color }}
          title={`${p.name}: click to see where they are`}
          onClick={() => onFollow(p)}
        >
          {initials(p.name)}
        </button>
      ))}
      {people.length > shown.length && <span className="presence-more">+{people.length - shown.length}</span>}
    </div>
  );
}

interface LayerProps {
  model: TimelineModel;
  scale: Scale;
  /** Re-render when rows move. */
  version: number;
}

/** Other people's pointers and selections, drawn over the body. */
export const PresenceLayer = memo(function PresenceLayer({ model, scale }: LayerProps) {
  const peers = usePeers();
  const { pad, laneH, blockH } = model.dims;
  const out = [];
  for (const p of peers) {
    if (p.sel) {
      const t = model.findTask(p.sel);
      const i = t ? model.indexOfUser(t.userId) : -1;
      if (t && i >= 0) {
        const x = scale.x(t.start);
        const y = model.rowTops[i]! + pad + t.lane * laneH;
        out.push(
          <div
            key={`s${p.id}`}
            className="peer-sel"
            style={{ ['--c' as string]: p.color, transform: `translate(${x - 1}px, ${y - 2}px)`, width: Math.max(8, scale.w(t.start, t.end) + 1), height: blockH + 4 }}
          >
            <span className="peer-tag">{p.name}</span>
          </div>,
        );
      }
    }
    if (p.cur) {
      const i = model.indexOfUser(p.cur.user);
      const row = model.rows[i];
      if (row) {
        const x = scale.xF(p.cur.day);
        const y = model.rowTops[i]! + Math.min(Math.max(0, p.cur.dy), row.height);
        out.push(
          <div key={`c${p.id}`} className="peer-cursor" style={{ ['--c' as string]: p.color, transform: `translate(${x}px, ${y}px)` }}>
            <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden>
              <path d="M1 1 L1 14 L4.6 10.8 L7.2 16.6 L9.6 15.5 L7 9.8 L12 9.6 Z" fill="var(--c)" stroke="#fff" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
            <span className="peer-name">{p.name}</span>
          </div>,
        );
      }
    }
  }
  return <>{out}</>;
});
