import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";

export interface ToolReply {
  isError: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  text: string;
  meta: Record<string, unknown> | undefined;
}

export interface Connected {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<ToolReply>;
  close(): Promise<void>;
}

/** The real server behind the SDK's in-memory transport: a real client, real exchanges. */
export async function connect(): Promise<Connected> {
  const server = createServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        // plain text: SDK schema error
      }
      return { isError: r.isError === true, data, text, meta: r._meta };
    },
    close: () => client.close(),
  };
}
