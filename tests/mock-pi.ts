import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Minimal mock ExtensionAPI for event-flow tests: records handlers and
 * registered commands, lets tests fire events with a fake ctx.
 */
export interface MockPi {
  pi: ExtensionAPI;
  handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
  commands: Map<string, { handler: (args: string, ctx: any) => unknown }>;
  fire(event: string, payload: unknown, ctx?: unknown): Promise<void>;
}

export function makeMockPi(): MockPi {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, def: { handler: (args: string, ctx: any) => unknown }) {
      commands.set(name, def);
    },
    registerFlag(_name: string, _def: unknown) {},
    getFlag(_name: string) {
      return undefined;
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    handlers,
    commands,
    async fire(event: string, payload: unknown, ctx?: unknown) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(payload, ctx);
      }
    },
  };
}

export const MOCK_CTX = { cwd: process.cwd(), hasUI: false };
