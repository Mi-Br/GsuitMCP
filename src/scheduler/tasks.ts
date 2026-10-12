import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { validate as validateCron } from "node-cron";
import type { Paths } from "../config.js";

export const TaskKind = z.enum(["digest", "label_rule"]);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  enabled: z.boolean().default(true),
  /** Standard 5-field cron, e.g. "0 8 * * 1-5". */
  schedule: z.string().refine((s) => validateCron(s), { message: "Invalid cron expression (expected 5 fields, e.g. '0 8 * * 1-5')." }),
  /** IANA timezone such as "Europe/Amsterdam". Defaults to the machine's local zone. */
  timezone: z.string().optional(),
  /** Account selector: alias, email, comma list, or "all". */
  accounts: z.string().default("all"),
  kind: TaskKind,
  /** Gmail search query. For digest: which mail to collect. For label_rule: which mail to act on. */
  query: z.string().default(""),
  maxResults: z.number().int().min(1).max(100).default(25),
  /** label_rule only */
  action: z
    .object({
      addLabels: z.array(z.string()).optional(),
      removeLabels: z.array(z.string()).optional(),
      markRead: z.boolean().optional(),
      archive: z.boolean().optional(),
      star: z.boolean().optional(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRunAt: z.string().optional(),
  lastStatus: z.enum(["ok", "error", "partial"]).optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskInputSchema = TaskSchema.omit({ id: true, createdAt: true, updatedAt: true, lastRunAt: true, lastStatus: true });
export type TaskInput = z.infer<typeof TaskInputSchema>;

export interface TaskRunAccount {
  account: string;
  email: string;
  error?: string;
  /** digest */
  matched?: number;
  newSinceLastRun?: number;
  messages?: Array<Record<string, unknown> & { isNew?: boolean }>;
  /** label_rule */
  modified?: number;
}

export interface TaskRun {
  taskId: string;
  runAt: string;
  durationMs: number;
  trigger: "schedule" | "manual";
  status: "ok" | "error" | "partial";
  accounts: TaskRunAccount[];
  error?: string;
}

const MAX_RUNS_KEPT = 50;

export class TaskStore {
  constructor(private readonly paths: Paths) {}

  private read(): Task[] {
    if (!fs.existsSync(this.paths.tasks)) return [];
    const raw = JSON.parse(fs.readFileSync(this.paths.tasks, "utf8")) as { tasks?: unknown[] };
    return (raw.tasks ?? []).map((t) => TaskSchema.parse(t));
  }

  private write(tasks: Task[]): void {
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.paths.tasks, JSON.stringify({ version: 1, tasks }, null, 2) + "\n", { mode: 0o600 });
  }

  list(): Task[] {
    return this.read();
  }

  get(id: string): Task | undefined {
    return this.read().find((t) => t.id === id);
  }

  create(input: TaskInput): Task {
    const parsed = TaskInputSchema.parse(input);
    validateKind(parsed);
    const now = new Date().toISOString();
    const task: Task = { ...parsed, id: `task_${randomBytes(4).toString("hex")}`, createdAt: now, updatedAt: now };
    const tasks = this.read();
    tasks.push(task);
    this.write(tasks);
    return task;
  }

  update(id: string, patch: Partial<TaskInput>): Task {
    const tasks = this.read();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`No scheduled task with id ${id}.`);
    const merged = TaskSchema.parse({ ...tasks[idx], ...patch, updatedAt: new Date().toISOString() });
    validateKind(merged);
    tasks[idx] = merged;
    this.write(tasks);
    return merged;
  }

  recordRunStatus(id: string, status: Task["lastStatus"], at: string): void {
    const tasks = this.read();
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    t.lastRunAt = at;
    t.lastStatus = status;
    this.write(tasks);
  }

  delete(id: string): boolean {
    const tasks = this.read();
    const next = tasks.filter((t) => t.id !== id);
    this.write(next);
    const runs = this.runsPath(id);
    if (fs.existsSync(runs)) fs.unlinkSync(runs);
    return next.length !== tasks.length;
  }

  // ---------- runs ----------

  private runsPath(id: string): string {
    return path.join(this.paths.runsDir, `${id}.jsonl`);
  }

  appendRun(run: TaskRun): void {
    fs.mkdirSync(this.paths.runsDir, { recursive: true, mode: 0o700 });
    const existing = this.runs(run.taskId, MAX_RUNS_KEPT - 1);
    const lines = [...existing, run].map((r) => JSON.stringify(r));
    fs.writeFileSync(this.runsPath(run.taskId), lines.join("\n") + "\n", { mode: 0o600 });
  }

  runs(id: string, limit = 10): TaskRun[] {
    const p = this.runsPath(id);
    if (!fs.existsSync(p)) return [];
    const all = fs
      .readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TaskRun);
    return all.slice(-limit);
  }

  lastRun(id: string): TaskRun | undefined {
    const r = this.runs(id, 1);
    return r[0];
  }
}

function validateKind(task: TaskInput): void {
  if (task.kind === "label_rule") {
    const a = task.action ?? {};
    const hasAny = (a.addLabels?.length ?? 0) > 0 || (a.removeLabels?.length ?? 0) > 0 || a.markRead || a.archive || a.star;
    if (!hasAny) throw new Error("A label_rule task needs an action (addLabels, removeLabels, markRead, archive, or star).");
    if (!task.query.trim()) throw new Error("A label_rule task needs a non-empty query so it does not touch every message.");
  }
}
