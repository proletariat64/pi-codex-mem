import { readFileSync } from "node:fs";
import type { MemoryReadView } from "./view.ts";
import { renderTemplate } from "../template.ts";

const guidance = {
  v1: readFileSync(new URL("../../prompts/pi/v1/read_path.md", import.meta.url), "utf8"),
  v2: readFileSync(new URL("../../prompts/pi/v2/read_path.md", import.meta.url), "utf8"),
};

export function renderMemorySection(view: MemoryReadView, cwd: string): string {
  const applicability = view.applicability.includes(cwd) ? "includes the current workspace" :
    view.memoryVersion === "v1" ? "check each task group's scope before applying" : "check each route's project scope before applying";
  return renderTemplate(guidance[view.memoryVersion], {
    memory_version: view.memoryVersion, generation_id: JSON.stringify(view.generationId),
    base_path: JSON.stringify(view.directory), workspace: JSON.stringify(cwd),
    applicability, memory_summary: view.summary,
  });
}
