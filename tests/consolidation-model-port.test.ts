import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { createConsolidationModelPort } from "../src/pipeline/model-port.ts";

test("consolidation model transport delegates the full transcript to the captured registry", async () => {
  const model: Model<Api> = { id: "writer", name: "Writer", api: "openai-completions", provider: "fake",
    baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 160_000, maxTokens: 8_000 };
  const stream = createAssistantMessageEventStream();
  const calls: unknown[][] = [];
  const registry = {
    find: (provider: string, id: string) => provider === "fake" && id === "writer" ? model : undefined,
    streamSimple: (...args: unknown[]) => { calls.push(args); return stream; },
    getApiKeyAndHeaders: () => { throw new Error("credential reads are forbidden"); },
  } as unknown as ExtensionContext["modelRegistry"];
  const port = createConsolidationModelPort(registry);
  assert.equal(port.resolve({ provider: "fake", modelId: "writer" }), model);
  assert.equal(port.resolve({ provider: "missing", modelId: "writer" }), undefined);
  const context = normalizeContext({ messages: [{ role: "system", content: "writer instructions", timestamp: 0 }] });
  const options = { signal: new AbortController().signal, maxTokens: 4_000, maxRetries: 0 };
  assert.equal(await port.stream(model, context, options), stream);
  assert.deepEqual(calls, [[model, context, options]]);
});
