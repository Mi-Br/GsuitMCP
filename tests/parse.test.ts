import { describe, expect, it } from "vitest";
import { extractAddresses, htmlToText, parseMessage, truncate } from "../src/gmail/parse.js";
import { toBase64Url } from "../src/gmail/mime.js";

describe("htmlToText", () => {
  it("strips tags, keeps links and line breaks", () => {
    const html = `<html><head><style>p{}</style></head><body><p>Hello<br>there</p><a href="https://x.io">site</a> &amp; <ul><li>one</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Hello\nthere");
    expect(text).toContain("site (https://x.io)");
    expect(text).toContain("& ");
    expect(text).toContain("• one");
    expect(text).not.toContain("<");
  });
});

describe("parseMessage", () => {
  it("extracts headers, text, attachments and flags", () => {
    const parsed = parseMessage({
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "UNREAD", "STARRED"],
      internalDate: "1760256000000",
      snippet: "snip",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Ada <ada@example.com>" },
          { name: "Subject", value: "Report" },
          { name: "Message-ID", value: "<abc@example.com>" },
        ],
        parts: [
          { mimeType: "text/html", body: { data: toBase64Url("<p>Hi <b>there</b></p>") } },
          { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "att1", size: 1234 } },
        ],
      },
    });
    expect(parsed.from).toBe("Ada <ada@example.com>");
    expect(parsed.subject).toBe("Report");
    expect(parsed.messageIdHeader).toBe("<abc@example.com>");
    expect(parsed.unread).toBe(true);
    expect(parsed.starred).toBe(true);
    expect(parsed.text).toBe("Hi there");
    expect(parsed.attachments).toEqual([{ filename: "report.pdf", mimeType: "application/pdf", size: 1234, attachmentId: "att1" }]);
    expect(parsed.internalDate).toBe("2025-10-12T08:00:00.000Z");
  });

  it("prefers text/plain over html", () => {
    const parsed = parseMessage({
      id: "m",
      payload: {
        parts: [
          { mimeType: "text/plain", body: { data: toBase64Url("plain") } },
          { mimeType: "text/html", body: { data: toBase64Url("<p>html</p>") } },
        ],
      },
    });
    expect(parsed.text).toBe("plain");
    expect(parsed.html).toBe("<p>html</p>");
  });
});

describe("helpers", () => {
  it("extracts addresses", () => {
    expect(extractAddresses("A <a@x.io>, b@x.io , \"C, D\" <c@x.io>")).toEqual(["a@x.io", "b@x.io", "c@x.io"]);
  });
  it("truncates with a marker", () => {
    expect(truncate("abcdef", 3)).toEqual({ text: "abc\n…[truncated 3 more characters]", truncated: true });
    expect(truncate("abc", 3)).toEqual({ text: "abc", truncated: false });
  });
});
