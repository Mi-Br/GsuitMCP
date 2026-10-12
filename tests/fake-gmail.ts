import type { gmail_v1 } from "googleapis";
import type { GmailApi } from "../src/gmail/service.js";
import { fromBase64Url, toBase64Url } from "../src/gmail/mime.js";

export interface SeedMessage {
  id: string;
  threadId?: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  text: string;
  html?: string;
  labelIds?: string[];
  date?: string;
  messageIdHeader?: string;
  attachments?: Array<{ filename: string; mimeType: string; size: number }>;
}

interface StoredMessage {
  raw: gmail_v1.Schema$Message;
}

/**
 * In-memory Gmail that honours the subset of query syntax used in tests
 * (is:unread, from:, subject:, label:, after:, free text) and records calls.
 */
export class FakeGmail implements GmailApi {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private messages = new Map<string, StoredMessage>();
  private drafts = new Map<string, { message: gmail_v1.Schema$Message }>();
  private labelsList: gmail_v1.Schema$Label[] = [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "UNREAD", name: "UNREAD", type: "system" },
    { id: "STARRED", name: "STARRED", type: "system" },
    { id: "SENT", name: "SENT", type: "system" },
    { id: "DRAFT", name: "DRAFT", type: "system" },
    { id: "Label_1", name: "Invoices", type: "user" },
  ];
  private seq = 1;

  constructor(readonly email: string, seed: SeedMessage[] = []) {
    for (const m of seed) this.seed(m);
  }

  seed(m: SeedMessage): void {
    const headers: gmail_v1.Schema$MessagePartHeader[] = [
      { name: "From", value: m.from },
      { name: "To", value: m.to },
      { name: "Subject", value: m.subject },
      { name: "Date", value: m.date ?? "Mon, 12 Oct 2026 08:00:00 +0000" },
      { name: "Message-ID", value: m.messageIdHeader ?? `<${m.id}@example.com>` },
    ];
    if (m.cc) headers.push({ name: "Cc", value: m.cc });
    const parts: gmail_v1.Schema$MessagePart[] = [
      { mimeType: "text/plain", body: { data: toBase64Url(m.text), size: m.text.length } },
    ];
    if (m.html) parts.push({ mimeType: "text/html", body: { data: toBase64Url(m.html), size: m.html.length } });
    for (const a of m.attachments ?? []) {
      parts.push({ filename: a.filename, mimeType: a.mimeType, body: { attachmentId: `att_${a.filename}`, size: a.size } });
    }
    this.messages.set(m.id, {
      raw: {
        id: m.id,
        threadId: m.threadId ?? `t_${m.id}`,
        labelIds: m.labelIds ?? ["INBOX", "UNREAD"],
        snippet: m.text.slice(0, 60),
        internalDate: String(Date.parse(m.date ?? "2026-10-12T08:00:00Z")),
        payload: { mimeType: "multipart/mixed", headers, parts },
        sizeEstimate: m.text.length,
      },
    });
  }

  private record(method: string, params: unknown) {
    this.calls.push({ method, params });
  }

  private matches(msg: gmail_v1.Schema$Message, q: string | undefined): boolean {
    if (!q) return true;
    const headers = msg.payload?.headers ?? [];
    const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n)?.value ?? "";
    const labels = msg.labelIds ?? [];
    for (const term of q.split(/\s+/).filter(Boolean)) {
      if (term === "is:unread" && !labels.includes("UNREAD")) return false;
      else if (term === "in:inbox" && !labels.includes("INBOX")) return false;
      else if (term.startsWith("from:") && !h("from").toLowerCase().includes(term.slice(5).toLowerCase())) return false;
      else if (term.startsWith("subject:") && !h("subject").toLowerCase().includes(term.slice(8).toLowerCase())) return false;
      else if (term.startsWith("label:")) {
        const wanted = term.slice(6).toLowerCase();
        const id = this.labelsList.find((l) => l.name?.toLowerCase() === wanted)?.id;
        if (!id || !labels.includes(id)) return false;
      } else if (term.startsWith("after:")) {
        const since = Number(term.slice(6)) * 1000;
        if (Number(msg.internalDate) < since) return false;
      } else if (term.startsWith("-")) {
        /* ignore negations in the fake */
      } else if (!term.includes(":")) {
        const hay = `${h("subject")} ${h("from")} ${msg.snippet ?? ""}`.toLowerCase();
        if (!hay.includes(term.toLowerCase())) return false;
      }
    }
    return true;
  }

  users = {
    getProfile: async (params: { userId: string }) => {
      this.record("getProfile", params);
      return { data: { emailAddress: this.email } };
    },
    messages: {
      list: async (params: gmail_v1.Params$Resource$Users$Messages$List) => {
        this.record("messages.list", params);
        const matched = [...this.messages.values()]
          .map((m) => m.raw)
          .filter((m) => this.matches(m, params.q ?? undefined))
          .filter((m) => params.includeSpamTrash || !(m.labelIds ?? []).includes("TRASH"))
          .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
          .slice(0, params.maxResults ?? 100);
        return { data: { messages: matched.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: matched.length } };
      },
      get: async (params: gmail_v1.Params$Resource$Users$Messages$Get) => {
        this.record("messages.get", params);
        const m = this.messages.get(params.id ?? "");
        if (!m) throw Object.assign(new Error("Requested entity was not found."), { code: 404 });
        return { data: structuredClone(m.raw) };
      },
      modify: async (params: gmail_v1.Params$Resource$Users$Messages$Modify) => {
        this.record("messages.modify", params);
        const m = this.messages.get(params.id ?? "");
        if (!m) throw Object.assign(new Error("Requested entity was not found."), { code: 404 });
        const add = params.requestBody?.addLabelIds ?? [];
        const remove = params.requestBody?.removeLabelIds ?? [];
        m.raw.labelIds = [...new Set([...(m.raw.labelIds ?? []).filter((l) => !remove.includes(l)), ...add])];
        return { data: structuredClone(m.raw) };
      },
      send: async (params: gmail_v1.Params$Resource$Users$Messages$Send) => {
        this.record("messages.send", params);
        const id = `sent_${this.seq++}`;
        const raw = fromBase64Url(params.requestBody?.raw ?? "").toString("utf8");
        this.messages.set(id, { raw: { id, threadId: params.requestBody?.threadId ?? `t_${id}`, labelIds: ["SENT"], snippet: raw.slice(0, 40), payload: { headers: [] } } });
        return { data: { id, threadId: params.requestBody?.threadId ?? `t_${id}` } };
      },
      trash: async (params: gmail_v1.Params$Resource$Users$Messages$Trash) => {
        this.record("messages.trash", params);
        const m = this.messages.get(params.id ?? "");
        if (!m) throw Object.assign(new Error("Requested entity was not found."), { code: 404 });
        m.raw.labelIds = [...(m.raw.labelIds ?? []).filter((l) => l !== "INBOX"), "TRASH"];
        return { data: structuredClone(m.raw) };
      },
      attachments: {
        get: async (params: gmail_v1.Params$Resource$Users$Messages$Attachments$Get) => {
          this.record("attachments.get", params);
          return { data: { data: toBase64Url("hello"), size: 5 } };
        },
      },
    },
    threads: {
      get: async (params: gmail_v1.Params$Resource$Users$Threads$Get) => {
        this.record("threads.get", params);
        const msgs = [...this.messages.values()].map((m) => m.raw).filter((m) => m.threadId === params.id);
        return { data: { id: params.id, messages: structuredClone(msgs) } };
      },
    },
    labels: {
      list: async (params: gmail_v1.Params$Resource$Users$Labels$List) => {
        this.record("labels.list", params);
        return { data: { labels: structuredClone(this.labelsList) } };
      },
      create: async (params: gmail_v1.Params$Resource$Users$Labels$Create) => {
        this.record("labels.create", params);
        const label = { id: `Label_${this.seq++}`, name: params.requestBody?.name ?? "", type: "user" };
        this.labelsList.push(label);
        return { data: label };
      },
    },
    drafts: {
      list: async (params: gmail_v1.Params$Resource$Users$Drafts$List) => {
        this.record("drafts.list", params);
        return { data: { drafts: [...this.drafts.entries()].map(([id, d]) => ({ id, message: { id: d.message.id } })) } };
      },
      get: async (params: gmail_v1.Params$Resource$Users$Drafts$Get) => {
        this.record("drafts.get", params);
        const d = this.drafts.get(params.id ?? "");
        if (!d) throw Object.assign(new Error("Requested entity was not found."), { code: 404 });
        return { data: { id: params.id, message: structuredClone(d.message) } };
      },
      create: async (params: gmail_v1.Params$Resource$Users$Drafts$Create) => {
        this.record("drafts.create", params);
        const id = `draft_${this.seq++}`;
        const message = this.messageFromRaw(params.requestBody?.message?.raw ?? "", params.requestBody?.message?.threadId ?? undefined, `dm_${id}`);
        this.drafts.set(id, { message });
        return { data: { id, message: { id: message.id, threadId: message.threadId } } };
      },
      update: async (params: gmail_v1.Params$Resource$Users$Drafts$Update) => {
        this.record("drafts.update", params);
        if (!this.drafts.has(params.id ?? "")) throw Object.assign(new Error("Requested entity was not found."), { code: 404 });
        const message = this.messageFromRaw(params.requestBody?.message?.raw ?? "", params.requestBody?.message?.threadId ?? undefined, `dm_${params.id}`);
        this.drafts.set(params.id ?? "", { message });
        return { data: { id: params.id, message: { id: message.id, threadId: message.threadId } } };
      },
      delete: async (params: gmail_v1.Params$Resource$Users$Drafts$Delete) => {
        this.record("drafts.delete", params);
        this.drafts.delete(params.id ?? "");
        return {};
      },
      send: async (params: gmail_v1.Params$Resource$Users$Drafts$Send) => {
        this.record("drafts.send", params);
        const d = this.drafts.get(params.requestBody?.id ?? "");
        if (!d) throw Object.assign(new Error("Requested entity was not found."), { code: 404 });
        this.drafts.delete(params.requestBody?.id ?? "");
        const id = `sent_${this.seq++}`;
        return { data: { id, threadId: d.message.threadId ?? `t_${id}` } };
      },
    },
  };

  /** Minimal RFC 5322 parse so tests can assert on what the server generated. */
  private messageFromRaw(raw: string, threadId: string | undefined, id: string): gmail_v1.Schema$Message {
    const text = fromBase64Url(raw).toString("utf8");
    const [head, ...rest] = text.split("\r\n\r\n");
    const headers = head
      .split("\r\n")
      .filter((l) => l.includes(":"))
      .map((l) => {
        const i = l.indexOf(":");
        return { name: l.slice(0, i), value: l.slice(i + 1).trim() };
      });
    const body = rest.join("\r\n\r\n");
    const bodyText = Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
    return {
      id,
      threadId: threadId ?? `t_${id}`,
      labelIds: ["DRAFT"],
      payload: { mimeType: "text/plain", headers, body: { data: toBase64Url(bodyText), size: bodyText.length } },
      snippet: bodyText.slice(0, 60),
    };
  }

  rawDraft(id: string): { headers: Record<string, string>; text: string } | undefined {
    const d = this.drafts.get(id);
    if (!d) return undefined;
    const headers: Record<string, string> = {};
    for (const h of d.message.payload?.headers ?? []) headers[h.name ?? ""] = h.value ?? "";
    return { headers, text: fromBase64Url(d.message.payload?.body?.data ?? "").toString("utf8") };
  }
}
