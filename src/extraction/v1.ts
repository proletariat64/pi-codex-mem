import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { redactSensitive } from "../sensitive.ts";
import { renderTemplate } from "../template.ts";
import { codexExtractionFormat } from "./format.ts";

export interface V1Output {
  raw_memory: string;
  rollout_summary: string;
  rollout_slug: string;
}

export type V1ParseResult =
  | { ok: true; output: V1Output; outcome: "succeeded" | "no_output"; outputHash: string }
  | { ok: false; reason: string };

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Pinned utils/string truncation; the marker is added outside the byte budget. */
export function truncateCodexMiddle(text: string, maxBytes: number, tokens = false): string {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) return text;
  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  let offset = 0;
  let left = "";
  let right = "";
  let removed = 0;
  for (const character of text) {
    const end = offset + Buffer.byteLength(character, "utf8");
    if (end <= leftBudget) left += character;
    else if (offset >= totalBytes - rightBudget) right += character;
    else removed++;
    offset = end;
  }
  const count = tokens ? Math.ceil((totalBytes - maxBytes) / 4) : removed;
  return `${left}…${count} ${tokens ? "tokens" : "chars"} truncated…${right}`;
}

/** Pinned Codex v1 output semantics; legacy maxBytes is retained for API compatibility. */
export function parseV1Output(response: string, _maxBytes: number): V1ParseResult {
  const text = response.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "invalid JSON or extra prose" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "v1 response must be a JSON object" };
  }
  const object = parsed as Record<string, unknown>;
  if (Object.keys(object).some(key => !["raw_memory", "rollout_summary", "rollout_slug"].includes(key)) ||
      typeof object.raw_memory !== "string" || typeof object.rollout_summary !== "string" ||
      (object.rollout_slug !== undefined && object.rollout_slug !== null && typeof object.rollout_slug !== "string")) {
    return { ok: false, reason: "v1 response needs raw_memory and rollout_summary strings and an optional nullable slug" };
  }
  // The existing Pi storage contract represents an absent Codex slug as an empty string.
  const slug = typeof object.rollout_slug === "string" ? redactSensitive(object.rollout_slug) : "";
  const output: V1Output = {
    raw_memory: redactSensitive(object.raw_memory),
    rollout_summary: redactSensitive(object.rollout_summary),
    rollout_slug: slug,
  };
  // Pinned phase1::job::run treats either empty required field as no output.
  const outcome = output.raw_memory === "" || output.rollout_summary === "" ? "no_output" : "succeeded";
  return { ok: true, output, outcome, outputHash: digest(JSON.stringify(output)) };
}

/** Bump the policy version when the renderer, schema, or final evidence selection changes.
 * A new hash queues fresh work even for a prior succeeded/no-output revision. */
export function extractionPromptHash(system: string, template: string, version: "v1" | "v2"): string {
  return digest(system + "\n" + template + "\n" + JSON.stringify({
    version, schemaVersion: 1, rendererVersion: 4, evidenceSelectionVersion: 2, outputPolicyVersion: 2,
    contextEstimator: "codex-utf8-div4", rolloutContextPercent: 70, outputHeadroom: "remaining-context-v1",
    codexStructuredOutput: codexExtractionFormat(version),
  }));
}

export function v1PromptHash(): string {
  const system = readFileSync(new URL("../../prompts/upstream/v1/stage_one_system.md", import.meta.url), "utf8");
  const template = readFileSync(new URL("../../prompts/upstream/v1/stage_one_input.md", import.meta.url), "utf8");
  return extractionPromptHash(system, template, "v1");
}

export interface V1RequestInput {
  snapshotPath: string;
  cwd: string;
  items: readonly { entryId: string; role: string; origin: string | null; text: string }[];
  manifest?: {
    sourceId: string; sessionKey?: string; branchId?: string; leafId?: string;
    workspaceKey?: string; omittedSourceItems?: number; omissionReasons?: string[];
  };
  omittedForContext?: number;
  /** Host-normalized payload, optionally native head/tail truncated by the runner. */
  rolloutContents?: string;
}

export function v1EvidenceLine(item: V1RequestInput["items"][number]): string {
  return `[entry=${JSON.stringify(item.entryId)} role=${item.role} origin=${item.origin ?? "none"}] ${JSON.stringify(item.text)}`;
}

/** Read the immutable pinned files and render only sanitized snapshot evidence. */
export function renderV1Request(input: V1RequestInput): {
  systemPrompt: string; userPrompt: string; promptHash: string;
} {
  const systemPrompt = readFileSync(new URL("../../prompts/upstream/v1/stage_one_system.md", import.meta.url), "utf8");
  const template = readFileSync(new URL("../../prompts/upstream/v1/stage_one_input.md", import.meta.url), "utf8");
  const contents = input.rolloutContents ?? [
    input.manifest ? `[source manifest ${JSON.stringify(input.manifest)}]` : "",
    input.manifest?.omittedSourceItems ? `[${input.manifest.omittedSourceItems} source items omitted during normalization]` : "",
    ...input.items.map(v1EvidenceLine),
    input.omittedForContext ? `[${input.omittedForContext} evidence items omitted for model context budget]` : "",
  ].filter(Boolean).join("\n");
  const userPrompt = renderTemplate(template, {
    rollout_path: input.snapshotPath, rollout_cwd: input.cwd, rollout_contents: contents,
  });
  return { systemPrompt, userPrompt, promptHash: extractionPromptHash(systemPrompt, template, "v1") };
}
