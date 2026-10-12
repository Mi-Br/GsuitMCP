import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore } from "../src/scheduler/tasks.js";
import { tempPaths } from "./helpers.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

function store() {
  const paths = tempPaths();
  cleanup.push(paths.root);
  return new TaskStore(paths);
}

describe("TaskStore", () => {
  it("creates, updates, lists and deletes tasks", () => {
    const s = store();
    const t = s.create({ name: "Morning digest", schedule: "0 8 * * 1-5", accounts: "all", kind: "digest", query: "is:unread", maxResults: 10, enabled: true });
    expect(t.id).toMatch(/^task_/);
    expect(s.list()).toHaveLength(1);
    const u = s.update(t.id, { enabled: false, schedule: "30 7 * * *" });
    expect(u.enabled).toBe(false);
    expect(u.schedule).toBe("30 7 * * *");
    expect(s.delete(t.id)).toBe(true);
    expect(s.list()).toHaveLength(0);
  });

  it("rejects invalid cron and empty label rules", () => {
    const s = store();
    expect(() => s.create({ name: "bad", schedule: "every day", accounts: "all", kind: "digest", query: "", maxResults: 5, enabled: true })).toThrow(/cron/i);
    expect(() => s.create({ name: "rule", schedule: "0 * * * *", accounts: "all", kind: "label_rule", query: "from:news", maxResults: 5, enabled: true })).toThrow(/needs an action/);
    expect(() => s.create({ name: "rule", schedule: "0 * * * *", accounts: "all", kind: "label_rule", query: "", maxResults: 5, enabled: true, action: { archive: true } })).toThrow(/non-empty query/);
  });

  it("stores runs newest-last and caps history", () => {
    const s = store();
    const t = s.create({ name: "d", schedule: "* * * * *", accounts: "all", kind: "digest", query: "", maxResults: 5, enabled: true });
    for (let i = 0; i < 60; i++) {
      s.appendRun({ taskId: t.id, runAt: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`, durationMs: 1, trigger: "manual", status: "ok", accounts: [] });
    }
    const runs = s.runs(t.id, 100);
    expect(runs).toHaveLength(50);
    expect(s.lastRun(t.id)?.runAt).toBe("2026-01-01T00:59:00Z");
  });
});
