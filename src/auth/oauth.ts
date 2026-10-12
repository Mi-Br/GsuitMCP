import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { SCOPES, log, type Paths } from "../config.js";
import type { AccountRecord, AccountStore } from "../accounts.js";

interface InstalledCredentials {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

/** Read the OAuth client file downloaded from Google Cloud Console. Accepts "installed" or "web" shapes. */
export function loadClientCredentials(paths: Paths): InstalledCredentials {
  if (!fs.existsSync(paths.credentials)) {
    throw new Error(
      `OAuth client file not found at ${paths.credentials}.\n` +
        `Create a "Desktop app" OAuth client in Google Cloud Console, download the JSON, and save it there.\n` +
        `See README.md -> "1. Create Google OAuth credentials".`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(paths.credentials, "utf8")) as Record<string, InstalledCredentials>;
  const creds = raw.installed ?? raw.web;
  if (!creds?.client_id || !creds?.client_secret) {
    throw new Error(`${paths.credentials} does not look like a Google OAuth client file (missing client_id/client_secret).`);
  }
  return creds;
}

export function createOAuthClient(paths: Paths, redirectUri?: string): OAuth2Client {
  const creds = loadClientCredentials(paths);
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);
}

/**
 * Build an authenticated client for a stored account. Tokens refresh automatically
 * and refreshed tokens are written back to disk.
 */
export function clientForAccount(paths: Paths, store: AccountStore, account: AccountRecord): OAuth2Client {
  const tokens = store.readTokens(account.alias);
  if (!tokens?.refresh_token) {
    throw new Error(
      `Account "${account.alias}" has no refresh token. Re-authorise with \`gmail-multi-mcp auth add ${account.alias}\`.`,
    );
  }
  const client = createOAuthClient(paths);
  client.setCredentials(tokens);
  client.on("tokens", (fresh) => {
    store.writeTokens(account.alias, fresh);
  });
  return client;
}

function tryOpenBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* fall back to printing the URL */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

export interface AddAccountOptions {
  alias: string;
  description?: string;
  allowSend?: boolean;
  readonly?: boolean;
  /** Skip opening a browser; just print the URL. */
  noBrowser?: boolean;
  /** For tests: supply the authorisation code without a browser round-trip. */
  codeProvider?: (authUrl: string) => Promise<string>;
}

/**
 * Interactive OAuth flow using the loopback redirect (http://127.0.0.1:<port>/oauth2callback).
 * Google requires loopback for Desktop clients; any port is accepted.
 */
export async function addAccount(paths: Paths, store: AccountStore, opts: AddAccountOptions): Promise<AccountRecord> {
  const scopes = opts.readonly ? [...SCOPES.readonly] : [...SCOPES.full];
  loadClientCredentials(paths); // fail fast with a readable message before opening any port

  const code = opts.codeProvider
    ? await runWithCodeProvider(paths, scopes, opts.codeProvider)
    : await runLoopbackFlow(paths, scopes, opts.noBrowser ?? false);

  const client = createOAuthClient(paths, code.redirectUri);
  const { tokens } = await client.getToken(code.code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Remove this app from https://myaccount.google.com/permissions and run `auth add` again.",
    );
  }
  client.setCredentials(tokens);

  const gmail = google.gmail({ version: "v1", auth: client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email = profile.data.emailAddress;
  if (!email) throw new Error("Could not read the email address of the authorised account.");

  const existing = store.get(opts.alias);
  const record: AccountRecord = {
    alias: opts.alias,
    email,
    description: opts.description ?? existing?.description,
    allowSend: opts.readonly ? false : (opts.allowSend ?? existing?.allowSend ?? false),
    readonly: opts.readonly ?? false,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
  };
  store.upsert(record);
  store.writeTokens(opts.alias, tokens);
  log(`Authorised ${email} as "${opts.alias}"`);
  return record;
}

interface AuthCode {
  code: string;
  redirectUri: string;
}

async function runWithCodeProvider(
  paths: Paths,
  scopes: string[],
  provider: (url: string) => Promise<string>,
): Promise<AuthCode> {
  const redirectUri = "http://127.0.0.1/oauth2callback";
  const client = createOAuthClient(paths, redirectUri);
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: scopes });
  return { code: await provider(url), redirectUri };
}

async function runLoopbackFlow(paths: Paths, scopes: string[], noBrowser: boolean): Promise<AuthCode> {
  return new Promise<AuthCode>((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not open a local port for the OAuth callback."));
        return;
      }
      const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      const client = createOAuthClient(paths, redirectUri);
      const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: scopes });

      process.stderr.write(`\nOpen this URL in the browser where you are signed in to the Gmail account you want to add:\n\n  ${url}\n\n`);
      if (!noBrowser) tryOpenBrowser(url);

      const timeout = setTimeout(() => {
        server.close();
        reject(new Error("Timed out waiting for Google to redirect back (10 minutes)."));
      }, 10 * 60 * 1000);

      server.on("request", (req, res) => {
        const reqUrl = new URL(req.url ?? "/", redirectUri);
        if (reqUrl.pathname !== "/oauth2callback") {
          res.writeHead(404).end();
          return;
        }
        const error = reqUrl.searchParams.get("error");
        const code = reqUrl.searchParams.get("code");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (error || !code) {
          res.end(`<h2>Authorisation failed: ${error ?? "no code"}</h2><p>You can close this tab.</p>`);
          clearTimeout(timeout);
          server.close();
          reject(new Error(`Google returned an error: ${error ?? "missing code"}`));
          return;
        }
        res.end(`<h2>Gmail account connected.</h2><p>You can close this tab and return to the terminal.</p>`);
        clearTimeout(timeout);
        server.close();
        resolve({ code, redirectUri });
      });
    });
  });
}
