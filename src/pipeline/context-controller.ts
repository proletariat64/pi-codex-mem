import type { Message } from "@earendil-works/pi-ai";
import { normalizeModelUsage } from "../model-usage.ts";

/** Phase 2 context counting/control, spec docs/spec/consolidation-context-spec-v0.2.0.md §3 and §8. */

export const CONTEXT_COUNTING_POLICY_VERSION = 1;

/** Units are always explicit: exact provider tokens or estimated token units. */
export type TokenUnits = "tokens" | "estimated_tokens";
export type CountingMethod = "tokens" | "tokenizer_estimate" | "utf8_div4_estimate";

export interface ContextCountingPolicy {
  version: number;
  /** Fallback safety multiplier until a trustworthy provider observation raises it (spec §3.2). */
  safetyMultiplier: number;
  /** H: reserved transport/unknown framing headroom in tokens, not a counted item copy (spec §3.3). */
  overheadReserve: number;
  /** Output reserve cap: O = min(outputReserve, model.maxTokens) (spec §3.3). */
  outputReserve: number;
  softLimitRatio: number;
  hardLimitRatio: number;
  compactTargetRatio: number;
  /** Explicit framing estimates added once per message/tool item in fallback mode (spec §3.2). */
  messageFramingTokens: number;
  toolCallFramingTokens: number;
  toolResultFramingTokens: number;
  toolDeclarationFramingTokens: number;
}

export const DEFAULT_CONTEXT_COUNTING_POLICY: ContextCountingPolicy = {
  version: CONTEXT_COUNTING_POLICY_VERSION,
  safetyMultiplier: 1.25,
  overheadReserve: 1_024,
  outputReserve: 4_000,
  softLimitRatio: 0.7,
  hardLimitRatio: 0.9,
  compactTargetRatio: 0.5,
  messageFramingTokens: 4,
  toolCallFramingTokens: 4,
  toolResultFramingTokens: 8,
  toolDeclarationFramingTokens: 8,
};

/** Resolved capacity in tokens (never bytes), spec §3.3. */
export interface ResolvedModelCapacity {
  /** W: resolved model input-plus-output context window. */
  window: number;
  /** O = min(policy.outputReserve, model.maxTokens). */
  outputReserve: number;
  /** H: additional transport/unknown framing headroom. */
  overheadReserve: number;
  /** I = W - O - H. */
  inputLimit: number;
  softLimit: number;
  hardLimit: number;
  compactTarget: number;
  units: "tokens";
}

export interface CapacityInput {
  contextWindow: number;
  maxTokens: number;
}

export type CapacityResult =
  | { ok: true; capacity: ResolvedModelCapacity }
  | { ok: false; reason: "capacity_invalid"; field: "contextWindow" | "maxTokens" | "inputLimit" };

/** Validate the resolved capacity and derive limits per spec §3.3. Rejects missing,
 * non-finite, non-integral or non-positive values and non-positive input limits. */
export function deriveModelCapacity(
  model: CapacityInput | undefined,
  policy: ContextCountingPolicy = DEFAULT_CONTEXT_COUNTING_POLICY,
): CapacityResult {
  const positiveInteger = (value: number | undefined): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (!positiveInteger(model?.contextWindow)) return { ok: false, reason: "capacity_invalid", field: "contextWindow" };
  if (!positiveInteger(model?.maxTokens)) return { ok: false, reason: "capacity_invalid", field: "maxTokens" };
  const outputReserve = Math.min(policy.outputReserve, model.maxTokens);
  const overheadReserve = policy.overheadReserve;
  const inputLimit = model.contextWindow - outputReserve - overheadReserve;
  if (!positiveInteger(inputLimit)) return { ok: false, reason: "capacity_invalid", field: "inputLimit" };
  return {
    ok: true,
    capacity: {
      window: model.contextWindow,
      outputReserve,
      overheadReserve,
      inputLimit,
      softLimit: Math.floor(inputLimit * policy.softLimitRatio),
      hardLimit: Math.floor(inputLimit * policy.hardLimitRatio),
      compactTarget: Math.floor(inputLimit * policy.compactTargetRatio),
      units: "tokens",
    },
  };
}