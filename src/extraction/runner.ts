import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import type { ModelRef } from "../config.ts";
import { truncateUtf8 } from "../snapshot.ts";
import {
  commitExtraction, deferExtractionForBudget, failExtraction, nextLocalDayTime,
  pauseExtraction, reconcileModelCall, renewExtractionLease, reserveModelCall, reserveRepairAttempt,
  type LeasedJob,
} from "../store/jobs.ts";
import { parseV1Output, renderV1Request, v1EvidenceLine, type V1RequestInput } from "./v1.ts";

export interface ResolvedMemoryModel {
  provider: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}

export interface MemoryResponse {
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  text: string;
  usage?: { input: number; output: number };
  errorMessage?: string;
}

export interface MemoryModelPort {
  resolve(ref: ModelRef): ResolvedMemoryModel | undefined;
  request(model: ResolvedMemoryModel, context: Context, options: {
    signal: AbortSignal; maxTokens: number; timeoutMs: number; toolChoice: "none";
  }): Promise<MemoryResponse>;
}

export interface V1RunInput {
  db: DatabaseSync;
  root: string;
  job: LeasedJob;
  modelRef: ModelRef;
  port: MemoryModelPort;
  now: number;
  timezone: string;
  limits: { outputBytes: number; dailyInputTokens: number; dailyOutputTokens: number; dailyRequests: number };
  signal: AbortSignal;
  /** Production supplies Date.now; tests keep a deterministic clock. */
  clock?: () => number;
  /** Recheck between network requests; an in-flight call is allowed to finish. */
  canStartRequest?: () => "ready" | "foreground_active" | "configuration_changed";
}

export type V1RunResult =
  | { status: "succeeded" | "no_output" | "retry_wait" | "cancelled" | "blocked" | "superseded" }
  | { status: "budget_deferred"; reason: string };

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Only read the immutable, hashed source snapshot inside the owned store. */
function readSource(input: V1RunInput): V1RequestInput {
  const row = input.db.prepare(
    `SELECT r.snapshot_path, r.snapshot_hash, w.cwd FROM source_revisions r
     JOIN sessions s ON s.session_key = r.session_key
     JOIN workspaces w ON w.workspace_key = s.workspace_key
     WHERE r.source_id = ? AND r.status = 'captured'`,
  ).get(input.job.sourceId) as { snapshot_path: string; snapshot_hash: string; cwd: string } | undefined;
  if (!row) throw new Error("source_unavailable_for_version");
  const path = resolve(row.snapshot_path);
  const sources = join(input.root, "sources");
  if (!path.startsWith(resolve(sources) + sep) || lstatSync(sources).isSymbolicLink() ||
      lstatSync(dirname(path)).isSymbolicLink() || lstatSync(path).isSymbolicLink() ||
      !realpathSync(path).startsWith(realpathSync(sources) + sep)) {
    throw new Error("source_unavailable_for_version");
  }
  const bytes = readFileSync(path);
  if (digest(bytes) !== row.snapshot_hash) throw new Error("source_unavailable_for_version");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("source_unavailable_for_version");
  }
  const snapshot = parsed as { schemaVersion?: unknown; sourceId?: unknown; items?: unknown;
    sessionKey?: unknown; branchId?: unknown; leafId?: unknown; workspaceKey?: unknown;
    omissionsManifest?: unknown } | null;
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.sourceId !== input.job.sourceId ||
      !Array.isArray(snapshot.items) || snapshot.items.some((item) =>
        !item || typeof item !== "object" || typeof item.entryId !== "string" ||
        typeof item.role !== "string" || typeof item.text !== "string" ||
        (item.origin !== null && typeof item.origin !== "string"))) {
    throw new Error("source_unavailable_for_version");
  }
  const omissions = snapshot.omissionsManifest as { count?: unknown; reasons?: unknown } | undefined;
  if (omissions && (!Number.isSafeInteger(omissions.count) ||
      !Array.isArray(omissions.reasons) || omissions.reasons.some((reason) => typeof reason !== "string"))) {
    throw new Error("source_unavailable_for_version");
  }
  const asString = (value: unknown) => typeof value === "string" ? value : undefined;
  // SAFETY: every field consumed by the renderer is checked above; the
  // snapshot hash also matches the immutable DB reference.
  return { snapshotPath: path, cwd: row.cwd, items: snapshot.items as V1RequestInput["items"],
    manifest: { sourceId: input.job.sourceId, sessionKey: asString(snapshot.sessionKey),
      branchId: asString(snapshot.branchId), leafId: asString(snapshot.leafId),
      workspaceKey: asString(snapshot.workspaceKey),
      omittedSourceItems: omissions?.count as number | undefined,
      omissionReasons: omissions?.reasons as string[] | undefined } };
}

/** Select by the shared user → assistant → tool tier, newest within a tier. */
function fitV1Context(source: V1RequestInput, model: ResolvedMemoryModel,
  outputTokens: number): ReturnType<typeof renderV1Request> | null {
  const maxBytes = Math.floor((model.contextWindow - outputTokens - 1_024) * 0.7);
  const base = renderV1Request({ ...source, items: [] });
  const baseBytes = Buffer.byteLength(base.systemPrompt + base.userPrompt, "utf8");
  if (baseBytes + 80 > maxBytes) return null;
  let remaining = maxBytes - baseBytes - 80; // reserve for the explicit omissions marker
  const tiers: Record<string, number> = { user: 0, assistant: 1, tool: 2 };
  const order = source.items.map((item, index) => ({ item, index }))
    .sort((a, b) => (tiers[a.item.role] ?? 3) - (tiers[b.item.role] ?? 3) || b.index - a.index);
  const selected = new Set<number>();
  for (const { item, index } of order) {
    const bytes = Buffer.byteLength(v1EvidenceLine(item), "utf8") + 1;
    if (bytes <= remaining) { selected.add(index); remaining -= bytes; }
  }
  const request = renderV1Request({ ...source,
    items: source.items.filter((_item, index) => selected.has(index)),
    omittedForContext: source.items.length - selected.size });
  return Buffer.byteLength(request.systemPrompt + request.userPrompt, "utf8") <= maxBytes ? request : null;
}

function usableUsage(usage: MemoryResponse["usage"]): { input: number; output: number } | undefined {
  if (!usage || !Number.isSafeInteger(usage.input) || usage.input < 0 ||
      !Number.isSafeInteger(usage.output) || usage.output < 0 ||
      (usage.input === 0 && usage.output === 0)) return undefined;
  return usage;
}

function errorKind(message: string | undefined): "blocked" | "transient" {
  return /\b(?:401|403|unauthorized|authentication|invalid.api.key|model.not.found)\b/i.test(message ?? "")
    ? "blocked" : "transient";
}

function retryAfterMs(message: string | undefined): number | undefined {
  const match = /\bretry[- ]after\s*[:=]?\s*(\d{1,8})\s*(ms|milliseconds?|s|seconds?|m|minutes?)?\b/i.exec(message ?? "");
  if (!match) return undefined;
  const count = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "s";
  const multiplier = unit.startsWith("ms") || unit.startsWith("millisecond") ? 1
    : unit === "m" || unit.startsWith("minute") ? 60_000 : 1_000;
  return Math.min(2_147_483_647, count * multiplier);
}

/** Bounded request: abort on timeout or shutdown, and renew the fenced lease. */
async function requestWithLease(input: V1RunInput, model: ResolvedMemoryModel,
  context: Context, maxTokens: number): Promise<MemoryResponse> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  timeout.unref();
  const heartbeat = setInterval(() => {
    try {
      if (!renewExtractionLease(input.db, input.job, input.clock?.() ?? input.now)) controller.abort();
    } catch {
      controller.abort();
    }
  }, 30_000);
  heartbeat.unref();
  try {
    if (controller.signal.aborted) throw new Error("aborted");
    return await Promise.race([
      input.port.request(model, context, { signal: controller.signal, maxTokens, timeoutMs: 120_000, toolChoice: "none" }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    input.signal.removeEventListener("abort", onAbort);
  }
}

/** One v1 job through the captured model port, with budget and fencing gates. */
export async function runV1Extraction(input: V1RunInput): Promise<V1RunResult> {
  const clock = () => input.clock?.() ?? input.now;
  if (input.job.memoryVersion !== "v1") {
    const changed = failExtraction(input.db, input.job, "blocked", "unsupported_version", clock());
    return { status: changed ? "blocked" : "superseded" };
  }
  const model = input.port.resolve(input.modelRef);
  if (!model) {
    failExtraction(input.db, input.job, "blocked", "model_not_found", clock());
    return { status: "blocked" };
  }
  let source: V1RequestInput;
  try {
    source = readSource(input);
  } catch {
    failExtraction(input.db, input.job, "blocked", "source_unavailable_for_version", clock());
    return { status: "blocked" };
  }
  const outputTokens = Math.min(6_000, model.maxTokens);
  const request = fitV1Context(source, model, outputTokens);
  if (!request) {
    failExtraction(input.db, input.job, "blocked", "context_too_small", clock());
    return { status: "blocked" };
  }
  if (request.promptHash !== input.job.promptHash) {
    failExtraction(input.db, input.job, "blocked", "prompt_changed", clock());
    return { status: "blocked" };
  }
  let repair = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (input.signal.aborted) {
      failExtraction(input.db, input.job, "cancelled", "aborted", clock());
      return { status: "cancelled" };
    }
    const eligibility = input.canStartRequest?.() ?? "ready";
    if (eligibility !== "ready") {
      const changed = attempt === 0
        ? deferExtractionForBudget(input.db, input.job, eligibility, clock(), clock())
        : pauseExtraction(input.db, input.job, clock(), eligibility);
      return { status: changed ? "retry_wait" : "superseded" };
    }
    const userText = request.userPrompt + repair;
    const context: Context = { systemPrompt: request.systemPrompt, tools: [], messages: [
      { role: "user", content: userText, timestamp: clock() },
    ] };
    const estimate = { input: Buffer.byteLength(request.systemPrompt + userText, "utf8"),
      output: outputTokens };
    const inputLimit = Math.floor((model.contextWindow - outputTokens - 1_024) * 0.7);
    if (estimate.input > inputLimit) {
      const changed = failExtraction(input.db, input.job, "blocked", "repair_context_too_small", clock());
      return { status: changed ? "blocked" : "superseded" };
    }
    // A repair is a distinct network attempt. Claim it before reserving the
    // shared budget; if the budget denies the call, deferral refunds this
    // unspent attempt rather than the previous, already-spent request.
    if (attempt > 0 && !reserveRepairAttempt(input.db, input.job, clock())) {
      const changed = failExtraction(input.db, input.job, "blocked", "repair_unavailable", clock());
      return { status: changed ? "blocked" : "superseded" };
    }
    const reservationId = randomUUID();
    const budget = reserveModelCall(input.db, {
      id: reservationId, now: clock(), timezone: input.timezone,
      provider: model.provider, model: model.modelId, estimate,
      limits: { input: input.limits.dailyInputTokens, output: input.limits.dailyOutputTokens,
        requests: input.limits.dailyRequests },
    });
    if (!budget.ok) {
      const deferred = deferExtractionForBudget(input.db, input.job, budget.reason, clock(),
        nextLocalDayTime(clock(), input.timezone));
      return deferred ? { status: "budget_deferred", reason: budget.reason } : { status: "superseded" };
    }
    let response: MemoryResponse;
    try {
      response = await requestWithLease(input, model, context, estimate.output);
    } catch (err) {
      reconcileModelCall(input.db, reservationId, undefined);
      const cancelled = input.signal.aborted;
      const kind = cancelled ? "cancelled" : errorKind((err as Error).message);
      const changed = failExtraction(input.db, input.job, kind, kind === "cancelled" ? "aborted" : "provider_error",
        clock(), { retryAfterMs: retryAfterMs((err as Error).message) });
      return changed ? { status: kind === "transient" ? "retry_wait" : kind } : { status: "superseded" };
    }
    const usage = usableUsage(response.usage);
    reconcileModelCall(input.db, reservationId, usage);
    if (response.stopReason === "aborted" || input.signal.aborted) {
      const changed = failExtraction(input.db, input.job, "cancelled", "aborted", clock());
      return { status: changed ? "cancelled" : "superseded" };
    }
    if (response.stopReason === "error" || response.stopReason === "deferred") {
      const kind = errorKind(response.errorMessage);
      const changed = failExtraction(input.db, input.job, kind, kind === "blocked" ? "auth_or_model" : "provider_error",
        clock(), { retryAfterMs: retryAfterMs(response.errorMessage) });
      return { status: changed ? kind === "transient" ? "retry_wait" : "blocked" : "superseded" };
    }
    const parsed = response.stopReason === "stop"
      ? parseV1Output(response.text, input.limits.outputBytes)
      : { ok: false as const, reason: `unexpected stop reason ${response.stopReason}` };
    if (parsed.ok) {
      const accepted = commitExtraction(input.db, input.job, {
        memoryVersion: "v1", promptHash: request.promptHash, model: input.modelRef,
        rawMemory: parsed.output.raw_memory, rolloutSummary: parsed.output.rollout_summary,
        rolloutSlug: parsed.output.rollout_slug, outputHash: parsed.outputHash,
        usage: usage ?? estimate, outcome: parsed.outcome,
      }, clock());
      return { status: accepted ? parsed.outcome : "superseded" };
    }
    if (attempt === 1 || input.job.attemptCount >= 3) {
      const changed = failExtraction(input.db, input.job, "blocked", "invalid_schema", clock());
      return { status: changed ? "blocked" : "superseded" };
    }
    repair = `\n\nRepair the prior JSON response. Return ONLY the three required v1 string fields. Error: ${parsed.reason}. ` +
      `Prior response: ${truncateUtf8(response.text, 4096).text}`;
  }
  throw new Error("unreachable v1 repair limit");
}
