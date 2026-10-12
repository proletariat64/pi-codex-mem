import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { type Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig, MemoryVersion, ModelRef } from "../config.ts";
import { normalizeModelUsage } from "../model-usage.ts";
import { estimateModelVisibleTokens } from "./codex-context.ts";
import { reconcileModelCall, reserveModelCall } from "../store/jobs.ts";
import { renewConsolidationLease, type ConsolidationLease } from "../store/consolidation.ts";
import { createWorkspaceTools } from "./workspace-tools.ts";
import { createWriterRuntime, type ConsolidationModelPort } from "./model-port.ts";
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
  /** Validate completed outputs; publication still belongs to the host. */
  validateOutputs?: () => void;
}

export interface ConsolidationRunResult {
  status: "succeeded" | "blocked" | "retry_wait" | "cancelled" | "budget_deferred" | "paused";
  reason?: string;
  retryAfterMs?: number;
}

const writerTemplate = (version: MemoryVersion) => readFileSync(new URL(`../../prompts/upstream/${version}/${version === "v1" ? "consolidation.md" : "consolidation_v2.md"}`, import.meta.url), "utf8");

/** Prompt and host adapter changes invalidate prior terminal work. */
export function consolidationPromptHash(config: MemoryConfig, version: MemoryVersion = "v1"): string {
  return createHash("sha256").update(writerTemplate(version)).update(JSON.stringify({
    schemaVersion: 1, rendererVersion: 3, memoryVersion: version,
    toolResponseBytes: config.limits.toolResponseBytes, runtime: "pi-agent-session-v1",
    outputAllowlist: version === "v1" ? ["MEMORY.md", "memory_summary.md", "skills/<slug>/SKILL.md"] : ["memory_summary.md"],
    toolExecution: "sequential", artifactPolicyVersion: 4,
  })).digest("hex");
}

/** Only upstream template parameters are substituted; no added memory instructions. */
export function renderConsolidationPrompt(version: MemoryVersion): string {
  return writerTemplate(version)
    .replaceAll("{{ memory_root }}", ".")
    .replaceAll("{{ phase2_workspace_diff_file }}", "phase2_workspace_diff.md")
    .replaceAll("{{ memory_extensions_folder_structure }}", "- notes/<note-id>.md: read-only user notes")
    .replaceAll("{{ memory_extensions_primary_inputs }}", "- `notes/*.md`");
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

/** Confined in-memory Pi session. A completed writer is still unpublished until host validation/CAS. */
export async function runConsolidation(input: ConsolidationRunInput): Promise<ConsolidationRunResult> {
  const clock = input.clock ?? Date.now;
  const version = input.lease.memoryVersion;
  if (input.signal.aborted) return { status: "cancelled", reason: "aborted" };
  if (input.lease.promptHash !== consolidationPromptHash(input.config, version)) return { status: "blocked", reason: "prompt_changed" };
  const model = input.port.resolve(input.modelRef);
  if (!model) return { status: "blocked", reason: "model_not_found" };
  if (model.api === "pi-virtual") return { status: "blocked", reason: "unsupported_virtual_model" };
  const controller = new AbortController();
  let result: ConsolidationRunResult | undefined;
  let agent: Agent | undefined;
  let session: AgentSession | undefined;
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
  const abort = (next: ConsolidationRunResult) => {
    halt(next);
    controller.abort();
    if (session) void session.abort().catch(() => {});
    else agent?.abort();
  };
  const fence = (): boolean => {
    if (controller.signal.aborted) return false;
    try {
      if (renewConsolidationLease(input.db, input.lease, clock())) return true;
    } catch { /* Fail closed on unavailable store or lost ownership. */ }
    abort({ status: "blocked", reason: "lease_lost" });
    return false;
  };
  const onAbort = () => abort({ status: "cancelled", reason: "aborted" });
  input.signal.addEventListener("abort", onAbort, { once: true });
  const heartbeat = setInterval(fence, 30_000); heartbeat.unref();
  const aborted = new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => {
      for (const id of pendingReservations) charge(id);
      resolve();
    }, { once: true });
  });

  const streamFn: StreamFn = (requestModel, context, options) => {
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
    if (result) return rejectRequest();
    // Pi owns context admission and compaction. This estimate is only for the
    // shared daily ledger; compaction requests are accounted through this same seam.
    const maxTokens = options?.maxTokens ?? requestModel.maxTokens;
    let inputTokens: number;
    try { inputTokens = estimateModelVisibleTokens(context); }
    catch { halt({ status: "blocked", reason: "context_accounting_unavailable" }); return rejectRequest(); }
    const id = randomUUID();
    let budget: ReturnType<typeof reserveModelCall>;
    try {
      budget = reserveModelCall(input.db, { id, now: clock(), timezone: input.config.timezone,
        provider: requestModel.provider, model: requestModel.id, estimate: { input: inputTokens, output: maxTokens },
        limits: { input: input.config.limits.dailyInputTokens, output: input.config.limits.dailyOutputTokens,
          requests: input.config.limits.dailyRequests } });
    } catch {
      halt({ status: "blocked", reason: "budget_store_unavailable" }); return rejectRequest();
    }
    if (!budget.ok) { halt({ status: "budget_deferred", reason: budget.reason }); return rejectRequest(); }
    pendingReservations.add(id);
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
      try {
        if (signal.aborted) throw new Error("aborted");
        input.onRequestStarted?.();
        const provider = await Promise.race([input.port.stream(requestModel, context, { ...options, signal, maxTokens, maxRetries: 0 }), interrupted]);
        const iterator = provider[Symbol.asyncIterator]();
        while (true) {
          const item = await Promise.race([iterator.next(), interrupted]);
          if (item.done) break;
          if (signal.aborted) throw new Error("aborted");
          const event = item.value;
          if (event.type === "done" || event.type === "error") {
            const message = event.type === "done" ? event.message : event.error;
            const usage = usableUsage(message);
            charge(id, usage);
            if (!fence()) throw new Error("aborted");
            if (message.stopReason === "aborted") halt({ status: "cancelled", reason: "aborted" });
            else if (message.stopReason === "length") halt({ status: "blocked", reason: "output_budget" });
            else if (message.stopReason === "error" && providerFailure(message.errorMessage).status === "blocked") {
              halt(providerFailure(message.errorMessage));
            }
          }
          bounded.push(event);
        }
        const message = await Promise.race([provider.result(), interrupted]);
        charge(id, usableUsage(message));
        bounded.end(message);
      } catch (err) {
        charge(id);
        if (!result && controller.signal.aborted) halt({ status: "cancelled", reason: "aborted" });
        const message = failureMessage(requestModel, clock, signal.aborted, (err as Error).message ?? "provider_error");
        bounded.push({ type: "error", reason: signal.aborted ? "aborted" : "error", error: message });
      } finally { removeAbort(); }
    })();
    return bounded;
  };

  try {
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.directory, agentDir: input.directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "", appendSystemPrompt: [],
    });
    await resourceLoader.reload();
    if (controller.signal.aborted) return result ?? { status: "cancelled", reason: "aborted" };
    const workspaceTools = createWorkspaceTools(input.directory, {
      memoryVersion: version, responseBytes: Math.min(input.config.limits.toolResponseBytes, 16_384),
    });
    ({ session } = await createAgentSession({
      cwd: input.directory, agentDir: input.directory, model,
      modelRuntime: createWriterRuntime(input.port, model, streamFn), thinkingLevel: "medium",
      settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(input.directory),
      tools: workspaceTools.map(tool => tool.name), customTools: workspaceTools,
    }));
    agent = session.agent;
    // The SDK stream wrapper supplies native transport settings; its runtime
    // delegates both ordinary turns and summarization to the accounting seam.
    agent.toolExecution = "sequential";
    const nativeBeforeToolCall = agent.beforeToolCall;
    agent.beforeToolCall = async (context, signal) => {
      if (!fence() || result) return { block: true, reason: result?.reason ?? "writer_stopped", terminate: true };
      return nativeBeforeToolCall?.(context, signal);
    };
    const nativeFinishTurn = agent.finishTurn;
    agent.finishTurn = async (turn, signal) => {
      if (result) return { action: "end" };
      return (await nativeFinishTurn?.(turn, signal)) ?? undefined;
    };
    if (controller.signal.aborted) return result ?? { status: "cancelled", reason: "aborted" };
    await Promise.race([session.prompt(renderConsolidationPrompt(version)), aborted]);
    if (result) return result;
    if (!fence()) return result ?? { status: "blocked", reason: "lease_lost" };
    const last = agent.state.messages.filter((message): message is AssistantMessage => message.role === "assistant").at(-1);
    if (last?.stopReason !== "stop") return providerFailure(last?.errorMessage);
    try { input.validateOutputs?.(); }
    catch (error) { return { status: "blocked", reason: error instanceof ArtifactFormatError ? "validation_failed" : "artifact_integrity_failed" }; }
    return { status: "succeeded" };
  } catch {
    return result ?? { status: "blocked", reason: "writer_error" };
  } finally {
    clearInterval(heartbeat);
    input.signal.removeEventListener("abort", onAbort);
    for (const id of pendingReservations) charge(id);
    controller.abort();
    if (session) { await session.abort().catch(() => {}); session.dispose(); }
    else agent?.abort();
  }
}
