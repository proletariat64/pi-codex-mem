import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MemoryVersion } from "../config.ts";
import {
  hasUnsafeMemoryResidue,
  projectMemoryMessages,
  providerHasLegacyResidue,
  removeProviderCarrier,
  requestCapacity,
} from "./projection.ts";
import { MemoryRunReader } from "./run.ts";
import type { MemoryConsumer } from "./tools.ts";
import type { MemoryReadPin, ReadValidation, PinAcquisition } from "./evidence.ts";
export type { PinAcquisition } from "./evidence.ts";
import type { ForegroundDiagnostic } from "./carrier.ts";

/** Opaque timer handle owned by the caller's timer implementation. */
export type ForegroundTimerHandle = object;

/** Timer seam: production uses real timeouts; tests drive callbacks deterministically. */
export interface ForegroundTimer {
  schedule(callback: () => void, ms: number): ForegroundTimerHandle;
  cancel(handle: ForegroundTimerHandle): void;
}

const realTimer: ForegroundTimer = {
  schedule: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  cancel: handle => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Host facts and operations, sampled at every checkpoint by the caller.
 * The module never sees the extension context or mutable extension state.
 */
export interface ForegroundMemoryHost {
  /** Acquire a read pin for the explicit version; must not mutate any reader. */
  acquirePin(version: MemoryVersion): PinAcquisition;
  /** Re-sample configuration, store access and read policy for this cwd. */
  sampleEligibility(cwd: string): boolean;
  /** Revalidate the read pin against freshly sampled store facts. */
  validatePin(pin: MemoryReadPin): ReadValidation;
  /** Side effect after a retention-timer invalidation (background consolidation nudge). */
  onTimerInvalidated?: () => void;
  now?: () => number;
  timer?: ForegroundTimer;
}

export interface BeginRunInput {
  consumerSession: string;
  runId: string;
  prompt: string | null;
  promptOptions: { forceSystemPrompt?: unknown } | null;
  cwd: string;
  version: MemoryVersion | null;
  /** Host compatibility and configuration both allow reading during this run. */
  readingAvailable: boolean;
}

export interface PrepareRequestInput {
  messages: AgentMessage[];
  cwd: string;
  contextWindow: number | undefined;
  maxTokens: number | undefined;
  abort: () => void;
}

export interface AdmitDispatchInput {
  payload: unknown;
  cwd: string;
  contextWindow: number | undefined;
  maxTokens: number | undefined;
  abort: () => void;
}

/**
 * Provider payload returned to the host for direct replacement. The module
 * never inspects it beyond the projection helpers; the host boundary owns
 * the field schemas. undefined means no replacement.
 */
export interface DispatchReplacement { [key: string]: unknown }

export interface ToolCallInput<T> {
  /** The host re-checked compatibility, configuration, store access and read policy. */
  preadmitted: boolean;
  cwd: string;
  execute: () => Promise<T>;
  unavailable: () => T;
  isIntegrityError: (output: T) => boolean;
}

/**
 * Owns the complete foreground-run memory lifecycle: read pin, rendered cache,
 * retention timer, single recovery, projected identity and dispatch fencing.
 * Callers fire event-intent entry points with freshly sampled host facts; they
 * never coordinate pin, cache or timer state themselves.
 */
export class ForegroundMemory {
  private readonly host: ForegroundMemoryHost;
  private readonly reader = new MemoryRunReader();
  private consumer: MemoryConsumer | null = null;
  private prompt: string | null = null;
  private promptOptions: { forceSystemPrompt?: unknown } | null = null;
  // Only dispatch-fence identity and fingerprints survive revocation; no evidence body/view.
  private projectedIdentity: string | null = null;
  private readonly projectedFingerprints = new Set<string>();
  private retentionTimer: ForegroundTimerHandle | null = null;
  private diagnosticText: string | null = null;
  private readonly timer: ForegroundTimer;
  private readonly now: () => number;

  constructor(host: ForegroundMemoryHost) {
    this.host = host;
    this.timer = host.timer ?? realTimer;
    this.now = host.now ?? (() => Date.now());
  }

  // Narrow read-only inspection for memory tools, note provenance, doctor/status
  // and generation-cleanup pinning.
  get pin(): MemoryReadPin | null { return this.reader.pin; }
  get pinnedGenerationIds(): string[] { return this.reader.pin ? [this.reader.pin.generationId] : []; }
  get activeConsumer(): MemoryConsumer | null { return this.consumer; }
  get runPrompt(): string | null { return this.prompt; }
  get diagnostic(): ForegroundDiagnostic & { warningCounts: Record<string, number> } { return this.reader.diagnostic; }
  get readDiagnostic(): string | null { return this.diagnosticText; }

  /** before_agent_start: begin a fixed-version run, then acquire a pin and arm retention. */
  beginRun(input: BeginRunInput): void {
    this.consumer = { consumerSession: input.consumerSession, runId: input.runId };
    this.prompt = input.prompt;
    this.promptOptions = input.promptOptions;
    this.reader.begin(input.version, input.cwd);
    this.projectedIdentity = null; this.projectedFingerprints.clear();
    this.diagnosticText = null;
    this.cancelRetention();
    if (!input.readingAvailable) { this.invalidate("reading_unavailable"); return; }
    if (!this.eligible(input.cwd)) { this.invalidate("read_disabled"); return; }
    this.reader.pin = this.acquire();
    if (this.reader.pin) this.reader.report("disabled", "prepared");
    this.armRetention();
  }

  /** agent_settled: release all run state, including prompt metadata. */
  settle(): void {
    this.reader.release();
    this.projectedIdentity = null; this.projectedFingerprints.clear();
    this.cancelRetention();
    this.consumer = null; this.promptOptions = null;
    this.prompt = null;
  }

  /** session_start/session_shutdown: drop the run; optionally record a final invalidation. */
  resetSession(invalidateReason?: string): void {
    this.reader.release();
    this.projectedIdentity = null; this.projectedFingerprints.clear();
    this.cancelRetention();
    this.consumer = null; this.promptOptions = null;
    if (invalidateReason) this.invalidate(invalidateReason);
  }

  /** session_tree: the consumer grant ends, but dispatch-fence identity must survive
   * so a previously projected payload can still be suppressed. */
  sessionReplaced(): void {
    this.invalidate("session_replaced");
    this.consumer = null; this.promptOptions = null;
  }

  /** A correct note revokes current evidence synchronously. */
  noteCorrected(): void {
    this.invalidate("user_correction");
  }

  /** /memory clear revokes everything and ends the consumer grant. */
  storeCleared(): void {
    this.invalidate("user_clear");
    this.consumer = null; this.promptOptions = null;
  }

  /** context_with_system: project at most one validated carrier into a fresh request array. */
  prepareRequest(input: PrepareRequestInput): { messages: AgentMessage[] } {
    const messages = projectMemoryMessages(input.messages, null);
    if (hasUnsafeMemoryResidue(messages) ||
        providerHasLegacyResidue({ instructions: this.promptOptions?.forceSystemPrompt })) {
      this.abortUnsafe(input.abort, "unsafe_owned_residue");
      return { messages };
    }
    this.projectedIdentity = null; this.projectedFingerprints.clear();
    if (!this.consumer || !this.validate(input.cwd)) return { messages };
    const pin = this.reader.pin;
    if (!pin) return { messages };
    const capacity = requestCapacity(messages, input.contextWindow, input.maxTokens);
    const key = JSON.stringify([pin.identity, this.reader.cwd, capacity, "utf8-upper-v1", "read-guidance-v1"]);
    const rendered = this.reader.cache?.key === key ? this.reader.cache
      : pin.renderCarrier(input.cwd, { capacity });
    this.reader.cache = { key, ...rendered };
    if (!this.validate(input.cwd, false)) return { messages };
    if (rendered.text === null) {
      this.reader.report("disabled", rendered.reason, { representation: "omitted", counting: rendered.counting });
      return { messages };
    }
    this.projectedIdentity = pin.identity;
    this.projectedFingerprints.add(createHash("sha256").update(rendered.text).digest("hex"));
    this.reader.report("active", rendered.reason, { memoryVersion: pin.memoryVersion,
      generationId: pin.generationId, representation: rendered.representation, counting: rendered.counting });
    return { messages: projectMemoryMessages(messages, rendered.text) };
  }

  /** before_provider_request: admit, strip the owned carrier, or fail closed.
   * Returns the replacement payload directly; undefined means no replacement. */
  admitDispatch(input: AdmitDispatchInput): DispatchReplacement | undefined {
    if (providerHasLegacyResidue(input.payload)) {
      this.abortUnsafe(input.abort, "unsafe_owned_residue");
      return undefined;
    }
    const identity = this.projectedIdentity;
    if (!identity) return undefined;
    const valid = this.validate(input.cwd, false) && this.reader.pin !== null &&
      this.reader.pin.identity === identity;
    const payload = input.payload as { max_tokens?: number; max_output_tokens?: number;
      max_completion_tokens?: number } | null;
    const output = Math.max(input.maxTokens ?? Infinity,
      payload?.max_tokens ?? payload?.max_output_tokens ?? payload?.max_completion_tokens ?? 0);
    let serializedBytes = Infinity;
    try { serializedBytes = Buffer.byteLength(JSON.stringify(input.payload), "utf8") + 1024; }
    catch { /* Unknown effective input fails closed. */ }
    const fits = Number.isFinite(input.contextWindow) && serializedBytes + output <= input.contextWindow!;
    if (valid && fits) return undefined; // dispatch admission: bytes after this boundary cannot be recalled
    const removed = removeProviderCarrier(input.payload, this.projectedFingerprints);
    if (!removed.safe) {
      this.abortUnsafe(input.abort, "unsafe_provider_residue");
      return undefined;
    }
    this.projectedIdentity = null; this.projectedFingerprints.clear();
    if (valid) this.reader.report("disabled", "context_budget",
      { representation: "omitted", counting: "utf8_upper_estimate" });
    // removeProviderCarrier only returns safe replacements for record payloads.
    return removed.payload as DispatchReplacement;
  }

  /** Memory tool admission and return: execute only while the same pin stays valid. */
  async admitToolCall<T>(input: ToolCallInput<T>): Promise<T> {
    if (this.consumer && input.preadmitted && this.validate(input.cwd)) {
      const pin = this.reader.pin;
      const output = await input.execute();
      if (this.reader.pin === pin && this.validate(input.cwd, false)) {
        if (!input.isIntegrityError(output)) return output;
        this.invalidate("tool_integrity", false, true);
      }
    }
    if (this.reader.pin) this.invalidate("read_disabled");
    return input.unavailable();
  }

  private eligible(cwd: string): boolean {
    if (!this.consumer) return false;
    if (cwd !== this.reader.cwd) return false;
    return this.host.sampleEligibility(cwd);
  }

  private acquire(): MemoryReadPin | null {
    const version = this.reader.version;
    if (!version) return null;
    const outcome = this.host.acquirePin(version);
    if (outcome.failure) {
      this.reader.report(outcome.failure.error ? "error" : "disabled", outcome.failure.reason);
    }
    return outcome.pin;
  }

  private validate(cwd: string, recover = true): boolean {
    if (!this.eligible(cwd)) { this.invalidate("read_disabled"); return false; }
    const pin = this.reader.pin;
    if (pin) {
      const validation = this.host.validatePin(pin);
      if (!validation.valid) {
        this.invalidate(validation.reason, Boolean(validation.recoverable), Boolean(validation.error));
      }
    }
    if (!this.reader.pin && recover && this.reader.recover(() => this.acquire())) this.armRetention();
    return Boolean(this.reader.pin);
  }

  private invalidate(reason: string, recoverable = false, error = false): void {
    this.cancelRetention();
    this.reader.invalidate(reason, recoverable, error);
  }

  private abortUnsafe(abort: () => void, reason: string): void {
    this.invalidate(reason, false, true);
    this.diagnosticText = `memory foreground error: ${reason}; whole run aborted`;
    abort();
  }

  private cancelRetention(): void {
    if (this.retentionTimer !== null) this.timer.cancel(this.retentionTimer);
    this.retentionTimer = null;
  }

  private armRetention(): void {
    this.cancelRetention();
    const pin = this.reader.pin;
    if (!pin || pin.retentionDeadline === null) return;
    const handle = this.timer.schedule(() => {
      // A stale or canceled callback cannot touch this or a newer run.
      if (this.retentionTimer !== handle) return;
      this.retentionTimer = null;
      if (this.reader.pin !== pin) return;
      const validation = this.host.validatePin(pin);
      if (validation.valid) { this.armRetention(); return; }
      this.invalidate(validation.reason, Boolean(validation.recoverable), Boolean(validation.error));
      this.host.onTimerInvalidated?.();
    }, Math.max(0, Math.min(2_147_483_647, pin.retentionDeadline - this.now())));
    this.retentionTimer = handle;
  }
}
