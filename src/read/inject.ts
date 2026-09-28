import { readFileSync } from "node:fs";
import type { MemoryReadView } from "./view.ts";

const guidance = readFileSync(new URL("../../prompts/pi/v1/read_path.md", import.meta.url), "utf8");

export function renderMemorySection(view: MemoryReadView, cwd: string): string {
  const applicability = view.applicability.includes(cwd) ? "includes the current workspace" : "check each task group's scope before applying";
  return guidance
    .replace("{{ memory_version }}", view.memoryVersion)
    .replace("{{ generation_id }}", JSON.stringify(view.generationId))
    .replace("{{ base_path }}", JSON.stringify(view.directory))
    .replace("{{ workspace }}", JSON.stringify(cwd))
    .replace("{{ applicability }}", applicability)
    .replace("{{ memory_summary }}", view.summary);
}
