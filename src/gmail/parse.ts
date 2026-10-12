import type { gmail_v1 } from "googleapis";
import { fromBase64Url } from "./mime.js";

export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
}

export interface ParsedMessage {
  id: string;
  threadId: string;
  historyId?: string;
  internalDate?: string; // ISO
  labelIds: string[];
  unread: boolean;
  starred: boolean;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject?: string;
  date?: string;
  messageIdHeader?: string;
  references?: string;
  snippet?: string;
  text?: string;
  html?: string;
  attachments: AttachmentInfo[];
  sizeEstimate?: number;
}

export function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === lower)?.value ?? undefined;
}

/** Very small HTML -> text conversion, enough for reading email in a chat window. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      if (!text || text === href) return href;
      return `${text} (${href})`;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface Collected {
  text?: string;
  html?: string;
  attachments: AttachmentInfo[];
}

function walkParts(part: gmail_v1.Schema$MessagePart | undefined, acc: Collected): void {
  if (!part) return;
  const mime = part.mimeType ?? "";
  const filename = part.filename ?? "";
  if (filename) {
    acc.attachments.push({
      filename,
      mimeType: mime,
      size: part.body?.size ?? 0,
      attachmentId: part.body?.attachmentId ?? undefined,
    });
  } else if (part.body?.data) {
    const decoded = fromBase64Url(part.body.data).toString("utf8");
    if (mime === "text/plain" && acc.text === undefined) acc.text = decoded;
    else if (mime === "text/html" && acc.html === undefined) acc.html = decoded;
  }
  for (const child of part.parts ?? []) walkParts(child, acc);
}

export function parseMessage(msg: gmail_v1.Schema$Message): ParsedMessage {
  const headers = msg.payload?.headers;
  const acc: Collected = { attachments: [] };
  walkParts(msg.payload, acc);
  const labelIds = msg.labelIds ?? [];
  const internal = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : undefined;
  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    historyId: msg.historyId ?? undefined,
    internalDate: internal,
    labelIds,
    unread: labelIds.includes("UNREAD"),
    starred: labelIds.includes("STARRED"),
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    cc: headerValue(headers, "Cc"),
    bcc: headerValue(headers, "Bcc"),
    replyTo: headerValue(headers, "Reply-To"),
    subject: headerValue(headers, "Subject"),
    date: headerValue(headers, "Date"),
    messageIdHeader: headerValue(headers, "Message-ID") ?? headerValue(headers, "Message-Id"),
    references: headerValue(headers, "References"),
    snippet: msg.snippet ?? undefined,
    text: acc.text ?? (acc.html ? htmlToText(acc.html) : undefined),
    html: acc.html,
    attachments: acc.attachments,
    sizeEstimate: msg.sizeEstimate ?? undefined,
  };
}

/** Compact shape for lists: what Claude needs to triage, nothing more. */
export interface MessageSummary {
  id: string;
  threadId: string;
  date?: string;
  from?: string;
  to?: string;
  subject?: string;
  snippet?: string;
  unread: boolean;
  starred: boolean;
  labels: string[];
  hasAttachments: boolean;
}

export function summarize(parsed: ParsedMessage, labelNames: (id: string) => string): MessageSummary {
  return {
    id: parsed.id,
    threadId: parsed.threadId,
    date: parsed.internalDate ?? parsed.date,
    from: parsed.from,
    to: parsed.to,
    subject: parsed.subject,
    snippet: parsed.snippet,
    unread: parsed.unread,
    starred: parsed.starred,
    labels: parsed.labelIds.map(labelNames),
    hasAttachments: parsed.attachments.length > 0,
  };
}

/** Extract bare email address from "Name <addr>" for reply-all deduping. */
export function extractAddresses(headerVal: string | undefined): string[] {
  if (!headerVal) return [];
  // Split on commas that are outside double quotes, so "Last, First" <a@b.c> stays intact.
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of headerVal) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/<([^>]+)>/);
      return (m ? m[1] : s).trim();
    });
}

export function truncate(text: string | undefined, max: number): { text: string | undefined; truncated: boolean } {
  if (text === undefined) return { text, truncated: false };
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + `\n…[truncated ${text.length - max} more characters]`, truncated: true };
}
