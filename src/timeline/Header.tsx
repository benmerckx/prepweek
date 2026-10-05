import { memo } from 'react';
import { CHUNK } from './model.ts';
import type { Scale } from './scale.ts';
import { addMonths, isoWeek, isWeekend, monthLong, monthShort, startOfMonth, ymd, weekdayShort, startOfWeek } from '../lib/dates.ts';

interface Props {
  d0: number;
  d1: number;
  scale: Scale;
  today: number;
}

/** Month band + day (or week) band, rendered only for the current window. */
export const Header = memo(function Header({ d0, d1, scale, today }: Props) {
  const months = [];
  for (let m = startOfMonth(d0); m <= d1; m = addMonths(m, 1)) {
    const next = addMonths(m, 1);
    const { y, m: mi } = ymd(m);
    const w = scale.x(next) - scale.x(m);
    months.push(
      <div key={m} className="hd-month" style={{ left: scale.x(m), width: w }}>
        <span className="hd-month-label">
          {w > 90 ? monthLong(mi) : monthShort(mi)} <span className="hd-year">{y}</span>
        </span>
      </div>,
    );
  }

  const tiles = [];
  for (let c = d0; c <= d1; c += CHUNK) tiles.push(<DayTile key={c} c0={c} scale={scale} today={today} />);

  return (
    <>
      <div className="hd-months">{months}</div>
      <div className="hd-days">{tiles}</div>
    </>
  );
});

const DayTile = memo(function DayTile({ c0, scale, today }: { c0: number; scale: Scale; today: number }) {
  const cells = [];
  const c1 = c0 + CHUNK;
  const colW = scale.colW;
  if (colW >= 22) {
    for (let d = c0; d < c1; d++) {
      if (scale.isHidden(d)) continue;
      const cls = 'hd-day' + (isWeekend(d) ? ' weekend' : '') + (d === today ? ' today' : '');
      cells.push(
        <div key={d} className={cls + (colW >= 30 ? ' stack' : '')} style={{ left: scale.x(d), width: colW }}>
          {colW >= 30 && <span className="hd-wd">{weekdayShort(d)}</span>}
          <span className="hd-dn">{ymd(d).d}</span>
        </div>,
      );
    }
  } else {
    for (let d = startOfWeek(c0); d < c1; d += 7) {
      const w = scale.perWeek * colW;
      cells.push(
        <div key={d} className={'hd-week' + (today >= d && today < d + 7 ? ' today' : '')} style={{ left: scale.x(d), width: w }}>
          {w >= 30 ? (w >= 60 ? `Week ${isoWeek(d)}` : `W${isoWeek(d)}`) : ''}
        </div>,
      );
    }
  }
  return <>{cells}</>;
});
