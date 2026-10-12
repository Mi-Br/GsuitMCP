import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore } from "../src/accounts.js";
import { sinceToQuery } from "../src/registry.js";
import { tempPaths } from "./helpers.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

function store() {
  const paths = tempPaths();
  cleanup.push(paths.root);
  const s = new AccountStore(paths);
  s.upsert({ alias: "work", email: "me@work.com", allowSend: false, readonly: false, addedAt: "now" });
  s.upsert({ alias: "personal", email: "me@gmail.com", allowSend: true, readonly: false, addedAt: "now" });
  return s;
}

describe("AccountStore", () => {
  it("resolves aliases, emails, lists and all", () => {
    const s = store();
    expect(s.resolve("work").map((a) => a.alias)).toEqual(["work"]);
    expect(s.resolve("ME@GMAIL.COM").map((a) => a.alias)).toEqual(["personal"]);
    expect(s.resolve("work, personal").map((a) => a.alias)).toEqual(["work", "personal"]);
    expect(s.resolve("all").map((a) => a.alias)).toEqual(["personal", "work"]);
    expect(s.resolve(undefined).length).toBe(2);
    expect(() => s.resolve("nope")).toThrow(/Unknown account "nope"/);
  });

  it("resolveOne demands a single account when several exist", () => {
    const s = store();
    expect(() => s.resolveOne(undefined)).toThrow(/exactly one account/);
    expect(() => s.resolveOne("all")).toThrow(/exactly one account/);
    expect(s.resolveOne("work").email).toBe("me@work.com");
  });

  it("rejects bad aliases", () => {
    const s = store();
    expect(() => s.upsert({ alias: "Bad Alias!", email: "x@y.z", allowSend: false, readonly: false, addedAt: "" })).toThrow(/invalid/);
  });

  it("keeps the refresh token when a refreshed token set omits it", () => {
    const s = store();
    s.writeTokens("work", { refresh_token: "r1", access_token: "a1" });
    s.writeTokens("work", { access_token: "a2", expiry_date: 5 });
    expect(s.readTokens("work")).toMatchObject({ refresh_token: "r1", access_token: "a2", expiry_date: 5 });
    const mode = fs.statSync(s.tokenPath("work")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("removes account and tokens", () => {
    const s = store();
    s.writeTokens("work", { refresh_token: "r" });
    expect(s.remove("work")).toBe(true);
    expect(s.get("work")).toBeUndefined();
    expect(fs.existsSync(s.tokenPath("work"))).toBe(false);
  });
});

describe("sinceToQuery", () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0);
  it("handles relative and absolute values", () => {
    expect(sinceToQuery("24h", now)).toBe(`after:${Math.floor((now - 86_400_000) / 1000)}`);
    expect(sinceToQuery("2d", now)).toBe(`after:${Math.floor((now - 2 * 86_400_000) / 1000)}`);
    expect(sinceToQuery("2026-10-01T00:00:00Z", now)).toBe(`after:${Date.UTC(2026, 9, 1) / 1000}`);
    expect(sinceToQuery(undefined)).toBe("");
    expect(() => sinceToQuery("yesterday")).toThrow(/Cannot parse/);
  });
});
