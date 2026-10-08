import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { createConsolidationModelPort, tokenCounterForModel, type ConsolidationModelPort } from "../src/pipeline/model-port.ts";

import { createContextController, DEFAULT_CONTEXT_COUNTING_POLICY } from "../src/pipeline/context-controller.ts";

const model: Model<Api> = { id: "writer", name: "Writer", api: "openai-completions", provider: "fake",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 160_000, maxTokens: 8_000 };
const stream = createAssistantMessageEventStream();

test("consolidation model transport delegates the full transcript to the captured registry", async () => {
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

test("tokenCounterForModel exposes the port's optional matching-counter seam and defaults to none", () => {
  const registry = {
    find: () => model,
    streamSimple: () => stream,
    getApiKeyAndHeaders: () => { throw new Error("credential reads are forbidden"); },
  } as unknown as ExtensionContext["modelRegistry"];
  const plain = createConsolidationModelPort(registry);
  assert.equal(tokenCounterForModel(plain, model), undefined, "no counter is invented without a matching seam");
  const identity = { provider: "fake", modelId: "writer", api: model.api, policyVersion: DEFAULT_CONTEXT_COUNTING_POLICY.version };
  const countingPort: ConsolidationModelPort = {
    resolve: () => model,
    stream: () => stream,
    countTokens: (m, request) => request.messages.length >= 0
      ? { tokens: 42, counterIdentity: { ...identity, provider: m.provider, modelId: m.id } }
      : undefined,
  };
  const counter = tokenCounterForModel(countingPort, model);
  assert.ok(counter);
  assert.deepEqual(counter.count({ messages: [] }), { tokens: 42, identity });
  const controller = createContextController({ model, counter });
  const counted = controller.count({ messages: [] });
  assert.ok(counted.ok);
  assert.equal(counted.exact, true, "the captured port asserts the complete resolved identity");
  assert.notEqual(DEFAULT_CONTEXT_COUNTING_POLICY.version, 1, "corrected counting must invalidate old policy work and calibration");
});
