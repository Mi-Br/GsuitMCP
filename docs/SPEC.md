# gmail-multi-mcp — Design & Specification

Version 0.1.0 · Status: implemented

## 1. Problem

Claude's hosted Gmail connector binds one Google identity per conversation. People with several
mailboxes (work, personal, side business) have to pick one and lose the ability to ask
cross-inbox questions ("did anyone email me about the invoice?") or to draft from the right
identity without re-authenticating.

## 2. Goals

1. **Many accounts, one server.** Register any number of Gmail accounts under short aliases and
   address them individually or all at once from a single tool call.
2. **Read, organise, draft.** Search with full Gmail query syntax, read messages and threads as
   clean text, change labels/read state, and create correctly threaded drafts.
3. **Send only when the user opts in.** Default is drafts-only per account.
4. **Recurring work.** Run digests and label rules on a cron schedule inside the server, and make
   the tool surface friendly to Claude-side scheduled prompts.
5. **Local and private.** Runs on the user's machine over stdio; tokens stay on disk under the
   user's home directory; nothing talks to anything but Google.
6. **Friendly.** Setup in minutes, error messages that say what to run next, a `doctor` command.

### Non-goals (v0.1)

- Attachment download/upload (metadata is exposed; download is a follow-up).
- Calendar, Drive, Contacts (the repo name hints at them; keep the server single-purpose for now).
- A GUI. The CLI plus Claude is the interface.
- Multi-user / hosted deployment.

## 3. Architecture

```
 Claude Desktop / Claude Code / Cowork
            │  stdio (JSON-RPC, MCP)
            ▼
 ┌──────────────────────────────────────────────────────────┐
 │ gmail-multi-mcp serve                                    │
 │                                                          │
 │  server.ts ── 21 tools ──► registry.ts ──► GmailService  │
 │                               │               (per acct) │
 │                               ▼                          │
 │                          accounts.ts   tokens/*.json     │
 │                               │                          │
 │  scheduler.ts (node-cron, leader lock) ──► executeTask   │
 │        tasks.json  runs/*.jsonl                          │
 └──────────────────────────────────────────────────────────┘
            │  HTTPS (googleapis, OAuth2 refresh)
            ▼
        Gmail API
```

- **Language/runtime:** TypeScript on Node ≥ 18, ESM. Dependencies: `@modelcontextprotocol/sdk`,
  `googleapis`, `node-cron`, `zod`.
- **Transport:** stdio only. stdout is reserved for MCP frames; all logging is stderr.
- **State directory:** `~/.gmail-mcp` (override `GMAIL_MCP_HOME`). Files are written `0600`.
- **One process per client.** Claude Desktop and Claude Code each spawn their own server. Account
  and task files are shared through disk; the scheduler uses a lock file so cron jobs run in exactly
  one of them.

## 4. Data model

### 4.1 `accounts.json`

```json
{ "version": 1, "accounts": [
  { "alias": "work", "email": "me@company.com", "description": "Company mailbox",
    "allowSend": false, "readonly": false, "addedAt": "2026-10-12T09:00:00Z" } ] }
```

- `alias` — `^[a-z0-9][a-z0-9_-]{0,31}$`, unique, what the user and Claude say.
- `allowSend` — gate for `send_email` / `send_draft`. Default `false`.
- `readonly` — the account was authorised with `gmail.readonly`; every write tool refuses it.

### 4.2 `tokens/<alias>.json`

Google OAuth tokens (`refresh_token`, `access_token`, `expiry_date`, `scope`). The refresh token
is preserved across refreshes (Google only sends it on first consent).

### 4.3 `tasks.json` and `runs/<taskId>.jsonl`

See §7.

## 5. Authentication

- OAuth client type **Desktop app**; the user downloads `credentials.json` once.
- Flow: `auth add <alias>` starts a loopback HTTP server on `127.0.0.1:<random>`, opens the
  consent URL (`access_type=offline`, `prompt=consent` to guarantee a refresh token), receives the
  code, exchanges it, calls `users.getProfile` to learn the email, writes account + tokens.
- Scopes: `gmail.modify` (read, labels, drafts, send) or `gmail.readonly` with `--readonly`.
  `gmail.modify` cannot permanently delete mail; `trash_email` is the most destructive action.
- Refresh is automatic via `google-auth-library`; refreshed tokens are persisted from the
  `tokens` event. `invalid_grant`/401 is translated into "re-run `auth add <alias>`".
- Known Google gotcha documented for users: consent screens in *Testing* status expire refresh
  tokens after 7 days; publishing (without verification) removes the limit.

## 6. Tool catalogue

Conventions:

- `account` (string, optional): alias | email | comma list | `"all"`. Read tools default to `all`
  and return results **grouped per account**, each with its own `error` field so one bad token does
  not fail the call. Write tools require exactly one account (omit only when one is configured).
- All results are JSON text. Errors return `isError: true` with a one-line actionable message.
- Bodies are plain text (HTML converted); raw HTML is never returned. Bodies are truncated with a
  visible marker at `max_body_chars`.

| Tool | Args (besides `account`) | Returns | Notes |
|---|---|---|---|
| `list_accounts` | — | aliases, emails, permission summary, token presence | call first when unsure |
| `search_emails` | `query`, `max_results`=20, `since`, `unread_only`, `include_spam_trash` | per-account `messages[]` summaries | `since` = `24h`/`7d`/ISO → `after:` |
| `get_email` | `message_id`, `max_body_chars`=20000 | headers, text, labels, attachments meta | read-only |
| `get_thread` | `thread_id`, `max_body_chars_per_message`=8000 | messages oldest→newest | read-only |
| `list_labels` | — | per-account labels with unread counts | read-only |
| `inbox_digest` | `since`=24h, `unread_only`=true, `query`, `max_per_account`=25 | totals + per-account recent mail | built for "what's new" and recurring prompts |
| `modify_emails` | `message_ids[]`, `add_labels`, `remove_labels`, `mark_read`, `mark_unread`, `archive`, `move_to_inbox`, `star`, `unstar` | applied label ids | label names resolved, user labels auto-created |
| `trash_email` | `message_id` | — | destructive hint |
| `create_draft` | `to`, `cc`, `bcc`, `subject`, `body`, `body_html`, `reply_to_message_id`, `reply_all` | `draftId`, `threadId` | reply fills To/Subject/threading |
| `update_draft` | `draft_id` + draft fields | `draftId` | full replace |
| `list_drafts` | `max_results` | per-account drafts | |
| `get_draft` | `draft_id` | recipients, subject, text | |
| `delete_draft` | `draft_id` | — | |
| `send_draft` | `draft_id` | `messageId` | requires `allowSend` |
| `send_email` | draft fields | `messageId` | requires `allowSend`; description tells Claude to prefer drafts |
| `list_scheduled_tasks` | — | tasks + `nextRun`, `schedulerActive` | |
| `create_scheduled_task` | `name`, `schedule`, `timezone`, `accounts`, `kind`, `query`, `max_results`, `action`, `enabled` | task | cron validated |
| `update_scheduled_task` | `task_id` + any field | task | `enabled=false` pauses |
| `delete_scheduled_task` | `task_id` | — | removes history |
| `run_scheduled_task` | `task_id` | run record | manual trigger |
| `get_task_runs` | `task_id`, `limit`=5 | newest-first runs | digest runs carry `isNew` per message |

### 6.1 Message summary shape

```json
{ "id": "18f…", "threadId": "18f…", "date": "2026-10-12T07:00:00.000Z",
  "from": "Boss <boss@work.com>", "to": "me@work.com", "subject": "Q4 plan",
  "snippet": "Please review…", "unread": true, "starred": false,
  "labels": ["INBOX", "UNREAD"], "hasAttachments": false }
```

### 6.2 Draft/reply semantics

- `reply_to_message_id` fetches the original's `Message-ID`, `References`, `Subject`, `From`,
  `Reply-To`, `To`, `Cc`; sets `In-Reply-To`/`References`, `threadId`, and `Re:` subject
  (not stacked). `to` defaults to Reply-To or From. `reply_all` adds the other recipients to Cc,
  excluding the account itself.
- Messages are RFC 5322 with UTF-8, base64 bodies, RFC 2047 encoded headers, and
  `multipart/alternative` when `body_html` is given.

## 7. Scheduled tasks

### 7.1 Model

```json
{ "id": "task_3fa9c2d1", "name": "Morning digest", "enabled": true,
  "schedule": "0 8 * * 1-5", "timezone": "Europe/Amsterdam",
  "accounts": "all", "kind": "digest", "query": "is:unread -category:promotions",
  "maxResults": 25, "action": null,
  "createdAt": "…", "updatedAt": "…", "lastRunAt": "…", "lastStatus": "ok" }
```

| Kind | Behaviour |
|---|---|
| `digest` | For each account: run `query`, store message summaries. Compare with the previous run's ids to flag `isNew`. No mail is modified. |
| `label_rule` | For each writable account: run `query` (required non-empty), apply `action` (`addLabels`, `removeLabels`, `markRead`, `archive`, `star`). Read-only accounts report an error and are skipped. |

### 7.2 Execution

- `node-cron` with `noOverlap`; standard 5-field cron; optional IANA timezone.
- Each run appends a record (`runAt`, `durationMs`, `trigger`, `status` ok/partial/error,
  per-account results/errors) to `runs/<taskId>.jsonl`, capped at 50.
- **Leader election.** `scheduler.lock` holds `{pid, heartbeat}`; heartbeat every 30 s; a lock
  older than 90 s or with a dead pid is taken over. Non-leaders still serve tools and can
  `run_scheduled_task` manually. `GMAIL_MCP_SCHEDULER=off` opts a process out.
- Tasks run only while some server process is alive. For always-on, run `serve` under
  launchd/systemd/pm2.

### 7.3 AI-driven recurring work

Anything needing judgement (summarise, triage, draft) is scheduled in the Claude client (Cowork
scheduled tasks, Claude Code routines, or `claude -p` from cron). The server supports this with
`inbox_digest` (one call for everything new) and `digest` tasks + `get_task_runs` (what is new
since the last check, even if Claude was not running).

## 8. Safety & privacy

- Drafts are the default outcome; sending is opt-in per account and the tool descriptions tell
  Claude to confirm recipients/content first.
- `trash_email` and `delete_draft` carry `destructiveHint`; permanent deletion is not exposed.
- Tokens and account files are `0600`; the state directory is `0700`.
- No telemetry; no network besides Google APIs.
- Secrets are never printed; `doctor` reports token presence only.

## 9. Error handling

- Google errors are normalised in `describeError`: 401/`invalid_grant` → re-auth instruction;
  403 insufficient scope → re-add without `--readonly`; others pass the API message through.
- Multi-account reads never fail as a whole; each account entry has `error`.
- Unknown account → lists known aliases. No accounts → tells the user the `auth add` command.

## 10. CLI

```
gmail-multi-mcp serve
gmail-multi-mcp auth add <alias> [--description "…"] [--allow-send] [--readonly] [--no-browser]
gmail-multi-mcp accounts list | remove <alias> | allow-send <alias> on|off | describe <alias> "…"
gmail-multi-mcp tasks list
gmail-multi-mcp doctor
gmail-multi-mcp paths
```

## 11. Testing

- Unit tests: MIME builder, payload parser, HTML→text, address parsing, account resolution,
  token merging, task validation and run history.
- End-to-end tests: a real `McpServer` connected to a real MCP `Client` over
  `InMemoryTransport`, backed by `tests/fake-gmail.ts` (an in-memory Gmail that understands the
  query subset used). Covers all-account search with a failing account, reply-all drafting,
  send gating, read-only refusal, label changes, digest and label-rule tasks.
- Manual: `node dist/index.js serve` driven by raw JSON-RPC (initialize, tools/list, tools/call).

## 12. Roadmap

- Attachment download (`get_attachment` → temp file path) and sending with attachments.
- `watch`-style change detection via Gmail `history.list` for cheaper digests.
- Optional Calendar/Contacts tools behind the same account registry.
- Signed-in-browser hint: detect which Google account is active and warn on mismatch.
- `gmail-multi-mcp install-claude-desktop` to patch the client config automatically.
