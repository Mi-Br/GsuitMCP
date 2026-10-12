import fs from "node:fs";
import cron, { type ScheduledTask } from "node-cron";
import { log, type Paths } from "../config.js";
import type { AccountStore } from "../accounts.js";
import { forEachAccount, type ServiceRegistry } from "../registry.js";
import { TaskStore, type Task, type TaskRun, type TaskRunAccount } from "./tasks.js";

/**
 * Executes a task once. Used both by the cron scheduler and by the `run_scheduled_task` tool.
 */
export async function executeTask(
  task: Task,
  registry: ServiceRegistry,
  store: AccountStore,
  tasks: TaskStore,
  trigger: TaskRun["trigger"],
): Promise<TaskRun> {
  const started = Date.now();
  const runAt = new Date(started).toISOString();
  let accountsResult: TaskRunAccount[] = [];
  let error: string | undefined;

  try {
    const accounts = store.resolve(task.accounts);
    const previous = tasks.lastRun(task.id);
    const seenBefore = new Set(
      (previous?.accounts ?? []).flatMap((a) => (a.messages ?? []).map((m) => `${a.account}:${String(m.id)}`)),
    );

    const results = await forEachAccount(registry, accounts, async (svc, account) => {
      if (task.kind === "digest") {
        const { messages } = await svc.search(task.query, task.maxResults);
        const withNew = messages.map((m) => ({ ...m, isNew: !seenBefore.has(`${account.alias}:${m.id}`) }));
        return { matched: messages.length, newSinceLastRun: withNew.filter((m) => m.isNew).length, messages: withNew };
      }
      // label_rule
      if (account.readonly) throw new Error("Account is read-only; label rules cannot run on it.");
      const { messages } = await svc.search(task.query, task.maxResults);
      if (messages.length === 0) return { matched: 0, modified: 0 };
      const change = task.action ?? {};
      const res = await svc.modifyMessages(
        messages.map((m) => m.id),
        { addLabels: change.addLabels, removeLabels: change.removeLabels, markRead: change.markRead, archive: change.archive, star: change.star },
      );
      return { matched: messages.length, modified: res.modified.length };
    });

    accountsResult = results.map((r) => ({ account: r.account, email: r.email, error: r.error, ...(r.result ?? {}) }));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const failures = accountsResult.filter((a) => a.error).length;
  const status: TaskRun["status"] = error ? "error" : failures === 0 ? "ok" : failures === accountsResult.length ? "error" : "partial";
  const run: TaskRun = { taskId: task.id, runAt, durationMs: Date.now() - started, trigger, status, accounts: accountsResult, error };
  tasks.appendRun(run);
  tasks.recordRunStatus(task.id, status, runAt);
  log(`task ${task.id} (${task.name}) finished: ${status}${error ? ` - ${error}` : ""}`);
  return run;
}

interface LockFile {
  pid: number;
  heartbeat: number;
}

const HEARTBEAT_MS = 30_000;
const STALE_MS = 90_000;

/**
 * Runs the cron jobs. Only one process on the machine should do that, even if
 * Claude Desktop and Claude Code both spawn the server, so a lock file elects a leader.
 */
export class Scheduler {
  private jobs = new Map<string, ScheduledTask>();
  private heartbeat?: NodeJS.Timeout;
  private holdsLock = false;

  constructor(
    private readonly paths: Paths,
    private readonly registry: ServiceRegistry,
    private readonly accountStore: AccountStore,
    readonly tasks: TaskStore,
  ) {}

  get active(): boolean {
    return this.holdsLock;
  }

  start(): boolean {
    if (process.env.GMAIL_MCP_SCHEDULER === "off") {
      log("scheduler disabled via GMAIL_MCP_SCHEDULER=off");
      return false;
    }
    if (!this.acquireLock()) {
      log("another gmail-multi-mcp process already runs the scheduler; this one will only serve tools");
      return false;
    }
    this.holdsLock = true;
    this.heartbeat = setInterval(() => this.writeLock(), HEARTBEAT_MS);
    this.heartbeat.unref();
    this.reload();
    return true;
  }

  /** Re-read tasks.json and (re)schedule everything. Call after any task change. */
  reload(): void {
    if (!this.holdsLock) return;
    for (const job of this.jobs.values()) void job.destroy();
    this.jobs.clear();
    for (const task of this.tasks.list()) {
      if (!task.enabled) continue;
      try {
        const job = cron.schedule(
          task.schedule,
          async () => {
            await executeTask(task, this.registry, this.accountStore, this.tasks, "schedule");
          },
          { timezone: task.timezone, noOverlap: true, name: task.id },
        );
        this.jobs.set(task.id, job);
      } catch (err) {
        log(`could not schedule task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log(`scheduler active with ${this.jobs.size} task(s)`);
  }

  nextRun(taskId: string): string | undefined {
    const job = this.jobs.get(taskId);
    const next = job?.getNextRun();
    return next ? next.toISOString() : undefined;
  }

  stop(): void {
    for (const job of this.jobs.values()) void job.destroy();
    this.jobs.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.holdsLock) {
      try {
        fs.unlinkSync(this.paths.schedulerLock);
      } catch {
        /* already gone */
      }
      this.holdsLock = false;
    }
  }

  private readLock(): LockFile | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.paths.schedulerLock, "utf8")) as LockFile;
    } catch {
      return undefined;
    }
  }

  private writeLock(): void {
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.paths.schedulerLock, JSON.stringify({ pid: process.pid, heartbeat: Date.now() } satisfies LockFile));
  }

  private acquireLock(): boolean {
    const existing = this.readLock();
    if (existing && existing.pid !== process.pid) {
      const fresh = Date.now() - existing.heartbeat < STALE_MS;
      if (fresh && isProcessAlive(existing.pid)) return false;
    }
    this.writeLock();
    return true;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
