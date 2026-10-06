// Dependency arrows: from the end of a task to the start of what waits for
// it. Drawn under the blocks; red when the waiting task starts too early.

import { memo } from 'react';
import { allLinks, groupMembers } from '../data/store.ts';
import type { TaskView, TimelineModel } from './model.ts';
import type { Scale } from './scale.ts';

interface Props {
  model: TimelineModel;
  scale: Scale;
  /** Bumps whenever the layout (or the links) changed. */
  version: number;
  width: number;
  height: number;
  /** The selected block's thread: its arrows stand out. */
  selected: string | null;
}

export const LinkLayer = memo(function LinkLayer({ model, scale, width, height, selected }: Props) {
  const links = allLinks();
  if (!links.length) return null;
  const { dims } = model;
  const preview = model.getPreview();
  /** Where a task row is drawn right now (following a drag in progress). */
  const place = (id: string): (TaskView & { y: number }) | null => {
    const userId = preview?.id === id ? preview.userId : model.findTask(id)?.userId;
    if (!userId) return null;
    const i = model.indexOfUser(userId);
    const row = model.rows[i];
    const t = row?.tasks.find((x) => x.id === id);
    if (!row || !t || row.kind !== 'person') return null;
    return { ...t, y: model.rowTops[i]! + dims.pad + t.lane * dims.laneH + dims.blockH / 2 };
  };
  const paths = [];
  for (const l of links) {
    const on = selected !== null && (l.from === selected || l.to === selected);
    for (const a of groupMembers(l.from)) {
      const from = place(a);
      if (!from) continue;
      for (const b of groupMembers(l.to)) {
        const to = place(b);
        if (!to) continue;
        const late = to.start <= from.end;
        const x1 = scale.x(from.end + 1) - 2;
        const x2 = scale.x(to.start) + 1;
        const y1 = from.y;
        const y2 = to.y;
        let d: string;
        if (x2 - x1 >= 14) {
          const k = Math.min(48, (x2 - x1) / 2);
          d = `M${x1} ${y1} C${x1 + k} ${y1} ${x2 - k} ${y2} ${x2 - 1} ${y2}`;
        } else {
          // Backwards (or touching): out of the end, along the gap above the
          // waiting block, into its start.
          const mid = y2 + (y2 > y1 ? -1 : 1) * (dims.blockH / 2 + (dims.laneH - dims.blockH) / 2);
          d = `M${x1} ${y1} h8 V${mid} H${x2 - 8} V${y2} H${x2 - 1}`;
        }
        paths.push(<path key={`${l.id}:${a}:${b}`} d={d} className={(late ? 'late' : '') + (on ? ' on' : '')} markerEnd={late ? 'url(#dep-late)' : on ? 'url(#dep-on)' : 'url(#dep)'} />);
      }
    }
  }
  return (
    <svg className="dep-layer" width={width} height={height} aria-hidden>
      <defs>
        {(['dep', 'dep-on', 'dep-late'] as const).map((id) => (
          <marker key={id} id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse" className={id}>
            <path d="M0.5 0.8 7.2 4 0.5 7.2Z" />
          </marker>
        ))}
      </defs>
      {paths}
    </svg>
  );
});
