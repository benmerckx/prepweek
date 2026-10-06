// The daily digest: one email on workday mornings with what's on your plate
// today, what starts next, and what others did on your work since the last
// one. Built per sheet inside the sheet's Durable Object (from its TinyBase
// store), sent from the hourly cron (see sendDigests).

import type { MergeableStore } from "tinybase";
import { dayFromYMD, isWeekend, type Day } from "../src/lib/dates.ts";
import {
  HORIZON_DAYS,
  isRule,
  occurrences,
  parseSkip,
} from "../src/lib/recur.ts";
import { canEmail, directory, sendEmail } from "./auth.ts";
import { escapeHtml, renderDigest, type DigestSection } from "./email.ts";
import type { Env } from "./env.ts";

export interface DigestItem {
  /** The row to open. */
  taskId: string;
  title: string;
  color: string;
  /** "Mon 6 – Wed 8", "10:30–11:00", or who did what. */
  detail: string;
}

export interface SheetDigest {
  today: DigestItem[];
  next: DigestItem[];
  /** Mentions, comments and changes by others, newest first. */
  updates: DigestItem[];
  /** How many more of each there were than fit. */
  more: { today: number; next: number; updates: number };
}

const LIMIT = 8;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const dayLabel = (day: Day) => {
  const d = new Date(day * 86_400_000);
  return `${WEEKDAYS[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const nextWorkday = (day: Day) => {
  let d = day + 1;
  while (isWeekend(d)) d++;
  return d;
};
const clip = (s: string, n = 120) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

type Task = {
  userId: string;
  start: number;
  end: number;
  title: string;
  color: string;
  done: boolean;
  time: string;
  repeat: string;
  repeatUntil: number;
  skip: string;
  group: string;
  kind: string;
};

/** One person's digest on one sheet; null when there's nothing to say. */
export const sheetDigest = (
  store: MergeableStore,
  email: string,
  day: Day,
  since: number,
): SheetDigest | null => {
  const e = email.trim().toLowerCase();
  const me = store.getRowIds("users").find(
    (id) =>
      String(store.getCell("users", id, "email") ?? "")
        .trim()
        .toLowerCase() === e,
  );
  if (!me) return null;

  const today: (DigestItem & { sort: string })[] = [];
  const next: (DigestItem & { sort: string })[] = [];
  const tomorrow = nextWorkday(day);
  const myThreads = new Set<string>();
  /** A thread's row to open: mine when I'm on the task. */
  const rowOf = new Map<string, string>();
  for (const id of store.getRowIds("tasks")) {
    const t = store.getRow("tasks", id) as unknown as Task;
    const thread = t.group || id;
    if (t.userId !== me) {
      if (!rowOf.has(thread)) rowOf.set(thread, id);
      continue;
    }
    myThreads.add(thread);
    rowOf.set(thread, id);
    // Time off isn't work to do.
    if (t.done || t.kind === 'off') continue;
    const runs = isRule(t.repeat)
      ? occurrences(
          t.start,
          t.end,
          t.repeat,
          t.repeatUntil ?? 0,
          parseSkip(t.skip),
          tomorrow,
        ).filter((o) => o.end >= day)
      : [{ start: t.start, end: t.end }];
    for (const r of runs) {
      const item = { taskId: id, title: t.title || "Untitled", color: t.color };
      if (r.start <= day && r.end >= day) {
        const detail =
          t.time ||
          (r.end > r.start
            ? r.end === day
              ? "Last day"
              : `Until ${dayLabel(r.end)}`
            : "Today");
        today.push({ ...item, detail, sort: t.time });
      } else if (r.start === tomorrow) {
        const detail = `${dayLabel(r.start)}${r.end > r.start ? ` – ${dayLabel(r.end)}` : ""}${t.time ? `, ${t.time}` : ""}`;
        next.push({ ...item, detail, sort: t.time });
      }
    }
  }

  const title = (thread: string, fallback = "") => {
    const row = rowOf.get(thread) ?? thread;
    return store.hasRow("tasks", row)
      ? String(store.getCell("tasks", row, "title") || "Untitled")
      : fallback;
  };
  const color = (thread: string) =>
    String(
      store.getCell("tasks", rowOf.get(thread) ?? thread, "color") ?? "#8b8d98",
    );
  const mine = (taskId: string) =>
    myThreads.has(taskId) || store.getCell("tasks", taskId, "userId") === me;

  // Newest first; one line per task for changes ("Ava: Move task, Rename task").
  const updates: (DigestItem & { at: number })[] = [];
  for (const id of store.getRowIds("comments")) {
    const c = store.getRow("comments", id) as {
      taskId: string;
      at: number;
      by: string;
      byId: string;
      text: string;
      mentions: string;
    };
    if (c.at <= since || c.byId === me) continue;
    const mentioned = c.mentions.split(",").includes(me);
    if (!mentioned && !mine(c.taskId)) continue;
    const by = c.by || "Someone";
    updates.push({
      taskId: rowOf.get(c.taskId) ?? c.taskId,
      title: title(c.taskId, "A task"),
      color: color(c.taskId),
      detail: `${by} ${mentioned ? "mentioned you" : "commented"}: “${clip(c.text.replace(/\s+/g, " ").trim())}”`,
      at: c.at,
    });
  }
  const changes = new Map<
    string,
    { at: number; who: Set<string>; what: Set<string>; title: string }
  >();
  for (const id of store.getRowIds("activity")) {
    const a = store.getRow("activity", id) as {
      at: number;
      by: string;
      byId: string;
      label: string;
      taskId: string;
      title: string;
      owner: string;
    };
    if (a.at <= since || !a.taskId || a.byId === me || /comment/i.test(a.label))
      continue;
    if (a.owner !== me && !mine(a.taskId)) continue;
    const key = rowOf.get(a.taskId) ?? a.taskId;
    const c = changes.get(key) ?? {
      at: 0,
      who: new Set(),
      what: new Set(),
      title: title(a.taskId, a.title || "A task"),
    };
    c.at = Math.max(c.at, a.at);
    c.who.add(a.by || "Someone");
    c.what.add(a.label.toLowerCase());
    changes.set(key, c);
  }
  for (const [taskId, c] of changes) {
    const what = [...c.what];
    updates.push({
      taskId,
      title: c.title,
      color: color(taskId),
      detail: `${[...c.who].join(", ")}: ${what.slice(0, 3).join(", ")}${what.length > 3 ? ` and ${what.length - 3} more` : ""}`,
      at: c.at,
    });
  }

  if (!today.length && !next.length && !updates.length) return null;
  // All-day work first, then by time of day.
  const bySort = (
    a: { sort: string; title: string },
    b: { sort: string; title: string },
  ) =>
    (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0) ||
    a.title.localeCompare(b.title);
  today.sort(bySort);
  next.sort(bySort);
  updates.sort((a, b) => b.at - a.at);
  const strip = <T extends DigestItem>({
    taskId,
    title,
    color,
    detail,
  }: T): DigestItem => ({ taskId, title, color, detail });
  return {
    today: today.slice(0, LIMIT).map(strip),
    next: next.slice(0, LIMIT).map(strip),
    updates: updates.slice(0, LIMIT).map(strip),
    more: {
      today: Math.max(0, today.length - LIMIT),
      next: Math.max(0, next.length - LIMIT),
      updates: Math.max(0, updates.length - LIMIT),
    },
  };
};

/** The day number and date ("2026-10-06"), hour and weekday of `now` in `tz`. */
export const localTime = (now: number, tz: string) => {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  }
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const day = dayFromYMD(y, m - 1, d);
  return {
    day,
    date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    hour: get("hour") % 24,
    weekend: isWeekend(day),
  };
};

/** Digests go out at this local hour, Monday to Friday. */
export const DIGEST_HOUR = 7;
const WEEK_MS = 7 * 86_400_000;

export interface DigestRecipient {
  userId: string;
  email: string;
  name: string;
  token: string;
  date: string;
  day: Day;
  since: number;
  /** Where the person uses the app ('' = unknown). */
  origin: string;
  sheets: { id: string; name: string }[];
}

/** Build one person's email from their sheets; null when there's nothing in it. */
export const buildDigest = async (
  env: Env,
  r: DigestRecipient,
  origin: string,
) => {
  const sections: DigestSection[] = [];
  let count = 0;
  for (const sheet of r.sheets) {
    const stub = env.SHEETS.get(env.SHEETS.idFromName(`sync/${sheet.id}`));
    const d = await stub.digest(r.email, r.day, r.since).catch((e) => {
      console.error("digest", sheet.id, e);
      return null;
    });
    if (!d) continue;
    count += d.today.length + d.next.length + d.updates.length;
    sections.push({
      sheet: sheet.name,
      href: `${origin}/s/${encodeURIComponent(sheet.id)}`,
      ...d,
    });
  }
  if (!count) return null;
  const today = sections.reduce((n, s) => n + s.today.length + s.more.today, 0);
  const updates = sections.reduce(
    (n, s) => n + s.updates.length + s.more.updates,
    0,
  );
  const summary = [
    today
      ? `${today} thing${today === 1 ? "" : "s"} on today`
      : "Nothing planned today",
    updates ? `${updates} update${updates === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const first = r.name.split(" ")[0] || "there";
  return {
    offHref: `${origin}/api/digest/off?t=${encodeURIComponent(r.token)}`,
    subject: `Your day: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`,
    html: renderDigest({
      origin,
      preheader: escapeHtml(summary),
      heading: `Good morning, ${escapeHtml(first)}`,
      intro: escapeHtml(`${summary}.`),
      sections,
      offHref: `${origin}/api/digest/off?t=${encodeURIComponent(r.token)}`,
    }),
  };
};

/** The hourly cron: everyone whose workday morning it is gets theirs. */
export const sendDigests = async (env: Env, now = Date.now()) => {
  if (!canEmail(env)) return;
  const due = await directory(env).dueForDigest(now);
  for (const r of due) {
    try {
      const origin = (env.APP_URL || r.origin).replace(/\/$/, "");
      const mail = await buildDigest(
        env,
        { ...r, since: Math.max(r.since, now - WEEK_MS) },
        origin,
      );
      if (mail)
        await sendEmail(env, r.email, mail.subject, mail.html, {
          "List-Unsubscribe": `<${mail.offHref}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        });
      await directory(env).markDigestSent(r.userId, r.date, now);
    } catch (e) {
      console.error("digest for", r.userId, e);
    }
  }
};
