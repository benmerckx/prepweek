import { store, PALETTE, newId, joinTags } from './store.ts';
import { today, startOfWeek, isWeekend } from '../lib/dates.ts';

const FIRST = ['Ava', 'Noah', 'Mila', 'Lucas', 'Emma', 'Liam', 'Nora', 'Arthur', 'Lena', 'Jules', 'Olivia', 'Finn',
  'Sofia', 'Louis', 'Julia', 'Victor', 'Hanna', 'Mats', 'Elise', 'Milan', 'Lotte', 'Sem', 'Fien', 'Bas',
  'Ines', 'Tibo', 'Lore', 'Wout', 'Amber', 'Kobe', 'Saar', 'Jasper', 'Zoë', 'Robbe', 'Marie', 'Thijs'];
const LAST = ['Peeters', 'Janssens', 'Maes', 'Jacobs', 'Mertens', 'Willems', 'Claes', 'Goossens', 'Wouters', 'De Smet'];
const PROJECTS = [
  'Website relaunch', 'Mobile app', 'Brand refresh', 'API v3', 'Onboarding flow', 'Data migration',
  'Design system', 'Q-planning', 'Client workshop', 'Billing revamp', 'Search', 'Support rotation',
  'Customer interviews', 'Security audit', 'Marketing site', 'Analytics', 'Holiday', 'Conference',
];

/** Demo clients; titles not listed are internal projects (or none). */
const CLIENTS: Record<string, string> = {
  'Website relaunch': 'Acme', 'Mobile app': 'Acme', 'Brand refresh': 'Globex', 'Marketing site': 'Globex',
  'API v3': 'Initech', 'Data migration': 'Initech', 'Billing revamp': 'Initech', 'Client workshop': 'Globex',
};
const NO_PROJECT = new Set(['Holiday', 'Conference']);
const TAGS = ['billable', 'onsite', 'remote', 'urgent', 'review'];
/** A few kinds of work get a fill pattern in the demo. */
const PATTERN_OF: Record<string, string> = {
  Holiday: 'stripes', Conference: 'dots', 'Support rotation': 'zigzag', 'Q-planning': 'grid', 'Customer interviews': 'waves',
};

/** Small deterministic PRNG so the demo looks the same everywhere. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Fill the store with people and tasks spread over roughly two years around
 * today. `density` scales the number of tasks (1 ≈ 3k tasks for 24 people).
 */
export const seed = (people = 24, density = 1, seedValue = 7) => {
  const rnd = mulberry32(seedValue);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const from = startOfWeek(today()) - 7 * 52;
  const to = startOfWeek(today()) + 7 * 60;

  store.transaction(() => {
    store.delTables();
    const t0 = today();
    const ms: [number, string, string][] = [
      [t0 - 26, 'Kickoff', '#64748b'],
      [t0 + 9, 'Design freeze', '#8b5cf6'],
      [t0 + 31, 'v2 launch', '#ef4444'],
      [t0 + 52, 'Offsite', '#22a06b'],
      [t0 + 80, 'Year-end freeze', '#4f5bd5'],
    ];
    for (const [day, title, color] of ms) store.setRow('milestones', newId(), { day, title, color });
    const projectId = new Map<string, string>();
    PROJECTS.forEach((name, i) => {
      if (NO_PROJECT.has(name)) return;
      const id = newId();
      projectId.set(name, id);
      store.setRow('projects', id, { name, client: CLIENTS[name] ?? '', color: PALETTE[i % PALETTE.length]!, archived: false });
    });
    const extra = (title: string) => ({
      projectId: projectId.get(title) ?? '',
      pattern: PATTERN_OF[title] ?? '',
      tags: rnd() < 0.22 ? joinTags(rnd() < 0.2 ? [pick(TAGS), pick(TAGS)] : [pick(TAGS)]) : '',
    });
    for (let u = 0; u < people; u++) {
      const userId = newId();
      store.setRow('users', userId, {
        name: `${FIRST[u % FIRST.length]} ${LAST[(u * 7) % LAST.length]}`,
        color: PALETTE[u % PALETTE.length]!,
        order: u,
        team: people > 40 ? '' : u < 6 ? 'Design' : u < 16 ? 'Engineering' : 'Product',
      });
      // Each person has a few "main" projects and some noise.
      const mains = [pick(PROJECTS), pick(PROJECTS), pick(PROJECTS)];
      let day = from + Math.floor(rnd() * 5);
      while (day < to) {
        const len = rnd() < 0.15 ? 1 : 1 + Math.floor(rnd() * rnd() * 15);
        let start = day;
        while (isWeekend(start)) start++;
        const end = start + len - 1;
        const title = rnd() < 0.7 ? pick(mains) : pick(PROJECTS);
        const color = PALETTE[PROJECTS.indexOf(title) % PALETTE.length]!;
        store.setRow('tasks', newId(), { userId, start, end, title, color, lane: -1, notes: '', ...extra(title) });
        // Occasionally stack a parallel task to exercise the lane packer.
        if (rnd() < 0.35 * density) {
          const s2 = start + Math.floor(rnd() * len);
          const t2 = pick(PROJECTS);
          store.setRow('tasks', newId(), {
            userId, start: s2, end: s2 + Math.floor(rnd() * 6), title: t2,
            color: PALETTE[PROJECTS.indexOf(t2) % PALETTE.length]!, lane: -1, notes: '', ...extra(t2),
          });
        }
        day = end + 1 + Math.floor((rnd() * 4) / density);
        // Now and then a free stretch (holiday, bench time).
        if (rnd() < 0.05) day += 5 + Math.floor(rnd() * 12);
      }
    }
  });
};
