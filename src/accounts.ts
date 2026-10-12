import fs from "node:fs";
import path from "node:path";
import type { Paths } from "./config.js";

export interface AccountRecord {
  /** Short handle the user and Claude refer to, e.g. "personal", "work". */
  alias: string;
  email: string;
  /** Free-text description so Claude knows what the account is for. */
  description?: string;
  /** Sending is opt-in per account. Drafting is always allowed (unless readonly). */
  allowSend: boolean;
  /** Authorised with gmail.readonly only: no drafts, labels changes, or sending. */
  readonly: boolean;
  addedAt: string;
}

export interface StoredTokens {
  refresh_token?: string | null;
  access_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
  token_type?: string | null;
}

interface AccountsFile {
  version: 1;
  accounts: AccountRecord[];
}

export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const ALL_ACCOUNTS = "all";

export class AccountNotFoundError extends Error {
  constructor(selector: string, known: string[]) {
    super(
      known.length === 0
        ? `No Gmail accounts are configured. Run \`gmail-multi-mcp auth add <alias>\` first.`
        : `Unknown account "${selector}". Known accounts: ${known.join(", ")} (or "all").`,
    );
    this.name = "AccountNotFoundError";
  }
}

/**
 * Persists the account registry and per-account OAuth tokens on disk.
 * Pure file I/O, no Google calls, so it is trivially testable.
 */
export class AccountStore {
  constructor(private readonly paths: Paths) {}

  private ensureDirs(): void {
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.paths.tokensDir, { recursive: true, mode: 0o700 });
  }

  private read(): AccountsFile {
    if (!fs.existsSync(this.paths.accounts)) return { version: 1, accounts: [] };
    const raw = JSON.parse(fs.readFileSync(this.paths.accounts, "utf8")) as Partial<AccountsFile>;
    return { version: 1, accounts: raw.accounts ?? [] };
  }

  private write(file: AccountsFile): void {
    this.ensureDirs();
    fs.writeFileSync(this.paths.accounts, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  }

  list(): AccountRecord[] {
    return this.read().accounts.slice().sort((a, b) => a.alias.localeCompare(b.alias));
  }

  get(alias: string): AccountRecord | undefined {
    return this.read().accounts.find((a) => a.alias === alias);
  }

  /**
   * Resolve what the user typed into concrete accounts.
   * Accepts an alias, an email address, a comma-separated list of either, or "all".
   */
  resolve(selector: string | undefined): AccountRecord[] {
    const all = this.list();
    const wanted = (selector ?? ALL_ACCOUNTS).trim();
    if (wanted === "" || wanted.toLowerCase() === ALL_ACCOUNTS) {
      if (all.length === 0) throw new AccountNotFoundError(wanted, []);
      return all;
    }
    const parts = wanted.split(",").map((p) => p.trim()).filter(Boolean);
    const out: AccountRecord[] = [];
    for (const part of parts) {
      const match = all.find(
        (a) => a.alias === part.toLowerCase() || a.email.toLowerCase() === part.toLowerCase(),
      );
      if (!match) throw new AccountNotFoundError(part, all.map((a) => a.alias));
      if (!out.includes(match)) out.push(match);
    }
    return out;
  }

  /** Resolve a selector that must name exactly one account (write operations). */
  resolveOne(selector: string | undefined): AccountRecord {
    const all = this.list();
    if (!selector || selector.trim() === "" || selector.trim().toLowerCase() === ALL_ACCOUNTS) {
      if (all.length === 1) return all[0];
      throw new Error(
        `This operation needs exactly one account. Pass "account" as one of: ${all.map((a) => a.alias).join(", ")}.`,
      );
    }
    const matches = this.resolve(selector);
    if (matches.length !== 1) {
      throw new Error(`This operation needs exactly one account, got ${matches.length}: ${selector}`);
    }
    return matches[0];
  }

  upsert(record: AccountRecord): void {
    if (!ALIAS_PATTERN.test(record.alias)) {
      throw new Error(
        `Alias "${record.alias}" is invalid. Use 1-32 lowercase letters, digits, "-" or "_", e.g. "work" or "personal".`,
      );
    }
    const file = this.read();
    const idx = file.accounts.findIndex((a) => a.alias === record.alias);
    if (idx >= 0) file.accounts[idx] = record;
    else file.accounts.push(record);
    this.write(file);
  }

  update(alias: string, patch: Partial<Omit<AccountRecord, "alias">>): AccountRecord {
    const current = this.get(alias);
    if (!current) throw new AccountNotFoundError(alias, this.list().map((a) => a.alias));
    const next = { ...current, ...patch };
    this.upsert(next);
    return next;
  }

  remove(alias: string): boolean {
    const file = this.read();
    const before = file.accounts.length;
    file.accounts = file.accounts.filter((a) => a.alias !== alias);
    this.write(file);
    const tokenPath = this.tokenPath(alias);
    if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
    return file.accounts.length !== before;
  }

  tokenPath(alias: string): string {
    return path.join(this.paths.tokensDir, `${alias}.json`);
  }

  readTokens(alias: string): StoredTokens | undefined {
    const p = this.tokenPath(alias);
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, "utf8")) as StoredTokens;
  }

  writeTokens(alias: string, tokens: StoredTokens): void {
    this.ensureDirs();
    const existing = this.readTokens(alias) ?? {};
    // Google only returns refresh_token on the first consent; never lose it on refresh.
    const merged: StoredTokens = { ...existing, ...tokens };
    if (!tokens.refresh_token && existing.refresh_token) merged.refresh_token = existing.refresh_token;
    fs.writeFileSync(this.tokenPath(alias), JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  }

  hasCredentials(): boolean {
    return fs.existsSync(this.paths.credentials);
  }
}
