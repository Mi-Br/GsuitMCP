import type { gmail_v1 } from "googleapis";
import { buildRawMessage, replySubject } from "./mime.js";
import {
  extractAddresses,
  parseMessage,
  summarize,
  truncate,
  type MessageSummary,
  type ParsedMessage,
} from "./parse.js";

/**
 * The subset of the Gmail API this server uses. Declaring it explicitly lets tests
 * substitute an in-memory fake without mocking the whole googleapis client.
 */
export interface GmailApi {
  users: {
    getProfile(params: { userId: string }): Promise<{ data: gmail_v1.Schema$Profile }>;
    messages: {
      list(params: gmail_v1.Params$Resource$Users$Messages$List): Promise<{ data: gmail_v1.Schema$ListMessagesResponse }>;
      get(params: gmail_v1.Params$Resource$Users$Messages$Get): Promise<{ data: gmail_v1.Schema$Message }>;
      modify(params: gmail_v1.Params$Resource$Users$Messages$Modify): Promise<{ data: gmail_v1.Schema$Message }>;
      send(params: gmail_v1.Params$Resource$Users$Messages$Send): Promise<{ data: gmail_v1.Schema$Message }>;
      trash(params: gmail_v1.Params$Resource$Users$Messages$Trash): Promise<{ data: gmail_v1.Schema$Message }>;
      attachments: {
        get(params: gmail_v1.Params$Resource$Users$Messages$Attachments$Get): Promise<{ data: gmail_v1.Schema$MessagePartBody }>;
      };
    };
    threads: {
      get(params: gmail_v1.Params$Resource$Users$Threads$Get): Promise<{ data: gmail_v1.Schema$Thread }>;
    };
    labels: {
      list(params: gmail_v1.Params$Resource$Users$Labels$List): Promise<{ data: gmail_v1.Schema$ListLabelsResponse }>;
      create(params: gmail_v1.Params$Resource$Users$Labels$Create): Promise<{ data: gmail_v1.Schema$Label }>;
    };
    drafts: {
      list(params: gmail_v1.Params$Resource$Users$Drafts$List): Promise<{ data: gmail_v1.Schema$ListDraftsResponse }>;
      get(params: gmail_v1.Params$Resource$Users$Drafts$Get): Promise<{ data: gmail_v1.Schema$Draft }>;
      create(params: gmail_v1.Params$Resource$Users$Drafts$Create): Promise<{ data: gmail_v1.Schema$Draft }>;
      update(params: gmail_v1.Params$Resource$Users$Drafts$Update): Promise<{ data: gmail_v1.Schema$Draft }>;
      delete(params: gmail_v1.Params$Resource$Users$Drafts$Delete): Promise<unknown>;
      send(params: gmail_v1.Params$Resource$Users$Drafts$Send): Promise<{ data: gmail_v1.Schema$Message }>;
    };
  };
}

export interface DraftInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  /** Reply to this message: threads the draft and fills In-Reply-To/References. */
  replyToMessageId?: string;
  /** With replyToMessageId: also copy the original To/Cc recipients. */
  replyAll?: boolean;
}

export interface LabelChange {
  addLabels?: string[];
  removeLabels?: string[];
  markRead?: boolean;
  markUnread?: boolean;
  archive?: boolean;
  star?: boolean;
  unstar?: boolean;
  moveToInbox?: boolean;
}

const SYSTEM_LABEL_ALIASES: Record<string, string> = {
  inbox: "INBOX",
  unread: "UNREAD",
  starred: "STARRED",
  important: "IMPORTANT",
  sent: "SENT",
  draft: "DRAFT",
  drafts: "DRAFT",
  spam: "SPAM",
  trash: "TRASH",
};

/** Per-account Gmail operations. One instance per account, labels cached per instance. */
export class GmailService {
  private labelCache?: Map<string, gmail_v1.Schema$Label>;

  constructor(
    private readonly api: GmailApi,
    public readonly email: string,
  ) {}

  // ---------- labels ----------

  async labels(force = false): Promise<gmail_v1.Schema$Label[]> {
    if (!this.labelCache || force) {
      const res = await this.api.users.labels.list({ userId: "me" });
      this.labelCache = new Map((res.data.labels ?? []).map((l) => [l.id ?? "", l]));
    }
    return [...this.labelCache.values()];
  }

  private labelNameFor = (id: string): string => this.labelCache?.get(id)?.name ?? id;

  /** Resolve a user-supplied label name or id to an id. Creates user labels on demand if asked. */
  async resolveLabelId(nameOrId: string, createIfMissing = false): Promise<string> {
    const labels = await this.labels();
    const trimmed = nameOrId.trim();
    const alias = SYSTEM_LABEL_ALIASES[trimmed.toLowerCase()];
    if (alias) return alias;
    const byId = labels.find((l) => l.id === trimmed);
    if (byId?.id) return byId.id;
    const byName = labels.find((l) => l.name?.toLowerCase() === trimmed.toLowerCase());
    if (byName?.id) return byName.id;
    if (!createIfMissing) {
      throw new Error(`Label "${nameOrId}" does not exist in ${this.email}. Known labels: ${labels.map((l) => l.name).join(", ")}`);
    }
    const created = await this.api.users.labels.create({
      userId: "me",
      requestBody: { name: trimmed, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    await this.labels(true);
    return created.data.id ?? trimmed;
  }

  // ---------- reading ----------

  async search(query: string, maxResults = 20, options: { includeSpamTrash?: boolean; labelIds?: string[] } = {}): Promise<{
    messages: MessageSummary[];
    resultSizeEstimate?: number;
  }> {
    await this.labels();
    const list = await this.api.users.messages.list({
      userId: "me",
      q: query || undefined,
      maxResults: Math.min(Math.max(maxResults, 1), 100),
      includeSpamTrash: options.includeSpamTrash ?? false,
      labelIds: options.labelIds,
    });
    const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
    const messages = await Promise.all(
      ids.map(async (id) => {
        const full = await this.api.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });
        return summarize(parseMessage(full.data), this.labelNameFor);
      }),
    );
    return { messages, resultSizeEstimate: list.data.resultSizeEstimate ?? undefined };
  }

  async getMessage(id: string, maxBodyChars = 20_000): Promise<ParsedMessage & { labels: string[]; bodyTruncated: boolean }> {
    await this.labels();
    const res = await this.api.users.messages.get({ userId: "me", id, format: "full" });
    const parsed = parseMessage(res.data);
    const body = truncate(parsed.text, maxBodyChars);
    return {
      ...parsed,
      text: body.text,
      html: undefined, // never ship raw HTML to the model; text is derived from it when needed
      labels: parsed.labelIds.map(this.labelNameFor),
      bodyTruncated: body.truncated,
    };
  }

  async getThread(threadId: string, maxBodyCharsPerMessage = 8_000): Promise<{
    threadId: string;
    subject?: string;
    messages: Array<ParsedMessage & { labels: string[]; bodyTruncated: boolean }>;
  }> {
    await this.labels();
    const res = await this.api.users.threads.get({ userId: "me", id: threadId, format: "full" });
    const messages = (res.data.messages ?? []).map((m) => {
      const parsed = parseMessage(m);
      const body = truncate(parsed.text, maxBodyCharsPerMessage);
      return { ...parsed, text: body.text, html: undefined, labels: parsed.labelIds.map(this.labelNameFor), bodyTruncated: body.truncated };
    });
    return { threadId: res.data.id ?? threadId, subject: messages[0]?.subject, messages };
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<{ data: string; size: number }> {
    const res = await this.api.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
    return { data: res.data.data ?? "", size: res.data.size ?? 0 };
  }

  // ---------- labels / state ----------

  async modifyMessages(ids: string[], change: LabelChange): Promise<{ modified: string[]; addLabelIds: string[]; removeLabelIds: string[] }> {
    const add = new Set<string>();
    const remove = new Set<string>();
    for (const l of change.addLabels ?? []) add.add(await this.resolveLabelId(l, true));
    for (const l of change.removeLabels ?? []) remove.add(await this.resolveLabelId(l));
    if (change.markRead) remove.add("UNREAD");
    if (change.markUnread) add.add("UNREAD");
    if (change.archive) remove.add("INBOX");
    if (change.moveToInbox) add.add("INBOX");
    if (change.star) add.add("STARRED");
    if (change.unstar) remove.add("STARRED");
    for (const l of add) if (remove.has(l)) throw new Error(`Label ${l} cannot be both added and removed.`);
    if (add.size === 0 && remove.size === 0) throw new Error("No label changes requested.");

    const modified: string[] = [];
    for (const id of ids) {
      await this.api.users.messages.modify({
        userId: "me",
        id,
        requestBody: { addLabelIds: [...add], removeLabelIds: [...remove] },
      });
      modified.push(id);
    }
    return { modified, addLabelIds: [...add], removeLabelIds: [...remove] };
  }

  async trashMessage(id: string): Promise<void> {
    await this.api.users.messages.trash({ userId: "me", id });
  }

  // ---------- drafts ----------

  private async buildDraftMessage(input: DraftInput): Promise<{ raw: string; threadId?: string }> {
    let threadId: string | undefined;
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    let subject = input.subject;
    let to = [...input.to];
    let cc = input.cc ? [...input.cc] : undefined;

    if (input.replyToMessageId) {
      const original = await this.api.users.messages.get({
        userId: "me",
        id: input.replyToMessageId,
        format: "metadata",
        metadataHeaders: ["From", "To", "Cc", "Reply-To", "Subject", "Message-ID", "References"],
      });
      const parsed = parseMessage(original.data);
      threadId = parsed.threadId;
      inReplyTo = parsed.messageIdHeader;
      references = parsed.references?.split(/\s+/).filter(Boolean);
      if (!subject) subject = replySubject(parsed.subject);
      if (to.length === 0) {
        const replyTo = extractAddresses(parsed.replyTo ?? parsed.from);
        to = replyTo;
      }
      if (input.replyAll) {
        const me = this.email.toLowerCase();
        const others = [...extractAddresses(parsed.to), ...extractAddresses(parsed.cc)].filter(
          (a) => a.toLowerCase() !== me && !to.map((t) => t.toLowerCase()).includes(a.toLowerCase()),
        );
        cc = [...(cc ?? []), ...others].filter((v, i, arr) => arr.indexOf(v) === i);
      }
    }

    const raw = buildRawMessage({
      from: this.email,
      to,
      cc,
      bcc: input.bcc,
      subject,
      text: input.body,
      html: input.bodyHtml,
      inReplyTo,
      references,
    });
    return { raw, threadId };
  }

  async createDraft(input: DraftInput): Promise<{ draftId: string; messageId?: string; threadId?: string }> {
    const { raw, threadId } = await this.buildDraftMessage(input);
    const res = await this.api.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw, threadId } },
    });
    return { draftId: res.data.id ?? "", messageId: res.data.message?.id ?? undefined, threadId: res.data.message?.threadId ?? threadId };
  }

  async updateDraft(draftId: string, input: DraftInput): Promise<{ draftId: string; messageId?: string; threadId?: string }> {
    const { raw, threadId } = await this.buildDraftMessage(input);
    const res = await this.api.users.drafts.update({
      userId: "me",
      id: draftId,
      requestBody: { message: { raw, threadId } },
    });
    return { draftId: res.data.id ?? draftId, messageId: res.data.message?.id ?? undefined, threadId: res.data.message?.threadId ?? threadId };
  }

  async listDrafts(maxResults = 20): Promise<Array<{ draftId: string } & MessageSummary>> {
    await this.labels();
    const res = await this.api.users.drafts.list({ userId: "me", maxResults: Math.min(Math.max(maxResults, 1), 100) });
    const drafts = res.data.drafts ?? [];
    return Promise.all(
      drafts.map(async (d) => {
        const full = await this.api.users.drafts.get({ userId: "me", id: d.id ?? "", format: "metadata" });
        const parsed = parseMessage(full.data.message ?? {});
        return { draftId: d.id ?? "", ...summarize(parsed, this.labelNameFor) };
      }),
    );
  }

  async getDraft(draftId: string): Promise<{ draftId: string } & ParsedMessage> {
    const res = await this.api.users.drafts.get({ userId: "me", id: draftId, format: "full" });
    const parsed = parseMessage(res.data.message ?? {});
    return { draftId: res.data.id ?? draftId, ...parsed, html: undefined };
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.api.users.drafts.delete({ userId: "me", id: draftId });
  }

  // ---------- sending ----------

  async sendDraft(draftId: string): Promise<{ messageId: string; threadId?: string }> {
    const res = await this.api.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
    return { messageId: res.data.id ?? "", threadId: res.data.threadId ?? undefined };
  }

  async sendMessage(input: DraftInput): Promise<{ messageId: string; threadId?: string }> {
    const { raw, threadId } = await this.buildDraftMessage(input);
    const res = await this.api.users.messages.send({ userId: "me", requestBody: { raw, threadId } });
    return { messageId: res.data.id ?? "", threadId: res.data.threadId ?? undefined };
  }
}
