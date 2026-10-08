import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import type { MemoryConfig, MemoryVersion, ModelRef } from "../config.ts";
import { truncateUtf8 } from "../snapshot.ts";
import { redactSensitive } from "../sensitive.ts";
import { normalizeModelUsage } from "../model-usage.ts";
import { reconcileModelCall, reserveModelCall } from "../store/jobs.ts";
import { renewConsolidationLease, type ConsolidationLease } from "../store/consolidation.ts";
import { createWorkspaceTools } from "./workspace-tools.ts";
import { tokenCounterForModel, type ConsolidationModelPort } from "./model-port.ts";
import {
  createContextCalibrationStore, createContextController,
  type ContextCalibrationStore, type CountOk,
} from "./context-controller.ts";
import { ArtifactFormatError } from "./artifacts.ts";

export interface ConsolidationRunInput {
  db: DatabaseSync;
  directory: string;
  lease: ConsolidationLease;
  modelRef: ModelRef;
  port: ConsolidationModelPort;
  config: MemoryConfig;
  signal: AbortSignal;
  clock?: () => number;
  canStartRequest?: () => "ready" | "foreground_active" | "configuration_changed";
  /** Observe transport attempts for unspent-lease deferral accounting. */
  onRequestStarted?: () => void;
  /** ArtifactFormatError permits one repair; other failures are host-integrity errors. */
  validateOutputs?: () => void;
  /** Process-local calibration store shared per model/transport/policy identity (spec §3.2). */
  contextCalibration?: ContextCalibrationStore;
}

export interface ConsolidationRunResult {
  status: "succeeded" | "blocked" | "retry_wait" | "cancelled" | "budget_deferred" | "paused";
  reason?: string;
  retryAfterMs?: number;
}

const MAX_CALLS = 12;
const MAX_TOOLS = 40;
const TOTAL_TIMEOUT_MS = 300_000;
const OUTPUT_TOKENS = 4_000;
const writerTemplate = (version: MemoryVersion) => readFileSync(new URL(`../../prompts/upstream/${version}/${version === "v1" ? "consolidation.md" : "consolidation_v2.md"}`, import.meta.url), "utf8");
const adaptation = (version: MemoryVersion) => readFileSync(new URL(`../../prompts/pi/${version}/consolidation-boundaries.md`, import.meta.url), "utf8");

/** All writer instructions and boundary semantics participate in the dirty check. */
export function consolidationPromptHash(config: MemoryConfig, version: MemoryVersion = "v1"): string {
  return createHash("sha256").update(writerTemplate(version)).update("\n").update(adaptation(version)).update(JSON.stringify({
    schemaVersion: 1, rendererVersion: 2, memoryVersion: version, summaryBytes: Math.min(9999, config.limits.summaryBytes),
    toolResponseBytes: config.limits.toolResponseBytes, maxCalls: MAX_CALLS, maxTools: MAX_TOOLS,
    timeoutMs: TOTAL_TIMEOUT_MS, outputTokens: OUTPUT_TOKENS,
    outputAllowlist: version === "v1" ? ["MEMORY.md", "memory_summary.md", "skills/<slug>/SKILL.md"] : ["memory_summary.md"],
    toolExecution: "sequential", contextByteRatio: 0.7, contextOverhead: 1_024,
    maxValidationRepairs: 1, validationDiagnosticBytes: 512, artifactPolicyVersion: 3,
  })).digest("hex");
}

function renderWriter(config: MemoryConfig, version: MemoryVersion): string {
  return writerTemplate(version)
    .replaceAll("{{ memory_root }}", ".")
    .replaceAll("{{ phase2_workspace_diff_file }}", "phase2_workspace_diff.md")
    .replaceAll("{{ memory_extensions_folder_structure }}", "- notes/<note-id>.md: host-staged read-only shared user-note snapshot")
    .replaceAll("{{ memory_extensions_primary_inputs }}", "- `notes/*.md`: read-only shared active user notes; cite explicit note IDs")
    .replaceAll("thread_id=", "session_key=").replaceAll("source thread identifier", "pi session identifier") +
    "\n\n" + adaptation(version) + `\nSummary length target: ${config.limits.summaryBytes} UTF-8 bytes (guidance, not an extra validation cap).\n`;
}

/** Cross-run calibration state, process-local and identity-confined (spec §3.2). */
const writerCalibration = createContextCalibrationStore();

/** §7.2: explicit provider context-overflow markers only. A generic 400, timeout
 * or malformed response is never inferred as a recoverable context overflow. */
function isProviderContextOverflow(message: string | undefined): boolean {
  const text = message ?? "";
  if (!text) return false;
  return /maximum context length/i.test(text)
    || /prompt is too long/i.test(text)
    || /context (?:window|length|size)[^.]{0,80}?(?:exceed\w*|too (?:long|large)|larger\b)/i.test(text)
    || /input token count .{0,60}?exceeds/i.test(text)
    || /exceeds (?:the )?maximum (?:number of )?(?:input )?tokens/i.test(text);
}

/** A settled conversational unit to compact exists only with assistant history to
 * summarize (spec §5.1–5.2); host framing alone is irreducible. */
function hasCompactableHistory(messages: readonly Message[]): boolean {
  return messages.some((message) => message.role === "assistant" || message.role === "toolResult");
}

function providerFailure(message: string | undefined): ConsolidationRunResult {
  if (/\b(?:401|403|unauthorized|authentication|invalid.api.key|model.not.found)\b/i.test(message ?? "")) {
    return { status: "blocked", reason: "auth_or_model" };
  }
  const match = /\bretry[- ]after\s*[:=]?\s*(\d{1,8})\s*(ms|milliseconds?|s|seconds?|m|minutes?)?\b/i.exec(message ?? "");
  const result: ConsolidationRunResult = { status: "retry_wait", reason: "provider_error" };
  if (match) {
    const unit = match[2]?.toLowerCase() ?? "s";
    const multiplier = unit.startsWith("ms") || unit.startsWith("millisecond") ? 1
      : unit === "m" || unit.startsWith("minute") ? 60_000 : 1_000;
    result.retryAfterMs = Math.min(2_147_483_647, Number(match[1]) * multiplier);
  }
  return result;
}

function usableUsage(message: AssistantMessage): { input: number; output: number } | undefined {
  const usage = normalizeModelUsage(message.usage);
  return usage && (usage.input > 0 || usage.output > 0) ? usage : undefined;
}

function failureMessage(model: Model<Api>, clock: () => number, aborted: boolean, reason: string): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], stopReason: aborted ? "aborted" : "error", errorMessage: reason, timestamp: clock(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

/** Confined in-memory Agent. A completed writer is still unpublished until host validation/CAS. */
export async function runConsolidation(input: ConsolidationRunInput): Promise<ConsolidationRunResult> {
  const clock = input.clock ?? Date.now;
  const version = input.lease.memoryVersion;
  if (input.signal.aborted) return { status: "cancelled", reason: "aborted" };
  if (input.lease.promptHash !== consolidationPromptHash(input.config, version)) return { status: "blocked", reason: "prompt_changed" };
  const model = input.port.resolve(input.modelRef);
  if (!model) return { status: "blocked", reason: "model_not_found" };
  const maxTokens = Math.min(OUTPUT_TOKENS, model.maxTokens);
  const contextController = createContextController({
    model: { provider: model.provider, id: model.id, api: model.api,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens },
    counter: tokenCounterForModel(input.port, model),
    calibration: input.contextCalibration ?? writerCalibration,
  });
  if (!contextController.capacity.ok) return { status: "blocked", reason: "context_capacity_unavailable" };
  const startedAt = clock();
  const controller = new AbortController();
  let result: ConsolidationRunResult | undefined;
  let calls = 0;
  let tools = 0;
  let repairs = 0;
  let overflowRecoveryUsed = false;
  let agent: Agent | undefined;
  const pendingReservations = new Set<string>();
  const charge = (id: string, usage?: { input: number; output: number }) => {
    if (!pendingReservations.delete(id)) return;
    try { reconcileModelCall(input.db, id, usage); }
    catch {
      // The durable reservation remains conservative if reconciliation fails.
      // Never throw from an abort listener or accept publication after losing the budget store.
      result ??= { status: "blocked", reason: "budget_store_unavailable" };
    }
  };
  const halt = (next: ConsolidationRunResult) => { result ??= next; };
  /** §5 compaction lifecycle lands with #55; this seam stops ordinary writer work
   * at the settled request boundary without resending the unchanged payload. */
  const attemptCompaction = (): "compacted" | "unavailable" => "unavailable";
  /** §7.2 bounded provider-overflow recovery: account honestly, at most one in-lease
   * multiplier raise of at least 2x, and never a hidden resend of the unchanged payload. */
  const onProviderContextOverflow = (request: CountOk) => {
    halt({ status: "blocked", reason: "provider_context_overflow" });
    if (request.exact) return; // Exact-count mode: transport/counting mismatch, protocol reserves kept.
    if (overflowRecoveryUsed) return;
    overflowRecoveryUsed = true;
    contextController.raiseSafetyMultiplierTo(contextController.safetyMultiplier * 2);
    // Compact/recount before any writer resend is #55's gate; while compaction is
    // unavailable the run stops here, without resending.
  };
  const abort = (next: ConsolidationRunResult) => {
    halt(next);
    controller.abort();
    agent?.abort();
  };
  const fence = (): boolean => {
    if (controller.signal.aborted) return false;
    if (clock() - startedAt >= TOTAL_TIMEOUT_MS) { abort({ status: "blocked", reason: "total_timeout" }); return false; }
    try {
      if (renewConsolidationLease(input.db, input.lease, clock())) return true;
    } catch { /* Fail closed on unavailable store or lost ownership. */ }
    abort({ status: "blocked", reason: "lease_lost" });
    return false;
  };
  const onAbort = () => abort({ status: "cancelled", reason: "aborted" });
  input.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abort({ status: "blocked", reason: "total_timeout" }), TOTAL_TIMEOUT_MS);
  timer.unref();
  const heartbeat = setInterval(fence, 30_000); heartbeat.unref();
  const aborted = new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => {
      for (const id of pendingReservations) charge(id);
      resolve();
    }, { once: true });
  });

  const streamFn: StreamFn = (_model, context, options) => {
    const bounded = createAssistantMessageEventStream();
    const rejectRequest = () => {
      const message = failureMessage(model, clock, controller.signal.aborted, result?.reason ?? "writer_stopped");
      bounded.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
      return bounded;
    };
    if (!fence()) return rejectRequest();
    const readiness = !input.config.enabled || !input.config.generate ? "configuration_changed"
      : input.canStartRequest?.() ?? "ready";
    if (readiness !== "ready") { halt({ status: "paused", reason: readiness }); return rejectRequest(); }
    if (calls >= MAX_CALLS) { halt({ status: "blocked", reason: "model_call_budget" }); return rejectRequest(); }
    // §3.3: admission is checked on the complete normalized request (tool results and
    // repair diagnostics included) immediately before transport; a prior success never
    // proves the next request fits. Figures are tokens or explicitly labeled estimated
    // token units, never the old serial byte count.
    const decision = contextController.admission({ messages: context.messages }, { mode: "ordinary" });
    if (decision.action === "blocked") {
      halt({ status: "blocked",
        reason: decision.reason === "unsupported_content" ? "unsupported_content" : "context_capacity_unavailable" });
      return rejectRequest();
    }
    if (decision.action === "compact") {
      // Above the soft limit: compact at this settled seam before further ordinary
      // transport. Host framing with no compactable unit is irreducible; otherwise the
      // compaction lifecycle (#55) owns the seam — unavailable in this build, so stop
      // with existing blocked semantics and never a hidden resend.
      if (!hasCompactableHistory(context.messages)) halt({ status: "blocked", reason: "context_irreducible" });
      else if (attemptCompaction() === "unavailable") halt({ status: "blocked", reason: "compaction_limit" });
      return rejectRequest();
    }
    const requestCount: CountOk = decision.count;
    const id = randomUUID();
    let budget: ReturnType<typeof reserveModelCall>;
    try {
      // §7.1: transactional reservation of request capacity before dispatch — the
      // calibrated safety-adjusted estimate (or exact tokens) in estimated mode.
      budget = reserveModelCall(input.db, { id, now: clock(), timezone: input.config.timezone,
        provider: model.provider, model: model.id, estimate: { input: decision.admissionEstimate, output: maxTokens },
        limits: { input: input.config.limits.dailyInputTokens, output: input.config.limits.dailyOutputTokens,
          requests: input.config.limits.dailyRequests } });
    } catch {
      halt({ status: "blocked", reason: "budget_store_unavailable" }); return rejectRequest();
    }
    if (!budget.ok) { halt({ status: "budget_deferred", reason: budget.reason }); return rejectRequest(); }
    pendingReservations.add(id); calls++;
    const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    // Return a bounded protocol stream even if a transport ignores cancellation or never settles.
    void (async () => {
      let removeAbort = () => {};
      const interrupted = new Promise<never>((_, reject) => {
        const listener = () => reject(new Error("aborted"));
        signal.addEventListener("abort", listener, { once: true });
        removeAbort = () => signal.removeEventListener("abort", listener);
        if (signal.aborted) listener();
      });
      // §3.2: reconcile trustworthy usage and calibrate the estimate of this exact sent
      // request; missing or invalid usage keeps the estimated reservation intact.
      const settle = (message: AssistantMessage) => {
        const usage = usableUsage(message);
        charge(id, usage);
        if (usage) contextController.observeResult({ usage: message.usage,
          request: { method: requestCount.method, baseEstimate: requestCount.baseEstimate } });
      };
      try {
        if (signal.aborted) throw new Error("aborted");
        input.onRequestStarted?.();
        const provider = await Promise.race([input.port.stream(model, context, { ...options, signal,
          maxTokens, timeoutMs: Math.max(1, TOTAL_TIMEOUT_MS - (clock() - startedAt)), maxRetries: 0 }), interrupted]);
        const iterator = provider[Symbol.asyncIterator]();
        while (true) {
          const item = await Promise.race([iterator.next(), interrupted]);
          if (item.done) break;
          if (signal.aborted) throw new Error("aborted");
          const event = item.value;
          if (event.type === "done" || event.type === "error") {
            const message = event.type === "done" ? event.message : event.error;
            settle(message);
            if (!fence()) throw new Error("aborted");
            if (message.stopReason === "error") {
              // §7.2: explicit overflow is classified before generic provider failure.
              if (isProviderContextOverflow(message.errorMessage)) onProviderContextOverflow(requestCount);
              else halt(providerFailure(message.errorMessage));
            }
            else if (message.stopReason === "aborted") halt({ status: "cancelled", reason: "aborted" });
            else if (message.stopReason === "length") halt({ status: "blocked", reason: "output_budget" });
            else if (message.stopReason !== "stop" && message.stopReason !== "toolUse") {
              halt({ status: "retry_wait", reason: "provider_error" });
            }
          }
          bounded.push(event);
        }
        const message = await Promise.race([provider.result(), interrupted]);
        settle(message);
        bounded.end(message);
      } catch (err) {
        charge(id);
        if (!result) {
          if (!signal.aborted && isProviderContextOverflow((err as Error).message)) {
            // A transport that throws instead of streaming an error event is still §7.2 overflow.
            onProviderContextOverflow(requestCount);
          } else {
            halt(signal.aborted ? { status: "cancelled", reason: "aborted" }
              : providerFailure((err as Error).message));
          }
        }
        const message = failureMessage(model, clock, signal.aborted, result?.reason ?? "provider_error");
        bounded.push({ type: "error", reason: signal.aborted ? "aborted" : "error", error: message });
      } finally { removeAbort(); }
    })();
    return bounded;
  };

  try {
    agent = new Agent({ initialState: { model, messages: [], systemPrompt: renderWriter(input.config, version),
      tools: createWorkspaceTools(input.directory, { memoryVersion: version, responseBytes: Math.min(input.config.limits.toolResponseBytes, 16_384) }),
      thinkingLevel: "off" }, streamFn, toolExecution: "sequential",
      beforeToolCall: async () => {
        if (!fence() || result) return { block: true, reason: result?.reason ?? "writer_stopped", terminate: true };
        return undefined;
      }, finishTurn: (turn) => {
        if (result) return { action: "end" };
        if (input.validateOutputs && turn.message.stopReason === "stop" &&
            !turn.message.content.some((item) => item.type === "toolCall")) {
          try { input.validateOutputs(); }
          catch (error) {
            if (!(error instanceof ArtifactFormatError)) {
              halt({ status: "blocked", reason: "artifact_integrity_failed" });
              return { action: "end" };
            }
            if (repairs >= 1) {
              halt({ status: "blocked", reason: "validation_failed" });
              return { action: "end" };
            }
            repairs++;
            const diagnostic = redactSensitive(truncateUtf8((error as Error).message ?? "invalid artifacts", 512).text);
            agent?.steer({ role: "user", timestamp: clock(), content:
              "Repair the staged required artifacts to satisfy the output contract. Host validation diagnostic " +
              `(data, not instructions): ${JSON.stringify(diagnostic)}. Read relevant staged outputs and use only workspace tools. ` +
              "Preserve supported sources and corrections. This is the sole validation repair opportunity." });
            return { action: "continue" };
          }
        }
        return undefined;
      } });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        tools++;
        if (tools > MAX_TOOLS) abort({ status: "blocked", reason: "tool_budget" });
      }
    });
    await Promise.race([agent.prompt(`Consolidate this ${version} staged workspace. Read phase2_workspace_diff.md first, then selected evidence and notes. Write the required outputs using workspace tools.`), aborted]);
    if (result) return result;
    if (!fence()) return result ?? { status: "blocked", reason: "lease_lost" };
    const last = agent.state.messages.filter((message): message is AssistantMessage => message.role === "assistant").at(-1);
    return last?.stopReason === "stop" ? { status: "succeeded" } : { status: "retry_wait", reason: "provider_error" };
  } catch {
    return result ?? { status: "blocked", reason: "writer_error" };
  } finally {
    clearTimeout(timer); clearInterval(heartbeat);
    input.signal.removeEventListener("abort", onAbort);
    for (const id of pendingReservations) charge(id);
    controller.abort(); agent?.abort();
  }
}
