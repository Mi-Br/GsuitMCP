import os from "node:os";
import path from "node:path";

/**
 * All state lives in one directory so it is easy to back up, inspect, or wipe.
 *
 *   ~/.gmail-mcp/
 *     credentials.json      OAuth client (downloaded from Google Cloud Console)
 *     accounts.json         alias -> { email, allowSend, readonly, ... }
 *     tokens/<alias>.json   refresh/access tokens, chmod 600
 *     tasks.json            scheduled tasks
 *     runs/<taskId>.jsonl   results of each scheduled-task run
 *     scheduler.lock        pid + heartbeat of the process running the scheduler
 *
 * Override the root with GMAIL_MCP_HOME.
 */
export interface Paths {
  root: string;
  credentials: string;
  accounts: string;
  tokensDir: string;
  tasks: string;
  runsDir: string;
  schedulerLock: string;
}

export function resolvePaths(root = process.env.GMAIL_MCP_HOME ?? path.join(os.homedir(), ".gmail-mcp")): Paths {
  return {
    root,
    credentials: process.env.GMAIL_MCP_CREDENTIALS ?? path.join(root, "credentials.json"),
    accounts: path.join(root, "accounts.json"),
    tokensDir: path.join(root, "tokens"),
    tasks: path.join(root, "tasks.json"),
    runsDir: path.join(root, "runs"),
    schedulerLock: path.join(root, "scheduler.lock"),
  };
}

export const SCOPES = {
  full: ["https://www.googleapis.com/auth/gmail.modify"],
  readonly: ["https://www.googleapis.com/auth/gmail.readonly"],
} as const;

/** Logging goes to stderr: stdout is the MCP transport and must stay clean. */
export function log(...parts: unknown[]): void {
  if (process.env.GMAIL_MCP_QUIET === "1") return;
  const stamp = new Date().toISOString();
  process.stderr.write(`[gmail-mcp ${stamp}] ${parts.map(String).join(" ")}\n`);
}
