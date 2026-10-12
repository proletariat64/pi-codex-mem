import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import type { ModelRef } from "../config.ts";
import { selectEvidenceWithinBudget } from "../snapshot.ts";
import {
  commitExtraction, deferExtractionForBudget, failExtraction, nextLocalDayTime,
  reconcileModelCall, renewExtractionLease, reserveModelCall,
  type LeasedJob,
} from "../store/jobs.ts";
import { parseV1Output, renderV1Request, v1EvidenceLine, truncateCodexMiddle } from "./v1.ts";
import { codexExtractionFormat, type ExtractionVersion } from "./format.ts";
import { parseV2Output, renderV2Request, type V2RequestInput } from "./v2.ts";

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
    signal: AbortSignal; maxTokens: number; timeoutMs: number; toolChoice: "none"; version: ExtractionVersion;
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
  limits: { outputBytes: number; dailyInputTokens: number; dailyOutputTokens: number; dailyRequests: number;
    v2RolloutSummaryBytes?: number };
  signal: AbortSignal;
  /** Production supplies Date.now; tests keep a deterministic clock. */
  clock?: () => number;
  /** Recheck between network requests; an in-flight call is allowed to finish. */
  canStartRequest?: () => "ready" | "foreground_active" | "configuration_changed";
}

export interface V2RunInput extends V1RunInput {
  limits: V1RunInput["limits"] & { v2RolloutSummaryBytes: number };
}

export type V1RunResult =
  | { status: "succeeded" | "no_output" | "retry_wait" | "cancelled" | "blocked" | "superseded" }
  | { status: "budget_deferred"; reason: string };

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Only read the immutable, hashed source snapshot inside the owned store. */
function readSource(input: V1RunInput): V2RequestInput {
  const row = input.db.prepare(
    `SELECT r.snapshot_path, r.snapshot_hash, w.cwd, w.git_branch FROM source_revisions r
     JOIN sessions s ON s.session_key = r.session_key
     JOIN workspaces w ON w.workspace_key = s.workspace_key
     WHERE r.source_id = ? AND r.status = 'captured'`,
  ).get(input.job.sourceId) as { snapshot_path: string; snapshot_hash: string; cwd: string;
    git_branch: string | null } | undefined;
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
    workspace?: unknown; omissionsManifest?: unknown } | null;
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
  // Captured scope is immutable; the workspaces row may have changed branch
  // since this revision was enrolled. Older snapshots without scope fall back.
  const scope = snapshot.workspace && typeof snapshot.workspace === "object" &&
    !Array.isArray(snapshot.workspace) ? snapshot.workspace as { cwdReal?: unknown; gitBranch?: unknown } : null;
  const cwd = typeof scope?.cwdReal === "string" ? scope.cwdReal : row.cwd;
  let gitBranch = row.git_branch;
  if (typeof scope?.gitBranch === "string") gitBranch = scope.gitBranch;
  else if (scope?.gitBranch === null) gitBranch = null;
  // SAFETY: every field consumed by the renderer is checked above; the
  // snapshot hash also matches the immutable DB reference.
  return { snapshotPath: path, cwd, gitBranch,
    items: snapshot.items as V2RequestInput["items"],
    manifest: { sourceId: input.job.sourceId, sessionKey: asString(snapshot.sessionKey),
      branchId: asString(snapshot.branchId), leafId: asString(snapshot.leafId),
      workspaceKey: asString(snapshot.workspaceKey),
      omittedSourceItems: omissions?.count as number | undefined,
      omissionReasons: omissions?.reasons as string[] | undefined } };
}

/** Pi supplies a resolved window; Codex's effective-window percentage has no Pi metadata field. */
function fitContext(source: V2RequestInput, model: ResolvedMemoryModel,
  version: "v1" | "v2"): ReturnType<typeof renderV1Request> | null {
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return null;
  const rolloutTokens = Math.max(1, Math.floor(model.contextWindow * 0.7));
  let request: ReturnType<typeof renderV1Request>;
  if (version === "v1") {
    // Preserve the normalized Pi snapshot representation, but use native head/tail
    // truncation rather than introducing a second role-priority selection policy.
    const contents = [
      source.manifest ? `[source manifest ${JSON.stringify(source.manifest)}]` : "",
      source.manifest?.omittedSourceItems ? `[${source.manifest.omittedSourceItems} source items omitted during normalization]` : "",
      ...source.items.map(v1EvidenceLine),
    ].filter(Boolean).join("\n");
    request = renderV1Request({ ...source, rolloutContents: truncateCodexMiddle(contents, rolloutTokens * 4, true) });
  } else {
    // v2 retains Pi snapshot role/dependency tiers at the host representation boundary.
    const selected = selectEvidenceWithinBudget(source.items, rolloutTokens * 4 - 80,
      item => Buffer.byteLength(v1EvidenceLine(item), "utf8") + 1);
    request = renderV2Request({ ...source, items: source.items.filter(item => selected.has(item)),
      omittedForContext: source.items.length - selected.size });
  }
  return Math.ceil(Buffer.byteLength(request.systemPrompt + request.userPrompt, "utf8") / 4) <= model.contextWindow ? request : null;
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
  context: Context, maxTokens: number, version: ExtractionVersion): Promise<MemoryResponse> {
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
      input.port.request(model, context, { signal: controller.signal, maxTokens, timeoutMs: 120_000, toolChoice: "none", version }),
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

/** Shared budget/fencing gates with a version-specific pinned prompt and parser. */
async function runExtraction(input: V1RunInput, version: "v1" | "v2"): Promise<V1RunResult> {
  const clock = () => input.clock?.() ?? input.now;
  if (input.job.memoryVersion !== version) {
    const changed = failExtraction(input.db, input.job, "blocked", "unsupported_version", clock());
    return { status: changed ? "blocked" : "superseded" };
  }
  const model = input.port.resolve(input.modelRef);
  if (!model) {
    failExtraction(input.db, input.job, "blocked", "model_not_found", clock());
    return { status: "blocked" };
  }
  let source: V2RequestInput;
  try {
    source = readSource(input);
  } catch {
    failExtraction(input.db, input.job, "blocked", "source_unavailable_for_version", clock());
    return { status: "blocked" };
  }
  const request = fitContext(source, model, version);
  if (!request) {
    failExtraction(input.db, input.job, "blocked", "context_too_small", clock());
    return { status: "blocked" };
  }
  const inputTokens = Math.ceil(Buffer.byteLength(request.systemPrompt + request.userPrompt, "utf8") / 4);
  // The native rollout allowance is independent of output. At the Pi transport
  // boundary, clamp the requested output to the remaining resolved context.
  const outputTokens = Math.floor(Math.min(model.maxTokens, model.contextWindow - inputTokens));
  // Admission must at least fit the native no-output JSON under the same UTF-8/4
  // estimate. This is a schema-derived floor, not another memory-size policy;
  // it does not guarantee tokenizer accuracy or a complete nonempty response.
  const emptyOutput = Object.fromEntries(codexExtractionFormat(version).schema.required.map(field => [field, ""]));
  const minimumOutputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(emptyOutput), "utf8") / 4);
  if (!Number.isFinite(outputTokens) || outputTokens < minimumOutputTokens) {
    failExtraction(input.db, input.job, "blocked", "context_too_small", clock());
    return { status: "blocked" };
  }
  if (request.promptHash !== input.job.promptHash) {
    failExtraction(input.db, input.job, "blocked", "prompt_changed", clock());
    return { status: "blocked" };
  }
  if (input.signal.aborted) {
    failExtraction(input.db, input.job, "cancelled", "aborted", clock());
    return { status: "cancelled" };
  }
  const eligibility = input.canStartRequest?.() ?? "ready";
  if (eligibility !== "ready") {
    const changed = deferExtractionForBudget(input.db, input.job, eligibility, clock(), clock());
    return { status: changed ? "retry_wait" : "superseded" };
  }
  const userText = request.userPrompt;
  const context: Context = { systemPrompt: request.systemPrompt, tools: [], messages: [
    { role: "user", content: userText, timestamp: clock() },
  ] };
  const estimate = { input: inputTokens,
    output: outputTokens };
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
    response = await requestWithLease(input, model, context, estimate.output, version);
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
  let parsed: ReturnType<typeof parseV1Output> | ReturnType<typeof parseV2Output>;
  if (response.stopReason !== "stop") {
    parsed = { ok: false, reason: `unexpected stop reason ${response.stopReason}` };
  } else if (version === "v1") {
    parsed = parseV1Output(response.text, input.limits.outputBytes);
  } else {
    parsed = parseV2Output(response.text, input.limits.outputBytes, input.limits.v2RolloutSummaryBytes ?? 9_000);
  }
  if (parsed.ok) {
    const accepted = commitExtraction(input.db, input.job, {
      memoryVersion: version, promptHash: request.promptHash, model: input.modelRef,
      rawMemory: "raw_memory" in parsed.output ? parsed.output.raw_memory : null,
      rolloutSummary: parsed.output.rollout_summary, rolloutSlug: parsed.output.rollout_slug,
      outputHash: parsed.outputHash, usage: usage ?? estimate, outcome: parsed.outcome,
      truncation: "truncation" in parsed ? parsed.truncation : undefined,
    }, clock());
    return { status: accepted ? parsed.outcome : "superseded" };
  }
  // The pinned phase1 sampler parses once; malformed output fails this job.
  const changed = failExtraction(input.db, input.job, "blocked", "invalid_schema", clock());
  return { status: changed ? "blocked" : "superseded" };
}

export function runV1Extraction(input: V1RunInput): Promise<V1RunResult> {
  return runExtraction(input, "v1");
}

export function runV2Extraction(input: V2RunInput): Promise<V1RunResult> {
  return runExtraction(input, "v2");
}
