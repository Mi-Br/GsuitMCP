import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Paths } from "./config.js";
import type { AccountRecord, AccountStore } from "./accounts.js";
import { ServiceRegistry, describeError, forEachAccount, sinceToQuery } from "./registry.js";
import { TaskInputSchema, TaskStore } from "./scheduler/tasks.js";
import { Scheduler, executeTask } from "./scheduler/scheduler.js";

export interface ServerDeps {
  paths: Paths;
  store: AccountStore;
  registry: ServiceRegistry;
  tasks: TaskStore;
  scheduler?: Scheduler;
  version?: string;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${describeError(err)}` }], isError: true };
}

function guarded<T>(fn: (args: T) => Promise<unknown>): (args: T) => Promise<ToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

const accountParam = z
  .string()
  .optional()
  .describe('Which Gmail account: an alias (e.g. "work"), an email address, a comma-separated list, or "all" (default). Use list_accounts to see aliases.');

const oneAccountParam = z
  .string()
  .optional()
  .describe('Exactly one Gmail account: an alias (e.g. "work") or email address. May be omitted only when a single account is configured.');

const recipients = z.array(z.string()).describe("Email addresses, optionally with display names: 'Ada <ada@example.com>'.");

const draftFields = {
  to: recipients.optional().describe("Recipients. When replying and omitted, the original sender (or Reply-To) is used."),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  subject: z.string().optional().describe("Subject. When replying and omitted, 'Re: <original subject>' is used."),
  body: z.string().describe("Plain-text body. Keep the user's voice; do not add signatures unless asked."),
  body_html: z.string().optional().describe("Optional HTML version of the body (sent as multipart/alternative)."),
  reply_to_message_id: z.string().optional().describe("Gmail message id to reply to. Threads the draft and sets In-Reply-To/References."),
  reply_all: z.boolean().optional().describe("With reply_to_message_id: also Cc everyone on the original message."),
};

function requireWritable(account: AccountRecord): void {
  if (account.readonly) {
    throw new Error(`Account "${account.alias}" was authorised read-only. Re-add it without --readonly to create drafts or change labels.`);
  }
}

function requireSendable(account: AccountRecord): void {
  requireWritable(account);
  if (!account.allowSend) {
    throw new Error(
      `Sending is disabled for account "${account.alias}" (drafts only). ` +
        `The user can enable it with: gmail-multi-mcp accounts allow-send ${account.alias} on`,
    );
  }
}

export function createServer(deps: ServerDeps): McpServer {
  const { store, registry, tasks, scheduler } = deps;
  const server = new McpServer({ name: "gmail-multi-mcp", version: deps.version ?? "0.1.0" });

  // ------------------------------------------------------------------ accounts

  server.registerTool(
    "list_accounts",
    {
      title: "List Gmail accounts",
      description:
        "List every connected Gmail account with its alias, email, description, and whether drafting/sending is allowed. Call this first when unsure which account the user means.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guarded(async () => {
      const accounts = store.list();
      return {
        accounts: accounts.map((a) => ({
          alias: a.alias,
          email: a.email,
          description: a.description,
          permissions: a.readonly ? "read-only" : a.allowSend ? "read, draft, send" : "read, draft (sending disabled)",
          hasToken: !!store.readTokens(a.alias)?.refresh_token,
        })),
        hint:
          accounts.length === 0
            ? "No accounts yet. Ask the user to run: gmail-multi-mcp auth add <alias>"
            : 'Pass account="all" to search across every account at once.',
      };
    }),
  );

  // ------------------------------------------------------------------ reading

  server.registerTool(
    "search_emails",
    {
      title: "Search emails",
      description:
        "Search one or all accounts with Gmail query syntax (e.g. 'is:unread newer_than:1d', 'from:boss@x.com has:attachment', 'label:Invoices'). Returns compact summaries grouped by account. Use get_email for the full body.",
      inputSchema: {
        account: accountParam,
        query: z.string().default("").describe("Gmail search query. Empty returns the most recent mail."),
        max_results: z.number().int().min(1).max(100).default(20).describe("Per account, 1-100."),
        since: z.string().optional().describe('Convenience filter: "24h", "7d", "2w", or an ISO date. Added as an after: clause.'),
        unread_only: z.boolean().optional(),
        include_spam_trash: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ account, query, max_results, since, unread_only, include_spam_trash }) => {
      const accounts = store.resolve(account);
      const q = [query, sinceToQuery(since), unread_only ? "is:unread" : ""].filter(Boolean).join(" ").trim();
      const results = await forEachAccount(registry, accounts, (svc) => svc.search(q, max_results, { includeSpamTrash: include_spam_trash }));
      return {
        query: q,
        accounts: results.map((r) => ({
          account: r.account,
          email: r.email,
          error: r.error,
          count: r.result?.messages.length,
          messages: r.result?.messages,
        })),
      };
    }),
  );

  server.registerTool(
    "get_email",
    {
      title: "Read an email",
      description: "Fetch one message with headers, plain-text body (HTML converted), labels, and attachment metadata.",
      inputSchema: {
        account: oneAccountParam,
        message_id: z.string(),
        max_body_chars: z.number().int().min(500).max(200_000).default(20_000),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ account, message_id, max_body_chars }) => {
      const acc = store.resolveOne(account);
      const msg = await registry.for(acc).getMessage(message_id, max_body_chars);
      return { account: acc.alias, email: acc.email, ...msg };
    }),
  );

  server.registerTool(
    "get_thread",
    {
      title: "Read a thread",
      description: "Fetch every message in a conversation thread, oldest first, with bodies converted to text.",
      inputSchema: {
        account: oneAccountParam,
        thread_id: z.string(),
        max_body_chars_per_message: z.number().int().min(500).max(100_000).default(8_000),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ account, thread_id, max_body_chars_per_message }) => {
      const acc = store.resolveOne(account);
      const thread = await registry.for(acc).getThread(thread_id, max_body_chars_per_message);
      return { account: acc.alias, email: acc.email, ...thread };
    }),
  );

  server.registerTool(
    "list_labels",
    {
      title: "List labels",
      description: "List labels (folders) for one or all accounts, including system labels like INBOX and STARRED.",
      inputSchema: { account: accountParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ account }) => {
      const accounts = store.resolve(account);
      const results = await forEachAccount(registry, accounts, async (svc) =>
        (await svc.labels(true)).map((l) => ({ id: l.id, name: l.name, type: l.type, unread: l.messagesUnread ?? undefined })),
      );
      return { accounts: results.map((r) => ({ account: r.account, email: r.email, error: r.error, labels: r.result })) };
    }),
  );

  server.registerTool(
    "inbox_digest",
    {
      title: "Inbox digest",
      description:
        "One call to see what is new across accounts: recent (default unread, last 24h) messages per account. Ideal for 'what came in overnight?' and for recurring check-ins.",
      inputSchema: {
        account: accountParam,
        since: z.string().default("24h").describe('"24h", "7d", or an ISO date.'),
        unread_only: z.boolean().default(true),
        query: z.string().default("").describe("Extra Gmail query terms, e.g. '-category:promotions'."),
        max_per_account: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ account, since, unread_only, query, max_per_account }) => {
      const accounts = store.resolve(account);
      const q = [query, sinceToQuery(since), unread_only ? "is:unread" : "", "in:inbox"].filter(Boolean).join(" ").trim();
      const results = await forEachAccount(registry, accounts, (svc) => svc.search(q, max_per_account));
      return {
        generatedAt: new Date().toISOString(),
        query: q,
        totals: { accounts: accounts.length, messages: results.reduce((n, r) => n + (r.result?.messages.length ?? 0), 0) },
        accounts: results.map((r) => ({ account: r.account, email: r.email, error: r.error, count: r.result?.messages.length, messages: r.result?.messages })),
      };
    }),
  );

  // ------------------------------------------------------------------ labels / state

  server.registerTool(
    "modify_emails",
    {
      title: "Modify emails (labels, read state, archive, star)",
      description:
        "Change labels on one or more messages in a single account: mark read/unread, archive (remove from inbox), star, move to inbox, add/remove labels by name. Missing user labels are created.",
      inputSchema: {
        account: oneAccountParam,
        message_ids: z.array(z.string()).min(1).max(100),
        add_labels: z.array(z.string()).optional().describe("Label names or ids to add; created if missing."),
        remove_labels: z.array(z.string()).optional(),
        mark_read: z.boolean().optional(),
        mark_unread: z.boolean().optional(),
        archive: z.boolean().optional().describe("Remove from INBOX."),
        move_to_inbox: z.boolean().optional(),
        star: z.boolean().optional(),
        unstar: z.boolean().optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guarded(async ({ account, message_ids, add_labels, remove_labels, mark_read, mark_unread, archive, move_to_inbox, star, unstar }) => {
      const acc = store.resolveOne(account);
      requireWritable(acc);
      const res = await registry.for(acc).modifyMessages(message_ids, {
        addLabels: add_labels,
        removeLabels: remove_labels,
        markRead: mark_read,
        markUnread: mark_unread,
        archive,
        moveToInbox: move_to_inbox,
        star,
        unstar,
      });
      return { account: acc.alias, ...res };
    }),
  );

  server.registerTool(
    "trash_email",
    {
      title: "Move email to trash",
      description: "Move a message to Trash (recoverable for 30 days). Confirm with the user before trashing anything they did not explicitly name.",
      inputSchema: { account: oneAccountParam, message_id: z.string() },
      annotations: { destructiveHint: true },
    },
    guarded(async ({ account, message_id }) => {
      const acc = store.resolveOne(account);
      requireWritable(acc);
      await registry.for(acc).trashMessage(message_id);
      return { account: acc.alias, trashed: message_id };
    }),
  );

  // ------------------------------------------------------------------ drafts

  server.registerTool(
    "create_draft",
    {
      title: "Create a draft",
      description:
        "Create a Gmail draft in one account. Nothing is sent. Supports replies (reply_to_message_id) with correct threading. Tell the user the draft is waiting in that account's Drafts folder.",
      inputSchema: { account: oneAccountParam, ...draftFields },
    },
    guarded(async ({ account, to, cc, bcc, subject, body, body_html, reply_to_message_id, reply_all }) => {
      const acc = store.resolveOne(account);
      requireWritable(acc);
      if (!reply_to_message_id && (!to || to.length === 0)) throw new Error("A new (non-reply) draft needs at least one recipient in `to`.");
      const res = await registry.for(acc).createDraft({
        to: to ?? [],
        cc,
        bcc,
        subject: subject ?? "",
        body,
        bodyHtml: body_html,
        replyToMessageId: reply_to_message_id,
        replyAll: reply_all,
      });
      return { account: acc.alias, email: acc.email, ...res, status: "Draft saved (not sent)." };
    }),
  );

  server.registerTool(
    "update_draft",
    {
      title: "Update a draft",
      description: "Replace the content of an existing draft (all fields are rewritten, so pass the complete new version).",
      inputSchema: { account: oneAccountParam, draft_id: z.string(), ...draftFields },
    },
    guarded(async ({ account, draft_id, to, cc, bcc, subject, body, body_html, reply_to_message_id, reply_all }) => {
      const acc = store.resolveOne(account);
      requireWritable(acc);
      const res = await registry.for(acc).updateDraft(draft_id, {
        to: to ?? [],
        cc,
        bcc,
        subject: subject ?? "",
        body,
        bodyHtml: body_html,
        replyToMessageId: reply_to_message_id,
        replyAll: reply_all,
      });
      return { account: acc.alias, ...res, status: "Draft updated (not sent)." };
    }),
  );

  server.registerTool(
    "list_drafts",
    {
      title: "List drafts",
      description: "List drafts in one or all accounts.",
      inputSchema: { account: accountParam, max_results: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ account, max_results }) => {
      const accounts = store.resolve(account);
      const results = await forEachAccount(registry, accounts, (svc) => svc.listDrafts(max_results));
      return { accounts: results.map((r) => ({ account: r.account, email: r.email, error: r.error, drafts: r.result })) };
    }),
  );

  server.registerTool(
    "get_draft",
    {
      title: "Read a draft",
      description: "Fetch a draft's recipients, subject and body.",
      inputSchema: { account: oneAccountParam, draft_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ account, draft_id }) => {
      const acc = store.resolveOne(account);
      return { account: acc.alias, ...(await registry.for(acc).getDraft(draft_id)) };
    }),
  );

  server.registerTool(
    "delete_draft",
    {
      title: "Delete a draft",
      description: "Permanently delete a draft.",
      inputSchema: { account: oneAccountParam, draft_id: z.string() },
      annotations: { destructiveHint: true },
    },
    guarded(async ({ account, draft_id }) => {
      const acc = store.resolveOne(account);
      requireWritable(acc);
      await registry.for(acc).deleteDraft(draft_id);
      return { account: acc.alias, deleted: draft_id };
    }),
  );

  // ------------------------------------------------------------------ sending (opt-in)

  server.registerTool(
    "send_draft",
    {
      title: "Send a draft",
      description:
        "Send an existing draft. Only works for accounts where the user enabled sending. Always confirm recipients and content with the user before calling this.",
      inputSchema: { account: oneAccountParam, draft_id: z.string() },
      annotations: { destructiveHint: true },
    },
    guarded(async ({ account, draft_id }) => {
      const acc = store.resolveOne(account);
      requireSendable(acc);
      const res = await registry.for(acc).sendDraft(draft_id);
      return { account: acc.alias, email: acc.email, ...res, status: "Sent." };
    }),
  );

  server.registerTool(
    "send_email",
    {
      title: "Send an email",
      description:
        "Compose and send immediately from one account (no draft). Only for accounts with sending enabled. Prefer create_draft unless the user explicitly asked to send. Confirm recipients and content first.",
      inputSchema: { account: oneAccountParam, ...draftFields },
      annotations: { destructiveHint: true },
    },
    guarded(async ({ account, to, cc, bcc, subject, body, body_html, reply_to_message_id, reply_all }) => {
      const acc = store.resolveOne(account);
      requireSendable(acc);
      if (!reply_to_message_id && (!to || to.length === 0)) throw new Error("At least one recipient is required.");
      const res = await registry.for(acc).sendMessage({
        to: to ?? [],
        cc,
        bcc,
        subject: subject ?? "",
        body,
        bodyHtml: body_html,
        replyToMessageId: reply_to_message_id,
        replyAll: reply_all,
      });
      return { account: acc.alias, email: acc.email, ...res, status: "Sent." };
    }),
  );

  // ------------------------------------------------------------------ scheduled tasks

  const taskInput = {
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    schedule: z.string().describe("5-field cron, e.g. '0 8 * * 1-5' = weekdays at 08:00."),
    timezone: z.string().optional().describe("IANA zone like 'Europe/Amsterdam'. Default: machine local time."),
    accounts: z.string().default("all").describe('Alias, email, comma list, or "all".'),
    kind: z.enum(["digest", "label_rule"]).describe("digest: collect matching mail each run and flag what is new. label_rule: apply label changes to matching mail."),
    query: z.string().default("").describe("Gmail query. Required for label_rule."),
    max_results: z.number().int().min(1).max(100).default(25),
    action: z
      .object({
        add_labels: z.array(z.string()).optional(),
        remove_labels: z.array(z.string()).optional(),
        mark_read: z.boolean().optional(),
        archive: z.boolean().optional(),
        star: z.boolean().optional(),
      })
      .optional()
      .describe("label_rule only."),
    enabled: z.boolean().default(true),
  };

  type TaskArgs = {
    name: string;
    description?: string;
    schedule: string;
    timezone?: string;
    accounts: string;
    kind: "digest" | "label_rule";
    query: string;
    max_results: number;
    action?: { add_labels?: string[]; remove_labels?: string[]; mark_read?: boolean; archive?: boolean; star?: boolean };
    enabled: boolean;
  };

  const toTaskInput = (a: Partial<TaskArgs>) => {
    const out: Record<string, unknown> = {};
    if (a.name !== undefined) out.name = a.name;
    if (a.description !== undefined) out.description = a.description;
    if (a.schedule !== undefined) out.schedule = a.schedule;
    if (a.timezone !== undefined) out.timezone = a.timezone;
    if (a.accounts !== undefined) out.accounts = a.accounts;
    if (a.kind !== undefined) out.kind = a.kind;
    if (a.query !== undefined) out.query = a.query;
    if (a.max_results !== undefined) out.maxResults = a.max_results;
    if (a.enabled !== undefined) out.enabled = a.enabled;
    if (a.action !== undefined) {
      out.action = {
        addLabels: a.action.add_labels,
        removeLabels: a.action.remove_labels,
        markRead: a.action.mark_read,
        archive: a.action.archive,
        star: a.action.star,
      };
    }
    return out;
  };

  const describeTask = (t: ReturnType<TaskStore["list"]>[number]) => ({
    ...t,
    nextRun: scheduler?.nextRun(t.id),
    schedulerRunningInThisProcess: scheduler?.active ?? false,
  });

  server.registerTool(
    "list_scheduled_tasks",
    {
      title: "List scheduled tasks",
      description:
        "List recurring tasks the server runs on a cron schedule (digests and label rules), with last status and next run time. Tasks run only while the MCP server process is alive.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guarded(async () => ({ schedulerActive: scheduler?.active ?? false, tasks: tasks.list().map(describeTask) })),
  );

  server.registerTool(
    "create_scheduled_task",
    {
      title: "Create a scheduled task",
      description:
        "Create a recurring task. Kinds: 'digest' (collect matching mail on a schedule and flag new messages since the last run; read with get_task_runs) or 'label_rule' (e.g. auto-archive newsletters, star mail from a VIP). Validate the cron with the user before creating.",
      inputSchema: taskInput,
    },
    guarded(async (args) => {
      const task = tasks.create(TaskInputSchema.parse(toTaskInput(args as TaskArgs)));
      scheduler?.reload();
      return describeTask(task);
    }),
  );

  server.registerTool(
    "update_scheduled_task",
    {
      title: "Update a scheduled task",
      description: "Change any field of a scheduled task, including enabled=false to pause it.",
      inputSchema: {
        task_id: z.string(),
        ...Object.fromEntries(Object.entries(taskInput).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
      } as { task_id: z.ZodString } & { [K in keyof typeof taskInput]: z.ZodOptional<(typeof taskInput)[K]> },
    },
    guarded(async ({ task_id, ...rest }) => {
      const task = tasks.update(task_id, toTaskInput(rest as Partial<TaskArgs>));
      scheduler?.reload();
      return describeTask(task);
    }),
  );

  server.registerTool(
    "delete_scheduled_task",
    {
      title: "Delete a scheduled task",
      description: "Delete a scheduled task and its run history.",
      inputSchema: { task_id: z.string() },
      annotations: { destructiveHint: true },
    },
    guarded(async ({ task_id }) => {
      const removed = tasks.delete(task_id);
      scheduler?.reload();
      return { deleted: removed ? task_id : null };
    }),
  );

  server.registerTool(
    "run_scheduled_task",
    {
      title: "Run a scheduled task now",
      description: "Execute a scheduled task immediately (outside its schedule) and return the run result.",
      inputSchema: { task_id: z.string() },
    },
    guarded(async ({ task_id }) => {
      const task = tasks.get(task_id);
      if (!task) throw new Error(`No scheduled task with id ${task_id}.`);
      return executeTask(task, registry, store, tasks, "manual");
    }),
  );

  server.registerTool(
    "get_task_runs",
    {
      title: "Get task run history",
      description:
        "Return the most recent runs of a scheduled task. For digest tasks each run lists the matched messages with isNew=true for mail not seen in the previous run.",
      inputSchema: { task_id: z.string(), limit: z.number().int().min(1).max(50).default(5) },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ task_id, limit }) => ({ taskId: task_id, runs: tasks.runs(task_id, limit).reverse() })),
  );

  return server;
}
