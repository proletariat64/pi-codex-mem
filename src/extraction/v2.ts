import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { redactSensitive } from "../sensitive.ts";
import { renderTemplate } from "../template.ts";
import { extractionPromptHash, v1EvidenceLine, truncateCodexMiddle, type V1RequestInput } from "./v1.ts";

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
const SUMMARY_BYTES = 9_000;

/** Pinned two-field v2 contract; legacy byte parameters do not override native policy. */
export function parseV2Output(response: string, _maxBytes: number, _summaryBytes: number): V2ParseResult {
  const text = response.trim();
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
  const redactedSummary = redactSensitive(object.rollout_summary);
  const slug = redactSensitive(object.rollout_slug);
  const originalBytes = Buffer.byteLength(redactedSummary, "utf8");
  const truncated = originalBytes > SUMMARY_BYTES;
  const summary = truncateCodexMiddle(redactedSummary, SUMMARY_BYTES);
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
  return extractionPromptHash(system, template, "v2");
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
  const userPrompt = renderTemplate(template, {
    rollout_path: input.snapshotPath, rollout_cwd: input.cwd,
    rollout_git_branch: input.gitBranch ?? "unknown", rollout_contents: contents,
  });
  return { systemPrompt: system, userPrompt, promptHash: extractionPromptHash(system, template, "v2") };
}
