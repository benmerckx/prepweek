import { expect, test } from "bun:test";
import { createMergeableStore } from "tinybase";
import { dayFromYMD } from "../src/lib/dates.ts";
import { localTime, sheetDigest } from "./digest.ts";

const MON = dayFromYMD(2026, 9, 5); // Monday 5 Oct 2026
const NOW = Date.UTC(2026, 9, 5, 7);

const sheet = () => {
  const s = createMergeableStore();
  s.setRow("users", "me", { name: "Ava", email: "Ava@Example.com" });
  s.setRow("users", "noah", { name: "Noah", email: "noah@example.com" });
  const task = (id: string, row: Record<string, string | number | boolean>) =>
    s.setRow("tasks", id, {
      userId: "me",
      start: MON,
      end: MON,
      title: id,
      color: "#3b7bff",
      done: false,
      time: "",
      repeat: "",
      repeatUntil: 0,
      skip: "",
      group: "",
      ...row,
    });
  task("today", { time: "10:00–11:00" });
  task("week", { start: MON - 2, end: MON + 3 });
  task("done", { done: true });
  task("tuesday", { start: MON + 1, end: MON + 1 });
  task("standup", { start: MON - 7, end: MON - 7, repeat: "weekly" });
  task("shared", { userId: "noah", group: "shared" });
  task("shared2", { group: "shared", start: MON + 10, end: MON + 10 });
  task("noahs", { userId: "noah" });
  s.setRow("comments", "c1", {
    taskId: "shared",
    at: NOW - 1000,
    by: "Noah",
    byId: "noah",
    text: "Ready  for\nreview",
    mentions: "",
  });
  s.setRow("comments", "c2", {
    taskId: "noahs",
    at: NOW - 900,
    by: "Noah",
    byId: "noah",
    text: "Can you look?",
    mentions: "me",
  });
  s.setRow("comments", "c3", {
    taskId: "noahs",
    at: NOW - 800,
    by: "Noah",
    byId: "noah",
    text: "Not for Ava",
    mentions: "",
  });
  s.setRow("comments", "old", {
    taskId: "today",
    at: NOW - 10 * 86_400_000,
    by: "Noah",
    byId: "noah",
    text: "Old",
    mentions: "",
  });
  s.setRow("comments", "own", {
    taskId: "today",
    at: NOW - 500,
    by: "Ava",
    byId: "me",
    text: "Mine",
    mentions: "",
  });
  s.setRow("activity", "a1", {
    at: NOW - 700,
    by: "Noah",
    byId: "noah",
    label: "Move task",
    taskId: "week",
    title: "week",
    owner: "me",
  });
  s.setRow("activity", "a2", {
    at: NOW - 600,
    by: "Noah",
    byId: "noah",
    label: "Rename task",
    taskId: "week",
    title: "week",
    owner: "me",
  });
  s.setRow("activity", "a3", {
    at: NOW - 600,
    by: "Noah",
    byId: "noah",
    label: "Comment",
    taskId: "week",
    title: "week",
    owner: "me",
  });
  return s;
};

test("today, next up and updates for one person", () => {
  const d = sheetDigest(sheet(), "ava@example.com", MON, NOW - 86_400_000)!;
  expect(d.today.map((i) => i.title)).toEqual(["standup", "week", "today"]);
  expect(d.today[2]!.detail).toBe("10:00–11:00");
  expect(d.today.find((i) => i.title === "week")!.detail).toBe(
    "Until Thu 8 Oct",
  );
  expect(d.next.map((i) => i.title)).toEqual(["tuesday"]);
  // Comments on a shared task open my own row of it; a mention elsewhere too.
  expect(d.updates.map((i) => [i.taskId, i.detail])).toEqual([
    ["week", "Noah: move task, rename task"],
    ["noahs", "Noah mentioned you: “Can you look?”"],
    ["shared2", "Noah commented: “Ready for review”"],
  ]);
});

test("nothing for strangers or empty days", () => {
  expect(sheetDigest(sheet(), "someone@else.com", MON, 0)).toBeNull();
  const s = createMergeableStore();
  s.setRow("users", "me", { name: "Ava", email: "ava@example.com" });
  expect(sheetDigest(s, "ava@example.com", MON, 0)).toBeNull();
});

test("local time in a zone", () => {
  const t = localTime(Date.UTC(2026, 9, 5, 22, 30), "Asia/Tokyo");
  expect(t).toEqual({
    day: MON + 1,
    date: "2026-10-06",
    hour: 7,
    weekend: false,
  });
  expect(localTime(Date.UTC(2026, 9, 5, 7), "Not/AZone").hour).toBe(7);
});
