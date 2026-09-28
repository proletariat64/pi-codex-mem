import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { redactSensitive } from "../sensitive.ts";

export interface V1Output {
  raw_memory: string;
  rollout_summary: string;
  rollout_slug: string;
}

export type V1ParseResult =
  | { ok: true; output: V1Output; outcome: "succeeded" | "no_output"; outputHash: string }
  | { ok: false; reason: string };

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Strictly accept the pinned v1 three-string JSON contract, not model prose. */
export function parseV1Output(response: string, maxBytes: number): V1ParseResult {
  let text = response.trim();
  if (text.startsWith("```") || text.endsWith("```")) {
    const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
    if (!fence) return { ok: false, reason: "invalid enclosing JSON fence" };
    text = fence[1]!.trim();
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes * 4) return { ok: false, reason: "response too large" };
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
  const keys = Object.keys(object).sort((a, b) => a.localeCompare(b));
  if (keys.join(",") !== "raw_memory,rollout_slug,rollout_summary" ||
      typeof object.raw_memory !== "string" || typeof object.rollout_summary !== "string" ||
      typeof object.rollout_slug !== "string") {
    return { ok: false, reason: "v1 response needs exactly raw_memory, rollout_summary, rollout_slug strings" };
  }
  const bytes = Buffer.byteLength(object.raw_memory, "utf8") +
    Buffer.byteLength(object.rollout_summary, "utf8") + Buffer.byteLength(object.rollout_slug, "utf8");
  if (bytes > maxBytes) return { ok: false, reason: "v1 combined fields exceed byte limit" };
  const slug = redactSensitive(object.rollout_slug).toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  const output: V1Output = {
    raw_memory: redactSensitive(object.raw_memory),
    rollout_summary: redactSensitive(object.rollout_summary),
    rollout_slug: slug,
  };
  const sanitizedBytes = Object.values(output).reduce((sum, field) => sum + Buffer.byteLength(field, "utf8"), 0);
  if (sanitizedBytes > maxBytes) return { ok: false, reason: "sanitized v1 fields exceed byte limit" };
  const substantive = output.raw_memory.trim() !== "" || output.rollout_summary.trim() !== "";
  if (!substantive && output.rollout_slug !== "") return { ok: false, reason: "slug without substantive memory" };
  if (!substantive && (output.raw_memory !== "" || output.rollout_summary !== "")) {
    return { ok: false, reason: "whitespace-only v1 content" };
  }
  const outcome = substantive ? "succeeded" : "no_output";
  return { ok: true, output, outcome, outputHash: digest(JSON.stringify(output)) };
}

export function v1PromptHash(): string {
  const system = readFileSync(new URL("../../prompts/upstream/v1/stage_one_system.md", import.meta.url), "utf8");
  const template = readFileSync(new URL("../../prompts/upstream/v1/stage_one_input.md", import.meta.url), "utf8");
  return digest(system + "\n" + template);
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
  const contents = [
    input.manifest ? `[source manifest ${JSON.stringify(input.manifest)}]` : "",
    input.manifest?.omittedSourceItems ? `[${input.manifest.omittedSourceItems} source items omitted during normalization]` : "",
    ...input.items.map(v1EvidenceLine),
    input.omittedForContext ? `[${input.omittedForContext} evidence items omitted for model context budget]` : "",
  ].filter(Boolean).join("\n");
  const userPrompt = template
    .replace("{{ rollout_path }}", JSON.stringify(input.snapshotPath))
    .replace("{{ rollout_cwd }}", JSON.stringify(input.cwd))
    .replace("{{ rollout_contents }}", contents);
  return { systemPrompt, userPrompt, promptHash: digest(systemPrompt + "\n" + template) };
}
