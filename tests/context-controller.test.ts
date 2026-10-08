import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONTEXT_COUNTING_POLICY,
  deriveModelCapacity,
} from "../src/pipeline/context-controller.ts";

/** Spec §3.3 worked example: the 272k-token window from spec §1.1. */
const window272k = { contextWindow: 272_000, maxTokens: 8_192 };

test("deriveModelCapacity derives token-valued W/O/H/I and soft/hard/compact limits", () => {
  const result = deriveModelCapacity(window272k);
  assert.ok(result.ok);
  const { capacity } = result;
  assert.equal(capacity.window, 272_000);
  assert.equal(capacity.outputReserve, 4_000);
  assert.equal(capacity.overheadReserve, 1_024);
  assert.equal(capacity.inputLimit, 266_976);
  assert.equal(capacity.softLimit, 186_883);
  assert.equal(capacity.hardLimit, 240_278);
  assert.equal(capacity.compactTarget, 133_488);
  assert.equal(capacity.units, "tokens");
});

test("deriveModelCapacity caps the output reserve at min(outputReserve, maxTokens)", () => {
  const result = deriveModelCapacity({ contextWindow: 100_000, maxTokens: 1_000 });
  assert.ok(result.ok);
  assert.equal(result.capacity.outputReserve, 1_000);
  assert.equal(result.capacity.inputLimit, 100_000 - 1_000 - DEFAULT_CONTEXT_COUNTING_POLICY.overheadReserve);
});

test("deriveModelCapacity rejects missing, non-finite, non-integral or non-positive capacity", () => {
  const invalid: (Parameters<typeof deriveModelCapacity>[0] | undefined)[] = [
    undefined,
    { contextWindow: NaN, maxTokens: 8_192 },
    { contextWindow: 0, maxTokens: 8_192 },
    { contextWindow: -1, maxTokens: 8_192 },
    { contextWindow: 272_000.5, maxTokens: 8_192 },
    { contextWindow: 272_000, maxTokens: NaN },
    { contextWindow: 272_000, maxTokens: 0 },
    { contextWindow: 4_600, maxTokens: 8_192 },
  ];
  for (const input of invalid) {
    const result = input === undefined ? deriveModelCapacity(input as never) : deriveModelCapacity(input);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
    assert.equal(result.reason, "capacity_invalid");
  }
});

test("deriveModelCapacity accepts a small but positive input limit", () => {
  const result = deriveModelCapacity({ contextWindow: 6_100, maxTokens: 1_000 });
  assert.ok(result.ok);
  assert.equal(result.capacity.inputLimit, 6_100 - 1_000 - 1_024);
  assert.equal(result.capacity.softLimit, Math.floor(result.capacity.inputLimit * 0.7));
});