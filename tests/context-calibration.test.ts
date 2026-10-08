import { test } from "node:test";
import assert from "node:assert/strict";
import type { Usage } from "@earendil-works/pi-ai";
import {
  DEFAULT_CONTEXT_COUNTING_POLICY as DEFAULT_POLICY,
  createContextCalibrationStore,
  createContextController,
} from "../src/pipeline/context-controller.ts";
import type { Message } from "@earendil-works/pi-ai";

const writer = { provider: "fake", id: "writer", api: "openai-completions", contextWindow: 272_000, maxTokens: 8_192 };
const messages: Message[] = [{ role: "user", content: "Consolidate the workspace.", timestamp: 1 }];
const usage = (over: Partial<Usage>): Usage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...over,
});

test("provider calibration normalizes uncached, cache-read and cache-write input into one charge (CT04)", () => {
  const controller = createContextController({ model: writer });
  const observation = controller.observeResult({
    usage: usage({ input: 1_000, cacheRead: 5_000, cacheWrite: 500, output: 400 }),
    request: { method: "utf8_div4_estimate", baseEstimate: 5_000 },
  });
  assert.ok(observation);
  assert.equal(observation.observedInputTokens, 6_500, "uncached + cache-read + cache-write");
  assert.equal(observation.observedRatio, 1.3);
  assert.equal(observation.appliedMultiplier, 1.3);
  assert.equal(controller.safetyMultiplier, 1.3, "raised to at least observed/base");
  const snapshot = controller.snapshot();
  assert.deepEqual(snapshot.counting.latestObservation, observation);
  assert.equal(snapshot.counting.safetyMultiplier, 1.3);
  assert.equal(snapshot.counting.method, undefined, "no request counted through the controller yet");
});

test("multiplier increases but is never lowered within a lease (CT03/CT04)", () => {
  const controller = createContextController({ model: writer });
  assert.ok(controller.observeResult({ usage: usage({ input: 300 }), request: { method: "utf8_div4_estimate", baseEstimate: 100 } }));
  assert.equal(controller.safetyMultiplier, 3);
  const lower = controller.observeResult({ usage: usage({ input: 10 }), request: { method: "utf8_div4_estimate", baseEstimate: 100 } });
  assert.ok(lower);
  assert.equal(lower.observedRatio, 0.1, "the observation is still recorded");
  assert.equal(controller.safetyMultiplier, 3, "never lowered within the lease");
});

test("missing, zero and invalid usage leave the estimate and reservation intact (CT04)", () => {
  const controller = createContextController({ model: writer });
  const before = controller.admission({ messages });
  assert.ok(before.action !== "blocked" && before.count.method === "utf8_div4_estimate");
  for (const bad of [undefined, usage({}), usage({ input: -5 }), usage({ input: 1.5 })]) {
    assert.equal(controller.observeResult({ usage: bad, request: { method: "utf8_div4_estimate", baseEstimate: before.count.baseEstimate } }), undefined);
  }
  const after = controller.admission({ messages });
  assert.ok(after.action !== "blocked");
  assert.equal(after.admissionEstimate, before.admissionEstimate, "safety-adjusted reservation unchanged");
  assert.equal(controller.safetyMultiplier, 1.25);
});

test("an underestimated request raises the estimate so the next admission charges honestly (CT04)", () => {
  const counter = { count: () => ({ tokens: 100, identity: { provider: "other-provider", modelId: "sibling" } }) };
  const controller = createContextController({ model: writer, counter });
  const first = controller.admission({ messages: [] });
  assert.ok(first.action !== "blocked");
  assert.equal(first.admissionEstimate, 125);
  assert.ok(controller.observeResult({
    usage: usage({ input: 200, output: 50 }),
    request: { method: "tokenizer_estimate", baseEstimate: first.count.baseEstimate },
  }));
  const second = controller.admission({ messages: [] });
  assert.equal(second.action !== "blocked" ? second.admissionEstimate : 0, 200,
    "the replayed request must be admitted at a level covering the observed usage");
});

test("calibration store is reused only for the same model/transport/policy identity (CT04)", () => {
  const store = createContextCalibrationStore();
  const raised = createContextController({ model: writer, counter: { count: () => ({ tokens: 100, identity: { provider: "other", modelId: "sibling" } }) }, calibration: store });
  assert.ok(raised.observeResult({ usage: usage({ input: 300 }), request: { method: "tokenizer_estimate", baseEstimate: 100 } }));
  assert.equal(raised.safetyMultiplier, 3);
  const otherModel = createContextController({ model: { ...writer, id: "other-model" }, calibration: store });
  assert.equal(otherModel.safetyMultiplier, 1.25, "a replaced model identity does not inherit another model's calibration");
  const sameModel = createContextController({ model: writer, calibration: store });
  assert.equal(sameModel.safetyMultiplier, 3, "process-local calibration may be reused for the same identity");
  const otherPolicy = createContextController({
    model: writer,
    policy: { ...DEFAULT_POLICY, version: 999 },
    calibration: store,
  });
  assert.equal(otherPolicy.safetyMultiplier, 1.25, "a replaced policy identity does not inherit the calibration");
});

test("exact counts record their observation but do not raise the safety multiplier (CT03)", () => {
  const controller = createContextController({ model: writer, counter: { count: () => ({ tokens: 1_000, identity: { provider: "fake", modelId: "writer", api: writer.api, policyVersion: DEFAULT_POLICY.version } }) } });
  const observation = controller.observeResult({
    usage: usage({ input: 1_050 }),
    request: { method: "tokens", baseEstimate: 1_000 },
  });
  assert.ok(observation);
  assert.equal(observation.observedRatio, 1.05);
  assert.equal(controller.safetyMultiplier, 1.25, "exact mode keeps normal protocol reserves instead of a heuristic multiplier");
  const admission = controller.admission({ messages: [] });
  assert.ok(admission.action !== "blocked");
  assert.equal(admission.admissionEstimate, 1_000);
});

test("diagnostics snapshot reports counting policy, multiplier, observation and token-valued limits (§8)", () => {
  const controller = createContextController({ model: writer });
  assert.ok(controller.observeResult({ usage: usage({ input: 1_300 }), request: { method: "utf8_div4_estimate", baseEstimate: 1_000 } }));
  controller.admission({ messages });
  const snapshot = controller.snapshot();
  assert.deepEqual(snapshot.identity, { provider: "fake", modelId: "writer", api: "openai-completions", policyVersion: DEFAULT_POLICY.version });
  assert.equal(snapshot.counting.method, "utf8_div4_estimate");
  assert.equal(snapshot.counting.policyVersion, DEFAULT_POLICY.version);
  assert.equal(snapshot.counting.safetyMultiplier, 1.3);
  assert.equal(snapshot.counting.latestObservation?.observedInputTokens, 1_300);
  assert.equal(snapshot.capacity?.window, 272_000);
  assert.equal(snapshot.capacity?.outputReserve, 4_000);
  assert.equal(snapshot.capacity?.overheadReserve, 1_024);
  assert.equal(snapshot.capacity?.softLimit, 186_883);
  assert.equal(snapshot.capacity?.hardLimit, 240_278);
  assert.equal(snapshot.capacity?.compactTarget, 133_488);
  assert.equal(snapshot.capacity.units, "tokens");
  assert.equal(snapshot.currentInputUnits, "estimated_tokens");
  assert.ok(snapshot.currentInputCount);
});