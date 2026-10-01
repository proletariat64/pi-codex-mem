import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Minimal mock ExtensionAPI for event-flow tests: records handlers and
 * registered commands, lets tests fire events with a fake ctx.
 */
export interface MockPi {
  pi: ExtensionAPI;
  handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
  commands: Map<string, { handler: (args: string, ctx: any) => unknown }>;
  tools: Map<string, ToolDefinition>;
  fire(event: string, payload: unknown, ctx?: unknown): Promise<unknown>;
}

export function makeMockPi(): MockPi {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, def: { handler: (args: string, ctx: any) => unknown }) {
      commands.set(name, def);
    },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    getActiveTools() { return [...tools.keys()]; },
    getAllTools() { return [...tools.values()]; },
    registerFlag(_name: string, _def: unknown) {},
    getFlag(_name: string) {
      return undefined;
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    handlers,
    commands,
    tools,
    async fire(event: string, payload: unknown, ctx?: unknown) {
      // Legacy fake contexts need the host method for capability probing. Explicit
      // abort spies still win; this no-op is not evidence of transport cancellation.
      const context = Object.assign({ abort: () => {}, getSystemPrompt: () => "" }, ctx);
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        const returned = await handler(payload, context);
        if (returned !== undefined) result = returned;
      }
      return result;
    },
  };
}

export const MOCK_CTX = { cwd: process.cwd(), hasUI: false };

/** Exercise request projection separately from canonical prompt options/history. */
export async function projectRequest(mock: MockPi, ctx: unknown, messages: AgentMessage[] = [
  { role: "system", content: "Foreground policy", timestamp: 0 },
  { role: "user", content: "Current task", timestamp: 1 },
]) {
  const canonical = structuredClone(messages);
  const result = await mock.fire("context_with_system", { messages }, ctx);
  assert.ok(result && typeof result === "object" && "messages" in result && Array.isArray(result.messages),
    "context_with_system returns request messages");
  const projected = result.messages as AgentMessage[];
  assert.notEqual(projected, messages, "request projection uses a fresh array");
  assert.deepEqual(messages, canonical, "canonical history remains unchanged");
  const owned = (message: AgentMessage) => message.role === "custom" && message.customType === "pi_memory";
  const carriers = projected.filter(owned);
  assert.ok(carriers.length <= 1, "at most one owned carrier per request");
  assert.deepEqual(projected.filter(message => !owned(message)), messages.filter(message => !owned(message)),
    "non-memory messages, system policy and tool pairs remain unchanged");
  const llm = convertToLlm(projected);
  const carrier = carriers[0];
  let memory: string | undefined;
  if (carrier) {
    const anchor = projected[0]?.role === "system" ? 1 : 0;
    assert.equal(projected[anchor], carrier, "carrier follows leading system, or starts headless context");
    assert.equal(carrier.role, "custom");
    if (carrier.role === "custom") {
      assert.equal(carrier.display, false);
      assert.equal(typeof carrier.content, "string");
      memory = carrier.content as string;
      assert.deepEqual(llm[anchor], { role: "user", content: [{ type: "text", text: memory }], timestamp: carrier.timestamp },
        "owned custom carrier becomes user-role historical evidence in actual convertToLlm");
    }
  }
  return { messages: projected, llm, memory };
}
