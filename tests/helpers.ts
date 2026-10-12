import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolvePaths, type Paths } from "../src/config.js";
import { AccountStore, type AccountRecord } from "../src/accounts.js";
import { ServiceRegistry } from "../src/registry.js";
import { TaskStore } from "../src/scheduler/tasks.js";
import { createServer } from "../src/server.js";
import { FakeGmail, type SeedMessage } from "./fake-gmail.js";

export function tempPaths(): Paths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-test-"));
  return resolvePaths(root);
}

export interface Harness {
  paths: Paths;
  store: AccountStore;
  registry: ServiceRegistry;
  tasks: TaskStore;
  fakes: Map<string, FakeGmail>;
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; json: any; isError: boolean }>;
  close: () => Promise<void>;
}

export interface HarnessAccount {
  alias: string;
  email: string;
  allowSend?: boolean;
  readonly?: boolean;
  messages?: SeedMessage[];
}

export async function harness(accounts: HarnessAccount[]): Promise<Harness> {
  process.env.GMAIL_MCP_QUIET = "1";
  const paths = tempPaths();
  const store = new AccountStore(paths);
  const fakes = new Map<string, FakeGmail>();
  for (const a of accounts) {
    const record: AccountRecord = {
      alias: a.alias,
      email: a.email,
      allowSend: a.allowSend ?? false,
      readonly: a.readonly ?? false,
      addedAt: new Date().toISOString(),
    };
    store.upsert(record);
    store.writeTokens(a.alias, { refresh_token: "fake-refresh" });
    fakes.set(a.alias, new FakeGmail(a.email, a.messages ?? []));
  }
  const registry = new ServiceRegistry(paths, store, (acc) => {
    const fake = fakes.get(acc.alias);
    if (!fake) throw new Error(`no fake for ${acc.alias}`);
    return fake;
  });
  const tasks = new TaskStore(paths);
  const server = createServer({ paths, store, registry, tasks });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);

  const call: Harness["call"] = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content as Array<{ type: string; text?: string }>) ?? [];
    const text = content.map((c) => c.text ?? "").join("\n");
    let json: unknown = undefined;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { text, json, isError: res.isError === true };
  };

  return {
    paths,
    store,
    registry,
    tasks,
    fakes,
    client,
    call,
    close: async () => {
      await client.close();
      await server.close();
      fs.rmSync(paths.root, { recursive: true, force: true });
    },
  };
}
