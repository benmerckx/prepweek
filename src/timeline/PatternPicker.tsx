import { PATTERNS } from '../data/store.ts';

/** Solid or one of the block patterns, previewed in `color`. */
export function PatternPicker({ value, color, onPick }: { value: string; color: string; onPick(pattern: string): void }) {
  return (
    <div className="patterns" role="radiogroup" aria-label="Pattern" style={{ ['--c' as string]: color }}>
      {['', ...PATTERNS].map((p) => (
        <button
          key={p || 'solid'}
          className={'pattern-swatch' + (p === value ? ' on' : '') + (p ? '' : ' solid')}
          data-pattern={p || undefined}
          role="radio"
          aria-checked={p === value}
          aria-label={p ? `${p} pattern` : 'No pattern'}
          title={p ? p[0]!.toUpperCase() + p.slice(1) : 'Solid'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(p)}
        />
      ))}
    </div>
  );
}

/** A small block-like chip: a project's color and pattern. */
export function PatternChip({ color, pattern, big }: { color: string; pattern?: string; big?: boolean }) {
  return <span className={'pattern-swatch chip' + (big ? ' big' : '')} data-pattern={pattern || undefined} style={{ ['--c' as string]: color }} aria-hidden />;
}
