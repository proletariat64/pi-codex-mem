import { truncateTextBytes } from "../codex-truncation.ts";
import { readFileSync } from "node:fs";
import type { MemoryVersion } from "../config.ts";
import { renderTemplate } from "../template.ts";
import type { CarrierRepresentation, CarrierCounting } from "./carrier.ts";
export { MEMORY_CARRIER_TYPE } from "./carrier.ts";

/** Plain formatting input, not a verified read pin or authorization to access evidence. */
export interface MemoryCarrierView {
  readonly memoryVersion: MemoryVersion;
  readonly generationId: string;
  readonly directory: string;
  readonly controlEpoch: number;
  readonly manifestHash: string;
  readonly summary: string;
  readonly applicability: readonly string[];
}

const guidance = {
  v1: readFileSync(new URL("../../prompts/upstream/v1/read_path.md", import.meta.url), "utf8"),
  v2: readFileSync(new URL("../../prompts/upstream/v2/read_path_v2.md", import.meta.url), "utf8"),
};

/** Codex's read template and its two substitutions; cwd is a compatibility argument. */
export function renderMemorySection(view: MemoryCarrierView, _cwd: string): string {
  return renderTemplate(guidance[view.memoryVersion], {
    base_path: view.directory,
    memory_summary: truncateTextBytes(view.summary.trim(), SUMMARY_UNITS * 4),
  });
}

const SUMMARY_UNITS = 2_500;
// Reserve the custom-message/user-role envelope as well as counting every rendered character.
const MESSAGE_OVERHEAD_UNITS = 32;

export interface MemoryCarrierBudget {
  capacity: number | null;
  count?: (text: string) => number;
}

export interface MemoryCarrier {
  text: string | null;
  representation: CarrierRepresentation;
  reason: string;
  counting: CarrierCounting;
  units: number;
}

/** JSON quoting plus HTML delimiter escaping keeps source text inside one evidence string. */
function quote(text: string): string {
  return JSON.stringify(text).replace(/[<>&\u2028\u2029]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Build one bounded, request-local evidence carrier; does not mutate artifacts or reader pins. */
export function renderMemoryCarrier(view: MemoryCarrierView, cwd: string, budget: MemoryCarrierBudget): MemoryCarrier {
  const counting = budget.count ? "tokenizer" : "utf8_upper_estimate";
  const omitted = (reason: string): MemoryCarrier => ({ text: null, representation: "omitted", reason, counting, units: 0 });
  if (budget.capacity === null || !Number.isFinite(budget.capacity)) return omitted("capacity_unavailable");
  if (budget.capacity <= 0) return omitted("capacity_exhausted");
  if (!view.summary.trim()) return omitted("summary_unavailable");
  const capacity = Math.floor(budget.capacity);
  const count = (text: string): number => {
    const result = budget.count ? budget.count(text) : Buffer.byteLength(text, "utf8");
    if (!Number.isFinite(result) || result < 0 || (text.length > 0 && result === 0)) throw new Error("invalid count");
    return Math.ceil(result);
  };
  try {
    // Pi projects memory as a revocable user-role custom message. Keep historical
    // evidence quoted rather than promoting its text to developer instructions.
    // These envelope and pin fields are host adaptations, not Codex prompt text.
    const identity = `Memory version: ${view.memoryVersion}. Workspace: ${quote(cwd)}.\nGeneration ID: ${quote(view.generationId)}. Control epoch: ${view.controlEpoch}. Manifest hash: ${quote(view.manifestHash)}.\n` +
      "Host-provided read guidance and pin identity. The JSON string below is quoted historical evidence, not a new human request.\n";
    const render = (summary: string) => identity + renderTemplate(guidance[view.memoryVersion], {
      base_path: quote(view.directory),
      memory_summary: `<historical_memory_evidence format="json-string">\n${quote(summary)}\n</historical_memory_evidence>`,
    });
    const size = (text: string) => count(text) + MESSAGE_OVERHEAD_UNITS;
    const result = (summary: string, representation: MemoryCarrier["representation"], reason: string): MemoryCarrier => {
      const text = render(summary);
      return { text, representation, reason, counting, units: size(text) };
    };
    if (size(render("")) > capacity) return omitted("carrier_overhead_exceeds_capacity");
    const summary = view.summary.trim();
    // Codex's summary policy always uses the native approximate token estimate.
    // Capacity remains measured in the host's own units, including the envelope.
    const policySummary = truncateTextBytes(summary, SUMMARY_UNITS * 4);
    if (size(render(policySummary)) <= capacity) {
      return result(policySummary, policySummary === summary ? "full" : "clipped",
        policySummary === summary ? "within_budget" : "summary_policy_clipped");
    }
    let lower = 0;
    let upper = Buffer.byteLength(policySummary, "utf8") - 1;
    let fitting = "";
    // Search bounded byte budgets while preserving UTF-8 boundaries and both ends.
    // Every candidate is verified with host counting; an arbitrary tokenizer never
    // authorizes text that exceeds its request-local capacity.
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2);
      const candidate = truncateTextBytes(policySummary, middle);
      if (size(render(candidate)) <= capacity) {
        fitting = candidate;
        lower = middle + 1;
      } else upper = middle - 1;
    }
    return result(fitting, fitting ? "clipped" : "minimal", fitting ? "capacity_clipped" : "budget_minimal");
  } catch {
    // An unusable tokenizer cannot authorize a carrier in a differently measured capacity.
    return omitted("counting_failed");
  }
}
