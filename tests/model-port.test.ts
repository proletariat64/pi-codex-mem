import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRegistryModelPort } from "../src/extraction/model-port.ts";

test("pi model port resolves the configured model and streams through the registry without copying credentials", async () => {
  const calls: { provider: string; modelId: string; options: Record<string, unknown>; tools: unknown[] | undefined }[] = [];
  const registry = {
    find(provider: string, id: string) {
      return provider === "fake" && id === "extract" ? {
        provider, id, contextWindow: 160_000, maxTokens: 8_000,
      } : undefined;
    },
    streamSimple(model: { provider: string; id: string }, context: { tools?: unknown[] }, options: Record<string, unknown>) {
      calls.push({ provider: model.provider, modelId: model.id, options, tools: context.tools });
      return { result: async () => ({ stopReason: "error", errorMessage: "401 unauthorized",
        content: [], usage: { input: 2, output: 0 } }) };
    },
    getApiKeyAndHeaders() { throw new Error("extensions must not retrieve credentials"); },
  } as unknown as ExtensionContext["modelRegistry"];
  const port = createRegistryModelPort(registry);
  const model = port.resolve({ provider: "fake", modelId: "extract" });
  assert.deepEqual(model, { provider: "fake", modelId: "extract", contextWindow: 160_000, maxTokens: 8_000 });
  assert.equal(port.resolve({ provider: "other", modelId: "extract" }), undefined);
  assert.ok(model);
  const result = await port.request(model, { systemPrompt: "system", messages: [], tools: [] },
    { signal: new AbortController().signal, maxTokens: 6_000, timeoutMs: 120_000, toolChoice: "none" });
  assert.equal(result.stopReason, "error", "fulfilled stream result is not success");
  assert.equal(result.errorMessage, "401 unauthorized");
  assert.deepEqual(result.usage, { input: 2, output: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options.apiKey, undefined);
  assert.equal(calls[0]?.options.toolChoice, "none");
  assert.deepEqual(calls[0]?.tools, []);
});
