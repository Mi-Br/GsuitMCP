/**
 * Build RFC 5322 messages for Gmail's `raw` field without pulling in a MIME library.
 * Supports plain text, optional HTML alternative, UTF-8 everywhere, and reply threading headers.
 */

export interface OutgoingMessage {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  /** Message-ID header of the message being replied to (sets In-Reply-To / References). */
  inReplyTo?: string;
  references?: string[];
}

export function encodeHeaderValue(value: string): string {
  // RFC 2047 encoded-word for non-ASCII header values.
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function toBase64Url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(input: string): Buffer {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

function formatAddressList(list: string[] | undefined): string | undefined {
  if (!list || list.length === 0) return undefined;
  return list.map((a) => a.trim()).filter(Boolean).join(", ");
}

/** Returns the RFC 5322 message as a string (CRLF line endings). */
export function buildMimeMessage(msg: OutgoingMessage): string {
  const headers: string[] = [];
  if (msg.from) headers.push(`From: ${msg.from}`);
  const to = formatAddressList(msg.to);
  if (!to) throw new Error("At least one recipient is required.");
  headers.push(`To: ${to}`);
  const cc = formatAddressList(msg.cc);
  if (cc) headers.push(`Cc: ${cc}`);
  const bcc = formatAddressList(msg.bcc);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${encodeHeaderValue(msg.subject ?? "")}`);
  if (msg.inReplyTo) {
    headers.push(`In-Reply-To: ${msg.inReplyTo}`);
    const refs = [...(msg.references ?? []), msg.inReplyTo].filter((v, i, arr) => arr.indexOf(v) === i);
    headers.push(`References: ${refs.join(" ")}`);
  }
  headers.push("MIME-Version: 1.0");

  const textPart = `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(
    Buffer.from(msg.text ?? "", "utf8").toString("base64"),
  )}`;

  if (!msg.html) {
    return [...headers, textPart].join("\r\n");
  }

  const boundary = `=_gmail_mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const htmlPart = `Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(
    Buffer.from(msg.html, "utf8").toString("base64"),
  )}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return [
    ...headers,
    "",
    `--${boundary}`,
    textPart,
    `--${boundary}`,
    htmlPart,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

/** Gmail's API wants the whole message base64url encoded. */
export function buildRawMessage(msg: OutgoingMessage): string {
  return toBase64Url(buildMimeMessage(msg));
}

/** "Re: " prefix without stacking "Re: Re:". */
export function replySubject(subject: string | undefined): string {
  const s = (subject ?? "").trim();
  if (/^re:/i.test(s)) return s;
  return `Re: ${s}`;
}
