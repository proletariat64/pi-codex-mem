import { readFileSync } from "node:fs";
import type { MemoryReadView } from "./view.ts";

const guidance = {
  v1: readFileSync(new URL("../../prompts/pi/v1/read_path.md", import.meta.url), "utf8"),
  v2: readFileSync(new URL("../../prompts/pi/v2/read_path.md", import.meta.url), "utf8"),
};

export function renderMemorySection(view: MemoryReadView, cwd: string): string {
  const applicability = view.applicability.includes(cwd) ? "includes the current workspace" :
    view.memoryVersion === "v1" ? "check each task group's scope before applying" : "check each route's project scope before applying";
  return guidance[view.memoryVersion]
    .replace("{{ memory_version }}", view.memoryVersion)
    .replace("{{ generation_id }}", JSON.stringify(view.generationId))
    .replace("{{ base_path }}", JSON.stringify(view.directory))
    .replace("{{ workspace }}", JSON.stringify(cwd))
    .replace("{{ applicability }}", applicability)
    .replace("{{ memory_summary }}", view.summary);
}
