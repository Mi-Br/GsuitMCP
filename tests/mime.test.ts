import { describe, expect, it } from "vitest";
import { buildMimeMessage, buildRawMessage, encodeHeaderValue, fromBase64Url, replySubject, toBase64Url } from "../src/gmail/mime.js";

describe("mime", () => {
  it("round-trips base64url", () => {
    const input = "héllo wörld ?/+";
    expect(fromBase64Url(toBase64Url(input)).toString("utf8")).toBe(input);
    expect(toBase64Url(input)).not.toMatch(/[+/=]/);
  });

  it("encodes non-ascii headers with RFC 2047", () => {
    expect(encodeHeaderValue("plain subject")).toBe("plain subject");
    expect(encodeHeaderValue("Ünïcode")).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  });

  it("builds a plain text message with threading headers", () => {
    const mime = buildMimeMessage({
      from: "me@example.com",
      to: ["a@example.com", "B <b@example.com>"],
      cc: ["c@example.com"],
      subject: "Hi",
      text: "Body text",
      inReplyTo: "<orig@example.com>",
      references: ["<first@example.com>"],
    });
    expect(mime).toContain("From: me@example.com\r\n");
    expect(mime).toContain("To: a@example.com, B <b@example.com>\r\n");
    expect(mime).toContain("Cc: c@example.com\r\n");
    expect(mime).toContain("In-Reply-To: <orig@example.com>\r\n");
    expect(mime).toContain("References: <first@example.com> <orig@example.com>\r\n");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    const body = mime.split("\r\n\r\n")[1];
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Body text");
  });

  it("builds multipart/alternative when html is given", () => {
    const mime = buildMimeMessage({ to: ["a@example.com"], subject: "x", text: "t", html: "<b>t</b>" });
    expect(mime).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"/);
    expect(mime).toContain("text/plain");
    expect(mime).toContain("text/html");
    expect(mime.trim()).toMatch(/--$/);
  });

  it("rejects messages without recipients", () => {
    expect(() => buildRawMessage({ to: [], subject: "x", text: "t" })).toThrow(/recipient/);
  });

  it("prefixes Re: once", () => {
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello")).toBe("RE: Hello");
    expect(replySubject(undefined)).toBe("Re: ");
  });
});
