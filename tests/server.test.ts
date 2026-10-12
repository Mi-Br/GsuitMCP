import { afterEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const seedWork = [
  { id: "w1", from: "Boss <boss@work.com>", to: "me@work.com", subject: "Q4 plan", text: "Please review the plan.", labelIds: ["INBOX", "UNREAD"], date: "2026-10-12T07:00:00Z" },
  { id: "w2", from: "news@letter.com", to: "me@work.com", subject: "Weekly newsletter", text: "Lots of news", labelIds: ["INBOX"], date: "2026-10-11T07:00:00Z" },
];
const seedPersonal = [
  { id: "p1", from: "Mum <mum@family.org>", to: "me@gmail.com", cc: "dad@family.org", subject: "Dinner?", text: "Sunday at 6?", html: "<p>Sunday at <b>6</b>?</p>", labelIds: ["INBOX", "UNREAD"], date: "2026-10-12T06:00:00Z", messageIdHeader: "<dinner@family.org>" },
];

describe("gmail-multi-mcp server", () => {
  it("exposes the expected tools", async () => {
    h = await harness([{ alias: "work", email: "me@work.com" }]);
    const tools = (await h.client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      [
        "list_accounts", "search_emails", "get_email", "get_thread", "list_labels", "inbox_digest",
        "modify_emails", "trash_email",
        "create_draft", "update_draft", "list_drafts", "get_draft", "delete_draft",
        "send_draft", "send_email",
        "list_scheduled_tasks", "create_scheduled_task", "update_scheduled_task", "delete_scheduled_task", "run_scheduled_task", "get_task_runs",
      ].sort(),
    );
  });

  it("lists accounts with permissions", async () => {
    h = await harness([
      { alias: "work", email: "me@work.com" },
      { alias: "personal", email: "me@gmail.com", allowSend: true },
    ]);
    const { json } = await h.call("list_accounts");
    expect(json.accounts).toEqual([
      expect.objectContaining({ alias: "personal", email: "me@gmail.com", permissions: "read, draft, send", hasToken: true }),
      expect.objectContaining({ alias: "work", email: "me@work.com", permissions: "read, draft (sending disabled)" }),
    ]);
  });

  it("searches across all accounts and isolates per-account failures", async () => {
    h = await harness([
      { alias: "work", email: "me@work.com", messages: seedWork },
      { alias: "personal", email: "me@gmail.com", messages: seedPersonal },
    ]);
    const { json, isError } = await h.call("search_emails", { account: "all", query: "is:unread" });
    expect(isError).toBe(false);
    const byAlias = Object.fromEntries(json.accounts.map((a: any) => [a.account, a]));
    expect(byAlias.work.messages.map((m: any) => m.id)).toEqual(["w1"]);
    expect(byAlias.personal.messages.map((m: any) => m.id)).toEqual(["p1"]);
    expect(byAlias.work.messages[0]).toMatchObject({ from: "Boss <boss@work.com>", subject: "Q4 plan", unread: true, labels: ["INBOX", "UNREAD"] });

    // one account failing must not break the other
    const fake = h.fakes.get("personal")!;
    fake.users.messages.list = async () => {
      throw Object.assign(new Error("invalid_grant"), { code: 401 });
    };
    const second = await h.call("search_emails", { account: "all" });
    const again = Object.fromEntries(second.json.accounts.map((a: any) => [a.account, a]));
    expect(again.work.messages).toHaveLength(2);
    expect(again.personal.error).toMatch(/Authorisation expired/);
  });

  it("reads a message with html converted to text", async () => {
    h = await harness([{ alias: "personal", email: "me@gmail.com", messages: seedPersonal }]);
    const { json } = await h.call("get_email", { message_id: "p1" });
    expect(json.account).toBe("personal");
    expect(json.text).toBe("Sunday at 6?");
    expect(json.html).toBeUndefined();
    expect(json.labels).toEqual(["INBOX", "UNREAD"]);
  });

  it("returns a helpful error for unknown accounts", async () => {
    h = await harness([{ alias: "work", email: "me@work.com" }]);
    const { isError, text } = await h.call("search_emails", { account: "nope" });
    expect(isError).toBe(true);
    expect(text).toMatch(/Unknown account "nope". Known accounts: work/);
  });

  it("creates a threaded reply-all draft without sending", async () => {
    h = await harness([{ alias: "personal", email: "me@gmail.com", messages: seedPersonal }]);
    const { json, isError } = await h.call("create_draft", {
      account: "personal",
      reply_to_message_id: "p1",
      reply_all: true,
      body: "Sunday works, see you at 6.",
    });
    expect(isError).toBe(false);
    expect(json.status).toMatch(/not sent/);
    expect(json.threadId).toBe("t_p1");
    const fake = h.fakes.get("personal")!;
    const draft = fake.rawDraft(json.draftId)!;
    expect(draft.headers.To).toBe("mum@family.org");
    expect(draft.headers.Cc).toBe("dad@family.org");
    expect(draft.headers.Subject).toBe("Re: Dinner?");
    expect(draft.headers["In-Reply-To"]).toBe("<dinner@family.org>");
    expect(draft.text).toBe("Sunday works, see you at 6.");
    expect(fake.calls.some((c) => c.method === "messages.send" || c.method === "drafts.send")).toBe(false);

    const list = await h.call("list_drafts", { account: "personal" });
    expect(list.json.accounts[0].drafts).toHaveLength(1);
  });

  it("refuses to send unless the account allows it", async () => {
    h = await harness([
      { alias: "work", email: "me@work.com" },
      { alias: "personal", email: "me@gmail.com", allowSend: true },
    ]);
    const denied = await h.call("send_email", { account: "work", to: ["x@y.z"], subject: "hi", body: "b" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/Sending is disabled for account "work"/);

    const allowed = await h.call("send_email", { account: "personal", to: ["x@y.z"], subject: "hi", body: "b" });
    expect(allowed.isError).toBe(false);
    expect(allowed.json.status).toBe("Sent.");
  });

  it("refuses writes on read-only accounts", async () => {
    h = await harness([{ alias: "ro", email: "ro@x.com", readonly: true, messages: seedWork }]);
    const res = await h.call("modify_emails", { message_ids: ["w1"], mark_read: true });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/read-only/);
  });

  it("modifies labels by name, creating user labels on demand", async () => {
    h = await harness([{ alias: "work", email: "me@work.com", messages: seedWork }]);
    const res = await h.call("modify_emails", { message_ids: ["w2"], archive: true, mark_read: true, add_labels: ["Newsletters"] });
    expect(res.isError).toBe(false);
    expect(res.json.removeLabelIds.sort()).toEqual(["INBOX", "UNREAD"]);
    const fake = h.fakes.get("work")!;
    expect(fake.calls.some((c) => c.method === "labels.create")).toBe(true);
    const after = await h.call("get_email", { message_id: "w2" });
    expect(after.json.labels).toEqual(["Newsletters"]);
  });

  it("builds a digest over every account", async () => {
    h = await harness([
      { alias: "work", email: "me@work.com", messages: seedWork },
      { alias: "personal", email: "me@gmail.com", messages: seedPersonal },
    ]);
    const { json } = await h.call("inbox_digest", { since: "2026-10-01" });
    expect(json.totals).toEqual({ accounts: 2, messages: 2 });
    expect(json.query).toMatch(/after:\d+ is:unread in:inbox/);
  });

  it("creates, runs and reports scheduled digest tasks", async () => {
    h = await harness([
      { alias: "work", email: "me@work.com", messages: seedWork },
      { alias: "personal", email: "me@gmail.com", messages: seedPersonal },
    ]);
    const created = await h.call("create_scheduled_task", {
      name: "Morning digest",
      schedule: "0 8 * * 1-5",
      kind: "digest",
      query: "is:unread",
      accounts: "all",
    });
    expect(created.isError).toBe(false);
    const taskId = created.json.id;

    const first = await h.call("run_scheduled_task", { task_id: taskId });
    expect(first.json.status).toBe("ok");
    const firstWork = first.json.accounts.find((a: any) => a.account === "work");
    expect(firstWork.matched).toBe(1);
    expect(firstWork.newSinceLastRun).toBe(1);

    h.fakes.get("work")!.seed({ id: "w3", from: "cto@work.com", to: "me@work.com", subject: "Urgent", text: "Call me", labelIds: ["INBOX", "UNREAD"], date: "2026-10-12T09:00:00Z" });
    const second = await h.call("run_scheduled_task", { task_id: taskId });
    const secondWork = second.json.accounts.find((a: any) => a.account === "work");
    expect(secondWork.matched).toBe(2);
    expect(secondWork.newSinceLastRun).toBe(1);
    expect(secondWork.messages.find((m: any) => m.id === "w3").isNew).toBe(true);
    expect(secondWork.messages.find((m: any) => m.id === "w1").isNew).toBe(false);

    const runs = await h.call("get_task_runs", { task_id: taskId, limit: 5 });
    expect(runs.json.runs).toHaveLength(2);
    expect(runs.json.runs[0].runAt >= runs.json.runs[1].runAt).toBe(true);

    const listed = await h.call("list_scheduled_tasks");
    expect(listed.json.tasks[0]).toMatchObject({ id: taskId, lastStatus: "ok" });

    const paused = await h.call("update_scheduled_task", { task_id: taskId, enabled: false });
    expect(paused.json.enabled).toBe(false);
    const deleted = await h.call("delete_scheduled_task", { task_id: taskId });
    expect(deleted.json.deleted).toBe(taskId);
  });

  it("runs label rules and skips read-only accounts", async () => {
    h = await harness([
      { alias: "work", email: "me@work.com", messages: seedWork },
      { alias: "ro", email: "ro@x.com", readonly: true, messages: seedWork },
    ]);
    const created = await h.call("create_scheduled_task", {
      name: "Archive newsletters",
      schedule: "0 * * * *",
      kind: "label_rule",
      query: "from:news@letter.com",
      action: { archive: true, mark_read: true, add_labels: ["Newsletters"] },
    });
    const run = await h.call("run_scheduled_task", { task_id: created.json.id });
    expect(run.json.status).toBe("partial");
    expect(run.json.accounts.find((a: any) => a.account === "work")).toMatchObject({ matched: 1, modified: 1 });
    expect(run.json.accounts.find((a: any) => a.account === "ro").error).toMatch(/read-only/);
    const after = await h.call("get_email", { account: "work", message_id: "w2" });
    expect(after.json.labels).toEqual(["Newsletters"]);
  });
});
