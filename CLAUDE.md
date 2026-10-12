# gmail-multi-mcp – notes for Claude working in this repo

This is a local MCP server (TypeScript, stdio transport) that exposes several Gmail accounts to Claude.
Read `README.md` for the user-facing setup and `docs/SPEC.md` for the design and tool contracts.

## Install it for the user (Claude Desktop / Claude Code)

1. `npm install && npm run build` in this directory.
2. Make sure `~/.gmail-mcp/credentials.json` exists (the user downloads it from Google Cloud Console; see README step 2). You cannot do this step for them.
3. For each inbox: `node dist/index.js auth add <alias> [--allow-send] [--description "..."]`. This opens a browser; the user must approve.
4. Register the server:
   - Claude Desktop: add the `gmail-multi` entry from `claude_desktop_config.example.json` (absolute path!) to the user's `claude_desktop_config.json`, then restart Claude Desktop.
   - Claude Code: `claude mcp add gmail-multi -- node <abs path>/dist/index.js serve`
5. Verify with `node dist/index.js doctor`.

## Layout

```
src/index.ts            bin entry
src/cli.ts              commands: serve | auth add | accounts | tasks | doctor | paths
src/config.ts           paths (~/.gmail-mcp), scopes, stderr logger
src/accounts.ts         account registry + token files
src/auth/oauth.ts       loopback OAuth flow, per-account OAuth2 client
src/gmail/mime.ts       RFC 5322 builder (text + optional html, threading headers)
src/gmail/parse.ts      Gmail payload -> text, html->text, summaries
src/gmail/service.ts    GmailService: search/get/thread/labels/drafts/send; GmailApi interface
src/registry.ts         one GmailService per account, forEachAccount, error wording, since->after:
src/scheduler/tasks.ts  task schema (zod), tasks.json, runs/*.jsonl
src/scheduler/scheduler.ts  node-cron jobs, leader lock, executeTask
src/server.ts           McpServer + all 21 tools
tests/                  vitest; fake-gmail.ts is an in-memory Gmail API used by the e2e tests
```

## Rules

- stdout is the MCP channel: never `console.log` in server code, use `log()` (stderr).
- Sending is opt-in per account (`allowSend`); never bypass `requireSendable`.
- Keep tool results JSON; keep error messages actionable (tell the user the exact command to run).
- `npm test` and `npm run typecheck` must pass before committing.
