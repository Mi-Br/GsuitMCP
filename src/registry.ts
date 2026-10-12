import { google } from "googleapis";
import type { Paths } from "./config.js";
import type { AccountRecord, AccountStore } from "./accounts.js";
import { clientForAccount } from "./auth/oauth.js";
import { GmailService, type GmailApi } from "./gmail/service.js";

export type ServiceFactory = (account: AccountRecord) => GmailApi;

/**
 * Hands out one GmailService per account and caches it for the life of the process.
 * The factory is injectable so tests can plug in a fake Gmail API.
 */
export class ServiceRegistry {
  private readonly cache = new Map<string, GmailService>();
  private readonly factory: ServiceFactory;

  constructor(
    readonly paths: Paths,
    readonly store: AccountStore,
    factory?: ServiceFactory,
  ) {
    this.factory =
      factory ??
      ((account) => {
        const auth = clientForAccount(paths, store, account);
        return google.gmail({ version: "v1", auth }) as unknown as GmailApi;
      });
  }

  for(account: AccountRecord): GmailService {
    let svc = this.cache.get(account.alias);
    if (!svc) {
      svc = new GmailService(this.factory(account), account.email);
      this.cache.set(account.alias, svc);
    }
    return svc;
  }

  invalidate(alias?: string): void {
    if (alias) this.cache.delete(alias);
    else this.cache.clear();
  }
}

/**
 * Run `fn` for each resolved account, collecting per-account results and errors
 * instead of failing the whole call when one account has an expired token.
 */
export async function forEachAccount<T>(
  registry: ServiceRegistry,
  accounts: AccountRecord[],
  fn: (svc: GmailService, account: AccountRecord) => Promise<T>,
): Promise<Array<{ account: string; email: string; result?: T; error?: string }>> {
  return Promise.all(
    accounts.map(async (account) => {
      try {
        const result = await fn(registry.for(account), account);
        return { account: account.alias, email: account.email, result };
      } catch (err) {
        return { account: account.alias, email: account.email, error: describeError(err) };
      }
    }),
  );
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const anyErr = err as Error & { code?: number | string; errors?: Array<{ message?: string }> };
    const detail = anyErr.errors?.[0]?.message;
    if (anyErr.code === 401 || /invalid_grant/i.test(err.message)) {
      return `Authorisation expired or revoked (${err.message}). Re-run \`gmail-multi-mcp auth add <alias>\` for this account.`;
    }
    if (anyErr.code === 403 && /insufficient/i.test(detail ?? err.message)) {
      return `Insufficient permission: this account was authorised read-only. Re-add it without --readonly to allow drafts/labels. (${detail ?? err.message})`;
    }
    return detail ? `${err.message}: ${detail}` : err.message;
  }
  return String(err);
}

/** Turn "24h" / "7d" / "30m" / ISO date into a Gmail `after:` clause (epoch seconds). */
export function sinceToQuery(since: string | undefined, now = Date.now()): string {
  if (!since) return "";
  const rel = since.trim().match(/^(\d+)\s*([mhdw])$/i);
  let ms: number;
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    ms = n * ({ m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as Record<string, number>)[unit];
  } else {
    const parsed = Date.parse(since);
    if (Number.isNaN(parsed)) throw new Error(`Cannot parse "since": use e.g. "24h", "7d", or an ISO date like 2026-10-01.`);
    return `after:${Math.floor(parsed / 1000)}`;
  }
  return `after:${Math.floor((now - ms) / 1000)}`;
}
