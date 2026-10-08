// Lane packing for task blocks within one row (one user).
//
// Tasks are closed day intervals [start, end]. We want to stack overlapping
// tasks into horizontal "lanes" so that:
//
//   1. No two tasks in the same lane overlap.
//   2. The number of lanes used by each cluster of overlapping tasks is the
//      minimum possible (= the maximum number of tasks covering any one day).
//   3. Tasks keep their lane between layouts whenever possible, so blocks
//      don't jump around while you drag something nearby or a remote edit
//      arrives. A task can also carry an explicit lane hint (set when the user
//      drops it in a particular lane), which is honoured the same way.
//   4. No gaps: a task never sits below a lane that is free for its whole
//      span. Kept lanes (3) can leave such holes when the task above moves
//      away or is deleted, so a last pass lets tasks float up into them.
//
// Why (2) and (3) don't conflict: we place tasks in start order. When task t
// is placed, every task already occupying a lane at t.start overlaps day
// t.start, so together with t there are at most k of them, where k is the
// cluster's maximum overlap. Hence at least one of the first k lanes is always
// free, and *any* free choice among those k keeps the packing optimal. That
// freedom is what we spend on stability.
//
// Complexity: O(n log n) for the sort plus O(n·k) for placement, which is
// effectively linear because k is small.

export interface PackItem {
  id: string;
  start: number;
  end: number; // inclusive
  /** Preferred lane (explicit hint or previous layout); may be ignored. */
  lane?: number;
}

export interface PackResult {
  lanes: Map<string, number>;
  /** Lanes needed by the busiest cluster in this row (>= 0). */
  laneCount: number;
  /** Maximal runs of overlapping items, in order, with the lanes each needs. */
  clusters: Cluster[];
}

export interface Cluster {
  start: number;
  end: number;
  lanes: number;
}

const byStart = (a: PackItem, b: PackItem): number =>
  a.start - b.start ||
  // Longer tasks first: they anchor the top lanes, which reads better.
  b.end - b.start - (a.end - a.start) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Maximum number of intervals covering a single day (items sorted by start). */
const maxOverlap = (items: PackItem[], from: number, to: number): number => {
  const ends: number[] = [];
  let best = 0;
  for (let i = from; i < to; i++) {
    const it = items[i]!;
    // Drop intervals that ended before this one starts (min-heap would be
    // asymptotically nicer; clusters are small so a sorted insert is faster).
    let j = 0;
    while (j < ends.length && ends[j]! < it.start) j++;
    if (j > 0) ends.splice(0, j);
    let pos = ends.length;
    while (pos > 0 && ends[pos - 1]! > it.end) pos--;
    ends.splice(pos, 0, it.end);
    if (ends.length > best) best = ends.length;
  }
  return best;
};

/**
 * Move tasks up into lanes that are free for their whole span, until none
 * can move. Tasks in one lane never overlap, so sorted by start they're also
 * sorted by end: the lane is free for [start, end] when the last task in it
 * starting by `end` has ended before `start`.
 */
const floatUp = (items: PackItem[], from: number, to: number, lanes: Map<string, number>, laneCount: number) => {
  const byLane: PackItem[][] = Array.from({ length: laneCount }, () => []);
  for (let n = from; n < to; n++) byLane[lanes.get(items[n]!.id)!]!.push(items[n]!);
  /** Index of the last task in `lane` that starts on or before `day` (-1: none). */
  const lastBy = (lane: PackItem[], day: number) => {
    let lo = 0;
    let hi = lane.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lane[mid]!.start <= day) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };
  for (let moved = true; moved; ) {
    moved = false;
    for (let n = from; n < to; n++) {
      const it = items[n]!;
      const cur = lanes.get(it.id)!;
      for (let l = 0; l < cur; l++) {
        const lane = byLane[l]!;
        const at = lastBy(lane, it.end);
        if (at >= 0 && lane[at]!.end >= it.start) continue;
        const old = byLane[cur]!;
        old.splice(old.indexOf(it), 1);
        lane.splice(at + 1, 0, it);
        lanes.set(it.id, l);
        moved = true;
        break;
      }
    }
  }
};

export const packLanes = (input: readonly PackItem[]): PackResult => {
  const items = input.slice().sort(byStart);
  const lanes = new Map<string, number>();
  const clusters: Cluster[] = [];
  let laneCount = 0;

  let i = 0;
  while (i < items.length) {
    // Find the cluster: a maximal run of transitively overlapping intervals.
    let j = i + 1;
    let clusterEnd = items[i]!.end;
    while (j < items.length && items[j]!.start <= clusterEnd) {
      if (items[j]!.end > clusterEnd) clusterEnd = items[j]!.end;
      j++;
    }

    const k = maxOverlap(items, i, j);
    if (k > laneCount) laneCount = k;
    const laneEnd = new Array<number>(k).fill(-Infinity);

    // Lanes kept from before may skip numbers (the task above was deleted):
    // close them up, so tasks keep their order as they move up.
    const ranks = new Map<number, number>();
    for (let n = i; n < j; n++) if (items[n]!.lane !== undefined && items[n]!.lane! >= 0) ranks.set(items[n]!.lane!, 0);
    [...ranks.keys()].sort((a, b) => a - b).forEach((l, r) => ranks.set(l, r));

    for (let n = i; n < j; n++) {
      const it = items[n]!;
      let lane = -1;
      const pref = it.lane === undefined ? undefined : ranks.get(it.lane);
      if (pref !== undefined && pref >= 0 && pref < k && laneEnd[pref]! < it.start) {
        lane = pref;
      } else {
        for (let l = 0; l < k; l++) {
          if (laneEnd[l]! < it.start) {
            lane = l;
            break;
          }
        }
      }
      // Unreachable by the argument above; kept as a guard against bad input
      // (e.g. end < start) so we degrade instead of overlapping.
      if (lane === -1) {
        lane = laneEnd.length;
        laneEnd.push(-Infinity);
        if (laneEnd.length > laneCount) laneCount = laneEnd.length;
      }
      laneEnd[lane] = it.end;
      lanes.set(it.id, lane);
    }
    floatUp(items, i, j, lanes, laneEnd.length);
    clusters.push({ start: items[i]!.start, end: clusterEnd, lanes: laneEnd.length });
    i = j;
  }

  return { lanes, laneCount, clusters };
};
