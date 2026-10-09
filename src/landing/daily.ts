// The daily week: a small planning puzzle, the same for everyone each day.
//
// A team's week (people down the side, Mon–Fri across) with a few days off,
// and a tray of blocks whose days add up to exactly the free days. Every
// block goes on the board, and the rules have to hold:
//
//   who       a block only some people can do ("Only Noah", "Ava or Mila")
//   day       a block that has to cover a given day ("Launch on Friday")
//   after     one block that can only start once another is done
//   together  two blocks that share at least one day (a meeting)
//
// Puzzles are made from the date: a random week is cut into blocks (the
// answer), then rules true of that answer are added until it's the only
// answer, and on harder days the rules that aren't needed are taken away
// again, so each one counts. Pure and deterministic; see daily.test.ts.

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
export const PEOPLE = ['Ava', 'Noah', 'Mila', 'Lucas'];
const COLORS = ['#3b6fd4', '#2a9a6a', '#d9473f', '#d69a1f', '#8452d6', '#1d98ab', '#d2448d', '#e2692a', '#6e9b26', '#737089'];
const TITLES = ['Kickoff', 'Workshop', 'Review', 'Launch', 'Pitch', 'Research', 'Design', 'Build', 'Retro', 'Testing', 'Copy', 'Demo', 'Sprint', 'Interviews', 'Offsite', 'Audit', 'Planning', 'Training'];

export interface Piece {
  id: number;
  title: string;
  color: string;
  len: number;
}
export type Rule =
  | { kind: 'who'; piece: number; people: number[] }
  | { kind: 'day'; piece: number; day: number }
  | { kind: 'after'; first: number; then: number }
  | { kind: 'together'; a: number; b: number };
export type Place = { row: number; col: number } | null;

export type Level = 0 | 1 | 2;
export const LEVELS = ['Easy', 'Medium', 'Hard'] as const;

export interface Week {
  /** Puzzle number (#1 on the first day), or 0 for a practice week. */
  number: number;
  level: Level;
  rows: number;
  /** Days off, as "row:col". */
  off: Set<string>;
  pieces: Piece[];
  rules: Rule[];
  /** The one answer. */
  solution: Place[];
}

// --- Randomness, from a seed ---

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
type Rng = () => number;
const pick = <T,>(rng: Rng, a: readonly T[]) => a[Math.floor(rng() * a.length)]!;
const shuffle = <T,>(rng: Rng, a: T[]) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

// --- Checking a board ---

const ends = (p: Piece, at: { col: number }) => at.col + p.len - 1;
const covers = (p: Piece, at: { col: number }, day: number) => day >= at.col && day <= ends(p, at);

/** Whether a rule holds (true), is broken (false), or can't tell yet (null: a block isn't placed). */
export const ruleState = (rule: Rule, pieces: Piece[], places: Place[]): boolean | null => {
  switch (rule.kind) {
    case 'who': {
      const at = places[rule.piece];
      return at ? rule.people.includes(at.row) : null;
    }
    case 'day': {
      const at = places[rule.piece];
      return at ? covers(pieces[rule.piece]!, at, rule.day) : null;
    }
    case 'after': {
      const a = places[rule.first];
      const b = places[rule.then];
      return a && b ? b.col > ends(pieces[rule.first]!, a) : null;
    }
    case 'together': {
      const a = places[rule.a];
      const b = places[rule.b];
      if (!a || !b) return null;
      return a.col <= ends(pieces[rule.b]!, b) && b.col <= ends(pieces[rule.a]!, a);
    }
  }
};

/** Blocks in each rule, for highlighting. */
export const ruleBlocks = (rule: Rule) =>
  rule.kind === 'who' || rule.kind === 'day' ? [rule.piece] : rule.kind === 'after' ? [rule.first, rule.then] : [rule.a, rule.b];

/** Every block placed and every rule holding. */
export const isSolved = (w: Week, places: Place[]) => places.every(Boolean) && w.rules.every((r) => ruleState(r, w.pieces, places) === true);

/** Whether a block may go at a spot: on the board, on free days, over nobody else. */
export const fits = (w: Week, places: Place[], i: number, row: number, col: number) => {
  const len = w.pieces[i]!.len;
  if (row < 0 || row >= w.rows || col < 0 || col + len > 5) return false;
  for (let c = col; c < col + len; c++) {
    if (w.off.has(`${row}:${c}`)) return false;
    for (let j = 0; j < places.length; j++) {
      const o = places[j];
      if (j !== i && o && o.row === row && c >= o.col && c <= ends(w.pieces[j]!, o)) return false;
    }
  }
  return true;
};

// --- Counting answers (exact cover: fill the first empty day, every way) ---

const countAnswers = (rows: number, off: Set<string>, pieces: Piece[], rules: Rule[], cap: number) => {
  const n = pieces.length;
  const filled = Array.from({ length: rows * 5 }, (_, k) => off.has(`${Math.floor(k / 5)}:${k % 5}`));
  const allowed = pieces.map(() => new Set(Array.from({ length: rows }, (_, r) => r)));
  const days: number[][] = pieces.map(() => []);
  const pairs: Rule[][] = pieces.map(() => []);
  for (const r of rules) {
    if (r.kind === 'who') for (const row of [...allowed[r.piece]!]) if (!r.people.includes(row)) allowed[r.piece]!.delete(row);
    if (r.kind === 'day') days[r.piece]!.push(r.day);
    if (r.kind === 'after' || r.kind === 'together') for (const i of ruleBlocks(r)) pairs[i]!.push(r);
  }
  // Blocks of the same length that no rule mentions are interchangeable:
  // search them as one (or swapping them blows the search up), then count
  // every way of swapping them back.
  const named = new Set(rules.flatMap(ruleBlocks));
  const sig = pieces.map((p, i) => (named.has(i) ? `#${i}` : `L${p.len}`));
  let swaps = 1;
  const sizes = new Map<string, number>();
  for (const g of sig) sizes.set(g, (sizes.get(g) ?? 0) + 1);
  for (const size of sizes.values()) for (let f = 2; f <= size; f++) swaps *= f;
  const places: Place[] = Array(n).fill(null);
  let found = 0;
  const go = (from: number) => {
    let k = from;
    while (k < filled.length && filled[k]) k++;
    if (k === filled.length) {
      found++;
      return;
    }
    const row = Math.floor(k / 5);
    const col = k % 5;
    const tried = new Set<string>();
    for (let i = 0; i < n && found * swaps < cap; i++) {
      if (places[i] || tried.has(sig[i]!)) continue;
      const p = pieces[i]!;
      if (!allowed[i]!.has(row) || col + p.len > 5) continue;
      let free = true;
      for (let c = col; c < col + p.len; c++) if (filled[row * 5 + c]) free = false;
      if (!free || !days[i]!.every((d) => d >= col && d < col + p.len)) continue;
      places[i] = { row, col };
      tried.add(sig[i]!);
      if (pairs[i]!.every((r) => ruleState(r, pieces, places) !== false)) {
        for (let c = col; c < col + p.len; c++) filled[row * 5 + c] = true;
        go(k + p.len);
        for (let c = col; c < col + p.len; c++) filled[row * 5 + c] = false;
      }
      places[i] = null;
    }
  };
  go(0);
  return Math.min(cap, found * swaps);
};

/** How many answers a week has, up to `cap` (for tests and the generator). */
export const answers = (w: Pick<Week, 'rows' | 'off' | 'pieces' | 'rules'>, cap = 2) => countAnswers(w.rows, w.off, w.pieces, w.rules, cap);

// --- Making a week ---

const LEVEL = [
  // rows, days off, hints on top of the rules that are needed
  { rows: 3, off: 2, spare: 3 },
  { rows: 4, off: 3, spare: 1 },
  { rows: 4, off: 2, spare: 0 },
] as const;

/** Counting stops here: enough to compare rules by how much they narrow things down. */
const CAP = 120;

const sameRule = (a: Rule, b: Rule) => JSON.stringify(a) === JSON.stringify(b);

/** Rules true of the answer, the kinds people find interesting weighed up. */
const candidates = (rng: Rng, rows: number, pieces: Piece[], sol: Place[]): Rule[] => {
  const out: Rule[] = [];
  const n = pieces.length;
  for (let i = 0; i < n; i++) {
    const at = sol[i]!;
    const others = Array.from({ length: rows }, (_, r) => r).filter((r) => r !== at.row);
    out.push({ kind: 'who', piece: i, people: [at.row] });
    for (let k = 0; k < 2; k++) out.push({ kind: 'who', piece: i, people: [at.row, pick(rng, others)].sort() });
    for (let d = at.col; d <= ends(pieces[i]!, at); d++) out.push({ kind: 'day', piece: i, day: d });
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = sol[j]!;
      if (b.col > ends(pieces[i]!, at)) out.push({ kind: 'after', first: i, then: j });
      if (i < j && at.row !== b.row && ruleState({ kind: 'together', a: i, b: j }, pieces, sol)) out.push({ kind: 'together', a: i, b: j });
    }
  }
  return out;
};
const WEIGHT: Record<Rule['kind'], number> = { who: 3, day: 2, after: 4, together: 3 };
const weighted = (rng: Rng, rules: Rule[]) => {
  const total = rules.reduce((s, r) => s + WEIGHT[r.kind] + (r.kind === 'who' && r.people.length === 1 ? -2 : 0), 0);
  let x = rng() * total;
  for (const r of rules) {
    x -= WEIGHT[r.kind] + (r.kind === 'who' && r.people.length === 1 ? -2 : 0);
    if (x <= 0) return r;
  }
  return rules[rules.length - 1]!;
};

export const makeWeek = (seed: number, level: Level, number = 0): Week => {
  const rng = mulberry32(seed);
  const L = LEVEL[level];
  for (let attempt = 0; ; attempt++) {
    const rows = L.rows;
    // Days off: never two on the same day.
    const off = new Set<string>();
    const cols = shuffle(rng, [0, 1, 2, 3, 4]);
    for (let k = 0; k < L.off; k++) off.add(`${Math.floor(rng() * rows)}:${cols[k]}`);
    // The answer: each person's free days cut into blocks of 1–3 days.
    const pieces: Piece[] = [];
    const sol: Place[] = [];
    const titles = shuffle(rng, [...TITLES]);
    const colors = shuffle(rng, [...COLORS]);
    for (let r = 0; r < rows; r++) {
      let c = 0;
      while (c < 5) {
        if (off.has(`${r}:${c}`)) {
          c++;
          continue;
        }
        let run = 0;
        while (c + run < 5 && !off.has(`${r}:${c + run}`)) run++;
        while (run > 0) {
          const x = rng();
          const len = Math.min(run, x < 0.18 ? 1 : x < 0.62 ? 2 : 3);
          pieces.push({ id: pieces.length, title: titles[pieces.length % titles.length]!, color: colors[pieces.length % colors.length]!, len });
          sol.push({ row: r, col: c });
          run -= len;
          c += len;
        }
      }
    }
    // Shuffle the tray (ids follow the tray order).
    const order = shuffle(rng, pieces.map((_, i) => i));
    const tray = order.map((i, k) => ({ ...pieces[i]!, id: k }));
    const answer = order.map((i) => sol[i]!);
    // Add rules until the answer is the only one.
    const pool = candidates(rng, rows, tray, answer);
    // Start from a two-person hint on every block: that narrows the search
    // enough to count answers quickly. Tidying takes the unneeded ones away.
    const rules: Rule[] = pool.filter((r, k) => r.kind === 'who' && r.people.length === 2 && pool.findIndex((x) => x.kind === 'who' && x.piece === r.piece && x.people.length === 2) === k);
    let left = answers({ rows, off, pieces: tray, rules }, CAP);
    while (left > 1) {
      const open = pool.filter((r) => !rules.some((x) => sameRule(x, r)));
      if (!open.length) break;
      // A few weighted picks; keep the one that narrows things down most.
      let best: Rule | null = null;
      let bestLeft = left;
      for (let k = 0; k < 5; k++) {
        const r = weighted(rng, open);
        const n = answers({ rows, off, pieces: tray, rules: [...rules, r] }, left);
        if (n < bestLeft) {
          best = r;
          bestLeft = n;
        }
      }
      // Still too many answers to tell apart: any true rule helps.
      if (!best) {
        best = weighted(rng, open);
        bestLeft = answers({ rows, off, pieces: tray, rules: [...rules, best] }, CAP);
      }
      rules.push(best);
      left = bestLeft;
      if (rules.length > 24) break;
    }
    if (left !== 1) continue;
    // Drop every rule that isn't needed, so each one counts.
    for (const r of shuffle(rng, [...rules])) {
        const without = rules.filter((x) => x !== r);
        if (answers({ rows, off, pieces: tray, rules: without }) === 1) rules.splice(rules.indexOf(r), 1);
      }
    // Easier days: a few extra hints.
    for (let k = 0; k < L.spare; k++) {
      const open = pool.filter((r) => r.kind === 'who' && !rules.some((x) => sameRule(x, r)));
      if (open.length) rules.push(pick(rng, open));
    }
    // Keep the rules list readable; otherwise try another week.
    const listed = rules.filter((r) => r.kind !== 'who').length;
    if ((listed > 7 || listed < 2) && attempt < 40) continue;
    // Who-rules on one block: merged into the narrowest.
    const merged: Rule[] = [];
    for (const r of rules) {
      if (r.kind !== 'who') {
        merged.push(r);
        continue;
      }
      const prev = merged.find((x) => x.kind === 'who' && x.piece === r.piece) as Extract<Rule, { kind: 'who' }> | undefined;
      if (!prev) merged.push({ ...r });
      else prev.people = prev.people.filter((p) => r.people.includes(p));
    }
    const order2: Rule['kind'][] = ['day', 'after', 'together', 'who'];
    merged.sort((a, b) => order2.indexOf(a.kind) - order2.indexOf(b.kind));
    return { number, level, rows, off, pieces: tray, rules: merged, solution: answer };
  }
};

// --- Today's week ---

/** Day numbers in the visitor's own calendar. */
export const localDay = (d = new Date()) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
/** #1 was Thursday 1 October 2026. */
const FIRST = Math.floor(Date.UTC(2026, 9, 1) / 86_400_000);
/** Easy at the start of the week, hard on Friday and Saturday. */
export const levelOf = (day: number): Level => {
  const wd = (((day + 3) % 7) + 7) % 7; // 0 = Monday
  return wd <= 1 ? 0 : wd === 4 || wd === 5 ? 2 : 1;
};
const hash = (n: number) => {
  let h = n ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};
export const dailyWeek = (day = localDay()) => makeWeek(hash(day), levelOf(day), day - FIRST + 1);
export const practiceWeek = (level: Level) => makeWeek(Math.floor(Math.random() * 2 ** 31), level, 0);

// --- Words ---

const list = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`);
export const whoLabel = (people: number[]) => (people.length === 1 ? `Only ${PEOPLE[people[0]!]}` : list(people.map((p) => PEOPLE[p]!)));
export const ruleText = (r: Rule, pieces: Piece[]) => {
  const t = (i: number) => pieces[i]!.title;
  switch (r.kind) {
    case 'who':
      return `${t(r.piece)}: ${whoLabel(r.people).replace(/^Only/, 'only')}`;
    case 'day':
      return `${t(r.piece)} on ${DAY_NAMES[r.day]}`;
    case 'after':
      return `${t(r.then)} after ${t(r.first)}`;
    case 'together':
      return `${t(r.a)} and ${t(r.b)} on the same day`;
  }
};
