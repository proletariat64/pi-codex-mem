import type { Message, SystemMessage, Tool, Usage } from "@earendil-works/pi-ai";
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

/** Identity a counting result or calibration belongs to (spec §3.1–3.2). */
export interface CountingIdentity {
  provider: string;
  modelId: string;
  api: string;
  policyVersion: number;
}

/** Optional matching-counter seam: a provider adapter's tokenizer, adapted behind the model port. */
export interface MatchingTokenCounter {
  /** Count the normalized request, declaring the model/transport identity that produced the count. */
  count(request: NormalizedRequest): { tokens: number; identity: { provider: string; modelId: string; api?: string } } | undefined;
}

export interface CountOk {
  ok: true;
  method: CountingMethod;
  units: TokenUnits;
  exact: boolean;
  /** Model-visible items plus framing, counted exactly once. */
  baseEstimate: number;
}

export type CountResult = CountOk | { ok: false; reason: "unsupported_content"; kind: "image" };

type ControllerModel = {
  provider: string;
  id: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
};

export interface AdmissionOk {
  action: "admit" | "compact";
  mode: "ordinary" | "compaction";
  /** True when the count exceeded the hard limit: no ordinary transport may be sent (spec §3.3). */
  atOrAboveHardLimit: boolean;
  count: CountOk;
  /** Raw model-visible count before the safety multiplier (see admissionEstimate). */
  capacity: ResolvedModelCapacity;
  /** ceil(baseEstimate * safetyMultiplier), or exact tokens; the value reserved for transport. */
  admissionEstimate: number;
  estimateUnits: TokenUnits;
}

export type AdmissionDecision =
  | AdmissionOk
  | { action: "blocked"; reason: "context_capacity_unavailable" | "unsupported_content" | "compaction_input_oversized";
    count?: CountOk; capacity?: ResolvedModelCapacity; admissionEstimate?: number; estimateUnits?: TokenUnits };

/** Shared Phase 2 context controller behind the model-port seam (spec §3).
 * Calibration and multiplier state are per model/transport/policy identity. */
export interface RequestContextController {
  readonly identity: CountingIdentity;
  readonly policy: ContextCountingPolicy;
  readonly capacity: CapacityResult;
  /** Current safety multiplier applied to estimated counts. Never lowered within a lease. */
  readonly safetyMultiplier: number;
  count(request: NormalizedRequest): CountResult;
  /** Admission check on the complete request immediately before transport (spec §3.3). */
  admission(request: NormalizedRequest, options?: { mode?: "ordinary" | "compaction" }): AdmissionDecision;
  /** Calibrate with the usage of one completed, trustworthy request (spec §3.2).
   * Returns undefined when usage is missing, zero or invalid; the reservation stays intact. */
  observeResult(observation: { usage: Usage | undefined; request: { method: CountingMethod; baseEstimate: number } }): CalibratedObservation | undefined;
  /** §7.2 bounded provider-overflow recovery: raise the fallback safety multiplier
   * for estimated modes to at least `minimum`; never lowered within a lease. */
  raiseSafetyMultiplierTo(minimum: number): number;
  snapshot(): ContextDiagnostics;
}

/** Latest trustworthy provider observation associated with one sent request (spec §3.2, §8). */
export interface CalibratedObservation {
  /** Normalized provider input usage: uncached + cache-read + cache-write tokens. */
  observedInputTokens: number;
  /** The sent request's counted base estimate. */
  requestBaseEstimate: number;
  /** observedInputTokens / requestBaseEstimate. */
  observedRatio: number;
  /** Safety multiplier after applying this observation. */
  appliedMultiplier: number;
  units: "tokens";
}

/** §8 diagnostics state: no bodies, only units, policy, multiplier and limits. */
export interface ContextDiagnostics {
  identity: CountingIdentity;
  counting: {
    /** Method of the most recent counted request. */
    method: CountingMethod | undefined;
    policyVersion: number;
    safetyMultiplier: number;
    latestObservation: CalibratedObservation | undefined;
  };
  capacity: ResolvedModelCapacity | undefined;
  currentInputCount: number | undefined;
  currentInputUnits: TokenUnits | undefined;
}

/** Process-local calibration state for one model/transport/policy identity (spec §3.2). */
export interface CalibrationEntry {
  multiplier: number;
  latest: CalibratedObservation | undefined;
}

export interface ContextCalibrationStore {
  get(identity: CountingIdentity): CalibrationEntry | undefined;
  set(identity: CountingIdentity, entry: CalibrationEntry): void;
}

/** Create a store of per-identity calibrations. Reuse is confined to identical identities. */
export function createContextCalibrationStore(): ContextCalibrationStore {
  const entries = new Map<string, CalibrationEntry>();
  const key = (identity: CountingIdentity) =>
    JSON.stringify([identity.provider, identity.modelId, identity.api, identity.policyVersion]);
  return {
    get: (identity) => entries.get(key(identity)),
    set: (identity, entry) => { entries.set(key(identity), entry); },
  };
}

function countIdentity(model: ControllerModel, policy: ContextCountingPolicy, counter: MatchingTokenCounter | undefined,
  request: NormalizedRequest): { ok: true; count: CountOk } | { ok: false; reason: "unsupported_content"; kind: "image" } {
  const fallback = countModelVisibleRequest(request, policy);
  if (!fallback.ok) return fallback;
  const counted = counter?.count(request);
  if (counted && Number.isSafeInteger(counted.tokens) && counted.tokens > 0) {
    const { provider, modelId, api } = counted.identity;
    const matches = provider === model.provider && modelId === model.id
      && (api === undefined || api === model.api);
    if (matches) return { ok: true, count: { ok: true, method: "tokens", units: "tokens", exact: true, baseEstimate: counted.tokens } };
    // A tokenizer for a vaguely related model is an estimate, not exact (spec §3.1).
    return { ok: true, count: { ok: true, method: "tokenizer_estimate", units: "estimated_tokens", exact: false, baseEstimate: counted.tokens } };
  }
  return { ok: true, count: fallback };
}

export function createContextController(init: {
  model: ControllerModel;
  counter?: MatchingTokenCounter;
  policy?: ContextCountingPolicy;
  /** Process-local calibration store; recycled only for identical identities. */
  calibration?: ContextCalibrationStore;
}): RequestContextController {
  const policy = init.policy ?? DEFAULT_CONTEXT_COUNTING_POLICY;
  const identity: CountingIdentity = {
    provider: init.model.provider, modelId: init.model.id, api: init.model.api, policyVersion: policy.version,
  };
  const capacity = deriveModelCapacity({ contextWindow: init.model.contextWindow, maxTokens: init.model.maxTokens }, policy);
  const calibration = init.calibration ?? createContextCalibrationStore();
  let safetyMultiplier = calibration.get(identity)?.multiplier ?? policy.safetyMultiplier;
  let lastCount: CountOk | undefined;
  let latestObservation = calibration.get(identity)?.latest;
  return {
    identity,
    policy,
    capacity,
    get safetyMultiplier() { return safetyMultiplier; },
    count: (request) => {
      const result = countIdentity(init.model, policy, init.counter, request);
      if (result.ok) lastCount = result.count;
      return result.ok ? result.count : result;
    },
    admission: (request, options) => {
      const mode = options?.mode ?? "ordinary";
      if (!capacity.ok) return { action: "blocked", reason: "context_capacity_unavailable" };
      const counted = countIdentity(init.model, policy, init.counter, request);
      if (counted.ok) lastCount = counted.count;
      if (!counted.ok) return { action: "blocked", reason: "unsupported_content" };
      const { count } = counted;
      const admissionEstimate = count.exact ? count.baseEstimate : Math.ceil(count.baseEstimate * safetyMultiplier);
      const estimateUnits = count.units;
      const capped = capacity.capacity;
      if (mode === "compaction") {
        if (admissionEstimate > capped.hardLimit) {
          return { action: "blocked", reason: "compaction_input_oversized", count, capacity: capped,
            admissionEstimate, estimateUnits };
        }
        return { action: "admit", mode, atOrAboveHardLimit: admissionEstimate === capped.hardLimit,
          count, capacity: capped, admissionEstimate, estimateUnits };
      }
      if (admissionEstimate > capped.hardLimit) {
        return { action: "compact", mode, atOrAboveHardLimit: true, count, capacity: capped,
          admissionEstimate, estimateUnits };
      }
      if (admissionEstimate > capped.softLimit) {
        return { action: "compact", mode, atOrAboveHardLimit: false, count, capacity: capped,
          admissionEstimate, estimateUnits };
      }
      return { action: "admit", mode, atOrAboveHardLimit: false, count, capacity: capped,
        admissionEstimate, estimateUnits };
    },
    observeResult: ({ usage, request }) => {
      const normalized = normalizeModelUsage(usage);
      if (!normalized || normalized.input <= 0 || !(request.baseEstimate > 0)) return undefined;
      // Normalize input as uncached + cache-read + cache-write; output is not request-input usage.
      const observedRatio = normalized.input / request.baseEstimate;
      const observation: CalibratedObservation = {
        observedInputTokens: normalized.input,
        requestBaseEstimate: request.baseEstimate,
        observedRatio,
        appliedMultiplier: safetyMultiplier,
        units: "tokens",
      };
      if (request.method !== "tokens") {
        if (observedRatio > safetyMultiplier) {
          // Raise to at least observedInput / requestBaseEstimate; never lower within a lease.
          safetyMultiplier = observedRatio;
          observation.appliedMultiplier = safetyMultiplier;
        }
        calibration.set(identity, { multiplier: safetyMultiplier, latest: observation });
      }
      latestObservation = observation;
      return observation;
    },
    raiseSafetyMultiplierTo: (minimum) => {
      if (Number.isFinite(minimum) && minimum > safetyMultiplier) {
        safetyMultiplier = minimum;
        calibration.set(identity, { multiplier: safetyMultiplier, latest: latestObservation });
      }
      return safetyMultiplier;
    },
    snapshot: () => ({
      identity,
      counting: {
        method: lastCount?.method,
        policyVersion: policy.version,
        safetyMultiplier,
        latestObservation,
      },
      capacity: capacity.ok ? capacity.capacity : undefined,
      currentInputCount: lastCount?.baseEstimate,
      currentInputUnits: lastCount?.units,
    }),
  };
}

/** The normalized provider-visible request: transcript messages only (never host envelopes). */
export interface NormalizedRequest {
  messages: readonly Message[];
}

const div4 = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 4);

function systemText(message: SystemMessage): string {
  const parts: string[] = [];
  if (typeof message.content === "string") parts.push(message.content);
  else for (const block of message.content) parts.push(block.type === "text" ? block.text : "");
  for (const [name, value] of Object.entries(message.sections ?? {})) {
    parts.push(name);
    if (value !== null) parts.push(value);
  }
  return parts.join("\n");
}

/** Replay declarations and removals to the final effective set; count each once (spec §3.1). */
function effectiveTools(messages: readonly Message[]): Tool[] {
  const effective = new Map<string, Tool>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) effective.set(tool.name, tool);
    for (const removed of message.toolsRemoved ?? []) effective.delete(removed.name);
  }
  return [...effective.values()];
}

function countTextBlocks(blocks: readonly { type: "text" | "image"; text?: string }[]):
  { ok: true; units: number } | { ok: false } {
  let units = 0;
  for (const block of blocks) {
    if (block.type === "image") return { ok: false };
    units += div4(block.text ?? "");
  }
  return { ok: true, units };
}

/** Count the normalized model-visible request with the utf8_div4 fallback (spec §3.1–3.2).
 * Host-only metadata, IDs and host serialization envelopes are not model-visible text. */
export function countModelVisibleRequest(
  request: NormalizedRequest,
  policy: ContextCountingPolicy = DEFAULT_CONTEXT_COUNTING_POLICY,
): CountResult {
  let baseEstimate = 0;
  for (const message of request.messages) {
    if (message.role === "system") {
      baseEstimate += div4(systemText(message)) + policy.messageFramingTokens;
    } else if (message.role === "user") {
      if (typeof message.content === "string") {
        baseEstimate += div4(message.content) + policy.messageFramingTokens;
      } else {
        const text = countTextBlocks(message.content);
        if (!text.ok) return { ok: false, reason: "unsupported_content", kind: "image" };
        baseEstimate += text.units + policy.messageFramingTokens;
      }
    } else if (message.role === "assistant") {
      baseEstimate += policy.messageFramingTokens;
      for (const block of message.content) {
        if (block.type === "text") baseEstimate += div4(block.text);
        else if (block.type === "thinking") baseEstimate += div4(block.thinking);
        else if (block.type === "toolCall") {
          baseEstimate += div4(block.name) + div4(JSON.stringify(block.arguments)) + policy.toolCallFramingTokens;
        }
      }
    } else {
      baseEstimate += policy.toolResultFramingTokens + div4(message.toolName);
      const text = countTextBlocks(message.content);
      if (!text.ok) return { ok: false, reason: "unsupported_content", kind: "image" };
      baseEstimate += text.units + (message.details === undefined ? 0 : div4(JSON.stringify(message.details)));
    }
  }
  for (const tool of effectiveTools(request.messages)) {
    baseEstimate += policy.toolDeclarationFramingTokens + div4(tool.name) + div4(tool.description)
      + div4(JSON.stringify(tool.parameters));
  }
  return { ok: true, method: "utf8_div4_estimate", units: "estimated_tokens", exact: false, baseEstimate };
}

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