// Persistent diagnostics: SELECT-only; never claims work, pins memory or calls a model.
import type { DatabaseSync } from "node:sqlite";
import type { MemoryConfig, MemoryVersion } from "./config.ts";
import { getPublishedGeneration } from "./store/consolidation.ts";
import { localDay } from "./store/jobs.ts";
import { v1PromptHash } from "./extraction/v1.ts";
import { v2PromptHash } from "./extraction/v2.ts";

export interface MemoryDiagnostics {
  selectedReadable: boolean;
  selectedInvalidated: boolean;
  lines: string[];
  readiness: string[];
}

export function persistentDiagnostics(db: DatabaseSync, config: MemoryConfig, now = Date.now()): MemoryDiagnostics {
  const lines: string[] = [];
  const readiness: string[] = [];
  let selectedReadable = false;
  let selectedInvalidated = false;
  const day = localDay(now, config.timezone);
  const usage = db.prepare(`SELECT COALESCE(SUM(actual_input), 0) AS input,
    COALESCE(SUM(reserved_input), 0) AS reservedInput,
    COALESCE(SUM(actual_output), 0) AS output,
    COALESCE(SUM(reserved_output), 0) AS reservedOutput,
    COALESCE(SUM(call_count), 0) AS requests FROM budget_usage WHERE local_day = ?`).get(day) as {
      input: number; reservedInput: number; output: number; reservedOutput: number; requests: number;
    };
  let budgetWait = false;
  for (const version of ["v1", "v2"] as const) {
    const pipeline = db.prepare("SELECT read_blocked, block_reason FROM pipeline_state WHERE memory_version = ?").get(version);
    const generation = getPublishedGeneration(db, version, now, {
      maxUnusedDays: config.schedule.maxUnusedDays,
      extractionPromptHash: version === "v1" ? v1PromptHash() : v2PromptHash(),
    });
    const readable = Boolean(generation);
    if (version === config.version) {
      selectedReadable = readable;
      selectedInvalidated = Boolean(pipeline?.read_blocked);
    }
    let readinessState = readable ? "published" : "warming_up";
    if (pipeline?.read_blocked) readinessState = `read invalidated (${pipeline.block_reason})`;
    readiness.push(`${version} readiness: ${readinessState}`);
    const extraction = extractionLine(db, config, version, now);
    lines.push(extraction.line);
    budgetWait ||= extraction.budgetWait;
    // Independent sources can have outstanding waits even when newer work has
    // queued or completed. Do not let the latest-progress line hide those jobs.
    const waits = db.prepare(`SELECT j.status, j.error_code, COUNT(*) AS count, MIN(j.due_at) AS due_at
      FROM jobs j JOIN source_revisions r ON r.source_id = j.source_id
      JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
      WHERE j.kind = 'extract' AND j.memory_version = ? AND r.status = 'captured'
        AND h.state = 'active' AND h.latest_revision = r.source_id
        AND j.status IN ('retry_wait', 'blocked')
        AND j.error_code IN ('input_budget', 'output_budget', 'request_budget')
      GROUP BY j.status, j.error_code ORDER BY j.status, j.error_code`).all(version) as {
        status: string; error_code: string; count: number; due_at: number;
      }[];
    for (const wait of waits) {
      budgetWait = true;
      lines.push(`${version} extraction recovery: ${wait.count} ${wait.status} (${wait.error_code}); earliest job due ${new Date(wait.due_at).toISOString()}; last budget denial; current admission unknown`);
    }
    // Report the latest non-superseded state, including completion, rather than
    // resurfacing an older error after newer work has succeeded.
    const writer = db.prepare(`SELECT status, error_code, due_at, updated_at FROM jobs
      WHERE kind = 'consolidate' AND memory_version = ?
        AND status != 'superseded'
      ORDER BY updated_at DESC, created_at DESC, job_id LIMIT 1`).get(version);
    let consolidation = `${version} consolidation: not queued`;
    if (writer) {
      consolidation = `${version} consolidation: ${writer.status}` +
        (writer.error_code ? ` (last error: ${writer.error_code})` : "") +
        `; due ${new Date(Number(writer.due_at)).toISOString()}; last updated ${new Date(Number(writer.updated_at)).toISOString()}`;
      if (["input_budget", "output_budget", "request_budget"].includes(String(writer.error_code))) {
        budgetWait = true;
        consolidation += `; denial day ${localDay(Number(writer.updated_at), config.timezone)} (${config.timezone})`;
        if (writer.status !== "retry_wait") consolidation += "; historical denial; current admission unknown";
        else if (Number(writer.due_at) <= now) consolidation += "; retry due; prior budget denial is not current admission";
        else consolidation += "; scheduled retry; current admission unknown";
      }
    }
    lines.push(consolidation,
      `${version} readable generation: ${generation?.generationId ?? "none"}${!readable && !pipeline?.read_blocked ? " (initialization/publication pending; no eligible generation)" : ""}`);
    if (pipeline?.read_blocked) lines.push(`${version} invalidation reason: ${pipeline.block_reason ?? "unknown"}`);
    const notes = db.prepare(`SELECT COUNT(*) AS saved, COALESCE(SUM(CASE WHEN EXISTS (
      SELECT 1 FROM note_applications a WHERE a.note_id = n.note_id AND a.note_hash = n.text_hash
        AND a.memory_version = ? AND a.generation_id = ?) THEN 1 ELSE 0 END), 0) AS published
      FROM notes n WHERE n.status = 'active'`).get(version, generation?.generationId ?? "") as { saved: number; published: number };
    lines.push(`${version} notes: ${notes.saved} saved; ${notes.published} in readable publication; ${notes.saved - notes.published} pending publication`);
  }
  lines.unshift(`selected memory (${config.version}): ${selectedReadable ? "READABLE (available for next eligible run)" : "UNAVAILABLE"}`);
  if (budgetWait) lines.push(
    "budget scope: plugin local daily background-model budget (not provider quota, context window or session memory injection)",
    `budget day: ${day} (${config.timezone}); current configured limits`,
    `input used/reserved/limit: ${usage.input} / ${usage.reservedInput} / ${config.limits.dailyInputTokens}`,
    `output used/reserved/limit: ${usage.output} / ${usage.reservedOutput} / ${config.limits.dailyOutputTokens}`,
    `requests used/limit: ${usage.requests} / ${config.limits.dailyRequests}`,
    "next request estimated input/output: unknown (denied request estimate not persisted); admission uses used + reserved + estimated tokens",
    `recovery: wait for the budget reset or adjust local limits; /memory run --version ${config.version} --now skips idle waiting, not budget admission`,
    "retry due does not mean published; saved notes become searchable only after publication",
  );
  lines.push(...readiness);
  return { selectedReadable, selectedInvalidated, lines, readiness };
}

function extractionLine(db: DatabaseSync, config: MemoryConfig, version: MemoryVersion, now: number): { line: string; budgetWait: boolean } {
  const row = db.prepare(`SELECT j.status, j.error_code, j.due_at, s.last_activity_at,
    COALESCE((SELECT skip_idle FROM version_run_grants g WHERE g.request_id = j.request_id AND g.status = 'active'), 0) AS skip_idle,
    (SELECT MAX(expires_at) FROM process_activity p WHERE p.session_key = r.session_key
      AND p.activity_state = 'active' AND p.expires_at > ?) AS busy_until
    FROM jobs j JOIN source_revisions r ON r.source_id = j.source_id
    JOIN sessions s ON s.session_key = r.session_key
    JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
    WHERE j.kind = 'extract' AND j.memory_version = ? AND r.status = 'captured'
      AND h.state = 'active' AND h.latest_revision = r.source_id AND j.status != 'superseded'
    ORDER BY j.updated_at DESC, j.created_at DESC, j.job_id LIMIT 1`).get(now, version) as {
      status: string; error_code: string | null; due_at: number; last_activity_at: number;
      skip_idle: number; busy_until: number | null;
    } | undefined;
  if (!row) return { line: `${version} extraction: not queued`, budgetWait: false };
  let outcome = row.status;
  if (row.status === "leased") outcome = "extracting";
  else if (row.status === "succeeded") outcome = "extracted";
  const idleUntil = row.last_activity_at + (row.skip_idle ? 0 : config.schedule.minIdleMinutes * 60_000);
  const nextDue = Math.max(row.due_at, idleUntil, row.busy_until ?? 0);
  const pending = row.status === "queued" && idleUntil > now ? "pending idle window; " : "";
  const due = ["queued", "retry_wait"].includes(row.status) ? ` (${pending}next due ${new Date(nextDue).toISOString()})` : "";
  const budgetWait = ["input_budget", "output_budget", "request_budget"].includes(row.error_code ?? "");
  return { line: `${version} extraction: ${outcome}${row.error_code ? ` — ${row.error_code}` : ""}${due}` +
    `; job due ${new Date(row.due_at).toISOString()}` +
    (budgetWait ? "; last budget denial; current admission unknown" : ""), budgetWait };
}
