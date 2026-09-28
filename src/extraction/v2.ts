import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { redactSensitive } from "../sensitive.ts";
import { v1EvidenceLine, type V1RequestInput } from "./v1.ts";

export interface V2Output {
  rollout_summary: string;
  rollout_slug: string;
}

export interface V2Truncation {
  truncated: boolean;
  originalBytes: number;
  acceptedBytes: number;
}

export type V2ParseResult =
  | { ok: true; output: V2Output; outcome: "succeeded" | "no_output";
      outputHash: string; truncation: V2Truncation }
  | { ok: false; reason: string };

export interface V2RequestInput extends V1RequestInput { gitBranch?: string | null }

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const OMISSION_MARKER = "\n[... remainder omitted ...]";

/** Never split a code point, URL, or identifier by cutting inside a line. */
function truncateSummary(summary: string, limit: number): string | null {
  const available = limit - Buffer.byteLength(OMISSION_MARKER, "utf8");
  if (available <= 0) return null;
  const lastFitting = (boundary: RegExp): string | null => {
    let best: string | null = null;
    for (const match of summary.matchAll(boundary)) {
      const candidate = summary.slice(0, match.index).trimEnd();
      if (Buffer.byteLength(candidate, "utf8") > available) break;
      if (candidate.trim()) best = candidate;
    }
    return best;
  };
  const prefix = lastFitting(/\r?\n[ \t]*\r?\n/g) ?? lastFitting(/\r?\n/g);
  return prefix ? prefix + OMISSION_MARKER : null;
}

/** Strictly accept the pinned two-field v2 contract, never a v1 response. */
export function parseV2Output(response: string, maxBytes: number, summaryBytes: number): V2ParseResult {
  let text = response.trim();
  if (text.startsWith("```") || text.endsWith("```")) {
    const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
    if (!fence) return { ok: false, reason: "invalid enclosing JSON fence" };
    text = fence[1]?.trim() ?? "";
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes * 4) return { ok: false, reason: "response too large" };
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch { return { ok: false, reason: "invalid JSON or extra prose" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "v2 response must be a JSON object" };
  }
  const object = parsed as Record<string, unknown>;
  const keys = Object.keys(object).sort((a, b) => a.localeCompare(b));
  if (keys.join(",") !== "rollout_slug,rollout_summary" ||
      typeof object.rollout_summary !== "string" || typeof object.rollout_slug !== "string") {
    return { ok: false, reason: "v2 response needs exactly rollout_summary, rollout_slug strings" };
  }
  if (Buffer.byteLength(object.rollout_summary, "utf8") + Buffer.byteLength(object.rollout_slug, "utf8") > maxBytes) {
    return { ok: false, reason: "v2 combined fields exceed byte limit" };
  }
  const redactedSummary = redactSensitive(object.rollout_summary);
  const slug = redactSensitive(object.rollout_slug).toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  const originalBytes = Buffer.byteLength(redactedSummary, "utf8");
  const truncated = originalBytes > summaryBytes;
  const summary = truncated ? truncateSummary(redactedSummary, summaryBytes) : redactedSummary;
  if (summary === null) return { ok: false, reason: "no meaningful complete v2 summary line fits the byte limit" };
  if (!summary.trim() && object.rollout_slug !== "") {
    return { ok: false, reason: "slug without substantive summary" };
  }
  if (!summary.trim() && summary) return { ok: false, reason: "whitespace-only v2 summary" };
  const output: V2Output = { rollout_summary: summary, rollout_slug: slug };
  return { ok: true, output, outcome: summary ? "succeeded" : "no_output",
    outputHash: digest(JSON.stringify(output)),
    truncation: { truncated, originalBytes, acceptedBytes: Buffer.byteLength(summary, "utf8") } };
}

function promptFiles(): { system: string; template: string } {
  return {
    system: readFileSync(new URL("../../prompts/upstream/v2/stage_one_system_v2.md", import.meta.url), "utf8"),
    template: readFileSync(new URL("../../prompts/upstream/v2/stage_one_input_v2.md", import.meta.url), "utf8"),
  };
}

export function v2PromptHash(): string {
  const { system, template } = promptFiles();
  return digest(system + "\n" + template);
}

/** Render normalized snapshot evidence into the immutable v2 prompt family. */
export function renderV2Request(input: V2RequestInput): {
  systemPrompt: string; userPrompt: string; promptHash: string;
} {
  const { system, template } = promptFiles();
  const contents = [
    input.manifest ? `[source manifest ${JSON.stringify(input.manifest)}]` : "",
    input.manifest?.omittedSourceItems ? `[${input.manifest.omittedSourceItems} source items omitted during normalization]` : "",
    ...input.items.map(v1EvidenceLine),
    input.omittedForContext ? `[${input.omittedForContext} evidence items omitted for model context budget]` : "",
  ].filter(Boolean).join("\n");
  const userPrompt = template
    .replace("{{ rollout_path }}", JSON.stringify(input.snapshotPath))
    .replace("{{ rollout_cwd }}", JSON.stringify(input.cwd))
    .replace("{{ rollout_git_branch }}", JSON.stringify(input.gitBranch ?? "unknown"))
    .replace("{{ rollout_contents }}", contents);
  return { systemPrompt: system, userPrompt, promptHash: digest(system + "\n" + template) };
}
