# gmail-multi-mcp

A local [MCP](https://modelcontextprotocol.io) server that gives Claude access to **several Gmail accounts at the same time**.

The built-in Gmail connector can only see one inbox per conversation. This server registers each of your Gmail accounts under a short alias (`work`, `personal`, `shop`, …) and lets Claude search, read, label, draft, and optionally send in any of them, or in all of them with one call. It also runs recurring tasks (inbox digests, auto-labelling rules) on a schedule.

Everything runs on your machine. Tokens never leave `~/.gmail-mcp/`.

```
You:    What came in overnight across all my inboxes?
Claude: → inbox_digest(account="all", since="12h")
        work:     2 unread (Q4 plan from Boss, invoice from Acme)
        personal: 1 unread (Dinner? from Mum)
You:    Draft a reply to Mum saying Sunday at 6 works.
Claude: → create_draft(account="personal", reply_to_message_id=…, body=…)
        Draft saved in me@gmail.com's Drafts folder (not sent).
```

---

## Quick start

### 0. Prerequisites

- Node.js 18 or newer (`node --version`)
- A Google account for each inbox you want to connect

### 1. Install

```bash
git clone <this repository> GsuitMCP
cd GsuitMCP
npm install
npm run build
npm link          # optional: puts the `gmail-multi-mcp` command on your PATH
```

Without `npm link`, replace `gmail-multi-mcp` below with `node /absolute/path/to/GsuitMCP/dist/index.js`.

### 2. Create Google OAuth credentials (one time, ~5 minutes)

Google requires every app that touches Gmail to have its own OAuth client. You create one, download a JSON file, and all of your accounts authorise through it.

1. Open <https://console.cloud.google.com/> and create a project (any name, e.g. `gmail-mcp`).
2. **APIs & Services → Library** → search *Gmail API* → **Enable**.
3. **APIs & Services → OAuth consent screen**
   - User type: **External** → Create
   - App name: `gmail-mcp`, your email as support and developer contact → Save
   - Scopes: skip (the server requests them at login)
   - **Test users: add every Gmail address you plan to connect** → Save
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Name: anything → Create → **Download JSON**
5. Save that file as `~/.gmail-mcp/credentials.json`:

   ```bash
   mkdir -p ~/.gmail-mcp
   mv ~/Downloads/client_secret_*.json ~/.gmail-mcp/credentials.json
   ```

> **Avoid weekly re-login.** While the consent screen is in *Testing* status, Google expires refresh tokens after 7 days. Go to **OAuth consent screen → Publishing status → Publish app**. You do *not* need to complete verification for personal use; you will just see an "unverified app" warning once per account during login (click *Advanced → Go to gmail-mcp*). After publishing, tokens last until you revoke them.

### 3. Connect your accounts

Run this once per inbox. A browser window opens; sign in to **that** Gmail account and approve.

```bash
gmail-multi-mcp auth add work     --description "Company mailbox"
gmail-multi-mcp auth add personal --description "Private Gmail" --allow-send
gmail-multi-mcp auth add shop     --readonly
gmail-multi-mcp accounts list
```

| Flag | Effect |
|---|---|
| *(none)* | Read, label, and create drafts. Claude **cannot send**. |
| `--allow-send` | Claude may also send (it is instructed to confirm with you first). Toggle later with `accounts allow-send <alias> on\|off`. |
| `--readonly` | Read-only OAuth scope: no drafts, labels, or sending at all. |
| `--description` | Shown to Claude so it knows what the account is for. |

Tip: if the browser opens with the wrong Google account signed in, use `--no-browser`, copy the URL into a private window, and sign in to the right account.

### 4. Add the server to Claude

**Claude Desktop** – edit the config file
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gmail-multi": {
      "command": "node",
      "args": ["/absolute/path/to/GsuitMCP/dist/index.js", "serve"]
    }
  }
}
```

Restart Claude Desktop. The hammer/tools icon should list `gmail-multi` with 21 tools.

**Claude Code**:

```bash
claude mcp add gmail-multi -- node /absolute/path/to/GsuitMCP/dist/index.js serve
```

**Cowork / other MCP clients**: same command, stdio transport.

### 5. Check it

```bash
gmail-multi-mcp doctor
```

Then ask Claude: *"List my Gmail accounts"* and *"Search all my inboxes for unread mail from today."*

---

## What Claude can do

Every tool takes an `account` argument: an alias, an email address, a comma-separated list, or `all`. Write operations need exactly one account.

| Area | Tools |
|---|---|
| Accounts | `list_accounts` |
| Reading | `search_emails`, `get_email`, `get_thread`, `list_labels`, `inbox_digest` |
| Organising | `modify_emails` (read/unread, archive, star, add/remove labels), `trash_email` |
| Drafting | `create_draft`, `update_draft`, `list_drafts`, `get_draft`, `delete_draft` |
| Sending (opt-in per account) | `send_draft`, `send_email` |
| Scheduled tasks | `list_scheduled_tasks`, `create_scheduled_task`, `update_scheduled_task`, `delete_scheduled_task`, `run_scheduled_task`, `get_task_runs` |

Example prompts:

- "Show unread mail in **work** from the last 2 days with attachments."
- "Across **all** accounts, find anything from Acme about the invoice."
- "Read the thread about the Q4 plan and draft a reply in **work** agreeing to Thursday."
- "Archive every newsletter older than a week in **personal** and label them *Newsletters*."
- "Every weekday at 8:00 Amsterdam time, collect unread mail from all accounts so I can ask for a summary."

Replies created with `reply_to_message_id` are threaded correctly (In-Reply-To, References, `Re:` subject, reply-all support).

## Recurring tasks

There are two kinds of recurring work, handled in two places:

**1. Tasks the server runs by itself** (no AI needed): created with `create_scheduled_task`.

| Kind | What it does |
|---|---|
| `digest` | On a cron schedule, run a Gmail query across the chosen accounts and store the results. Each run flags messages that are *new since the previous run*. Read them later with `get_task_runs`. |
| `label_rule` | On a cron schedule, run a query and apply label changes (archive, mark read, star, add/remove labels). Good for "auto-archive newsletters", "star anything from my accountant". |

Tasks persist in `~/.gmail-mcp/tasks.json` and **run only while the MCP server process is alive**, i.e. while Claude Desktop (or another client) has it open. If several clients spawn the server at once, a lock file ensures only one of them runs the scheduler. To keep tasks running without Claude open, start `gmail-multi-mcp serve` under a process manager (launchd, systemd, pm2); set `GMAIL_MCP_SCHEDULER=off` on the Claude-spawned copies if you want that daemon to be the only scheduler.

**2. Tasks that need Claude** (summaries, triage, drafting): schedule them in the Claude client (Cowork scheduled tasks, Claude Code routines, or a cron that runs `claude -p "..."`). Point the prompt at the tools above, e.g. *"Call inbox_digest for all accounts since 24h, summarise by account, and create drafts for anything that needs a reply."* Pair this with a `digest` task so the summary can say what is new.

## Where things live

```
~/.gmail-mcp/
  credentials.json     OAuth client you downloaded (keep private)
  accounts.json        aliases, emails, permissions
  tokens/<alias>.json  refresh tokens, chmod 600
  tasks.json           scheduled tasks
  runs/<task>.jsonl    last 50 runs per task
  scheduler.lock       which process runs the scheduler
```

Override the directory with `GMAIL_MCP_HOME=/path`. Nothing is sent anywhere except Google's Gmail API. Remove an account with `gmail-multi-mcp accounts remove <alias>` and, to revoke on Google's side, <https://myaccount.google.com/permissions>.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `OAuth client file not found` | Step 2: save the downloaded JSON as `~/.gmail-mcp/credentials.json`. |
| `Access blocked: gmail-mcp has not completed the Google verification process` | Add the account as a *test user* on the consent screen, or publish the app (see note in step 2). |
| `Authorisation expired or revoked` after ~7 days | Consent screen is in *Testing*. Publish it, then `auth add <alias>` again. |
| `Google did not return a refresh token` | Remove the app at <https://myaccount.google.com/permissions> and run `auth add` again. |
| Claude says sending is disabled | That is the default. `gmail-multi-mcp accounts allow-send <alias> on`. |
| Tools not showing in Claude Desktop | Use an absolute path in the config, run `node dist/index.js serve` manually to see errors, restart Claude. |
| Scheduled task never runs | The server must be running at that time; check `list_scheduled_tasks` → `schedulerActive`. |

Logs go to stderr (visible in Claude Desktop's MCP logs). Set `GMAIL_MCP_QUIET=1` to silence them.

## Development

```bash
npm run dev -- accounts list   # run from source
npm test                       # unit + end-to-end tests against an in-memory Gmail
npm run typecheck
```

Design and tool contracts: [docs/SPEC.md](docs/SPEC.md).
