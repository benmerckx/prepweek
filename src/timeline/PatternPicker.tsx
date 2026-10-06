import { PATTERNS } from '../data/store.ts';

/** The block patterns, previewed in `color`; picking the active one turns it off. */
export function PatternPicker({ value, color, onPick }: { value: string; color: string; onPick(pattern: string): void }) {
  return (
    <div className="patterns" role="group" aria-label="Pattern" style={{ ['--c' as string]: color }}>
      {PATTERNS.map((p) => (
        <button
          key={p}
          type="button"
          className={'pattern-swatch' + (p === value ? ' on' : '')}
          data-pattern={p}
          aria-pressed={p === value}
          aria-label={`${p} pattern`}
          title={p === value ? 'No pattern' : p[0]!.toUpperCase() + p.slice(1)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(p === value ? '' : p)}
        />
      ))}
    </div>
  );
}

/** A small block-like chip: a project's color and pattern. */
export function PatternChip({ color, pattern, big }: { color: string; pattern?: string; big?: boolean }) {
  return <span className={'pattern-swatch chip' + (big ? ' big' : '')} data-pattern={pattern || undefined} style={{ ['--c' as string]: color }} aria-hidden />;
}
