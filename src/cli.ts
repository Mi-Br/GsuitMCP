import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolvePaths, log } from "./config.js";
import { AccountStore } from "./accounts.js";
import { addAccount } from "./auth/oauth.js";
import { ServiceRegistry, describeError } from "./registry.js";
import { TaskStore } from "./scheduler/tasks.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { createServer } from "./server.js";

const VERSION = "0.1.0";

const USAGE = `gmail-multi-mcp ${VERSION} - multi-account Gmail MCP server

Usage:
  gmail-multi-mcp serve                         Start the MCP server on stdio (default; what Claude runs)
  gmail-multi-mcp auth add <alias> [options]    Connect a Gmail account (opens browser)
        --description "<text>"                  What this account is for (shown to Claude)
        --allow-send                            Allow Claude to send from this account (default: drafts only)
        --readonly                              Request read-only access (no drafts/labels)
        --no-browser                            Print the URL instead of opening a browser
  gmail-multi-mcp accounts list                 Show connected accounts
  gmail-multi-mcp accounts remove <alias>       Forget an account and delete its tokens
  gmail-multi-mcp accounts allow-send <alias> on|off
  gmail-multi-mcp accounts describe <alias> "<text>"
  gmail-multi-mcp tasks list                    Show scheduled tasks
  gmail-multi-mcp doctor                        Check credentials, tokens, and API access
  gmail-multi-mcp paths                         Print where state is stored

Environment:
  GMAIL_MCP_HOME          State directory (default ~/.gmail-mcp)
  GMAIL_MCP_CREDENTIALS   Path to the OAuth client JSON (default $GMAIL_MCP_HOME/credentials.json)
  GMAIL_MCP_SCHEDULER=off Do not run scheduled tasks in this process
`;

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const command = args.shift() ?? "serve";
  const paths = resolvePaths();
  const store = new AccountStore(paths);

  switch (command) {
    case "serve":
      return serve(paths, store);

    case "auth": {
      const sub = args.shift();
      if (sub !== "add") {
        process.stderr.write(USAGE);
        return 2;
      }
      const allowSend = flag(args, "--allow-send");
      const readonly = flag(args, "--readonly");
      const noBrowser = flag(args, "--no-browser");
      const description = option(args, "--description");
      const alias = args.shift();
      if (!alias) {
        process.stderr.write("Missing alias. Example: gmail-multi-mcp auth add work\n");
        return 2;
      }
      try {
        const record = await addAccount(paths, store, { alias: alias.toLowerCase(), description, allowSend, readonly, noBrowser });
        process.stdout.write(
          `\nConnected ${record.email} as "${record.alias}" (${record.readonly ? "read-only" : record.allowSend ? "read, draft, send" : "read + draft; sending disabled"}).\n` +
            `Restart Claude Desktop (or the MCP server) so it picks up the new account.\n`,
        );
        return 0;
      } catch (err) {
        process.stderr.write(`\nFailed: ${describeError(err)}\n`);
        return 1;
      }
    }

    case "accounts": {
      const sub = args.shift() ?? "list";
      if (sub === "list") {
        const accounts = store.list();
        if (accounts.length === 0) {
          process.stdout.write("No accounts. Run: gmail-multi-mcp auth add <alias>\n");
          return 0;
        }
        for (const a of accounts) {
          const perms = a.readonly ? "read-only" : a.allowSend ? "read, draft, send" : "read, draft";
          const token = store.readTokens(a.alias)?.refresh_token ? "token ok" : "NO TOKEN";
          process.stdout.write(`${a.alias.padEnd(14)} ${a.email.padEnd(34)} ${perms.padEnd(18)} ${token}${a.description ? `  - ${a.description}` : ""}\n`);
        }
        return 0;
      }
      if (sub === "remove") {
        const alias = args.shift();
        if (!alias) return usage();
        process.stdout.write(store.remove(alias) ? `Removed ${alias}.\n` : `No account named ${alias}.\n`);
        return 0;
      }
      if (sub === "allow-send") {
        const alias = args.shift();
        const value = args.shift();
        if (!alias || !value || !["on", "off"].includes(value)) return usage();
        const acc = store.get(alias);
        if (acc?.readonly) {
          process.stderr.write(`${alias} is read-only; re-add it without --readonly first.\n`);
          return 1;
        }
        store.update(alias, { allowSend: value === "on" });
        process.stdout.write(`Sending ${value === "on" ? "enabled" : "disabled"} for ${alias}.\n`);
        return 0;
      }
      if (sub === "describe") {
        const alias = args.shift();
        const text = args.shift();
        if (!alias || text === undefined) return usage();
        store.update(alias, { description: text });
        process.stdout.write(`Updated description for ${alias}.\n`);
        return 0;
      }
      return usage();
    }

    case "tasks": {
      const tasks = new TaskStore(paths).list();
      if (tasks.length === 0) {
        process.stdout.write("No scheduled tasks. Ask Claude to create one with create_scheduled_task.\n");
        return 0;
      }
      for (const t of tasks) {
        process.stdout.write(
          `${t.id}  ${t.enabled ? "on " : "off"}  ${t.schedule.padEnd(16)} ${t.kind.padEnd(10)} ${t.name}  [${t.accounts}] ${t.lastStatus ? `last: ${t.lastStatus} @ ${t.lastRunAt}` : "never run"}\n`,
        );
      }
      return 0;
    }

    case "doctor":
      return doctor(paths, store);

    case "paths":
      process.stdout.write(JSON.stringify(paths, null, 2) + "\n");
      return 0;

    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return 0;

    default:
      return usage();
  }

  function usage(): number {
    process.stderr.write(USAGE);
    return 2;
  }
}

async function serve(paths: ReturnType<typeof resolvePaths>, store: AccountStore): Promise<number> {
  const registry = new ServiceRegistry(paths, store);
  const tasks = new TaskStore(paths);
  const scheduler = new Scheduler(paths, registry, store, tasks);
  const server = createServer({ paths, store, registry, tasks, scheduler, version: VERSION });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`serving ${store.list().length} account(s) from ${paths.root}`);
  scheduler.start();

  const shutdown = async () => {
    scheduler.stop();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // When the client closes stdin the transport ends; exit so we do not linger holding the scheduler lock.
  process.stdin.on("close", shutdown);

  return new Promise(() => {
    /* run until a signal */
  });
}

async function doctor(paths: ReturnType<typeof resolvePaths>, store: AccountStore): Promise<number> {
  let problems = 0;
  const line = (okay: boolean, text: string) => {
    if (!okay) problems++;
    process.stdout.write(`${okay ? "✓" : "✗"} ${text}\n`);
  };

  line(fs.existsSync(paths.root), `state directory ${paths.root}`);
  line(store.hasCredentials(), `OAuth client file ${paths.credentials}`);
  const accounts = store.list();
  line(accounts.length > 0, `${accounts.length} account(s) configured`);

  const registry = new ServiceRegistry(paths, store);
  for (const a of accounts) {
    const tokens = store.readTokens(a.alias);
    if (!tokens?.refresh_token) {
      line(false, `${a.alias}: no refresh token - run: gmail-multi-mcp auth add ${a.alias}`);
      continue;
    }
    try {
      const labels = await registry.for(a).labels(true);
      line(true, `${a.alias} (${a.email}): API reachable, ${labels.length} labels`);
    } catch (err) {
      line(false, `${a.alias} (${a.email}): ${describeError(err)}`);
    }
  }

  const tasks = new TaskStore(paths).list();
  line(true, `${tasks.length} scheduled task(s)`);
  process.stdout.write(problems === 0 ? "\nAll good.\n" : `\n${problems} problem(s) found.\n`);
  return problems === 0 ? 0 : 1;
}
