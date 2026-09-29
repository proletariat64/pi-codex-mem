import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDb } from "../src/store/db.ts";
import { reconcileModelCall, reserveModelCall } from "../src/store/jobs.ts";
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

test("pi model port counts cached read and write once in total input budget units", async (t) => {
  const registry = { find: () => ({ provider: "mock", id: "cached", contextWindow: 160_000, maxTokens: 8_000 }),
    streamSimple: () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "{}" }],
      usage: { input: 100, output: 20, cacheRead: 8_000, cacheWrite: 1_900, cacheWrite1h: 200,
        totalTokens: 10_020 } }) }),
  } as unknown as ExtensionContext["modelRegistry"];
  const port = createRegistryModelPort(registry);
  const model = port.resolve({ provider: "mock", modelId: "cached" }); assert.ok(model);
  const result = await port.request(model, { systemPrompt: "system", messages: [], tools: [] },
    { signal: new AbortController().signal, maxTokens: 6_000, timeoutMs: 120_000, toolChoice: "none" });
  assert.deepEqual(result.usage, { input: 10_000, output: 20 });
  const root = mkdtempSync(join(tmpdir(), "pi-cached-budget-"));
  const db = openStateDb(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const request = { now: Date.UTC(2026, 8, 29), timezone: "UTC", provider: "mock", model: "cached",
    estimate: { input: 10_000, output: 100 }, limits: { input: 15_000, output: 1_000, requests: 2 } };
  assert.deepEqual(reserveModelCall(db, { ...request, id: "first" }), { ok: true });
  reconcileModelCall(db, "first", result.usage);
  assert.equal(db.prepare("SELECT actual_input FROM budget_usage").get()!.actual_input, 10_000);
  assert.deepEqual(reserveModelCall(db, { ...request, id: "second" }), { ok: false, reason: "input_budget" });
});
